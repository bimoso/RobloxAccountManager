const { app, BrowserWindow, ipcMain, shell, net, session, safeStorage, clipboard } = require('electron');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
app.commandLine.appendSwitch('user-agent', CHROME_UA);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendArgument('--no-sandbox');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const os = require('os');
const { applyAccountDonutDefaults, applySettingsDonutDefaults } = require('./account-model');
const { donutRequest, buildDonutBaseUrl, classifyAvailability } = require('./donut-http');
const { redactSecrets, redactArgs, accountLogIdentity } = require('./redaction');

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });

let _mutexProc = null;
let _antiAfkProc = null;
const _accountPids = new Map(); // accountId -> pid of the RobloxPlayerBeta process we spawned for it

// ── Native helper (RobloxNative.exe) ────────────────────────────────────────
// A single C# helper that holds the singleton mutex, closes singleton-event
// handles before each launch, sets per-session volume, and runs anti-AFK.
// We prefer a prebuilt exe shipped with the app; if it's missing we compile the
// bundled source once with the .NET Framework csc.exe (present on every Windows
// machine) and cache it. If neither is available the related feature is a no-op.
let _nativeHelperPromise = null;

function nativeSrcPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'RobloxNative.cs')
    : path.join(__dirname, 'RobloxNative.cs');
}
function bundledNativeExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'RobloxNative.exe')
    : path.join(__dirname, 'RobloxNative.exe');
}
function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// Resolves to the path of a usable RobloxNative.exe, or null if none could be
// produced (callers then fall back to PowerShell). Memoized for the session.
function ensureNativeHelper() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (_nativeHelperPromise) return _nativeHelperPromise;
  _nativeHelperPromise = (async () => {
    // 1. Prefer a prebuilt exe shipped with the app (built by build.bat).
    try { const b = bundledNativeExePath(); if (fs.existsSync(b)) return b; } catch {}
    // 2. Otherwise compile the bundled source once into userData and cache it.
    const src = nativeSrcPath();
    try { if (!fs.existsSync(src)) return null; } catch { return null; }
    const outExe = path.join(app.getPath('userData'), 'RobloxNative.exe');
    try {
      // Reuse a cached build if it's at least as new as the source.
      if (fs.existsSync(outExe) && fs.statSync(outExe).mtimeMs >= fs.statSync(src).mtimeMs) return outExe;
    } catch {}
    const csc = findCsc();
    if (!csc) { console.error('[native] csc.exe not found; native helper unavailable'); return null; }
    const ok = await new Promise((resolve) => {
      try {
        const proc = spawn(csc, [
          '/nologo', '/optimize+', '/platform:x64', '/target:exe',
          '/out:' + outExe, src,
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let err = '';
        if (proc.stderr) proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => {
          if (code !== 0 && err.trim()) console.error('[native] compile failed:', err.trim());
          resolve(code === 0 && fs.existsSync(outExe));
        });
        setTimeout(() => { try { proc.kill(); } catch {} resolve(fs.existsSync(outExe)); }, 30000);
      } catch (e) { console.error('[native] compile error:', e.message); resolve(false); }
    });
    return ok ? outExe : null;
  })();
  return _nativeHelperPromise;
}

function isMultiInstanceEnabled() {
  return !!(loadSettings().multiInstance);
}

let _mutexReady = false;
let _mutexReadyPromise = null;

async function startMutexHolder() {
  if (_mutexProc) return _mutexReadyPromise || Promise.resolve();
  const nativeExe = await ensureNativeHelper();
  _mutexReadyPromise = new Promise((resolve) => {
    try {
      if (!nativeExe) { console.error('[mutex] native helper unavailable'); resolve(); return; }
      _mutexProc = spawn(nativeExe, ['mutex'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      _mutexProc.stdout.on('data', (data) => {
        if (data.toString().includes('MUTEX_HELD')) {
          _mutexReady = true;
          resolve();
        }
      });
      if (_mutexProc.stderr) _mutexProc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[mutex]', s); });
      // Safety fallback only. The holder prints MUTEX_HELD right after it grabs
      // the mutex (before the slow handle scan), so this should normally never
      // win the race. Kept generous so a slow cold start can't resolve readiness
      // before the mutex is actually held.
      setTimeout(resolve, 8000);
      _mutexProc.on('exit', () => { _mutexProc = null; _mutexReady = false; });
      _mutexProc.on('error', () => { _mutexProc = null; _mutexReady = false; resolve(); });
    } catch (e) {
      _mutexProc = null;
      resolve();
    }
  });
  return _mutexReadyPromise;
}

function stopMutexHolder() {
  if (!_mutexProc) return;
  try { _mutexProc.kill(); } catch {}
  _mutexProc = null;
}

// ── Anti-AFK holder ─────────────────────────────────────────────────────────
// Runs the native helper's `antiafk` loop, which taps a benign key into every
// running Roblox window on an interval so the ~20-minute idle kick never fires.
// Requires the native exe (Windows). No-op elsewhere or if the helper is
// unavailable. intervalSec defaults to 10 min; kept under the 20-min threshold.
async function startAntiAfk() {
  if (process.platform !== 'win32') return;
  if (_antiAfkProc) return;
  const nativeExe = await ensureNativeHelper();
  if (!nativeExe) { console.error('[antiafk] native helper unavailable; cannot run anti-AFK'); return; }
  const s = loadSettings();
  let deadline = parseInt(s.antiAfkInterval, 10);
  if (!Number.isFinite(deadline) || deadline < 60) deadline = 19 * 60; // 19 min, under the ~20-min kick
  try {
    _antiAfkProc = spawn(nativeExe, ['antiafk', String(deadline)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    sendLog('ok', 'afk', `Anti-AFK started (interval: ${Math.round(deadline/60)} min)`, { intervalSec: deadline });
    if (_antiAfkProc.stdout) _antiAfkProc.stdout.on('data', d => {
      const lines = d.toString().trim().split('\n');
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        const mw = t.match(/tapped\s+(\d+)\s+window/i);
        if (mw) sendLog('info', 'afk', `Anti-AFK: tapped ${mw[1]} Roblox window${mw[1]==='1'?'':'s'}`, { windows: parseInt(mw[1]) });
        else sendLog('info', 'afk', `Anti-AFK: ${t}`);
      }
    });
    if (_antiAfkProc.stderr) _antiAfkProc.stderr.on('data', d => {
      const t = d.toString().trim();
      if (t) { console.error('[antiafk]', t); sendLog('warn', 'afk', `Anti-AFK warning: ${t}`); }
    });
    _antiAfkProc.on('exit', (code) => { sendLog('warn', 'afk', `Anti-AFK process exited (code ${code})`); _antiAfkProc = null; });
    _antiAfkProc.on('error', (e) => { sendLog('err', 'afk', `Anti-AFK process error: ${e.message}`); _antiAfkProc = null; });
  } catch (e) { _antiAfkProc = null; console.error('[antiafk] spawn failed:', e.message); }
}

function stopAntiAfk() {
  if (!_antiAfkProc) return;
  sendLog('warn', 'afk', 'Anti-AFK stopped');
  try { _antiAfkProc.kill(); } catch {}
  _antiAfkProc = null;
}

// Fully re-squats the ROBLOX_singletonMutex / ROBLOX_singletonEvent pair
// instead of just confirming a holder is alive. Killing the old holder
// releases those kernel objects outright (Windows closes all of a process's
// handles when it dies), so the fresh one starts from a clean slate with no
// state left over from whatever session was running before.
//
// This is ONLY safe to call when we've just verified zero real Roblox
// processes are running -- see the big comment above _doLaunch for why
// respawning the holder while a real instance could be racing it is exactly
// what corrupts that instance's install pipeline. killAllRoblox is the one
// place that verification happens, which is why the restart lives there.
async function restartMutexHolder() {
  stopMutexHolder();
  await startMutexHolder();
}

// Polls tasklist until both RobloxPlayerBeta.exe and RobloxCrashHandler.exe
// are confirmed gone, or maxWaitMs elapses. taskkill returning just means the
// kill command was issued -- actual process teardown (and release of the
// handles/kernel objects those processes held) can lag a beat behind that.
// Treating "taskkill closed" as "fully gone" was the gap that let a relaunch
// race leftover state from the session that was just killed, which is what
// produced Roblox reinstalling itself and the new instances immediately
// glitching out.
function waitForRobloxFullyClosed(maxWaitMs = 5000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      let out = '';
      try {
        const proc = spawn('cmd', ['/c',
          'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH & tasklist /FI "IMAGENAME eq RobloxCrashHandler.exe" /NH'
        ], { windowsHide: true });
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve());
        proc.on('close', () => {
          const stillRunning = /RobloxPlayerBeta\.exe|RobloxCrashHandler\.exe/i.test(out);
          if (!stillRunning || Date.now() - startedAt >= maxWaitMs) { resolve(); return; }
          setTimeout(check, 300);
        });
      } catch { resolve(); }
    };
    check();
  });
}

// ── Roblox session control (volume / kill / count) ──────────────────────────
// Applies an OS-level volume (0-100) to every running RobloxPlayerBeta session
// at once. Returns the number of sessions adjusted. No-op off Windows.
async function setRobloxVolume(percent) {
  if (process.platform !== 'win32') return { ok: false, count: 0, error: 'Windows only' };
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const nativeExe = await ensureNativeHelper();
  return new Promise((resolve) => {
    let out = '';
    try {
      if (!nativeExe) { resolve({ ok: false, count: 0, error: 'native helper unavailable' }); return; }
      const proc = spawn(nativeExe, ['volume', String(pct)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[volume]', s); });
      proc.on('error', () => resolve({ ok: false, count: 0, error: 'spawn failed' }));
      proc.on('close', () => {
        const m = out.match(/SET:(\d+)/);
        resolve({ ok: true, count: m ? parseInt(m[1], 10) : 0 });
      });
      // safety timeout
      setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: true, count: 0 }); }, 12000);
    } catch (e) {
      resolve({ ok: false, count: 0, error: e.message });
    }
  });
}

// Count running Roblox clients (used to gate / inform the UI).
function countRobloxProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(0); return; }
    let out = '';
    try {
      const proc = spawn('cmd', ['/c', 'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH'], { windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve(0));
      proc.on('close', () => {
        const matches = out.match(/RobloxPlayerBeta\.exe/gi);
        resolve(matches ? matches.length : 0);
      });
    } catch { resolve(0); }
  });
}

// Terminates every Roblox client. Clears all watchers and notifies the renderer
// so every account dot resets to "not launched".
function killAllRoblox() {
  return new Promise((resolve) => {
    // Stop watchers immediately and tell the UI which accounts went down.
    const watchedIds = Array.from(_watchedAccounts.keys());
    _watchedAccounts.clear();
    _missCounts.clear();
    _stopWatchPollIfIdle();

    const notify = () => {
      if (win && !win.isDestroyed()) {
        for (const id of watchedIds) win.webContents.send('roblox:closed', id);
        win.webContents.send('roblox:allClosed');
      }
    };

    if (process.platform !== 'win32') { notify(); resolve({ ok: false, error: 'Windows only' }); return; }

    try {
      const proc = spawn('cmd', ['/c',
        'taskkill /F /IM RobloxPlayerBeta.exe /T & taskkill /F /IM RobloxCrashHandler.exe /T'
      ], { windowsHide: true });
      _accountPids.clear();
      const hadRunning = watchedIds.length > 0;
      let settled = false;
      const finishUp = async () => {
        if (settled) return;
        settled = true;
        // Don't trust taskkill's return alone -- confirm the processes are
        // actually gone before doing anything else.
        await waitForRobloxFullyClosed();
        // We just verified there's no real Roblox process left to race, so
        // this is the one safe moment to fully refresh the mutex/event
        // holder instead of merely checking it's alive. That clears out any
        // stale singleton state tied to the session we just killed -- the
        // actual cause of relaunches right after "kill all" reinstalling
        // Roblox and then the new instances immediately glitching out.
        if (hadRunning) { try { await restartMutexHolder(); } catch {} }
        else { try { await startMutexHolder(); } catch {} }
        notify();
      };
      proc.on('error', () => { finishUp().then(() => resolve({ ok: false, error: 'taskkill failed' })); });
      proc.on('close', () => { finishUp().then(() => resolve({ ok: true })); });
      setTimeout(() => { finishUp().then(() => resolve({ ok: true })); }, 6000);
    } catch (e) {
      notify();
      resolve({ ok: false, error: e.message });
    }
  });
}

// Terminates just the Roblox instance launched for one account (by PID), and
// notifies the renderer so only that account's dot resets.
function killAccountRoblox(accountId) {
  return new Promise((resolve) => {
    const pid = _accountPids.get(accountId);
    _accountPids.delete(accountId);

    _watchedAccounts.delete(accountId);
    _missCounts.delete(accountId);
    _stopWatchPollIfIdle();

    const notify = () => { if (win && !win.isDestroyed()) win.webContents.send('roblox:closed', accountId); };

    if (process.platform !== 'win32') { notify(); resolve({ ok: false, error: 'Windows only' }); return; }
    if (!pid) { notify(); resolve({ ok: false, error: 'No tracked process for this account' }); return; }

    try {
      const proc = spawn('cmd', ['/c', `taskkill /F /PID ${pid} /T`], { windowsHide: true });
      proc.on('error', () => { notify(); resolve({ ok: false, error: 'taskkill failed' }); });
      proc.on('close', () => { notify(); resolve({ ok: true }); });
      setTimeout(() => { notify(); resolve({ ok: true }); }, 4000);
    } catch (e) {
      notify();
      resolve({ ok: false, error: e.message });
    }
  });
}


const settingsPath = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  let s;
  try { s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}; } catch { s = {}; }
  applySettingsDonutDefaults(s); // donutApiTokenEnc:null, donutApiPort:10108, pendingDonutDeletions:[] when absent
  return s;
}
function saveSettings(s) { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), { mode: 0o600 }); }

const SALT = 'robloxaccountmanager-v1-salt-2025';
const ITERATIONS = 210_000;
const KEY_LEN = 32;
const DIGEST = 'sha512';

// safeStorage encrypts with the OS keychain -- DPAPI on Windows, tied to the
// logged-in user account. Unlike the device-key path, no key is ever written to
// disk in plaintext, so this is the secure default when no passphrase is set.
function safeStorageReady() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

// Kept only so accounts encrypted by older builds (random key stored in
// settings.json) still decrypt. New writes never use this path.
function getOrCreateDeviceKey() {
  const s = loadSettings();
  if (s._deviceKey && s._deviceKey.length === 64) {
    return Buffer.from(s._deviceKey, 'hex');
  }
  const key = crypto.randomBytes(KEY_LEN);
  saveSettings({ ...s, _deviceKey: key.toString('hex') });
  return key;
}

// Passphrase key derivation.
// New writes use scrypt (memory-hard -> far stronger against GPU/ASIC cracking
// than PBKDF2). N=2^15 costs ~32MB and <100ms, derived once and cached, so there
// is no per-record or runtime cost. PBKDF2 is kept only to read data written by
// older builds (the gcm:/cbc: formats), which migrates forward on the next save.
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
function deriveScryptKey(p) { return crypto.scryptSync(p, SALT, KEY_LEN, SCRYPT_PARAMS); }
function deriveLegacyKey(p) { return crypto.pbkdf2Sync(p, SALT, ITERATIONS, KEY_LEN, DIGEST); }

let _cachedKey = null, _cachedLegacyKey = null, _sessionPass = null;

// ---- Per-boot key session ----------------------------------------------------
// Passphrase mode stores only a verifier in settings (never a usable key). The
// unlocked passphrase is cached for the current OS boot session in a keychain-
// wrapped file tagged with the boot id, so the app remembers it across app
// restarts but forgets it after the computer reboots, prompting again next launch.
const sessionPath = path.join(app.getPath('userData'), '.keysession');
const VERIFY_TOKEN = 'robloxaccountmanager-verify-v1';
function bootId() { return Math.round(Date.now() / 1000 - os.uptime()); }
function passphraseMode() {
  const s = loadSettings();
  return !!(s.keyVerifier || s.customKeyEnc || (s.customKey && s.customKey.trim()));
}
function makeVerifier(pass) { return encryptGCM(VERIFY_TOKEN, deriveScryptKey(pass), 'gs'); }
function verifyPass(pass) {
  try {
    const v = loadSettings().keyVerifier;
    return !!v && decryptGCM(v, deriveScryptKey(pass), 'gs') === VERIFY_TOKEN;
  } catch { return false; }
}
function writeSessionKey(pass) {
  // No session caching: encryption key must be entered on every app launch
}
function readSessionKey() {
  return null; // No session caching: encryption key must be entered on every app launch
}
function clearSessionKey() { try { fs.unlinkSync(sessionPath); } catch {} }

// Runs once at startup: migrate older key formats to the verifier model, then try
// to restore the key from this boot's session cache (silent unlock).
function initEncryption() {
  try {
    const s = loadSettings();
    if (!s.keyVerifier) {
      let legacy = null;
      if (s.customKeyEnc && safeStorageReady()) { try { legacy = safeStorage.decryptString(Buffer.from(s.customKeyEnc, 'base64')); } catch {} }
      if (!legacy && s.customKey && s.customKey.trim()) legacy = s.customKey.trim();
      if (legacy) {
        const { customKey, customKeyEnc, ...rest } = s;
        saveSettings({ ...rest, keyVerifier: makeVerifier(legacy) });
        _sessionPass = legacy; writeSessionKey(legacy); // unlocked this boot; prompt after reboot
        return;
      }
    }
    if (passphraseMode()) {
      const cached = readSessionKey();
      if (cached && verifyPass(cached)) _sessionPass = cached;
    }
  } catch {}
}
function getStoredPassphrase() { return _sessionPass; }

// Primary key: scrypt-derived passphrase key (when unlocked), or the OS/device
// key in machine-bound mode. Returns null when passphrase mode is locked.
function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;
  if (_sessionPass) { _cachedKey = deriveScryptKey(_sessionPass); return _cachedKey; }
  if (!passphraseMode()) { _cachedKey = getOrCreateDeviceKey(); return _cachedKey; }
  return null; // locked
}
// Legacy PBKDF2 key, derived lazily only when an old gcm:/cbc: record is read.
function getLegacyKey() {
  if (_cachedLegacyKey) return _cachedLegacyKey;
  if (_sessionPass) { _cachedLegacyKey = deriveLegacyKey(_sessionPass); return _cachedLegacyKey; }
  if (!passphraseMode()) { _cachedLegacyKey = getOrCreateDeviceKey(); return _cachedLegacyKey; }
  return null; // locked
}
function invalidateKeyCache() { _cachedKey = null; _cachedLegacyKey = null; }

// Pre-derive the unlocked passphrase key off the main thread so the first decrypt
// hits the cache instead of blocking on a ~340ms derive. No-op when locked or
// machine-bound.
function prewarmKey() {
  try {
    if (_cachedKey || !_sessionPass) return;
    crypto.scrypt(_sessionPass, SALT, KEY_LEN, SCRYPT_PARAMS, (err, dk) => {
      if (!err && dk && !_cachedKey) _cachedKey = dk;
    });
  } catch {}
}

// AES-256-GCM. `tag` carries the prefix so the reader knows which KDF produced
// the key: gs: = scrypt (current), gcm: = legacy PBKDF2.
function encryptGCM(p, k, tag) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(p, 'utf8'), c.final()]);
  return tag + ':' + [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decryptGCM(ct, k, tag) {
  const s = ct.replace(new RegExp('^' + tag + ':'), '').split(':'); if (s.length < 3) return null;
  const iv = Buffer.from(s[0], 'base64'), at = Buffer.from(s[1], 'base64'), data = Buffer.from(s[2], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(at);
  return d.update(data, undefined, 'utf8') + d.final('utf8');
}

// Legacy CBC reader -- unauthenticated, no longer produced. Kept so existing
// cbc: values from older builds still decrypt and migrate forward on next save.
function decryptCBC(ct, k) {
  const s = ct.replace(/^cbc:/, '').split(':'); if (s.length < 2) return null;
  const iv = Buffer.from(s[0], 'base64'), data = Buffer.from(s[1], 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', k, iv);
  return d.update(data, undefined, 'utf8') + d.final('utf8');
}

function encryptField(p) {
  if (_sessionPass) return encryptGCM(p, getEncryptionKey(), 'gs'); // unlocked passphrase
  if (passphraseMode()) throw new Error('locked'); // never write with the wrong key
  if (safeStorageReady()) return 'safe:' + safeStorage.encryptString(p).toString('base64');
  return encryptGCM(p, getEncryptionKey(), 'gs'); // machine-bound, no keychain
}
function decryptField(ct) {
  try {
    if (!ct) return null;
    if (ct.startsWith('safe:')) {
      if (!safeStorageReady()) return null;
      return safeStorage.decryptString(Buffer.from(ct.slice(5), 'base64'));
    }
    if (ct.startsWith('gs:')) return decryptGCM(ct, getEncryptionKey(), 'gs');
    if (ct.startsWith('gcm:')) return decryptGCM(ct, getLegacyKey(), 'gcm');
    if (ct.startsWith('cbc:')) return decryptCBC(ct, getLegacyKey());
    return ct;
  } catch { return null; }
}

function isEncrypted(v) {
  return typeof v === 'string' && (v.startsWith('safe:') || v.startsWith('gs:') || v.startsWith('gcm:') || v.startsWith('cbc:'));
}
function encryptAccount(a) {
  const o = { ...a };
  if (o.cookie && !isEncrypted(o.cookie)) o.cookie = encryptField(o.cookie);
  applyAccountDonutDefaults(o); // donutProfileId/donutProfilePendingDelete stored unencrypted, like id/username
  o._enc = true;
  return o;
}
function decryptAccount(a) {
  const o = { ...a };
  if (o.cookie) o.cookie = decryptField(o.cookie) ?? '';
  applyAccountDonutDefaults(o); // default for accounts saved before this feature; never encrypted
  return o;
}

const dataPath = path.join(app.getPath('userData'), 'accounts.json');
function loadAccounts() {
  try { if (!fs.existsSync(dataPath)) return []; return JSON.parse(fs.readFileSync(dataPath, 'utf8')).map(decryptAccount); } catch { return []; }
}
function saveAccounts(a) { fs.writeFileSync(dataPath, JSON.stringify(a.map(encryptAccount), null, 2), { mode: 0o600 }); }

// One-time, best-effort upgrade: re-encrypt any legacy device-key (gcm:) or
// unauthenticated (cbc:) cookies to OS-keychain storage (safe:). Only runs when
// no passphrase is set and the keychain is available. Aborts untouched if any
// non-empty cookie fails to decrypt, so a bad read can never wipe data.
function migrateAccountEncryptionToKeychain() {
  try {
    if (passphraseMode()) return; // passphrase user: never touch (avoids wrong-key writes)
    if (!safeStorageReady()) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const needs = raw.some(a => a.cookie && (a.cookie.startsWith('gcm:') || a.cookie.startsWith('cbc:')));
    if (!needs) return;
    const plain = raw.map(decryptAccount);
    // Safety: if anything that had a cookie now reads empty, decryption failed.
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].cookie && !plain[i].cookie) { console.error('[migrate] decrypt failed; leaving accounts untouched'); return; }
    }
    saveAccounts(plain); // re-encrypts via encryptField -> safe:
    console.log('[migrate] upgraded account encryption to OS keychain');
  } catch (e) { console.error('[migrate] skipped:', e.message); }
}

// Packages: named groups of accounts that can be launched together with a
// single shared join-link. No secrets live here -- just names, account-id
// references, and the last-used link -- so no encryption is needed.
const packagesPath = path.join(app.getPath('userData'), 'packages.json');
function loadPackages() {
  try { if (!fs.existsSync(packagesPath)) return []; return JSON.parse(fs.readFileSync(packagesPath, 'utf8')); } catch { return []; }
}
function savePackages(p) { fs.writeFileSync(packagesPath, JSON.stringify(p, null, 2), { mode: 0o600 }); }

let win;

// ── Logging ───────────────────────────────────────────────────────────────
function sendLog(level, category, message, meta) {
  try {
    if (win && !win.isDestroyed())
      win.webContents.send('log:entry', { ts: Date.now(), level, category, message, meta: meta || {} });
  } catch {}
}

// ── Account_Browser_Launcher: secret-safe logging (Req 6.1-6.5) ─────────────
// Gathers every secret that could otherwise leak from this launcher: the stored
// Donut_API_Token (decrypted only in memory, here) plus any cookie value(s) the
// caller is currently handling. Passing the cookie in lets redactSecrets strip it
// from log text/metadata even though the cookie is never intentionally logged.
function launcherSecrets(...extraSecrets) {
  const secrets = [];
  try { const t = getDonutToken(); if (t) secrets.push(t); } catch (_) {}
  for (const e of extraSecrets) if (typeof e === 'string' && e) secrets.push(e);
  return secrets;
}

// sendLog wrapper for every Account_Browser_Launcher log entry. It:
//   1. forces the 'browser' log category (design: LOG_CATS.browser),
//   2. strips any cookie/Donut_API_Token fragment from the message text and the
//      metadata before it is written (Req 6.1, 6.4), and
//   3. when an account is supplied, stamps the entry with that account's username
//      and/or userId so cookie-related actions are always attributable (Req 6.3 /
//      design Property 18).
// `cookie` is accepted ONLY so its value is added to the redaction set; it is
// never placed into the message or metadata.
function logBrowser(level, message, meta, account, cookie) {
  const secrets = launcherSecrets(cookie);
  // Identity fields are authoritative: spread them last so a cookie-action entry
  // always carries whichever of username/userId is available (Req 6.3).
  const stamped = account ? { ...(meta || {}), ...accountLogIdentity(account) } : (meta || {});
  const safeMessage = redactSecrets(message, secrets);
  const safeMeta = redactSecrets(stamped, secrets);
  sendLog(level, 'browser', safeMessage, safeMeta);
}

// Redacts any cookie/Donut_API_Token fragment out of an argument list before it
// is handed to an external process (Req 6.2, 6.5). The launcher never puts a
// secret on a command line (Donut Browser spawns the Browser_Instance itself and
// the token travels only as an Authorization header), so this is defense in depth
// for any future spawn site that touches a secret.
function redactExternalArgs(args, ...extraSecrets) {
  return redactArgs(args, launcherSecrets(...extraSecrets));
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 945, minHeight: 755,
    frame: false, backgroundColor: '#0e0e10',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: true },
    show: false,
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
}
app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.robloxaccountmanager.app');
  initEncryption(); // migrate key formats + restore this boot's session key (silent unlock)
  prewarmKey(); // non-blocking; derives the passphrase key off the main thread
  // Upgrade any legacy-encrypted accounts to OS-keychain storage (no-op if none).
  migrateAccountEncryptionToKeychain();
  // Paint the UI immediately. The native-helper compile (first run only) and the
  // mutex grab used to block here, leaving the window hidden for seconds on a
  // cold start. The launch path independently awaits startMutexHolder() before
  // every launch, so the mutex is still guaranteed held before any instance is
  // launched -- moving window creation ahead of this removes startup latency
  // without ever letting a launch race an unheld mutex.
  createWindow();
  // Build/resolve the native helper once up front (compiles only if no prebuilt
  // exe shipped), then hold the mutex. startMutexHolder reuses the same memoized
  // result, so a launch fired before this resolves simply awaits the same promise.
  if (process.platform === 'win32') { await ensureNativeHelper(); await startMutexHolder(); }
  if (loadSettings().antiAfk) startAntiAfk();
  // Retry any Donut_Profile deletions left queued while Donut Browser was
  // unreachable during a prior account removal (Req 8.5). Fire-and-forget so it
  // never blocks startup; failures stay queued for the next opportunity.
  const _pendingDeletions = loadSettings().pendingDonutDeletions;
  if (Array.isArray(_pendingDeletions) && _pendingDeletions.length > 0) {
    Promise.resolve(retryPendingDeletions()).catch(() => {});
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { stopMutexHolder(); stopAntiAfk(); });

ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close', () => win.close());
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

// ---- Encryption unlock IPC ----
ipcMain.handle('enc:status', () => {
  if (!passphraseMode()) {
    // No key configured yet. Offer the one-time setup popup until dismissed.
    return { mode: 'setup' }; // Always force key setup, no device-bound mode
  }
  return { mode: _sessionPass ? 'unlocked' : 'locked' };
});
ipcMain.handle('enc:unlock', (_, pass) => {
  if (!pass || !verifyPass(pass)) return { ok: false };
  _sessionPass = pass; invalidateKeyCache(); writeSessionKey(pass);
  return { ok: true };
});
// Set, change, or clear the passphrase. Re-encrypts existing accounts with the
// new key in one step. Empty pass -> machine-bound mode.
ipcMain.handle('enc:setKey', (_, pass) => {
  try {
    const np = (pass || '').trim();
    // Decrypt with the CURRENT key while we still can. Abort if any account that
    // had a stored cookie now reads empty (failed decrypt) so we never re-encrypt
    // garbage and lose data.
    const raw = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : [];
    const accts = raw.map(decryptAccount);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].cookie && !accts[i].cookie) return { ok: false, error: 'decrypt failed' };
    }
    if (np) {
      _sessionPass = np; invalidateKeyCache();
      const { customKey, customKeyEnc, ...rest } = loadSettings();
      saveSettings({ ...rest, keyVerifier: makeVerifier(np), encSetupDone: true });
      writeSessionKey(np);
    } else {
      _sessionPass = null; invalidateKeyCache();
      const { customKey, customKeyEnc, keyVerifier, ...rest } = loadSettings();
      saveSettings({ ...rest, encSetupDone: true });
      clearSessionKey();
    }
    invalidateKeyCache();
    saveAccounts(accts); // re-encrypt with the new key (or machine-bound)
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('settings:load', () => {
  // Never expose key material to the renderer. The passphrase is entered via the
  // unlock/setup popup, not prefilled. Report whether a key is configured instead.
  const s = loadSettings();
  const { customKeyEnc, customKey, keyVerifier, _deviceKey, donutApiTokenEnc, ...rest } = s;
  // The Donut_API_Token is never returned to the renderer in any form (Req 9.7).
  // Strip the encrypted blob and surface only a boolean configured flag so the
  // Settings_Screen can render "configured / not configured" state.
  return { ...rest, keySet: passphraseMode(), donutApiTokenConfigured: !!donutApiTokenEnc };
});
ipcMain.handle('settings:save', (_, data) => {
  // Key changes go through enc:setKey (handles re-encryption + verifier). Strip any
  // key field here so a plain settings write can never persist or wipe a key.
  // The Donut_API_Token only ever goes through settings:saveDonutToken, so strip
  // donutApiTokenEnc here too: the general save path must never write/overwrite it
  // (least of all with a plaintext value coming from the renderer) (Req 9.2).
  const { customKey, customKeyEnc, keyVerifier, donutApiTokenEnc, ...rest } = data;
  saveSettings({ ...loadSettings(), ...rest });
  if ('encryptionType' in data) invalidateKeyCache();
  if ('multiInstance' in data) {
    if (data.multiInstance) startMutexHolder();
    else stopMutexHolder();
  }
  if ('antiAfk' in data) {
    if (data.antiAfk) startAntiAfk();
    else stopAntiAfk();
  } else if ('antiAfkInterval' in data && _antiAfkProc) {
    // Interval changed while running -> restart with the new value.
    stopAntiAfk(); startAntiAfk();
  }
  return true;
});
// Dedicated Donut_API_Token save path (Req 9.2, 9.4, 9.5). Kept separate from the
// general settings:save handler so plaintext token material never travels through
// (or gets returned by) that path. A non-empty token is encrypted with the same
// encryptField mechanism used for ROBLOSECURITY_Cookie values and stored as
// donutApiTokenEnc, replacing any previously stored token. An empty/blank value
// deletes the stored token (donutApiTokenEnc = null).
ipcMain.handle('settings:saveDonutToken', (_, token) => {
  try {
    const s = loadSettings();
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (trimmed) {
      s.donutApiTokenEnc = encryptField(trimmed); // encrypt before storing (Req 9.2); replaces existing (Req 9.4)
    } else {
      s.donutApiTokenEnc = null; // clearing the field deletes the stored token (Req 9.5)
    }
    saveSettings(s);
    return { ok: true, donutApiTokenConfigured: !!s.donutApiTokenEnc };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('multiinstance:status', () => ({ enabled: isMultiInstanceEnabled(), active: !!_mutexProc }));
ipcMain.handle('antiafk:status', () => ({ enabled: !!loadSettings().antiAfk, active: !!_antiAfkProc }));

ipcMain.handle('accounts:load', () => loadAccounts());
ipcMain.handle('accounts:add', (_, account) => {
  const accounts = loadAccounts();
  const a = { id: Date.now().toString(), ...account, createdAt: new Date().toISOString(), lastUsed: null };
  accounts.push(a); saveAccounts(accounts); return a;
});
ipcMain.handle('accounts:remove', async (_, id) => {
  const account = loadAccounts().find(a => a.id === id) || null;
  // Clean up Donut Browser state (close any open instance, delete/queue the
  // profile) BEFORE dropping the account record, so removal does not complete
  // until the instance is confirmed closed and the profile is deleted or queued
  // for deletion (Req 8.1-8.4).
  let cleanup = { pending: false, notice: null };
  if (account) {
    try { cleanup = await handleAccountRemovalCleanup(account); }
    catch (_) { cleanup = { pending: false, notice: null }; }
  }
  saveAccounts(loadAccounts().filter(a => a.id !== id));
  if (cleanup.notice && win && !win.isDestroyed()) {
    win.webContents.send('browser:notify', { type: 'warn', message: cleanup.notice });
  }
  return { ok: true, pending: cleanup.pending, notice: cleanup.notice };
});
ipcMain.handle('accounts:update', (_, id, data) => {
  const accounts = loadAccounts(), idx = accounts.findIndex(a => a.id === id);
  if (idx !== -1) { accounts[idx] = { ...accounts[idx], ...data }; saveAccounts(accounts); return accounts[idx]; }
  return null;
});
ipcMain.handle('accounts:reorder', (_, ids) => {
  const accounts = loadAccounts();
  const reordered = ids.map(id => accounts.find(a => a.id === id)).filter(Boolean);
  const rest = accounts.filter(a => !ids.includes(a.id));
  saveAccounts([...reordered, ...rest]);
  return true;
});

ipcMain.handle('packages:load', () => loadPackages());
ipcMain.handle('packages:save', (_, packages) => {
  try { savePackages(packages); return true; } catch (e) { return false; }
});

function fetchUserInfo(cookie) {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url: 'https://users.roblox.com/v1/users/authenticated', useSessionCookies: false, headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'Accept': 'application/json' } });
    let body = '';
    req.on('response', res => { res.on('data', c => body += c); res.on('end', () => { try { const d = JSON.parse(body); if (d && d.id) resolve({ ok: true, username: d.name, userId: String(d.id) }); else resolve({ ok: false, reason: body.slice(0, 200) }); } catch { resolve({ ok: false, reason: 'parse error' }); } }); });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: '', error: e.message }));
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

// ---- Donut Browser local API transport --------------------------------------
// Thin wrappers over ./donut-http's pure donutRequest, binding it to the app's
// stored settings (port + encrypted token). Kept next to httpsGet/httpsPost so
// the plain-HTTP local API path mirrors the HTTPS Roblox path.

// Reads settings.donutApiPort (default 10108) to build http://127.0.0.1:{port}.
function getDonutBaseUrl() {
  const s = loadSettings();
  return buildDonutBaseUrl(s.donutApiPort);
}

// Returns the decrypted Donut_API_Token, or null when none is stored. Decrypted
// only here at the point requests are built (Req 9.3); never persisted decrypted.
function getDonutToken() {
  const s = loadSettings();
  return decryptField(s.donutApiTokenEnc) || null;
}

// Sends a request to the Donut_Browser_API with the Authorization: Bearer token
// header (Req 9.3), resolving to { ok, status, json, error:'unreachable'|'http'|null }.
function donutHttp(method, urlPath, body) {
  return donutRequest(getDonutBaseUrl(), getDonutToken(), method, urlPath, body);
}

// ---- Donut Browser availability preflight (Req 3) ---------------------------

// Verifies the Donut_Browser_API is reachable and has accepted the stored
// Donut_API_Token before any profile is created or launched (Req 3.1).
// Resolves to { ok, error: null|'unreachable'|'unauthorized'|'payment_required'|'no_token' }:
//   - no stored token       -> { ok:false, error:'no_token' } WITHOUT sending a
//                              request (Req 9.6 / Property 27)
//   - Donut Browser down    -> { ok:false, error:'unreachable' } (Req 3.2)
//   - HTTP 401 (bad token)  -> { ok:false, error:'unauthorized' } (Req 3.3)
//   - HTTP 402 (needs Pro)  -> { ok:false, error:'payment_required' } (Req 3.4)
//   - HTTP 2xx              -> { ok:true, error:null }
// Uses GET /v1/profiles as the cheapest authenticated reachability call. The
// classification itself lives in ./donut-http (classifyAvailability) so it can
// be property-tested; this wrapper only supplies the token gate + transport.
async function checkDonutAvailability() {
  const token = getDonutToken();
  // Req 9.6 / Property 27: with no token, do not send any request at all.
  if (!token) return classifyAvailability(false, null);
  const res = await donutHttp('GET', '/v1/profiles');
  return classifyAvailability(true, res);
}

// ---- Wayfern engine availability (Req 3.5, 3.6, 3.7) ------------------------

// Interprets a Donut_Browser_API engine-status response body into a boolean
// "is the wayfern engine downloaded?". The exact status shape is a Donut Browser
// implementation detail behind donutHttp, so this reads the commonly-used
// fields defensively: an explicit boolean (`downloaded`/`installed`/`is_downloaded`)
// or a status string of 'downloaded'/'installed'/'ready'. Anything else (absent
// body, unknown shape) is treated as "not downloaded" so the caller triggers a
// download rather than assuming presence.
function isWayfernDownloaded(json) {
  if (!json || typeof json !== 'object') return false;
  if (typeof json.downloaded === 'boolean') return json.downloaded;
  if (typeof json.installed === 'boolean') return json.installed;
  if (typeof json.is_downloaded === 'boolean') return json.is_downloaded;
  const status = typeof json.status === 'string' ? json.status.toLowerCase() : null;
  if (status) return status === 'downloaded' || status === 'installed' || status === 'ready';
  return false;
}

// Ensures the "wayfern" browser engine is downloaded before a Donut_Profile is
// created (Req 3.5-3.7). The status is re-checked on every call (Req 3.5 /
// Property 10): no cached "already downloaded" result is kept across invocations.
// Flow:
//   1. GET /v1/engines/wayfern to read the current engine status (Req 3.5).
//   2. If the status check fails to reach/return successfully, abort with
//      { ok:false } (Req 3.7) -- we cannot confirm the engine.
//   3. If already downloaded, succeed without requesting a download.
//   4. If not downloaded, POST /v1/engines/wayfern/download and succeed only if
//      that request succeeds (Req 3.6); otherwise abort with { ok:false } (Req 3.7).
// Resolves to { ok, error: null|'status_failed'|'download_failed' }.
async function ensureWayfernEngine() {
  const statusRes = await donutHttp('GET', '/v1/engines/wayfern');
  // Req 3.7: cannot confirm the engine -> surface failure, open nothing.
  if (!statusRes || !statusRes.ok) return { ok: false, error: 'status_failed' };

  if (isWayfernDownloaded(statusRes.json)) return { ok: true, error: null };

  // Req 3.6: engine not downloaded -> request the download before proceeding.
  const dlRes = await donutHttp('POST', '/v1/engines/wayfern/download');
  // Req 3.7: cannot complete the download -> surface failure, open nothing.
  if (!dlRes || !dlRes.ok) return { ok: false, error: 'download_failed' };

  return { ok: true, error: null };
}

// ---- Donut Profile mapping (Req 1.1, 1.2, 2.1, 2.4, 2.5) --------------------
// Resolves an Account id to its isolated Donut_Profile id, creating one when the
// account has never been opened in a browser. The profile id is stored plain on
// the account record (it is an opaque handle, not a credential), so lookups here
// avoid any decrypt round-trip.

// Reads the Donut_Profile id currently mapped to an account id, or null when the
// account is unknown or not yet mapped. Reads from the on-disk account store so
// the caller always sees the persisted mapping (Req 2.4/2.5 dedupe source).
function getProfileIdForAccount(accountId) {
  const acct = loadAccounts().find(a => a.id === accountId);
  return (acct && acct.donutProfileId) || null;
}

// Creates a new Donut_Profile for an account and persists the id -> account
// mapping immediately, before returning, so a later /run failure can never leave
// a created-but-unrecorded profile (Req 2.1, and the basis for Req 2.6). Calls
// POST /v1/profiles via donutHttp; the created id is read defensively as `id`
// (the documented shape) or `profile_id`.
//
// Enforces the profile-id uniqueness invariant (Req 2.2 / Property 5): if Donut
// Browser ever returns an id already mapped to a different account, the mapping
// is NOT persisted and the call fails, so two distinct accounts can never point
// at the same profile.
//
// Resolves to { ok, profileId, error: null|'create_failed'|'duplicate_profile' }.
async function createDonutProfileForAccount(account) {
  const res = await donutHttp('POST', '/v1/profiles', { name: account.id });
  if (!res || !res.ok || !res.json) return { ok: false, profileId: null, error: 'create_failed' };

  const profileId = res.json.id != null ? String(res.json.id)
    : (res.json.profile_id != null ? String(res.json.profile_id) : null);
  if (!profileId) return { ok: false, profileId: null, error: 'create_failed' };

  // Persist the mapping immediately (Req 2.1). Reload here rather than trusting
  // the passed-in copy so a concurrent save can't be clobbered, and enforce the
  // uniqueness invariant against the current store (Req 2.2 / Property 5).
  const accounts = loadAccounts();
  if (accounts.some(a => a.id !== account.id && a.donutProfileId === profileId))
    return { ok: false, profileId: null, error: 'duplicate_profile' };

  const idx = accounts.findIndex(a => a.id === account.id);
  if (idx === -1) return { ok: false, profileId: null, error: 'create_failed' };
  accounts[idx].donutProfileId = profileId;
  saveAccounts(accounts);

  return { ok: true, profileId, error: null };
}

// Resolves the Donut_Profile to open a browser for, creating and mapping one only
// when the account is not already mapped (Req 1.1/1.2/2.4/2.5). Reusing an
// existing mapping never calls profile creation; an unmapped account creates a
// profile and persists the mapping before returning.
//
// Resolves to { ok, profileId, created, error }:
//   already mapped -> { ok:true, profileId, created:false, error:null }
//   newly created  -> { ok:true, profileId, created:true,  error:null }
//   creation failed-> { ok:false, profileId:null, created:false, error }
async function resolveOrCreateProfile(account) {
  const existing = getProfileIdForAccount(account.id);
  if (existing) return { ok: true, profileId: existing, created: false, error: null };

  const created = await createDonutProfileForAccount(account);
  if (!created.ok) return { ok: false, profileId: null, created: false, error: created.error };
  return { ok: true, profileId: created.profileId, created: true, error: null };
}

// ---- Donut Profile run / delete (Req 1.1, 8.1) ------------------------------

// Launches the Browser_Instance for a Donut_Profile via POST /v1/profiles/{id}/run
// (Req 1.1) and extracts the CDP_Port the launcher connects to for cookie
// injection. The port is read defensively across the shapes Donut Browser may
// use (`cdpPort`/`cdp_port`/`port`/`debuggingPort`/`remoteDebuggingPort`), since
// only the /run path itself is pinned by the requirements.
//
// Resolves to { ok, cdpPort, error: null|'run_failed'|'no_cdp_port' }:
//   run failed        -> { ok:false, cdpPort:null, error:'run_failed' }
//   ran, no CDP port  -> { ok:false, cdpPort:null, error:'no_cdp_port' }
//   ran with a port   -> { ok:true,  cdpPort, error:null }
async function runDonutProfile(profileId) {
  const res = await donutHttp('POST', `/v1/profiles/${profileId}/run`);
  if (!res || !res.ok || !res.json) return { ok: false, cdpPort: null, error: 'run_failed' };

  const raw = res.json.cdpPort ?? res.json.cdp_port ?? res.json.port
    ?? res.json.debuggingPort ?? res.json.remoteDebuggingPort;
  const cdpPort = Number(raw);
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) return { ok: false, cdpPort: null, error: 'no_cdp_port' };

  return { ok: true, cdpPort, error: null };
}

// Deletes a Donut_Profile via DELETE /v1/profiles/{id} (Req 8.1). A 404 "not
// found" response is folded into success: if the profile is already gone from
// Donut Browser, the desired end state (no such profile) is achieved, so callers
// can clear the mapping / drop it from the pending-deletion queue just as they
// would on a normal delete.
//
// Resolves to { ok, error: null|'unreachable'|'delete_failed' }:
//   Donut Browser down -> { ok:false, error:'unreachable' } (queued for retry)
//   HTTP 2xx or 404    -> { ok:true,  error:null }
//   other HTTP error   -> { ok:false, error:'delete_failed' }
async function deleteDonutProfile(profileId) {
  const res = await donutHttp('DELETE', `/v1/profiles/${profileId}`);
  if (res && res.ok) return { ok: true, error: null };
  if (res && res.status === 404) return { ok: true, error: null };
  if (!res || res.error === 'unreachable') return { ok: false, error: 'unreachable' };
  return { ok: false, error: 'delete_failed' };
}

// -- Pending-deletion retry queue (Req 8.4-8.6) --------------------------------
// The durable source of truth for "which Donut_Profiles still need deleting" is
// settings.pendingDonutDeletions (an array of profile ids). It's kept in
// settings.json rather than on the account record because the account record is
// gone by the time a retry runs.

// Appends a Donut_Profile id to the pending-deletion queue and persists it via
// saveSettings (Req 8.4). De-duplicates so the same id is never queued twice.
function addPendingDeletion(profileId) {
  if (!profileId) return;
  const s = loadSettings();
  if (!Array.isArray(s.pendingDonutDeletions)) s.pendingDonutDeletions = [];
  if (!s.pendingDonutDeletions.includes(profileId)) {
    s.pendingDonutDeletions.push(profileId);
    saveSettings(s);
  }
}

// Retries deleteDonutProfile for every id in settings.pendingDonutDeletions
// (Req 8.5). On success the id is removed from the queue; on failure it is left
// queued for a later retry (Req 8.6). The queue is persisted after each attempt
// (not only at the end) by reloading settings and rewriting it on every success,
// so an interrupted run never re-deletes an already-deleted profile nor drops a
// still-pending one.
async function retryPendingDeletions() {
  const initial = loadSettings();
  const queue = Array.isArray(initial.pendingDonutDeletions)
    ? initial.pendingDonutDeletions.slice()
    : [];
  if (queue.length === 0) return;
  for (const profileId of queue) {
    const res = await deleteDonutProfile(profileId);
    if (res && res.ok) {
      // Persist the removal immediately after this attempt. Reload first so a
      // concurrent addPendingDeletion (from an in-flight removal) isn't clobbered.
      const cur = loadSettings();
      cur.pendingDonutDeletions = (Array.isArray(cur.pendingDonutDeletions) ? cur.pendingDonutDeletions : [])
        .filter(id => id !== profileId);
      saveSettings(cur);
    }
    // On failure: leave the id queued (Req 8.6). No persistence needed for it.
  }
}

// -- Account removal cleanup (Req 8.1-8.4) ------------------------------------

// Closes a tracked Browser_Instance for an account and waits for confirmation
// that it has gone away before resolving (Req 8.3). The session map only ever
// holds 'opening'/'open' entries, so a present entry means an instance is (or is
// becoming) open. Best-effort and resolve-never-reject: it resolves whether the
// browser closed cleanly, had to be force-disconnected, or was already gone, but
// it always awaits the close so the caller can treat resolution as "confirmed
// closed". The tracked entry is removed here regardless of event ordering (the
// 'disconnected' handler wired at open time may also fire and clear it).
async function closeTrackedBrowserInstance(accountId) {
  const session = _browserSessions.get(accountId);
  if (!session) return { closed: false };

  const browser = session.browser;
  // Still 'opening': no connected Playwright Browser exists yet, so there is
  // nothing to close. Drop the entry so removal isn't blocked on an instance
  // that never finished opening.
  if (!browser) { _browserSessions.delete(accountId); return { closed: true }; }

  try {
    // browser.close() tears down the connected Browser_Instance; awaiting it
    // resolves once the connection is gone, which is our confirmation the
    // instance is closed. (Playwright exposes no separate disconnect(), so this
    // is the one teardown call available here.)
    await browser.close();
  } catch (_) {
    // A failed close still means we stop tracking the instance so removal can
    // proceed; there is no secondary teardown call to attempt in Playwright.
  }
  _browserSessions.delete(accountId);
  return { closed: true };
}

// Cleans up an account's Donut Browser state as part of removing that account
// (Req 8). Called by the accounts:remove IPC handler BEFORE the account record
// is dropped from accounts.json, so removal does not complete until the close is
// confirmed and the profile id has either been deleted or recorded as pending
// (Req 8.3).
//
// Flow:
//   1. If a Browser_Instance is tracked open for the account, close it and wait
//      for confirmation before touching the profile (Req 8.3).
//   2. If the account maps to a Donut_Profile id, DELETE it via deleteDonutProfile:
//        - success (or 404 already-gone) -> mapping is cleared by the record
//          removal itself (Req 8.2), nothing pending.
//        - 'unreachable' transport error -> queue the id for retry and return a
//          notice so the caller can tell the user removal completed but deletion
//          is pending (Req 8.4).
//        - any other (reachable) HTTP failure -> removal still completes; the id
//          is NOT queued, since only an unreachable Donut Browser defers deletion.
//
// Resolves to { pending: boolean, notice: string|null }. Never rejects: an
// account record removal must not be blocked by a Donut Browser cleanup failure
// other than waiting for the confirmed close in step 1.
async function handleAccountRemovalCleanup(account) {
  if (!account) return { pending: false, notice: null };
  const accountId = account.id;
  const profileId = account.donutProfileId || null;

  // 1. Tear down any tracked Browser_Instance first and wait for confirmation
  //    that it is closed before proceeding to delete the profile (Req 8.3).
  if (accountId && _browserSessions.has(accountId)) {
    await closeTrackedBrowserInstance(accountId);
  }

  // No mapped profile -> nothing to delete from Donut Browser.
  if (!profileId) return { pending: false, notice: null };

  // 2. Delete the mapped Donut_Profile.
  const res = await deleteDonutProfile(profileId);
  if (res && res.ok) {
    // Deleted (or already gone). The mapping is removed by dropping the record.
    logBrowser('info', 'Account removal: Donut profile deleted.', { profileId }, account);
    return { pending: false, notice: null };
  }
  if (res && res.error === 'unreachable') {
    // Donut Browser is down: record the id for a later retry and complete the
    // account removal anyway, telling the user deletion is pending (Req 8.4).
    addPendingDeletion(profileId);
    logBrowser('warn', 'Account removal: Donut Browser not reachable; profile deletion pending.', { profileId }, account);
    return {
      pending: true,
      notice: 'The account was removed, but its Donut Browser profile could not be deleted because Donut Browser was not reachable. It will be deleted automatically the next time Donut Browser is reachable.',
    };
  }
  // Reachable but the delete failed at the server: removal still completes and we
  // do not queue (only an unreachable Donut Browser defers deletion, per Req 8.4).
  logBrowser('warn', 'Account removal: Donut profile deletion failed.', { profileId, error: res && res.error }, account);
  return { pending: false, notice: null };
}

const _csrfCache = new Map();
const CSRF_TTL = 5 * 60_000; // 5 min -- tokens stay valid much longer than 90s

const _ticketCache = new Map();
const TICKET_TTL     = 25_000;
const TICKET_MIN_GAP = 8_000;

// Serializing launch queue -- prevents concurrent launches from all hammering
// auth.roblox.com at once and triggering 429s.
let _launchQueue = Promise.resolve();
let _lastLaunchTs = 0;
const LAUNCH_STAGGER = 4_000; // 4s between launches

async function getCSRFToken(cookie) {
  const cached = _csrfCache.get(cookie);
  if (cached && Date.now() - cached.ts < CSRF_TTL) return cached.token;

  const cookieHeader = `.ROBLOSECURITY=${cookie}`;
  for (const endpoint of ['/v2/logout', '/v1/logout']) {
    try {
      const res = await httpsPost('auth.roblox.com', endpoint, { 'Cookie': cookieHeader }, null);
      const token = res.headers['x-csrf-token'];
      if (token) {
        _csrfCache.set(cookie, { token, ts: Date.now() });
        return token;
      }
    } catch {}
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAuthTicket(cookie, csrfToken) {
  const now = Date.now();
  const cached = _ticketCache.get(cookie);

  if (cached && (now - cached.ts) < TICKET_TTL) {
    return { ok: true, ticket: cached.ticket };
  }

  if (cached && (now - cached.ts) < TICKET_MIN_GAP) {
    await sleep(TICKET_MIN_GAP - (now - cached.ts));
  }

  const baseHeaders = {
    'Cookie': `.ROBLOSECURITY=${cookie}`,
    'Referer': 'https://www.roblox.com',
    'Origin': 'https://www.roblox.com',
  };

  let token = csrfToken;
  const delays = [0, 2000, 5000];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);

    const res = await httpsPost('auth.roblox.com', '/v1/authentication-ticket', {
      ...baseHeaders,
      'X-CSRF-TOKEN': token,
    }, null);

    const ticket = res.headers['rbx-authentication-ticket'];
    if (ticket) {
      _ticketCache.set(cookie, { ticket, ts: Date.now() });
      return { ok: true, ticket };
    }

    if (res.status === 429) {
      _csrfCache.delete(cookie);
      const retryAfter = parseInt(res.headers['retry-after'] || '8', 10);
      await sleep(retryAfter * 1000);
      token = await getCSRFToken(cookie);
      if (!token) return { ok: false, error: 'Rate limited and could not refresh token. Wait a moment and try again.' };
      continue;
    }

    if (res.status === 403) {
      _csrfCache.delete(cookie);
      token = await getCSRFToken(cookie);
      if (!token) return { ok: false, error: 'Authentication failed (403). Cookie may be expired.' };
      continue;
    }

    return { ok: false, error: `Auth ticket request failed (HTTP ${res.status}). Try again in a moment.` };
  }

  return { ok: false, error: 'Still rate limited after 3 attempts. Please wait 30 seconds and try again.' };
}

async function getRobloxVersion() {
  try {
    const r = await httpsGet('https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer');
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      if (d && d.clientVersionUpload) return d.clientVersionUpload;
      if (d && d.version) return d.version;
    }
  } catch {}
  return null;
}

ipcMain.handle('roblox:getVersion', async () => {
  try { return await getRobloxVersion(); } catch { return null; }
});


ipcMain.handle('roblox:validateCookie', async (_, cookie) => {
  return await fetchUserInfo(cookie);
});

ipcMain.handle('roblox:setVolume', async (_, percent) => {
  try { return await setRobloxVolume(percent); } catch (e) { return { ok: false, count: 0, error: e.message }; }
});
ipcMain.handle('roblox:killAll', async () => {
  try {
    const killAllAccts = loadAccounts();
    const runningNames = Array.from(_watchedAccounts.keys()).map(id => { const a = killAllAccts.find(x => x.id === id); return a ? (a.username || id) : id; });
    sendLog('warn', 'kill', `Killed all Roblox instances (${_watchedAccounts.size} running: ${runningNames.join(', ') || 'none'})`, { count: _watchedAccounts.size, accounts: runningNames });
    return await killAllRoblox();
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('roblox:killOne', async (_, accountId) => {
  try {
    const killAccts = loadAccounts(); const killAcct = killAccts.find(a => a.id === accountId) || {};
    sendLog('warn', 'kill', `Killed Roblox instance for ${killAcct.username || accountId}`, { accountId, username: killAcct.username || null, userId: killAcct.userId || null, pid: _accountPids.get(accountId) || null });
    return await killAccountRoblox(accountId);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('roblox:runningCount', async () => {
  try { return await countRobloxProcesses(); } catch { return 0; }
});

async function ensureChrome() {
  try {
    // Prefer any Chromium browser already on the machine so we don't fall back to
    // a separately-downloaded build. Playwright drives all of these over CDP
    // identically (same stealth args, same cookie extraction) -- Edge ships on
    // every Win10/11 box and is non-removable, so for almost every user this is
    // the path that resolves. Order: Google Chrome first (most "vanilla"
    // fingerprint), then Edge, Brave.
    const home = os.homedir();
    const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
    const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    const systemChromePaths = [
      path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ];
    for (const p of systemChromePaths) {
      if (fs.existsSync(p)) return p;
    }

    // No system Chromium found. Fall back to Playwright's own bundled Chromium
    // if it has been installed (e.g. via `npx playwright install chromium`).
    // Playwright has no per-app on-demand Chrome download equivalent to
    // @puppeteer/browsers' install(); its browser-lookup API is
    // chromium.executablePath(), which resolves to the path Playwright would use
    // for a bundled Chromium. We only return it when it actually exists on disk,
    // so callers still fall back to "Paste Cookie" when nothing is available.
    const playwright = (() => { try { return require('playwright-core'); } catch { return null; } })();
    if (!playwright) return null;
    try {
      const pwPath = playwright.chromium.executablePath();
      if (pwPath && fs.existsSync(pwPath)) return pwPath;
    } catch (_) {}
    return null;
  } catch (e) {
    console.error('ensureChrome error:', e.message);
    return null;
  }
}

ipcMain.handle('roblox:openLogin', async () => {
  const hasPlaywright = (() => { try { require('playwright-core'); return true; } catch { return false; } })();
  if (!hasPlaywright) {
    return { success: false, error: 'Browser login is not available in this build. Use "Paste Cookie" instead.' };
  }
  const chromePath = await ensureChrome();
  if (!chromePath) {
    return { success: false, error: 'Failed to download Chrome. Check your internet connection and try again.' };
  }
  return puppeteerLogin(chromePath);
});

async function puppeteerLogin(chromePath) {
  return new Promise(async (resolve) => {
    let browser = null;
    let resolved = false;
    const cleanup = async () => { if (browser) { try { await browser.close(); } catch (_) {} browser = null; } };

    try {
      const playwright = (() => { try { return require('playwright-core'); } catch { return null; } })();
      if (!playwright) { resolve({ success: false, error: 'playwright-core not available in this build.' }); return; }
      const { chromium } = playwright;
      browser = await chromium.launch({
        executablePath: chromePath,
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=530,700'],
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
      });

      // Playwright's chromium.launch() opens the browser without a page (pages
      // live under a BrowserContext, not the Browser). Create one context and a
      // page in it, and register the stealth init script on the context so it
      // also covers any popup pages the verification flow spawns (Playwright's
      // equivalent of Puppeteer's page.evaluateOnNewDocument).
      const context = await browser.newContext({ viewport: null });
      await context.addInitScript(`
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        Object.defineProperty(navigator,'plugins',{get:()=>[{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'}]});
      `);
      const page = await context.newPage();

      await page.goto('https://www.roblox.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // The login flow navigates the tab, spawns popups, and replaces the page
      // during verification steps -- so a CDP session bound to one fixed page
      // goes invalid and every later check throws. Instead, re-resolve a live
      // page each tick (preferring whichever tab is actually on roblox.com) and
      // make a fresh CDP session each time. Playwright exposes pages per
      // BrowserContext (there is no browser.pages()), so walk browser.contexts()
      // and flatten their pages. Errors are logged, not swallowed.
      const resolveActivePage = async () => {
        let pages = [];
        try {
          for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) pages.push(p);
          }
        } catch (e) { console.error('login: enumerating pages failed:', e.message); return null; }
        pages = pages.filter(p => { try { return !p.isClosed(); } catch { return false; } });
        if (pages.length === 0) return null;
        const onRoblox = pages.find(p => { try { return (p.url() || '').includes('roblox.com'); } catch { return false; } });
        return onRoblox || pages[pages.length - 1];
      };

      const tryGetCookie = async () => {
        const target = await resolveActivePage();
        if (!target) return null;
        let client = null;
        try {
          client = await target.context().newCDPSession(target);
          const { cookies } = await client.send('Network.getAllCookies');
          return cookies.find(ck => ck.name === '.ROBLOSECURITY' && ck.domain.includes('roblox.com') && ck.value && ck.value.length > 100) || null;
        } finally {
          if (client) { try { await client.detach(); } catch (_) {} }
        }
      };

      const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // hard cap -- never hang forever
      const startedAt = Date.now();
      let loginTimer = null;

      const finishOk = async (rbxCookie) => {
        resolved = true;
        clearInterval(poll);
        if (loginTimer) clearTimeout(loginTimer);
        await cleanup();
        const info = await fetchUserInfo(rbxCookie.value);
        if (!info.ok) { resolve({ success: false, error: info.reason || 'Could not verify account.' }); return; }
        resolve({ success: true, cookie: rbxCookie.value, username: info.username, userId: info.userId });
      };

      const poll = setInterval(async () => {
        if (resolved) return;
        try {
          const rbxCookie = await tryGetCookie();
          if (rbxCookie) { await finishOk(rbxCookie); return; }
        } catch (e) {
          // Recreated next tick on a freshly resolved page -- just surface why.
          console.error('login poll error (will retry):', e.message);
        }
      }, 1500);

      loginTimer = setTimeout(async () => {
        if (resolved) return;
        resolved = true;
        clearInterval(poll);
        await cleanup();
        console.error('login: timed out after', Math.round((Date.now() - startedAt) / 1000), 's');
        resolve({ success: false, error: 'Timed out waiting for login. Please try again, or use "Paste Cookie".' });
      }, LOGIN_TIMEOUT_MS);

      browser.on('disconnected', () => { clearInterval(poll); if (loginTimer) clearTimeout(loginTimer); if (!resolved) { resolved = true; resolve({ success: false, error: 'Login window closed' }); } });
      ipcMain.once('login:cancel', async () => { clearInterval(poll); if (loginTimer) clearTimeout(loginTimer); if (!resolved) { resolved = true; await cleanup(); resolve({ success: false, error: 'Login window closed' }); } });
    } catch (e) {
      console.error('puppeteerLogin error:', e.message);
      await cleanup();
      if (!resolved) resolve({ success: false, error: 'Failed to launch Chrome: ' + e.message });
    }
  });
}

// ── Account_Browser_Launcher: CDP cookie injection (Req 1.3, 1.4) ───────────
// Mirror image of puppeteerLogin's CDP flow: instead of launching Chrome and
// *reading* the .ROBLOSECURITY cookie, we connect to an already-running
// Browser_Instance that Donut Browser launched (via its CDP port from the
// /run response) and *write* the account's .ROBLOSECURITY cookie onto the
// Roblox website domain, then navigate that instance to the Roblox home page.
//
// The cookie MUST be injected before navigating so the very first request to
// www.roblox.com is already authenticated -- so Network.setCookie is awaited
// strictly before page.goto. Resolve-never-reject, like the donut* helpers:
// callers branch on { ok, browser, error } rather than catching. On success we
// hand back the connected Playwright Browser (and the tracked page) so the
// session tracker (Req 4) can hold it and focus/disconnect later; we do NOT
// close it -- closing would tear down the user's Browser_Instance. On failure
// we only detach the CDP session; browser.close() is never called here (Req 4).
// The cookie value is never logged (Req 6.1).
async function injectCookieAndNavigate(cdpPort, cookie) {
  const playwright = (() => { try { return require('playwright-core'); } catch { return null; } })();
  if (!playwright) return { ok: false, error: 'playwright-core not available in this build.' };
  if (!cdpPort) return { ok: false, error: 'No CDP port for the Browser_Instance.' };
  if (!cookie) return { ok: false, error: 'No cookie to inject.' };

  const { chromium } = playwright;
  let browser = null;
  let client = null;
  try {
    browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${cdpPort}` });

    // Reuse the context/tab Donut Browser already opened rather than spawning a
    // second one. Over a CDP connection Playwright surfaces the browser's
    // existing contexts via browser.contexts(); the default context is [0].
    const context = browser.contexts()[0] || await browser.newContext();
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Inject the .ROBLOSECURITY cookie onto the Roblox website domain FIRST.
    // Scoped to `.roblox.com` so it applies across roblox.com subdomains, and
    // marked Secure/HttpOnly to match how Roblox itself sets the real cookie.
    client = await context.newCDPSession(page);
    await client.send('Network.setCookie', {
      name: '.ROBLOSECURITY',
      value: cookie,
      domain: '.roblox.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });

    // Only after the cookie is set do we navigate, so the home-page request is
    // authenticated from the first byte (Req 1.4).
    await page.goto('https://www.roblox.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

    return { ok: true, browser, page };
  } catch (e) {
    // The cookie value must never reach any log sink, so scrub it (and the stored
    // Donut_API_Token) out of the error text before it is written (Req 6.1, 6.4).
    const safeErr = redactSecrets(e.message, launcherSecrets(cookie));
    console.error('injectCookieAndNavigate error:', safeErr);
    // On failure we deliberately do NOT call browser.close(): over a CDP
    // connection that would tear down the user's Browser_Instance. Playwright
    // exposes no separate disconnect(), so we simply detach the CDP session
    // (below, in finally) and leave the user's browser untouched.
    return { ok: false, error: 'Could not inject cookie into the browser: ' + safeErr };
  } finally {
    if (client) { try { await client.detach(); } catch (_) {} }
  }
}

// ── Account_Browser_Launcher: in-memory session tracking (Req 4.2, 4.3, 4.4) ─
// A single app-run map of the Browser_Instances we currently have opening or
// open, keyed by account id and parallel to _accountPids for the game client.
// It is intentionally NOT persisted: it describes only the current process's
// live Playwright CDP connections, and a stale entry surviving an app restart
// (while Donut Browser's own state changed underneath us) would be worse than
// starting clean. Each entry is:
//   { state: 'opening'|'open', profileId, cdpPort, browser, page }
// - 'opening' is set the instant openAccountBrowser commits to a /run, before a
//   Playwright Browser exists, so a rapid second selection is deduped (Req 4.4).
// - 'open' is set once the cookie is injected and the page is up, carrying the
//   connected Playwright `browser` and the tracked `page` (Req 4.2).
// An account with no entry is treated as never-opened, so a selection after the
// instance closed starts a fresh /run (Req 4.3, design Property 11).
const _browserSessions = new Map(); // accountId -> { state, profileId, cdpPort, browser, page }

// Gather every open Page across a connected Playwright Browser's contexts.
// Playwright exposes pages per BrowserContext (there is no browser.pages()), so
// over a CDP connection we walk browser.contexts() and flatten their pages.
function collectBrowserPages(browser) {
  const pages = [];
  try {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) pages.push(p);
    }
  } catch (_) {}
  return pages;
}

// Restore/activate the Browser_Instance already tracked for an account instead
// of launching a second one (Req 4.2). Called by openAccountBrowser whenever a
// selection lands while the account's tracked state is 'opening' or 'open'.
//
// While still 'opening' there is no connected Playwright Browser yet, so there
// is nothing to bring to front; returning ok:true with focused:false still
// satisfies the dedupe contract (no second /run is sent). Once 'open', we bring
// the tracked page to the foreground via Playwright's page.bringToFront(), which
// activates the tab and raises/un-minimizes the owning window. Best-effort and
// resolve-never-reject, like the other launcher helpers: a focus failure is
// reported, never thrown, and never causes a duplicate launch.
//
// Resolves to { ok, focused, error: null|'no_session'|'not_active'|string }.
async function focusExistingSession(accountId) {
  const session = _browserSessions.get(accountId);
  if (!session) return { ok: false, focused: false, error: 'no_session' };
  if (session.state !== 'opening' && session.state !== 'open') {
    return { ok: false, focused: false, error: 'not_active' };
  }

  const browser = session.browser;
  // 'opening' (or an entry not yet holding a connected Browser): dedupe only.
  if (!browser) return { ok: true, focused: false, error: null };

  try {
    // Prefer the exact page we tracked at open time; fall back to the first tab.
    let page = session.page || null;
    if (page) {
      try { if (page.isClosed()) page = null; } catch (_) { page = null; }
    }
    if (!page) {
      const pages = collectBrowserPages(browser);
      if (pages.length === 0) return { ok: true, focused: false, error: null };
      page = pages[0];
    }

    // bringToFront activates the tab and raises/un-minimizes the browser window.
    await page.bringToFront();
    return { ok: true, focused: true, error: null };
  } catch (e) {
    return { ok: false, focused: false, error: e.message };
  }
}

// Drop an account's tracked session when its Browser_Instance goes away (Req
// 4.3). Wired as the 'disconnected' handler on the Playwright Browser by
// openAccountBrowser: when the user closes the window (or the process dies),
// Playwright fires 'disconnected' and we remove the entry so the next selection
// is treated as a first-time open and issues a fresh /run rather than trying to
// focus a dead instance (design Property 11). Removing the entry IS the
// transition to the 'closed'/removed state, since the map only holds
// opening/open sessions. Returns true if a session was cleared, false if none
// was tracked.
function clearSessionOnDisconnect(accountId) {
  return _browserSessions.delete(accountId);
}

// ── Account_Browser_Launcher: orchestration entry point (Req 1, 3, 4, 7, 9.6) ─
// A human-facing label for an account used only in error text shown to the user
// (never a log sink, so no redaction concern here). Prefers the nickname, then
// the username, then the userId, then the internal id, so the message always
// names *some* account even for a barely-populated record.
function accountLabel(account) {
  return (account && (account.nickname || account.username || account.userId || account.id)) || 'this account';
}

// Maps a checkDonutAvailability() error code to the distinct user-facing message
// each failure mode requires (Req 3.2/3.3/3.4, 9.6). Kept beside openAccountBrowser
// so every preflight branch surfaces its own wording (design Property 8).
function availabilityError(code) {
  switch (code) {
    case 'no_token':          return 'No Donut Browser API token is configured. Add one in Settings to open account browsers.';
    case 'unreachable':       return 'Donut Browser is not running or not reachable. Start Donut Browser and enable its Local API.';
    case 'unauthorized':      return 'The configured Donut Browser API token is invalid. Update it in Settings.';
    case 'payment_required':  return 'An active Donut Browser Pro subscription is required for this action.';
    default:                  return 'Donut Browser is not available.';
  }
}

// Top-level "Open in Browser" flow bound to ipcMain.handle('browser:open', ...).
// Every check is re-evaluated on each invocation -- nothing is cached across
// calls -- and the checks run in a fixed order so a failure short-circuits before
// any later, more expensive step (design Property 7):
//   1. Windows-only platform gate (Req 7.1 / Property 19).
//   2. Account-has-cookie gate (Req 1.5 / Property 3): no Donut call without one.
//   3. Session dedupe (Req 4.2/4.4 / Property 11): an opening/open account is
//      focused instead of launching a second Browser_Instance.
//   4. Preflight: reachability + auth (Req 3.1/3.9/9.6) then wayfern engine
//      (Req 3.5-3.7). Both re-checked every invocation.
//   5. Resolve/create the Donut_Profile (Req 1.1/1.2/2.x).
//   6. Mark the session 'opening' (so a racing second selection is deduped),
//      /run (Req 1.1), inject the cookie then navigate (Req 1.3/1.4), and only on
//      full success mark the session 'open' and wire disconnect cleanup.
// On any stage failure the entry point logs via logBrowser (which redacts the
// cookie / Donut_API_Token, Req 6) and leaves NO session recorded as open, so a
// subsequent selection starts cleanly. Resolves to { ok, error?, focused? } for
// the renderer to display (Req 1.6).
async function openAccountBrowser(accountId) {
  // 1. Windows-only, matching the rest of the app (Req 7.1 / Property 19). This
  //    short-circuits before any reachability check, profile call, or injection.
  if (process.platform !== 'win32') {
    const error = 'Open in Browser is available on Windows only.';
    logBrowser('warn', error, { accountId });
    return { ok: false, error };
  }

  const account = loadAccounts().find(a => a.id === accountId);
  if (!account) {
    logBrowser('error', 'Open in Browser: account not found.', { accountId });
    return { ok: false, error: 'Account not found.' };
  }

  // 2. Missing cookie -> error identifying the account, no Donut calls at all
  //    (Req 1.5 / Property 3). `account.cookie` is already decrypted by loadAccounts.
  if (!account.cookie) {
    logBrowser('error', 'Open in Browser: no ROBLOSECURITY cookie stored for this account.', null, account);
    return { ok: false, error: `No cookie is stored for ${accountLabel(account)}.` };
  }

  // 3. Dedupe: if a Browser_Instance for this account is already opening or open,
  //    focus it instead of sending a second /run (Req 4.2/4.4 / Property 11).
  const tracked = _browserSessions.get(accountId);
  if (tracked && (tracked.state === 'opening' || tracked.state === 'open')) {
    const focus = await focusExistingSession(accountId);
    return { ok: true, focused: !!focus.focused };
  }

  // 4a. Reachability + token/auth preflight, re-run every invocation (Req 3.1/3.9,
  //     9.6 / Property 7). No profile/run/inject call happens unless this passes.
  const avail = await checkDonutAvailability();
  if (!avail.ok) {
    logBrowser('error', `Open in Browser preflight failed: ${avail.error}.`, null, account);
    return { ok: false, error: availabilityError(avail.error) };
  }

  // Donut Browser is confirmed reachable, so this is a natural moment to retry any
  // Donut_Profile deletions that were queued while it was unreachable (Req 8.5).
  // Guarded because that retry queue is wired by a later task; this is a no-op
  // until then and never blocks the open flow.
  if (typeof retryPendingDeletions === 'function') {
    try { Promise.resolve(retryPendingDeletions()).catch(() => {}); } catch (_) {}
  }

  // 4b. Ensure the wayfern engine is present, re-checked every invocation
  //     (Req 3.5-3.7 / Property 10). Abort (open nothing) if it can't be prepared.
  const engine = await ensureWayfernEngine();
  if (!engine.ok) {
    logBrowser('error', `Open in Browser: wayfern engine unavailable (${engine.error}).`, null, account);
    return { ok: false, error: 'The Donut Browser "wayfern" engine could not be downloaded or confirmed.' };
  }

  // 5. Resolve the account's Donut_Profile, creating and persisting a mapping only
  //    when it is unmapped (Req 1.1/1.2/2.4/2.5). A failed /run afterwards leaves
  //    that freshly-persisted mapping in place (Req 2.6).
  const resolved = await resolveOrCreateProfile(account);
  if (!resolved.ok) {
    logBrowser('error', `Open in Browser: could not resolve or create a Donut profile (${resolved.error}).`, null, account);
    return { ok: false, error: 'Could not create a Donut Browser profile for this account.' };
  }

  // 6. Mark 'opening' BEFORE issuing /run so a second selection arriving mid-open
  //    is deduped rather than launching a duplicate instance (Req 4.4). Any failure
  //    below removes this entry so nothing is left recorded as open (Req 1.6).
  _browserSessions.set(accountId, {
    state: 'opening', profileId: resolved.profileId, cdpPort: null, browser: null, targetId: null,
  });

  const run = await runDonutProfile(resolved.profileId);
  if (!run.ok) {
    _browserSessions.delete(accountId);
    logBrowser('error', `Open in Browser: /run failed (${run.error}).`, { profileId: resolved.profileId }, account);
    return { ok: false, error: 'Could not launch the browser instance through Donut Browser.' };
  }

  // Inject the cookie via CDP, then navigate (Req 1.3/1.4). The cookie value is
  // passed to logBrowser only as a redaction secret, never as message/metadata.
  const injected = await injectCookieAndNavigate(run.cdpPort, account.cookie);
  if (!injected.ok) {
    _browserSessions.delete(accountId);
    logBrowser('error', 'Open in Browser: cookie injection failed.', { profileId: resolved.profileId }, account, account.cookie);
    return { ok: false, error: injected.error || 'Could not inject the cookie into the browser.' };
  }

  // Success. Wire Playwright's 'disconnected' event so closing the window clears
  // the tracked session and a later selection opens a fresh instance (Req 4.3).
  const browser = injected.browser;
  try { browser.once('disconnected', () => clearSessionOnDisconnect(accountId)); } catch (_) {}

  // Record the exact page so a repeat selection focuses it (Req 4.2); best-effort,
  // a missing page just falls back to the first tab in focusExistingSession.
  let page = injected.page || null;
  if (!page) {
    const pages = collectBrowserPages(browser);
    if (pages[0]) page = pages[0];
  }

  // Transition to 'open' only after a fully successful open (Req 4.2).
  _browserSessions.set(accountId, {
    state: 'open', profileId: resolved.profileId, cdpPort: run.cdpPort, browser, page,
  });

  logBrowser('info', 'Opened the Roblox website in an isolated Donut Browser session.', { profileId: resolved.profileId }, account);
  return { ok: true };
}

// Copy an account's ROBLOSECURITY cookie to the system clipboard with read-back
// verification (Req 5.2-5.5). Uses Electron's main-process `clipboard` module:
// write the decrypted cookie, read it back, and confirm success ONLY when the
// read-back exactly equals what was written. The account's stored cookie is
// never modified by this flow. The cookie value is passed to logBrowser purely
// as a redaction secret (Req 6) -- it is never placed into message or metadata.
async function copyAccountCookie(accountId) {
  const account = loadAccounts().find(a => a.id === accountId) || null;
  if (!account) {
    logBrowser('error', 'Copy Cookie: account not found.', { accountId });
    return { ok: false, error: 'Account not found.' };
  }

  // No cookie stored: error and DO NOT touch the clipboard (Req 5.4 / Property 15).
  const cookie = account.cookie;
  if (!cookie) {
    logBrowser('error', 'Copy Cookie: no ROBLOSECURITY cookie stored for this account.', null, account);
    return { ok: false, error: `No cookie is stored for ${accountLabel(account)}.` };
  }

  // Write, then read back and require an exact match (Req 5.2/5.3/5.5).
  try {
    clipboard.writeText(cookie);
  } catch (e) {
    logBrowser('error', 'Copy Cookie: failed to write the cookie to the clipboard.', { error: e && e.message }, account, cookie);
    return { ok: false, error: 'Could not write the cookie to the clipboard.' };
  }

  let readBack;
  try {
    readBack = clipboard.readText();
  } catch (e) {
    logBrowser('error', 'Copy Cookie: failed to read the clipboard back.', { error: e && e.message }, account, cookie);
    return { ok: false, error: 'Could not verify the cookie on the clipboard.' };
  }

  if (readBack !== cookie) {
    logBrowser('error', 'Copy Cookie: clipboard read-back did not match the copied cookie.', null, account, cookie);
    return { ok: false, error: 'The cookie could not be verified on the clipboard.' };
  }

  logBrowser('info', 'Copied the account cookie to the clipboard.', null, account, cookie);
  return { ok: true };
}

// Bind the Account_Browser_Launcher IPC surface (Req 1, 5). Both resolve to
// { ok, error? } for the renderer to display.
ipcMain.handle('browser:open', (_, accountId) => openAccountBrowser(accountId));
ipcMain.handle('browser:copyCookie', (_, accountId) => copyAccountCookie(accountId));


const genHistoryPath = path.join(app.getPath('userData'), 'genhistory.json');

ipcMain.handle('genhistory:read', () => {
  try {
    if (!fs.existsSync(genHistoryPath)) return [];
    return JSON.parse(fs.readFileSync(genHistoryPath, 'utf8'));
  } catch { return []; }
});

ipcMain.handle('genhistory:write', (_, list) => {
  try {
    const capped = Array.isArray(list) ? list.slice(0, 500) : [];
    fs.writeFileSync(genHistoryPath, JSON.stringify(capped, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
});

ipcMain.handle('genhistory:clear', () => {
  try {
    fs.writeFileSync(genHistoryPath, '[]', { mode: 0o600 });
    return true;
  } catch { return false; }
});

// Roblox version folders are named "version-<hash>". The hash has no
// chronological meaning, so alphabetically sorting folder names (the old
// approach) does NOT reliably find the most recently installed version --
// it can pick a stale leftover folder from a previous update. Instead we
// pick whichever RobloxPlayerBeta.exe was most recently written to disk,
// which is what Roblox's own updater touches when it installs a new build.
function getLatestRobloxVersionDir() {
  try {
    const versionsBase = path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');
    if (!fs.existsSync(versionsBase)) return null;
    const candidates = fs.readdirSync(versionsBase)
      .filter(d => d.startsWith('version-'))
      .map(d => {
        const exe = path.join(versionsBase, d, 'RobloxPlayerBeta.exe');
        if (!fs.existsSync(exe)) return null;
        try {
          return { dir: path.join(versionsBase, d), exe, mtime: fs.statSync(exe).mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0] : null;
  } catch { return null; }
}

function getFFlagPath() {
  const latest = getLatestRobloxVersionDir();
  if (!latest) return null;
  return path.join(latest.dir, 'ClientSettings', 'ClientAppSettings.json');
}

ipcMain.handle('fflag:read', () => {
  try {
    const p = getFFlagPath();
    if (!p || !fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
});

ipcMain.handle('fflag:write', (_, flags) => {
  try {
    const p = getFFlagPath();
    if (!p) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(flags, null, 2), 'utf8');
    return true;
  } catch { return false; }
});

// -- GlobalBasicSettings_13.xml FPS cap (works after the Fast Flag allowlist) --
// The file lives at %LOCALAPPDATA%\Roblox\GlobalBasicSettings_13.xml and
// contains an <int name="FramerateCap"> element inside a UserGameSettings Item.
// 0 means unlimited. Roblox must not be running when you write it (it overwrites
// on exit), so we write it here and it takes effect on the next launch.

function getGlobalSettingsPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'GlobalBasicSettings_13.xml');
}

ipcMain.handle('fps:read', () => {
  try {
    const p = getGlobalSettingsPath();
    if (!fs.existsSync(p)) return 60;
    const xml = fs.readFileSync(p, 'utf8');
    // Match <int name="FramerateCap">VALUE</int>
    const m = xml.match(/<int\s+name="FramerateCap"\s*>(\d+)<\/int>/i);
    return m ? parseInt(m[1], 10) : 60;
  } catch { return 60; }
});

ipcMain.handle('fps:write', (_, cap) => {
  try {
    const p = getGlobalSettingsPath();
    if (!fs.existsSync(p)) return { ok: false, error: 'GlobalBasicSettings_13.xml not found - launch Roblox once to create it.' };
    let xml = fs.readFileSync(p, 'utf8');
    const value = Math.max(0, Math.round(Number(cap) || 0));
    if (/<int\s+name="FramerateCap"\s*>\d+<\/int>/i.test(xml)) {
      // Update existing element
      xml = xml.replace(/<int\s+name="FramerateCap"\s*>\d+<\/int>/i, `<int name="FramerateCap">${value}</int>`);
    } else {
      // Insert before closing </Item> of the first Item block (UserGameSettings)
      xml = xml.replace(/(<\/Item>)/, `\t\t<int name="FramerateCap">${value}</int>\n$1`);
    }
    fs.writeFileSync(p, xml, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

async function resolveShareLink(shareCode, cookie, csrfToken) {
  // Port of evanovar/RobloxAccountManager resolve_share_url:
  // POST to sharelinks/v1/resolve-link with {linkId, linkType}
  // On 403, grab fresh CSRF from response header and retry

  const makeRequest = (csrf) => new Promise((resolve) => {
    // Try first payload shape, fall back to the second if needed.
    const tryPayload = (payloadStr, csrfHeader, cb) => {
      const req = https.request({
        hostname: 'apis.roblox.com',
        path: '/sharelinks/v1/resolve-link',
        method: 'POST',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'X-CSRF-TOKEN': csrfHeader || '',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          cb(res.statusCode, res.headers, body);
        });
      });
      req.on('error', e => cb(0, {}, ''));
      req.setTimeout(8000, () => { req.destroy(); cb(0, {}, ''); });
      req.write(payloadStr);
      req.end();
    };

    const payloads = [
      JSON.stringify({ linkId: shareCode, linkType: 'Server' }),
      JSON.stringify({ code: shareCode, type: 'Server' }),
    ];

    const tryNext = (i, currentCsrf) => {
      if (i >= payloads.length) return resolve({ ok: false });
      tryPayload(payloads[i], currentCsrf, (status, headers, body) => {
        if (status === 200) {
          const pidM = body.match(/"placeId"\s*:\s*(\d+)/);
          const lcM = body.match(/"(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)"/);
          if (pidM && lcM) {
            return resolve({ ok: true, placeId: pidM[1], linkCode: lcM[1] });
          }
        }
        if (status === 403 && headers['x-csrf-token']) {
          // Retry same payload with fresh CSRF from response
          tryPayload(payloads[i], headers['x-csrf-token'], (status2, headers2, body2) => {
            if (status2 === 200) {
              const pidM = body2.match(/"placeId"\s*:\s*(\d+)/);
              const lcM = body2.match(/"(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)"/);
              if (pidM && lcM) {
                return resolve({ ok: true, placeId: pidM[1], linkCode: lcM[1] });
              }
            }
            tryNext(i + 1, currentCsrf);
          });
        } else {
          tryNext(i + 1, currentCsrf);
        }
      });
    };

    tryNext(0, csrfToken || '');
  });

  const result = await makeRequest(csrfToken);
  if (!result.ok) {
    return { ok: false, error: 'Could not resolve share link. It may be expired or invalid.' };
  }

  return { ok: true, placeId: result.placeId, linkCode: result.linkCode };
}

async function followRedirect(url) {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url, redirect: 'manual', useSessionCookies: false });
    req.on('response', res => {
      const loc = res.headers['location'];
      resolve(loc || url);
    });
    req.on('error', () => resolve(url));
    req.end();
  });
}

// Resolves the accessCode for a private server linkCode using the sharelinks API.
// This is the correct method -- linkCode != accessCode, they are different tokens.
async function getAccessCode(placeId, linkCode, cookie, csrfToken) {
  // Primary: sharelinks resolve API
  try {
    const bodyStr = JSON.stringify({ shareCode: linkCode, shareType: 'Server' });
    const req = net.request({
      method: 'POST',
      url: 'https://apis.roblox.com/sharelinks/v1/resolve',
      useSessionCookies: false,
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'X-CSRF-TOKEN': csrfToken || '',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'application/json',
        'Origin': 'https://www.roblox.com',
        'Referer': 'https://www.roblox.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const result = await new Promise((resolve) => {
      let body = '';
      req.on('response', res => {
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(body);
            const inv = d?.privateServerInviteData
              || d?.resolvedShareData?.privateServerInviteData
              || d?.experienceInviteData?.privateServerInviteData;
            if (inv && inv.accessCode) resolve(inv.accessCode);
            else resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(bodyStr);
      req.end();
    });
    if (result) return result;
  } catch {}

  // Fallback: redirect scrape
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.roblox.com',
      path: `/games/${placeId}?privateServerLinkCode=${linkCode}`,
      method: 'GET',
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'Referer': 'https://www.roblox.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, res => {
      const loc = res.headers['location'] || '';
      const match = loc.match(/[?&]accessCode=([^&]+)/);
      resolve(match ? match[1] : null);
      res.resume();
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}


ipcMain.handle('roblox:getGameName', async (_, placeIdOrTarget, cookie) => {
  try {
    // If given a full URL/link, extract placeId first
    let placeId = placeIdOrTarget;
    if (!/^\d+$/.test(String(placeIdOrTarget).trim())) {
      // Try to extract placeId from URL
      try {
        const u = new URL(placeIdOrTarget.startsWith('http') ? placeIdOrTarget : 'https://' + placeIdOrTarget);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) {
          placeId = parts[1];
        } else {
          const m = placeIdOrTarget.match(/[?&]placeId=(\d+)/);
          if (m) placeId = m[1];
        }
      } catch {}
      if (!/^\d+$/.test(String(placeId).trim())) return null;
    }
    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'games.roblox.com',
        path: '/v1/games/multiget-place-details?placeIds=' + placeId,
        method: 'GET',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(body);
            const name = Array.isArray(d) ? d[0]?.name : null;
            resolve(name || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (result) return result;

    // Fallback: some places return nothing from multiget-place-details. Resolve
    // placeId -> universeId, then read the universe's name. Catches many IDs the
    // first call misses.
    const getJson = (hostname, urlPath) => new Promise((resolve) => {
      const req = https.request({
        hostname, path: urlPath, method: 'GET',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    try {
      const uni = await getJson('apis.roblox.com', '/universes/v1/places/' + placeId + '/universe');
      const universeId = uni && uni.universeId;
      if (universeId) {
        const games = await getJson('games.roblox.com', '/v1/games?universeIds=' + universeId);
        const name = games && Array.isArray(games.data) ? (games.data[0] && games.data[0].name) : null;
        if (name) return name;
      }
    } catch {}
    return null;
  } catch { return null; }
});

ipcMain.handle('roblox:launch', async (_, accountId, cookie, target) => {
  const result = await (_launchQueue = _launchQueue.then(() => _doLaunch(accountId, cookie, target)));
  return result;
});

const _watchedAccounts = new Map(); // accountId -> readyAt (epoch ms; not evaluated until then)
const _missCounts = new Map();      // consecutive "not found" counts per account
const MISS_THRESHOLD = 4;      // require 4 consecutive misses (~20s) before declaring closed
const POLL_INTERVAL  = 5000;   // poll every 5s
const LAUNCH_DELAY   = 15000;  // grace after launch before first evaluation (launcher->game gap)
let _watchTimer = null;

// One shared poll covering every watched account. Previously each account ran
// its own tasklist on its own timer, so N launched instances meant N tasklist
// spawns every POLL_INTERVAL. This runs a single tasklist per tick and applies
// the same per-account grace + miss/threshold logic, so behaviour is identical
// while process spawns drop from O(N) to O(1).
function _startWatchPoll() {
  if (_watchTimer) return;
  _watchTimer = setInterval(_watchTick, POLL_INTERVAL);
}
function _stopWatchPollIfIdle() {
  if (_watchedAccounts.size === 0 && _watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
}

function _watchRoblox(accountId) {
  // (Re)arm watching with a fresh post-launch grace period.
  _watchedAccounts.set(accountId, Date.now() + LAUNCH_DELAY);
  _missCounts.set(accountId, 0);
  _startWatchPoll();
}

function _watchTick() {
  if (_watchedAccounts.size === 0) { _stopWatchPollIfIdle(); return; }
  const isWin = process.platform === 'win32';
  // Windows: enumerate live RobloxPlayerBeta PIDs (CSV) so each watched account
  // can be evaluated against ITS OWN process. A single global "any roblox
  // running" flag (the old approach) meant closing one of several instances was
  // never noticed until the last one exited.
  const cmd = isWin
    ? 'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /FO CSV /NH'
    : 'pgrep -x RobloxPlayer';
  const proc = spawn(isWin ? 'cmd' : 'sh',
    isWin ? ['/c', cmd] : ['-c', cmd],
    { windowsHide: true });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.on('error', () => {}); // failed enumeration this tick -> skip, retry next tick
  proc.on('close', () => {
    // Set of currently-alive Roblox PIDs (Windows). On other platforms we only
    // have a coarse "something is running" signal.
    const alivePids = new Set();
    let anyRunning = false;
    if (isWin) {
      for (const m of out.matchAll(/"RobloxPlayerBeta\.exe","(\d+)"/gi)) alivePids.add(Number(m[1]));
      anyRunning = alivePids.size > 0;
    } else {
      anyRunning = out.trim().length > 0;
    }
    const now = Date.now();
    const closed = [];
    // PIDs currently claimed by watched accounts.
    const claimed = new Set();
    for (const id of _watchedAccounts.keys()) { const p = _accountPids.get(id); if (p) claimed.add(p); }
    // An "orphan" is a live RobloxPlayerBeta with no watched account claiming it.
    // These show up when Roblox hands a launch off from the process we spawned to
    // a new one (launcher -> game client). Adopting the orphan instead of counting
    // a miss is what stops a still-running instance being reported as closed.
    const orphans = isWin ? [...alivePids].filter(p => !claimed.has(p)) : [];
    for (const [accountId, readyAt] of _watchedAccounts) {
      if (now < readyAt) continue; // still in post-launch grace window
      const pid = _accountPids.get(accountId);
      // Per-account liveness: prefer the tracked PID; fall back to the coarse
      // signal only for accounts launched without one (openExternal path).
      let running = (isWin && pid) ? alivePids.has(pid) : anyRunning;
      if (isWin && pid && !running && orphans.length) {
        const adopted = orphans.shift();   // our process exited but Roblox is still up under a new PID
        _accountPids.set(accountId, adopted);
        running = true;
      }
      if (!running) {
        const misses = (_missCounts.get(accountId) || 0) + 1;
        _missCounts.set(accountId, misses);
        if (misses >= MISS_THRESHOLD) closed.push(accountId);
      } else {
        _missCounts.set(accountId, 0); // reset on any successful detection
      }
    }
    for (const accountId of closed) {
      _watchedAccounts.delete(accountId);
      _missCounts.delete(accountId);
      const closedAccts = loadAccounts();
      const closedAcct = closedAccts.find(a => a.id === accountId) || {};
      sendLog('warn', 'crash', `Roblox closed unexpectedly for ${closedAcct.username || accountId} (missed ${MISS_THRESHOLD} consecutive checks)`, {
        accountId, username: closedAcct.username || null, userId: closedAcct.userId || null, pid: _accountPids.get(accountId) || null
      });
      _accountPids.delete(accountId);
      if (win && !win.isDestroyed()) win.webContents.send('roblox:closed', accountId);
    }
    // already listed every Roblox PID above, so hand the count to the renderer
    // here -- saves it running its own tasklist poll while we're watching.
    if (isWin && win && !win.isDestroyed()) win.webContents.send('roblox:count', alivePids.size);
    _stopWatchPollIfIdle();
  });
}

// IMPORTANT: this used to kill+respawn the persistent mutex holder on every
// single launch. That respawn isn't instant (powershell start + Add-Type JIT
// compile), and during that gap nobody owns ROBLOX_singletonMutex -- if a
// real RobloxPlayerBeta process grabs it in that window, our script silently
// "succeeds" (HoldMutex doesn't check the `created` flag) while actually NOT
// owning the mutex. Every launch after that closes the singleton-event handle
// of that real, legitimate first instance, which corrupts its install/update
// pipeline and produces the "Installer encountered a critical error" dialog.
//
// Fix: keep ONE long-lived mutex holder for the whole app session (started in
// app.whenReady / restarted only if it died) and, per launch, just run the
// lightweight `closehandles` native subcommand that closes the singleton-event
// handles on whatever Roblox processes currently exist. It never touches the
// mutex.
function closeSingletonHandlesOnly() {
  return ensureNativeHelper().then((nativeExe) => new Promise((resolve) => {
    try {
      if (!nativeExe) { resolve(); return; }
      const proc = spawn(nativeExe, ['closehandles'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.stdout.on('data', (d) => { if (d.toString().includes('HANDLES_DONE')) finish(); });
      if (proc.stderr) proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[closehandles]', s); });
      proc.on('exit', finish);
      proc.on('error', finish);
      setTimeout(finish, 4000); // safety timeout
    } catch (e) {
      resolve();
    }
  }));
}

async function closeSingletonAndHoldMutex() {
  // Make sure our persistent mutex holder is alive (e.g. it may have died,
  // or multi-instance mode was just toggled on). This NEVER kills a holder
  // that's already running, so the mutex is never released/re-grabbed here.
  if (process.platform === 'win32') await startMutexHolder();
  // Then close any singleton-event handles on currently-running Roblox
  // processes so the new instance won't get redirected into an existing one.
  await closeSingletonHandlesOnly();
}

async function _doLaunch(accountId, cookie, target) {
  try {
    // Close ROBLOX_singletonEvent from any running Roblox process before each launch
    await closeSingletonAndHoldMutex();

    // Enforce stagger between launches to avoid 429
    const sinceLastLaunch = Date.now() - _lastLaunchTs;
    if (_lastLaunchTs > 0 && sinceLastLaunch < LAUNCH_STAGGER) {
      await sleep(LAUNCH_STAGGER - sinceLastLaunch);
    }
    const csrfToken = await getCSRFToken(cookie);
    if (!csrfToken) {
      const fa = (loadAccounts().find(a => a.id === accountId) || {});
      sendLog('err', 'launch', `Launch failed for ${fa.username || accountId}: could not get CSRF token (cookie may be expired)`, { accountId, username: fa.username || null });
      return { success: false, error: 'Failed to get CSRF token. Is the account cookie still valid?' };
    }

    const ticketResult = await getAuthTicket(cookie, csrfToken);
    if (!ticketResult.ok) {
      const fa2 = (loadAccounts().find(a => a.id === accountId) || {});
      sendLog('err', 'launch', `Launch failed for ${fa2.username || accountId}: auth ticket error - ${ticketResult.error}`, { accountId, username: fa2.username || null });
      return { success: false, error: `Failed to get auth ticket: ${ticketResult.error}` };
    }
    const { ticket } = ticketResult;

    const t = (target || '').trim();
    let launcherUrl = '';

    if (t) {
      if (/^\d+$/.test(t)) {
        launcherUrl = `https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=${t}&isPlayTogetherGame=false`;
      } else {
        let rawUrl = t.startsWith('http') ? t : 'https://' + t;

        try {
          const parsed0 = new URL(rawUrl);
          if (parsed0.hostname === 'ro.blox.com' || parsed0.hostname.endsWith('.ro.blox.com')) {
            rawUrl = await followRedirect(rawUrl);
          }
        } catch {}

        let parsedUrl;
        try { parsedUrl = new URL(rawUrl); } catch {}

        if (parsedUrl) {
          const privateCode = parsedUrl.searchParams.get('privateServerLinkCode');
          const shareCode = parsedUrl.searchParams.get('code');
          const shareType = parsedUrl.searchParams.get('type');
          const placeId = parsedUrl.pathname.match(/\/games\/(\d+)/)?.[1]
            || parsedUrl.pathname.match(/\/(\d+)/)?.[1];

          if (privateCode && placeId) {
            const accessCode = await getAccessCode(placeId, privateCode, cookie, csrfToken);
            if (!accessCode) return { success: false, error: 'Could not resolve private server access code. The link may be expired or you may not have permission.' };
            launcherUrl = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId=${placeId}&accessCode=${accessCode}&linkCode=${privateCode}`;

          } else if (parsedUrl.pathname === '/share' || (shareCode && shareType)) {
            const code = shareCode;
            if (!code) return { success: false, error: 'Invalid share link -- no code found.' };
            // Resolve the share link to get placeId + accessCode so we can
            // launch via the auth-ticket launcher (same as every other path).
            // Opening a bare roblox://navigation/share_links URI bypasses the
            // auth ticket and lets Roblox use whatever account is logged in on
            // the system -- which is the wrong account.
            const resolved = await resolveShareLink(code, cookie, csrfToken);
            if (!resolved.ok) return { success: false, error: resolved.error || 'Could not resolve share link. It may be expired or invalid.' };
            launcherUrl = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId=${resolved.placeId}&isPlayTogetherGame=false&linkCode=${resolved.linkCode}`;

          } else if (placeId) {
            launcherUrl = `https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=${placeId}&isPlayTogetherGame=false`;

          } else {
            return { success: false, error: 'Could not find a Place ID in the URL.' };
          }
        } else {
          return { success: false, error: 'Unrecognised input. Enter a place ID, game URL, or private server link.' };
        }
      }
    }

    const launchTime = Date.now();
    const browserId = String(Math.floor(Math.random() * 9e12 + 1e12));
    let robloxUri;
    if (launcherUrl) {
      robloxUri = `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${launchTime}+placelauncherurl:${encodeURIComponent(launcherUrl)}+browsertrackerid:${browserId}+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp`;
    } else {
      robloxUri = `roblox-player:1+launchmode:app+gameinfo:${ticket}+launchtime:${launchTime}+browsertrackerid:${browserId}+robloxLocale:en_us+gameLocale:en_us`;
    }

    // Find RobloxPlayerBeta.exe (most recently installed build, not just alphabetically last folder)
    let robloxExe = null;
    try {
      const latest = getLatestRobloxVersionDir();
      if (latest) robloxExe = latest.exe;
    } catch {}

    if (robloxExe && fs.existsSync(robloxExe)) {
      // Spawn directly -- bypasses the singleton URI handler that kills existing instances
      const child = spawn(robloxExe, [robloxUri], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      if (child && child.pid) _accountPids.set(accountId, child.pid);
      child.unref();
    } else {
      // Fallback to URI if exe not found
      await shell.openExternal(robloxUri);
    }

    _lastLaunchTs = Date.now();
    _ticketCache.delete(cookie);

    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    const acct = accounts[idx] || {};
    if (idx !== -1) { accounts[idx].lastUsed = new Date().toISOString(); saveAccounts(accounts); }

    sendLog('ok', 'launch', `Launched Roblox for ${acct.username || accountId}`, {
      accountId, username: acct.username || null, userId: acct.userId || null,
      target: (target || '').trim() || 'Roblox home', pid: _accountPids.get(accountId) || null
    });

    _watchRoblox(accountId);

    // If the user has set a master volume, apply it to the new instance once its
    // audio session has spun up (a few seconds after the window appears).
    try {
      const s = loadSettings();
      if (typeof s.masterVolume === 'number' && s.masterVolume !== 100) {
        setTimeout(() => { setRobloxVolume(s.masterVolume).catch(() => {}); }, 9000);
      }
    } catch {}

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
