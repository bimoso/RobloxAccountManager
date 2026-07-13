let accounts = [], launchAcc = null, editAcc = null, toastTimer;
let packages = [], editingPackageId = null;
const _launchedIds = new Set();
// Multi-select state for bulk actions.
let _selMode = false;
const _selectedIds = new Set();
// Accounts the launch modal currently targets (1 from a card, or the selection).
let _launchTargets = [];
let _bulkNoteTargets = [];
let _lastUsedTimer = null;
let _activePage = 'accounts';
let _renderAfterDrag = false;
// Presence (online / in-game / in-studio) per userId, refreshed on a poll.
const _presence = {}; // userId -> { type, placeId, universeId, name }

// ── Logs ─────────────────────────────────────────────────────────────────────
// Plain, append-only session log rendered like a tailed .txt file. No in-app
// filters or search box -- use Ctrl+F (native find) over the text instead.
const _logs = [];
const MAX_LOGS = 2000;
const LOG_CATS = { launch:'launch', crash:'crash', kill:'kill', cookie:'cookie', afk:'afk', enc:'enc', system:'system', close:'close', browser:'browser' };

function logEntry(level, category, message, meta) {
  const entry = { ts: Date.now(), level, category, message, meta: meta || {} };
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift(); // keep the most-recent tail
  if (document.getElementById('page-logs')?.classList.contains('active')) renderLogs();
}

function _logLine(e) {
  const t = new Date(e.ts);
  const ts = t.toLocaleTimeString('en-GB', { hour12:false }) + '.' + String(t.getMilliseconds()).padStart(3,'0');
  const cat = String(e.category || '').toUpperCase().padEnd(7);
  const keys = Object.keys(e.meta || {}).filter(k => e.meta[k] !== null && e.meta[k] !== undefined);
  const meta = keys.length ? '  ' + keys.map(k => `${k}=${e.meta[k]}`).join(' ') : '';
  return `<span class="lg-ts">${esc(ts)}</span>  <span class="lg-${esc(e.level)}">${esc(cat)}</span> ${esc(e.message + meta)}`;
}

function renderLogs() {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (!_logs.length) { el.textContent = 'No log entries yet.'; return; }
  // Tail behaviour: only auto-scroll to the newest line if already near the end.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = _logs.map(_logLine).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Native-style find (Ctrl+F) over the rendered log text. Uses window.find so
// selection, scroll-to-match and Ctrl+A/Ctrl+C all behave like a normal viewer.
function openLogFind() {
  const bar = document.getElementById('log-find');
  const inp = document.getElementById('log-find-input');
  if (!bar || !inp) return;
  bar.style.display = 'flex';
  inp.focus(); inp.select();
}
function closeLogFind() {
  const bar = document.getElementById('log-find');
  if (bar) bar.style.display = 'none';
  const sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
  const c = document.getElementById('log-find-count');
  if (c) c.textContent = '';
}
function logFind(backwards) {
  const inp = document.getElementById('log-find-input');
  const c = document.getElementById('log-find-count');
  if (!inp) return;
  const q = inp.value;
  if (!q) { if (c) c.textContent = ''; return; }
  const found = window.find(q, false, !!backwards, true, false, false, false);
  if (c) c.textContent = found ? '' : 'No matches';
}
const _avatarCache = {};
let settings = {};

const ENC_OPTIONS = {
  'aes-256-gcm': { label: 'AES-256-GCM', badge: 'Best', badgeClass: 'green' },
  'aes-256-cbc': { label: 'AES-256-CBC', badge: 'Standard', badgeClass: 'muted' },
};
let selectedEnc = 'aes-256-gcm';

let _encMode = null;
function showEncModal(mode) {
  _encMode = mode;
  const title = document.getElementById('enc-title');
  const desc = document.getElementById('enc-desc');
  const action = document.getElementById('enc-action');
  const skip = document.getElementById('enc-skip');
  const err = document.getElementById('enc-err');
  const inp = document.getElementById('enc-input');
  if (err) err.style.display = 'none';
  if (inp) inp.value = '';
  if (action) action.disabled = false;
  if (mode === 'setup') {
    title.textContent = 'Create an encryption key';
    desc.textContent = 'Set an encryption key to protect your saved accounts. You will be asked for it every time you open the app.';
    action.textContent = 'Set key';
    if (skip) if (skip) skip.style.display = 'none';
  } else {
    title.textContent = 'Enter your encryption key';
    desc.textContent = 'Enter the key you set to unlock your saved accounts.';
    action.textContent = 'Unlock';
    if (skip) skip.style.display = 'none';
  }
  openModal('m-enc');
  setTimeout(() => inp && inp.focus(), 60);
}
function _encErr(m) { const e = document.getElementById('enc-err'); if (e) { e.textContent = m; e.style.display = 'block'; } }
async function submitEnc() {
  const inp = document.getElementById('enc-input');
  const action = document.getElementById('enc-action');
  const val = inp ? inp.value : '';
  if (action) action.disabled = true;
  try {
    if (_encMode === 'setup') {
      if (!val) { _encErr('Please enter an encryption key.'); action.disabled = false; return; }
      const r = await api.encSetKey(val);
      if (!r || !r.ok) { _encErr('Could not set encryption key. Please try again.'); action.disabled = false; return; }
    } else {
      if (!val) { _encErr('Please enter your encryption key.'); action.disabled = false; return; }
      const r = await api.encUnlock(val);
      if (!r || !r.ok) { _encErr('Wrong key. Please try again.'); logEntry('warn', 'enc', 'Failed encryption unlock attempt (wrong key)'); action.disabled = false; inp.value = ''; inp.focus(); return; }
      logEntry('ok', 'enc', 'Encryption key accepted - accounts unlocked');
    }
    closeModal('m-enc');
    await continueInit();
  } catch (e) { _encErr('Something went wrong. Please try again.'); if (action) action.disabled = false; }
}
async function skipEnc() {
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = true;
  try { await api.encSetKey(''); } catch {}
  closeModal('m-enc');
  await continueInit();
}

async function init() {
  // Encryption gate: in passphrase mode the cookies can't be read until the key is
  // entered for this boot session. Show the popup first; only load data once ready.
  try {
    const st = await api.encStatus();
    if (st && st.mode === 'locked') { showEncModal('locked'); return; }
    if (st && st.mode === 'setup') { showEncModal('setup'); return; }
  } catch {}
  await continueInit();
}

async function continueInit() {
  [accounts, settings, packages] = await Promise.all([api.loadAccounts(), api.loadSettings(), api.loadPackages()]);
  logEntry('info', 'system', `Loaded ${accounts.length} account${accounts.length === 1 ? '' : 's'} from storage`);
  recheckAllCookies(true); // kick a full check off the moment cookies are readable, not on the 60s tick
  render();
  // put the toolbar back to the saved view + filter
  document.getElementById('vt-grid').classList.toggle('active', _acctView === 'grid');
  document.getElementById('vt-list').classList.toggle('active', _acctView === 'list');
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === _acctFilter));
  document.getElementById('filter-btn').classList.toggle('on', _acctFilter !== 'all');
  renderPackages();
  applySettings();
  refreshMultiStatus();
  detectRobloxVersion();
  startRunningPoll();
  startPresencePoll();
  startLastUsedTick();
  logEntry('info', 'system', 'RobloxAccountManager started', { version: 'v1', accounts: accounts.length, platform: navigator.platform });
  try { const k = localStorage.getItem('bloxgen_apikey'); if (k) { const el = document.getElementById('gen-apikey'); if (el) el.value = k; } } catch {}
  try { const afkStat = await api.antiAfkStatus(); if (afkStat && afkStat.enabled) logEntry('info', 'afk', `Anti-AFK is enabled on startup (active: ${afkStat.active})`, { enabled: afkStat.enabled, active: afkStat.active }); } catch {}
  try { _genHistory = (await api.readGenHistory()) || []; genRenderHistory(); } catch {}

  // Forward main-process log events into the renderer log
  api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta));

  // main pushes the count off the watch tick; the local poll backs off below
  api.onRobloxCount(n => { _lastCountPushAt = Date.now(); _mixRunning = n; setRunningBadges(n); });

  api.onRobloxClosed(id => {
    _launchedIds.delete(id);
    const closedAcct = accounts.find(a => a.id === id);
    logEntry('info', 'close', `Roblox closed for ${closedAcct ? closedAcct.username : id}`, { accountId: id, username: closedAcct?.username || null, userId: closedAcct?.userId || null });
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) card.classList.remove('is-live');
    const dot = document.querySelector(`.card[data-id="${id}"] .card-dot`);
    if (dot) { dot.classList.remove('launched'); dot.title = 'Not launched'; }
    refreshPkgAvatarStatus();
    pollRunningCount();
  });

  api.onAllRobloxClosed(() => {
    logEntry('warn', 'close', 'All Roblox instances closed');
    _launchedIds.clear();
    document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live'));
    document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
    refreshPkgAvatarStatus();
    pollRunningCount();
    if (document.getElementById('page-mixer')?.classList.contains('active')) mixRefreshRunning();
  });

  // Chrome download progress
  api.onChromeProgress(data => {
    const dlDiv = document.getElementById('login-dl');
    const waitDiv = document.getElementById('login-waiting');
    if (!dlDiv || !waitDiv) return;
    if (data.status === 'downloading') {
      dlDiv.style.display = '';
      waitDiv.style.display = 'none';
      if (data.percent !== undefined) {
        document.getElementById('dl-bar').style.width = data.percent + '%';
        document.getElementById('dl-pct').textContent = data.percent + '%';
      }
    } else if (data.status === 'done') {
      dlDiv.style.display = 'none';
      waitDiv.style.display = '';
    }
  });
}
init();

// ── Theme ──────────────────────────────────────────────────────────────────
var THEMES = ['dark','light','midnight','aurora','sunset','crimson','ocean','grape','forest','amber','rose','graphite'];
function applyTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  document.body.classList.remove('light');
  THEMES.forEach(t => { if (t !== 'dark' && t !== 'light') document.body.classList.remove('theme-' + t); });
  if (name === 'light') document.body.classList.add('light');
  else if (name !== 'dark') document.body.classList.add('theme-' + name);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = (name === 'light') ? 'dark_mode' : 'light_mode';
  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('sel', c.dataset.theme === name));
}
function currentTheme() { try { return localStorage.getItem('ui-theme') || 'dark'; } catch { return 'dark'; } }
function setTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  applyTheme(name);
  try { localStorage.setItem('ui-theme', name); } catch {}
}
// Titlebar button: quick dark <-> light switch (leaves the special themes).
function toggleTheme() {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
}
(function() {
  let t;
  try {
    t = localStorage.getItem('ui-theme');
    if (!t) { const old = localStorage.getItem('theme'); t = (old === 'light') ? 'light' : 'dark'; }
  } catch { t = 'dark'; }
  setTheme(t || 'dark');
})();

// ── BloxGen API key persistence ────────────────────────────────────────────
(function() {
  try {
    const saved = localStorage.getItem('bloxgen_apikey');
    if (saved) {
      const el = document.getElementById('gen-apikey');
      if (el) el.value = saved;
    }
  } catch {}
})();
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('gen-apikey');
  if (el) el.addEventListener('input', () => {
    try { localStorage.setItem('bloxgen_apikey', el.value); } catch {}
  });
});


async function detectRobloxVersion() {
  try {
    const ver = await api.getRobloxVersion();
    if (ver) {
      // Show full hash in titlebar badge, also update settings stat
      document.getElementById('tb-roblox-ver').textContent = ver;
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = ver;
    } else {
      document.getElementById('tb-roblox-ver').textContent = '-';
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = 'Not detected';
    }
  } catch {
    document.getElementById('tb-roblox-ver').textContent = '-';
    const el = document.getElementById('stat-rblx-ver');
    if (el) el.textContent = 'Not detected';
  }
}

function applySettings() {
  if (settings.encryptionType) {
    selectedEnc = settings.encryptionType;
    updateCddDisplay('enc', selectedEnc);
    document.querySelectorAll('#cdd-enc-menu .cdd-option').forEach(o =>
      o.classList.toggle('selected', o.dataset.value === selectedEnc));
  }
  const keyIn = document.getElementById('custom-key');
  if (keyIn) { keyIn.value = ''; keyIn.placeholder = settings.keySet ? 'Key is set, type to update it' : 'e.g. SecureKey1234@A#'; }
  // Render only the configured boolean state for the Donut_API_Token; never a
  // plaintext token value (Req 9.7). settings:load surfaces donutApiTokenConfigured.
  const donutIn = document.getElementById('donut-token');
  const donutStatus = document.getElementById('donut-token-status');
  const configured = !!settings.donutApiTokenConfigured;
  if (donutIn) { donutIn.value = ''; donutIn.placeholder = configured ? 'Token is set, type to replace it' : 'Not set'; }
  if (donutStatus) { donutStatus.textContent = configured ? 'Token is set' : 'Not set'; donutStatus.classList.toggle('g', configured); }
  const afk = document.getElementById('set-antiafk');
  if (afk) afk.checked = !!settings.antiAfk;
  const afkSb = document.getElementById('sb-antiafk');
  if (afkSb) afkSb.checked = !!settings.antiAfk;
}

let _acctQuery = '', _acctFilter = (() => { try { const f = localStorage.getItem('mr-acct-filter'); return (f && f !== 'running' && f !== 'idle') ? f : 'all'; } catch { return 'all'; } })(), _acctView = (() => { try { return localStorage.getItem('mr-acct-view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
function visibleAccounts() {
  let list = [...accounts];
  if (_acctQuery) {
    const q = _acctQuery;
    list = list.filter(a => (a.nickname || a.username || '').toLowerCase().includes(q) || String(a.userId || '').includes(q));
  }
  if (_acctFilter === 'running') list = list.filter(a => _launchedIds.has(a.id));
  else if (_acctFilter === 'idle') list = list.filter(a => !_launchedIds.has(a.id));
  else if (_acctFilter === 'valid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 1 : 0;
    return s(a.id) - s(b.id);
  });
  else if (_acctFilter === 'invalid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 0 : 1;
    return s(a.id) - s(b.id);
  });
  return list;
}
let _searchTimer;
function onAcctSearch(v) {
  _acctQuery = (v || '').trim().toLowerCase();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(render, 120); // debounce so a long list isn't rebuilt on every keystroke
}
function toggleFilterMenu(e) { if (e) e.stopPropagation(); document.getElementById('filter-menu').classList.toggle('open'); }
function setAcctFilter(f) {
  _acctFilter = f;
  try { localStorage.setItem('mr-acct-filter', (f === 'running' || f === 'idle') ? 'all' : f); } catch {}
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.getElementById('filter-menu').classList.remove('open');
  document.getElementById('filter-btn').classList.toggle('on', f !== 'all');
  render();
}
function setAcctView(v) {
  _acctView = v;
  try { localStorage.setItem('mr-acct-view', v); } catch {}
  document.getElementById('vt-grid').classList.toggle('active', v === 'grid');
  document.getElementById('vt-list').classList.toggle('active', v === 'list');
  render();
}
document.addEventListener('click', e => {
  const fm = document.getElementById('filter-menu');
  if (fm && fm.classList.contains('open') && !e.target.closest('.filter-wrap')) fm.classList.remove('open');
});

function toggleAntiAfk(src) {
  const el = document.getElementById(src === 'sb' ? 'sb-antiafk' : 'set-antiafk');
  const on = el.checked;
  settings.antiAfk = on;
  api.saveSettings({ antiAfk: on });
  const a = document.getElementById('set-antiafk'); if (a) a.checked = on;
  const b = document.getElementById('sb-antiafk'); if (b) b.checked = on;
  toast(on ? 'Anti-AFK on, accounts stay connected' : 'Anti-AFK off', on ? 'ok' : 'err');
}

function toggleCdd(name) {
  const trigger = document.getElementById('cdd-' + name + '-trigger');
  const menu = document.getElementById('cdd-' + name + '-menu');
  const open = menu.classList.contains('open');
  closeAllCdd();
  if (!open) { trigger.classList.add('open'); menu.classList.add('open'); }
}
function closeAllCdd() {
  document.querySelectorAll('.cdd-trigger.open').forEach(t => t.classList.remove('open'));
  document.querySelectorAll('.cdd-menu.open').forEach(m => m.classList.remove('open'));
}
function selectCdd(name, value) {
  selectedEnc = value;
  document.querySelectorAll('#cdd-' + name + '-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === value));
  updateCddDisplay(name, value);
  closeAllCdd();
}
function updateCddDisplay(name, value) {
  const meta = ENC_OPTIONS[value] || { label: value, badge: '', badgeClass: '' };
  const lbl = document.getElementById('cdd-' + name + '-label');
  const bdg = document.getElementById('cdd-' + name + '-badge');
  if (lbl) lbl.textContent = meta.label;
  if (bdg) { bdg.textContent = meta.badge; bdg.className = 'cdd-badge' + (meta.badgeClass ? ' ' + meta.badgeClass : ''); }
}
document.addEventListener('click', e => { if (!e.target.closest('.cdd')) closeAllCdd(); });

function settingsTab(tab) {
  ['general','themes','sounds'].forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn = document.getElementById('stab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'sounds') typeof soundRenderPage === 'function' && soundRenderPage();
}

const PAGE_ORDER = ['accounts','packages','charts','mixer','generator','settings','logs','credits'];

function goTo(p) {
  if (p === 'sounds' || p === 'themes') { goTo('settings'); settingsTab(p); return; }
  const nextPage = document.getElementById('page-' + p);
  if (!nextPage) return;

  closeCardMenu();
  if (p !== 'accounts') clearSelection(true);
  if (_dragging) finishDrag(false);

  const oldPage = document.querySelector('.page.active');
  const oldName = _activePage;
  const forward = PAGE_ORDER.indexOf(p) >= PAGE_ORDER.indexOf(oldName);
  _activePage = p;

  document.querySelectorAll('.page').forEach(x => {
    if (x !== oldPage && x !== nextPage) {
      x.classList.remove('active','page-enter-left','page-enter-right','page-exit-left','page-exit-right');
    }
  });
  if (oldPage && oldPage !== nextPage) {
    oldPage.classList.add(forward ? 'page-exit-left' : 'page-exit-right');
    oldPage.classList.remove('active');
    nextPage.classList.add(forward ? 'page-enter-right' : 'page-enter-left', 'active');
    requestAnimationFrame(() => nextPage.classList.remove('page-enter-right','page-enter-left'));
    setTimeout(() => oldPage.classList.remove('page-exit-left','page-exit-right'), 320);
  } else {
    nextPage.classList.add('active');
  }
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('nav-' + p)?.classList.add('active');
  if (p === 'settings') {
    document.getElementById('stat-count').textContent = accounts.length;
    refreshMultiStatus();
  }
  if (p === 'logs') renderLogs();
  if (p === 'charts' && !chartsLoaded) loadCharts();
  if (p === 'packages') renderPackages();
  if (p === 'mixer') mixInit();
  updateBulkBar();
  // generator page
}

function markLaunched(id) {
  _launchedIds.add(id);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx !== -1) accounts[idx] = { ...accounts[idx], lastUsed: new Date().toISOString() };
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.add('is-live');
    const dot = card.querySelector('.card-dot');
    if (dot) { dot.classList.add('launched'); dot.title = 'Launched'; }
    const used = card.querySelector('.card-last-used');
    if (used) used.textContent = lastUsedText(accounts[idx] || { lastUsed: new Date().toISOString() });
  }
  refreshPkgAvatarStatus();
}

function accountNotes(a) {
  return String((a && (a.notes ?? a.note)) || '').trim();
}

function notePreview(a) {
  return accountNotes(a).replace(/\s+/g, ' ');
}

function relativeTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, Date.now() - t);
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 45 * 1000) return 'just now';
  if (diff < hour) {
    const n = Math.max(1, Math.round(diff / min));
    return n + ' min ago';
  }
  if (diff < day) {
    const n = Math.round(diff / hour);
    return n + ' hour' + (n === 1 ? '' : 's') + ' ago';
  }
  if (diff < 7 * day) {
    const n = Math.round(diff / day);
    return n + ' day' + (n === 1 ? '' : 's') + ' ago';
  }
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function lastUsedText(a) {
  const rel = relativeTime(a && a.lastUsed);
  return rel ? 'Last used ' + rel : 'Never launched';
}

function refreshLastUsedLabels() {
  document.querySelectorAll('.card[data-id]').forEach(card => {
    const a = accounts.find(x => x.id === card.dataset.id);
    const el = card.querySelector('.card-last-used');
    if (a && el) el.textContent = lastUsedText(a);
  });
}

function startLastUsedTick() {
  if (_lastUsedTimer) return;
  _lastUsedTimer = setInterval(refreshLastUsedLabels, 60000);
}

async function killOne(id) {
  const a = accounts.find(x => x.id === id);
  logEntry('warn', 'kill', `Killing Roblox instance for ${a ? a.username : id}...`, { accountId: id, username: a?.username, userId: a?.userId });
  const res = await api.killOneRoblox(id);
  if (!res || !res.ok) toast(res?.error || 'Could not kill that instance', 'err');
  else logEntry('ok', 'kill', `Killed instance for ${a ? a.username : id}`, { accountId: id });
}

// ── Card context menu ─────────────────────────────────────────────────────
let _ctxMenuId = null;
function showCardMenu(id, x, y) {
  closeCardMenu();
  _ctxMenuId = id;
  const a = accounts.find(x => x.id === id);
  const isLive = _launchedIds.has(id);
  const menu = document.createElement('div');
  menu.id = 'card-ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-header">${esc(a ? (a.nickname || a.username || 'Unknown') : id)}</div>
    ${isLive ? `<button class="ctx-item ctx-danger" onclick="ctxKill('${id}')"><span class="material-icons-round">stop_circle</span>Kill instance</button>` : ''}
    <button class="ctx-item" onclick="ctxLaunch('${id}')"><span class="material-icons-round">rocket_launch</span>${isLive ? 'Relaunch' : 'Launch'}</button>
    <button class="ctx-item" onclick="ctxEdit('${id}')"><span class="material-icons-round">edit</span>Edit account</button>
    <button class="ctx-item" onclick="ctxOpenBrowser('${id}')"><span class="material-icons-round">public</span>Open in Browser</button>
    <button class="ctx-item" onclick="ctxQuickLogin('${id}')"><span class="material-icons-round">qr_code_2</span>Quick login</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxFriend('${id}')"><span class="material-icons-round">person_add</span>Send friend request</button>
    <button class="ctx-item" onclick="ctxDisplayName('${id}')"><span class="material-icons-round">badge</span>Change display name</button>
    <button class="ctx-item" onclick="ctxPassword('${id}')"><span class="material-icons-round">password</span>Change password</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxCopyId('${id}')"><span class="material-icons-round">tag</span>Copy user ID</button>
    <button class="ctx-item" onclick="ctxCopyUser('${id}')"><span class="material-icons-round">person</span>Copy username</button>
    <button class="ctx-item" onclick="ctxCopyCookie('${id}')"><span class="material-icons-round">content_paste</span>Copy Cookie</button>
  `;
  document.body.appendChild(menu);
  // Position: keep on screen
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 200) + 'px';
  menu.style.top = Math.min(y, vh - menu.offsetHeight - 10) + 'px';
  setTimeout(() => document.addEventListener('click', closeCardMenu, { once: true }), 0);
}
function closeCardMenu() { const m = document.getElementById('card-ctx-menu'); if (m) m.remove(); _ctxMenuId = null; }
async function ctxKill(id) { closeCardMenu(); await killOne(id); }
function ctxLaunch(id) { closeCardMenu(); openLaunch(id); }
function ctxEdit(id) { closeCardMenu(); openEdit(id); }
function ctxFriend(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (!a) return; _launchTargets = [a]; document.getElementById('friend-who').textContent = 'From ' + (a.nickname || a.username || a.id) + '.'; document.getElementById('friend-target').value = ''; setStatus('friend-status', 'hidden', ''); document.getElementById('friend-progress').innerHTML = ''; const b = document.getElementById('btn-friend'); b.disabled = false; b.textContent = 'Send'; openModal('m-friend'); }
function ctxDisplayName(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) openDisplayNameFor([a]); }
function ctxPassword(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) openPasswordFor([a]); }
function ctxCopyId(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.userId) navigator.clipboard.writeText(a.userId).then(() => toast('User ID copied', 'ok')); else toast('No user ID', 'err'); }
function ctxCopyUser(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.username) navigator.clipboard.writeText(a.username).then(() => toast('Username copied', 'ok')); else toast('No username', 'err'); }
async function ctxOpenBrowser(id) { closeCardMenu(); const r = await api.openAccountBrowser(id); if (!r.ok) toast(r.error || 'Could not open browser', 'err'); }
async function ctxCopyCookie(id) { closeCardMenu(); const r = await api.copyAccountCookie(id); toast(r.ok ? 'Cookie copied' : (r.error || 'Could not copy cookie'), r.ok ? 'ok' : 'err'); }

function refreshPkgAvatarStatus() {
  document.querySelectorAll('.pkg-avatar[data-acc-id]').forEach(av => {
    av.classList.toggle('online', _launchedIds.has(av.dataset.accId));
  });
}

// ── Multi-select + bulk actions ────────────────────────────────────────────
function syncSelectionCards() {
  document.querySelectorAll('.card[data-id]').forEach(c => {
    const selected = _selectedIds.has(c.dataset.id);
    c.classList.toggle('selected', selected);
    c.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function setSelectMode(on, clear) {
  _selMode = !!on;
  if (clear) _selectedIds.clear();
  document.body.classList.toggle('select-mode', _selMode);
  document.getElementById('select-btn')?.classList.toggle('on', _selMode);
  syncSelectionCards();
  updateBulkBar();
}

function clearSelection(exitMode) {
  _selectedIds.clear();
  if (exitMode) _selMode = false;
  document.body.classList.toggle('select-mode', _selMode);
  document.getElementById('select-btn')?.classList.toggle('on', _selMode);
  syncSelectionCards();
  updateBulkBar();
}

function toggleSelectMode() {
  if (_selMode) clearSelection(true);
  else setSelectMode(true, false);
}
function toggleSelect(id) {
  if (!_selMode) setSelectMode(true, false);
  if (_selectedIds.has(id)) _selectedIds.delete(id); else _selectedIds.add(id);
  syncSelectionCards();
  if (_selectedIds.size === 0) setSelectMode(false, false);
  else updateBulkBar();
}
function bulkSelectAll() {
  if (!_selMode) setSelectMode(true, false);
  visibleAccounts().forEach(a => _selectedIds.add(a.id));
  syncSelectionCards();
  updateBulkBar();
}
function bulkClear() {
  clearSelection(true);
}
function updateBulkBar() {
  const bar = document.getElementById('bulkbar');
  if (!bar) return;
  const n = _selectedIds.size;
  const count = document.getElementById('bulk-count');
  if (count) count.textContent = n;
  bar.classList.toggle('show', _activePage === 'accounts' && _selMode && n > 0);
}
function selectedAccounts() {
  return accounts.filter(a => _selectedIds.has(a.id));
}
function _cardActionHit(target) {
  return !!(target && target.closest && target.closest('button,input,textarea,select,a,.card-row,.card-kill,.drag-handle,.card-ingame,[data-card-action]'));
}

function bulkLaunch() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  openLaunchFor(sel);
}
async function bulkOpenBrowser() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  toast('Opening ' + sel.length + ' browser session' + (sel.length !== 1 ? 's' : '') + '…', 'ok');
  let ok = 0;
  if (typeof api.openAccountBrowsers === 'function') {
    const r = await api.openAccountBrowsers(sel.map(a => a.id));
    ok = Number(r?.opened || 0);
    (r?.results || []).forEach(item => {
      if (item && !item.ok) {
        const a = accounts.find(x => x.id === item.accountId);
        logEntry('err', 'browser', `Open browser failed for ${a?.username || item.accountId}: ${item.error || 'error'}`, { accountId: item.accountId });
      }
    });
  } else {
    for (const a of sel) {
      const r = await api.openAccountBrowser(a.id);
      if (r && r.ok) ok++; else logEntry('err', 'browser', `Open browser failed for ${a.username || a.id}: ${r?.error || 'error'}`, { accountId: a.id });
      await new Promise(r => setTimeout(r, 400));
    }
  }
  toast('Opened ' + ok + '/' + sel.length + ' browser sessions', ok === sel.length ? 'ok' : 'err');
}
function bulkFriend() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  _launchTargets = sel;
  document.getElementById('friend-who').textContent = 'From ' + sel.length + ' selected account' + (sel.length !== 1 ? 's' : '') + '.';
  document.getElementById('friend-target').value = '';
  setStatus('friend-status', 'hidden', '');
  document.getElementById('friend-progress').innerHTML = '';
  const b = document.getElementById('btn-friend'); b.disabled = false; b.textContent = 'Send';
  openModal('m-friend');
}
function bulkPassword() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  openPasswordFor(sel);
}
async function bulkKill() {
  const sel = selectedAccounts().filter(a => _launchedIds.has(a.id));
  if (!sel.length) { toast('None of the selected accounts are running', 'err'); return; }
  for (const a of sel) await killOne(a.id);
  toast('Killed ' + sel.length + ' instance' + (sel.length !== 1 ? 's' : ''), 'ok');
}
function openAccountActions() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  document.getElementById('aa-who').textContent = sel.length + ' account' + (sel.length !== 1 ? 's' : '') + ' selected.';
  openModal('m-account-actions');
}
function bulkDisplayName() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  openDisplayNameFor(sel);
}
function openBulkNotes() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  _bulkNoteTargets = sel;
  document.getElementById('bulk-notes-who').textContent = sel.length + ' selected account' + (sel.length !== 1 ? 's' : '') + '.';
  document.getElementById('bulk-notes-text').value = '';
  document.getElementById('bulk-notes-append').checked = true;
  setStatus('bulk-notes-status', 'hidden', '');
  openModal('m-bulk-notes');
  setTimeout(() => document.getElementById('bulk-notes-text').focus(), 120);
}
async function saveBulkNotes() {
  const text = document.getElementById('bulk-notes-text').value.trim();
  const append = document.getElementById('bulk-notes-append').checked;
  if (!text && append) { toast('Write a note first', 'err'); return; }
  const btn = document.getElementById('btn-bulk-notes');
  const members = _bulkNoteTargets.slice();
  if (!members.length) { toast('No selected accounts', 'err'); return; }
  btn.disabled = true;
  setStatus('bulk-notes-status', 'load', '<div class="spin"></div>Saving notes...');
  let ok = 0;
  for (const a of members) {
    const current = accountNotes(a);
    const notes = append && current && text ? current + '\n' + text : text;
    try {
      const updated = await api.updateAccount(a.id, { notes });
      if (updated) {
        const idx = accounts.findIndex(x => x.id === a.id);
        if (idx !== -1) accounts[idx] = updated;
        ok++;
      }
    } catch {}
  }
  btn.disabled = false;
  setStatus('bulk-notes-status', ok === members.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === members.length ? 'check_circle' : 'error_outline') + '</span>Saved ' + ok + '/' + members.length);
  render();
  setTimeout(() => { closeModal('m-bulk-notes'); toast('Notes saved for ' + ok + ' account' + (ok !== 1 ? 's' : ''), ok ? 'ok' : 'err'); }, 450);
}
async function bulkCopyCookies() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  const lines = sel.map(a => a.cookie).filter(Boolean);
  if (!lines.length) { toast('No cookies stored for the selected accounts', 'err'); return; }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Copied ' + lines.length + ' cookie' + (lines.length !== 1 ? 's' : '') + ' (one per line)', 'ok');
  } catch { toast('Could not write to clipboard', 'err'); }
}
async function bulkDelete() {
  const sel = selectedAccounts();
  if (!sel.length) { toast('Select at least one account', 'err'); return; }
  confirmAction('Delete ' + sel.length + ' selected account' + (sel.length !== 1 ? 's' : '') + '? This cannot be undone.', async () => {
    let ok = 0;
    const ids = new Set(sel.map(s => s.id));
    for (const a of sel) {
      try { await api.removeAccount(a.id); ok++; } catch {}
      _selectedIds.delete(a.id);
    }
    accounts = accounts.filter(a => !ids.has(a.id));
    // Drop the removed accounts from any groups.
    let touched = false;
    packages.forEach(p => { const before = p.accountIds.length; p.accountIds = p.accountIds.filter(aid => !ids.has(aid)); if (p.accountIds.length !== before) touched = true; });
    if (touched) { api.savePackages(packages); }
    logEntry('warn', 'system', `Removed ${ok} account(s) in bulk`);
    render();
    renderPackages();
    updateBulkBar();
    toast('Deleted ' + ok + ' account' + (ok !== 1 ? 's' : ''), 'err');
  });
}

// ── Presence polling ────────────────────────────────────────────────────────
let _presenceTimer = null;
async function refreshPresence() {
  const ids = accounts.map(a => a.userId).filter(Boolean);
  if (!ids.length) return;
  // Use any stored cookie for authentication (presence of non-friends needs it).
  const cookie = (accounts.find(a => a.cookie) || {}).cookie || null;
  try {
    const res = await api.getPresence(ids, cookie);
    const arr = (res && res.userPresences) || [];
    arr.forEach(p => {
      const uid = String(p.userId);
      _presence[uid] = {
        type: p.userPresenceType,
        placeId: p.placeId || p.rootPlaceId || null,
        gameId: p.gameId || null,
        universeId: p.universeId || null,
        name: p.lastLocation || '',
      };
    });
    updatePresenceBadges(visibleAccounts());
  } catch (e) { /* transient; retry next tick */ }
}
function startPresencePoll() {
  refreshPresence();
  if (_presenceTimer) clearInterval(_presenceTimer);
  _presenceTimer = setInterval(refreshPresence, 30000);
}
// Repaint just the status badges + in-game line in place without a full re-render.
function updatePresenceBadges(list) {
  (list || []).forEach(a => {
    const card = document.querySelector(`.card[data-id="${a.id}"]`);
    if (!card) return;
    const row = card.querySelector('.card-name-row');
    if (row) {
      const old = row.querySelector('.card-status');
      if (old) old.remove();
      const html = _statusBadge(a);
      if (html) {
        const expired = row.querySelector('.card-expired');
        if (expired) expired.insertAdjacentHTML('beforebegin', html);
        else row.insertAdjacentHTML('beforeend', html);
      }
    }
    // In-game name line (warm metadata cache, then repaint).
    const p = a.userId ? _presence[a.userId] : null;
    const cardId = card.querySelector('.card-id');
    const existing = card.querySelector('.card-ingame');
    if (existing) existing.remove();
    if (p && p.type === 2 && p.placeId && cardId) {
      const meta = _loadGameMeta()[String(p.placeId)];
      if (!meta) getGameMeta(String(p.placeId), () => updatePresenceBadges([a]));
      cardId.insertAdjacentHTML('afterend', _ingameLine(a));
    }
  });
}

function isDragActive() {
  return !!(_dragging || _dragPlaceholder || document.body.classList.contains('account-dragging'));
}

function flushDeferredRender() {
  if (!_renderAfterDrag) return;
  _renderAfterDrag = false;
  render();
}

function render() {
  if (isDragActive()) {
    _renderAfterDrag = true;
    return;
  }
  const grid = document.getElementById('grid'), empty = document.getElementById('empty'), sub = document.getElementById('acct-sub');
  sub.textContent = accounts.length ? accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + ' saved' : 'No accounts saved';
  const savedCount = document.getElementById('sb-saved-count');
  if (savedCount) savedCount.textContent = accounts.length ? accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + ' saved' : 'No accounts saved';
  const savedTime = document.getElementById('sb-saved-time'); if (savedTime) savedTime.textContent = 'Last saved just now';
  if (!accounts.length) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  const list = visibleAccounts();
  grid.classList.toggle('list-view', _acctView === 'list');
  if (!list.length) {
    grid.classList.remove('list-view');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12.5px;padding:40px 0">No accounts match your search or filter.</div>';
    return;
  }
  grid.innerHTML = list.map((a, i) => {
    const note = notePreview(a);
    const used = lastUsedText(a);
    return `
    <div class="card${_launchedIds.has(a.id) ? ' is-live' : ''}${_cookieStatus[a.id] === 'dead' ? ' cookie-dead' : ''}${_selectedIds.has(a.id) ? ' selected' : ''}" data-id="${a.id}" role="button" tabindex="0" aria-selected="${_selectedIds.has(a.id) ? 'true' : 'false'}">
      <div class="card-check" title="Select"><span class="material-icons-round">check</span></div>
      <div class="card-dot${_launchedIds.has(a.id) ? ' launched' : ''}" title="${_launchedIds.has(a.id) ? 'Launched' : 'Not launched'}"></div>
      ${_launchedIds.has(a.id) ? `<button class="card-kill" onclick="event.stopPropagation();killOne('${a.id}')" title="Kill this instance"><span class="material-icons-round">close</span></button>` : ''}
      <span class="material-icons-round drag-handle">drag_indicator</span>
      <div class="card-av" id="av-${a.id}">${(a.username || '?')[0].toUpperCase()}</div>
      <div class="card-id">
        <div class="card-name-row">
          <div class="card-name">${esc(a.nickname || a.username || 'Unknown')}</div>
          ${_statusBadge(a)}
          <span class="card-expired" title="This account's cookie is no longer valid. Re-add the account to refresh it."><span class="material-icons-round">error_outline</span>Expired</span>
        </div>
        <div class="card-meta">
          <div class="card-uid">${a.userId ? 'ID ' + a.userId : 'No ID'}</div>
          <div class="card-last-used">${esc(used)}</div>
        </div>
      </div>
      ${_ingameLine(a)}
      <div class="card-game ${a.gameTarget ? 'visible' : ''}" id="gt-${a.id}" title="${esc(a.gameTarget || '')}">
        ${a.gameTarget ? esc(truncate(_gameNameCache[a.id] || extractTargetLabel(a.gameTarget), 22)) : ''}
      </div>
      ${note ? `<div class="card-note" title="${esc(accountNotes(a))}"><span class="material-icons-round">sticky_note_2</span><span>${esc(truncate(note, 58))}</span></div>` : ''}
      <div class="card-row">
        <button class="btn btn-launch" onclick="openLaunch('${a.id}')">
          Start
        </button>
        <button class="btn btn-edit" onclick="openEdit('${a.id}')" title="Edit">
          <span class="material-icons-round">edit</span>
        </button>
        <button class="btn btn-del" onclick="removeAcc('${a.id}')" title="Remove">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    </div>`;
  }).join('') + `<div class="card-add" onclick="openLogin()"><span class="material-icons-round card-add-icon">add</span><span class="card-add-label">Add account</span></div>`;
  // Scope per-render work to the cards actually on screen. The grid is rebuilt
  // each render, so cached avatars/names still paint instantly; only uncached
  // lookups for visible cards hit the network, and filtered-out accounts are
  // resolved lazily when they next become visible (results stay cached).
  loadAvatarsBatch(list);
  list.forEach(a => { if (a.gameTarget && !_gameNameCache[a.id]) fetchGameName(a.id, a.gameTarget); });
  checkCookieHealth(list);
  updatePresenceBadges(list);
  // Bind right-click context menus + selection interactions to cards
  document.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card.dataset.id, e.clientX, e.clientY); });
    const chk = card.querySelector('.card-check');
    if (chk) chk.addEventListener('click', e => { e.stopPropagation(); toggleSelect(card.dataset.id); });
    card.addEventListener('click', e => {
      if (_cardActionHit(e.target)) return;
      toggleSelect(card.dataset.id);
    });
    card.addEventListener('keydown', e => {
      if ((e.key !== 'Enter' && e.key !== ' ') || _cardActionHit(e.target)) return;
      e.preventDefault();
      toggleSelect(card.dataset.id);
    });
  });
  initDrag();
}

// ── Presence status badge ─────────────────────────────────────────────────
function _statusBadge(a) {
  const p = a.userId ? _presence[a.userId] : null;
  if (!p) return '';
  if (p.type === 2) return '<span class="card-status st-ingame" title="' + esc(p.name || 'In game') + '">In game</span>';
  if (p.type === 3) return '<span class="card-status st-studio">In studio</span>';
  if (p.type === 1) return '<span class="card-status st-online">Online</span>';
  return '';
}
// "In: <game name>" line under the ID, shown only when the account is in a game.
function _ingameLine(a) {
  const p = a.userId ? _presence[a.userId] : null;
  if (!p || p.type !== 2 || !p.placeId) return '';
  const meta = _loadGameMeta()[String(p.placeId)] || {};
  const name = meta.name || 'In a game';
  return `<div class="card-ingame" title="${esc(name)}" onclick="event.stopPropagation();openLaunch('${a.id}')"><span class="material-icons-round">sports_esports</span>${esc(truncate(name, 24))}</div>`;
}

// Cookie expiry detection. Validates each account's cookie once per session (the
// same authenticated endpoint used at login) and flags dead ones with a red
// badge so only genuinely-expired accounts need re-adding. Staggered so we never
// burst the endpoint, and cached so repeated renders don't re-check.
const _cookieStatus = {}; // id -> 'checking' | 'ok' | 'dead' | 'unknown'
function applyCookieStatus(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('cookie-dead', _cookieStatus[id] === 'dead');
}
// On a launch auth failure, surface a likely-expired cookie immediately rather
// than waiting for the per-session health check. Only genuine auth/cookie errors
// flip the badge -- rate-limit (429) and transient HTTP errors are left alone so
// a temporary hiccup never mislabels a valid account.
function _flagCookieMaybeDead(id, error) {
  if (id && error && /cookie|expired|\b403\b/i.test(error)) {
    _cookieStatus[id] = 'dead';
    applyCookieStatus(id);
  }
}
let _cookieCheckRunning = false;
async function checkCookieHealth(list) {
  if (_cookieCheckRunning) return;
  const todo = list.filter(a => a.cookie && _cookieStatus[a.id] === undefined);
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try {
    for (const a of todo) {
      if (_cookieStatus[a.id] !== undefined) continue;
      _cookieStatus[a.id] = 'checking';
      try {
        const res = await api.validateCookie(a.cookie);
        const st = (res && res.ok) ? 'ok' : 'dead';
        _cookieStatus[a.id] = st;
        if (st === 'dead') logEntry('warn', 'cookie', `Cookie invalid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        else logEntry('info', 'cookie', `Cookie valid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
      } catch { _cookieStatus[a.id] = 'unknown'; logEntry('warn', 'cookie', `Cookie check failed for ${a.username || a.id}`, { accountId: a.id }); }
      applyCookieStatus(a.id);
      await new Promise(r => setTimeout(r, 200)); // stagger; avoid bursting the endpoint
    }
  } finally { _cookieCheckRunning = false; }
}

// Recheck ALL cookies every 60s so status stays live
let _recheckRunning = false;
const _cookieCheckedAt = {};            // id -> last validation epoch ms
const OK_RECHECK_MS = 5 * 60 * 1000;    // re-check known-good cookies at most every 5 min
// Cookie refresh (session keep-alive) scheduling:
const REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // refresh each account's cookie at most once every 3 days
const REFRESH_STAGGER_MS = 90 * 1000;                // space refreshes ~1-2 min apart across accounts
const REFRESH_RETRY_MS = 60 * 1000;                  // after a rate limit, wait ~1 min before retrying
let _lastCookieRefreshAt = 0;                        // epoch ms of the last refresh attempt (any account)
let _cookieRefreshBlockedUntil = 0;                  // backoff deadline after a 429
async function recheckAllCookies(force) {
  if (_recheckRunning) return; // bail if a previous pass is still going
  _recheckRunning = true;
  // flag unchecked cookies as 'checking' before the first await, otherwise the
  // checkCookieHealth pass inside render() races us and validates them twice
  for (const a of accounts) if (a.cookie && _cookieStatus[a.id] === undefined) _cookieStatus[a.id] = 'checking';
  try {
  let changed = false;
  let refreshedThisPass = false; // at most one cookie refresh per pass (stagger)
  const now = Date.now();
  for (const a of accounts) {
    if (!a.cookie) continue;
    // good cookies only get re-checked every few minutes to keep the request
    // rate down; dead/unknown ones are retried every tick so a recovery shows
    // up fast. force (the decrypt pass) ignores this and checks everything.
    if (!force && _cookieStatus[a.id] === 'ok' && _cookieCheckedAt[a.id] && (now - _cookieCheckedAt[a.id]) < OK_RECHECK_MS) continue;
    const prev = _cookieStatus[a.id];
    _cookieStatus[a.id] = 'checking';
    // Session keep-alive: refresh (rotate) the cookie at most once a week per
    // account, at most one account per pass, spaced ~1-2 min apart, and backing
    // off ~1 min on a rate limit. Persist the rotated value (and the refresh
    // timestamp) so the schedule survives restarts.
    if (!refreshedThisPass && Date.now() >= _cookieRefreshBlockedUntil &&
        (Date.now() - _lastCookieRefreshAt) >= REFRESH_STAGGER_MS &&
        (Date.now() - (a.cookieRefreshedAt || 0)) >= REFRESH_INTERVAL_MS) {
      refreshedThisPass = true;
      _lastCookieRefreshAt = Date.now();
      try {
        const r = await api.refreshCookie(a.cookie);
        if (r && r.rateLimited) {
          _cookieRefreshBlockedUntil = Date.now() + REFRESH_RETRY_MS; // wait ~1 min, then retry
          logEntry('warn', 'cookie', `Cookie refresh rate-limited for ${a.username || a.id}; retrying in ~1 min`, { accountId: a.id });
        } else {
          const fresh = r && r.cookie;
          const rotated = fresh && fresh !== a.cookie;
          if (rotated) a.cookie = fresh;
          a.cookieRefreshedAt = Date.now();
          await api.updateAccount(a.id, rotated
            ? { cookie: a.cookie, cookieRefreshedAt: a.cookieRefreshedAt }
            : { cookieRefreshedAt: a.cookieRefreshedAt });
          if (rotated) logEntry('info', 'cookie', `Cookie refreshed for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        }
      } catch {}
    }
    try {
      const res = await api.validateCookie(a.cookie);
      _cookieCheckedAt[a.id] = Date.now();
      const next = (res && res.ok) ? 'ok' : 'dead';
      if (next !== prev) {
        _cookieStatus[a.id] = next;
        applyCookieStatus(a.id); // toggles .cookie-dead on the card (badge + ring)
        changed = true;
        if (next === 'dead') logEntry('warn', 'cookie', `Cookie expired for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
        else if (prev === 'dead' && next === 'ok') logEntry('ok', 'cookie', `Cookie re-validated for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
      } else {
        _cookieStatus[a.id] = next;
      }
    } catch { _cookieStatus[a.id] = prev || 'unknown'; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (changed) render(); // rebuild once at the end so the cards match
  } finally { _recheckRunning = false; }
}
setInterval(() => { if (accounts.length) recheckAllCookies(false); }, 60000);


const _gameNameCache = {}; // accountId -> resolved game name
// Persistent target -> resolved name map. Game names are stable, so caching them
// across restarts avoids re-resolving every launch. Stored in WebView localStorage.
let _gameNamePersist = {};
try { _gameNamePersist = JSON.parse(localStorage.getItem('mr-gamenames') || '{}'); } catch { _gameNamePersist = {}; }
function _saveGameNames() { try { localStorage.setItem('mr-gamenames', JSON.stringify(_gameNamePersist)); } catch {} }

function extractTargetLabel(target) {
  if (!target) return '';
  const t = target.trim();
  if (/^\d+$/.test(t)) return t;
  try {
    const u = new URL(t.startsWith('http') ? t : 'https://' + t);
    const parts = u.pathname.split('/').filter(Boolean);
    // extract linkCode or share code for private servers
    const name = (parts[2] || parts[1] || '').replace(/-/g, ' ').trim();
    return name || u.hostname;
  } catch { return truncate(target, 22); }
}

async function fetchGameName(accountId, target) {
  if (!target) return;
  const t = target.trim();
  // Persistent cache hit: skip the network entirely.
  if (_gameNamePersist[t]) {
    _gameNameCache[accountId] = _gameNamePersist[t];
    updateGameLabel(accountId);
    return;
  }
  // Find the account to get its cookie for authenticated requests
  const acct = accounts.find(a => a.id === accountId);
  const cookie = acct ? acct.cookie : null;
  let placeId = null;
  if (/^\d+$/.test(t)) {
    placeId = t;
  } else {
    try {
      const u = new URL(t.startsWith('http') ? t : 'https://' + t);
      const parts = u.pathname.split('/').filter(Boolean);
      // /games/<placeId>/... or /games/<placeId>
      if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) placeId = parts[1];
      if (!placeId) placeId = u.searchParams.get('placeId');
      // PlaceLauncher URLs: ?placeId=...
      if (!placeId) { const m = t.match(/[?&]placeId=(\d+)/); if (m) placeId = m[1]; }
    } catch {}
  }
  if (!cookie) {
    _gameNameCache[accountId] = extractTargetLabel(target);
    updateGameLabel(accountId);
    return;
  }
  // Fetch via main process (authenticated with cookie)
  const name = await api.getGameName(placeId || t, cookie);
  _gameNameCache[accountId] = name || extractTargetLabel(target);
  // Persist only genuine resolved names (not the raw fallback label).
  if (name) { _gameNamePersist[t] = name; _saveGameNames(); }
  updateGameLabel(accountId);
}

function updateGameLabel(accountId) {
  const el = document.getElementById('gt-' + accountId);
  if (!el) return;
  const a = accounts.find(x => x.id === accountId);
  if (!a || !a.gameTarget) return;
  el.textContent = truncate(_gameNameCache[accountId] || extractTargetLabel(a.gameTarget), 22);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '\u2026' : s; }

let _dragSaveTimer = null;
let _dragging = null, _dragPlaceholder = null, _dragGrid = null;
let _dragOffX = 0, _dragOffY = 0, _dragMoved = false, _dragStartX = 0, _dragStartY = 0;
let _dragBaseLeft = 0, _dragBaseTop = 0, _dragFrame = 0, _dragNextX = 0, _dragNextY = 0;

function initDrag() {
  const grid = document.getElementById('grid');

  grid.querySelectorAll('.card').forEach(card => {
    const handle = card.querySelector('.drag-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();

      _dragging = card;
      const rect = card.getBoundingClientRect();
      _dragOffX = e.clientX - rect.left;
      _dragOffY = e.clientY - rect.top;
      _dragStartX = e.clientX;
      _dragStartY = e.clientY;
      _dragBaseLeft = rect.left;
      _dragBaseTop = rect.top;
      _dragNextX = rect.left;
      _dragNextY = rect.top;
      _dragMoved = false;

      _dragGrid = grid;

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });
  });
}

function beginFloatingDrag() {
  if (!_dragging || _dragPlaceholder) return;
  const grid = _dragGrid || document.getElementById('grid');
  const rect = _dragging.getBoundingClientRect();
  _dragBaseLeft = rect.left;
  _dragBaseTop = rect.top;

  _dragPlaceholder = document.createElement('div');
  _dragPlaceholder.className = 'card-slot';
  _dragPlaceholder.setAttribute('aria-hidden', 'true');
  _dragPlaceholder.style.height = rect.height + 'px';
  grid.insertBefore(_dragPlaceholder, _dragging);

  _dragging.classList.add('dragging', 'drag-floating');
  if (grid.classList.contains('list-view')) _dragging.classList.add('drag-list-clone');
  _dragging.style.position = 'fixed';
  _dragging.style.left = rect.left + 'px';
  _dragging.style.top = rect.top + 'px';
  _dragging.style.width = rect.width + 'px';
  _dragging.style.height = rect.height + 'px';
  _dragging.style.margin = '0';
  _dragging.style.zIndex = '9999';
  _dragging.style.pointerEvents = 'none';
  _dragging.style.willChange = 'transform';
  _dragging.style.transition = 'transform 95ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease, opacity 180ms ease';
  document.body.appendChild(_dragging);
  document.body.classList.add('account-dragging');
}

function updateFloatingDrag(x, y) {
  _dragNextX = x;
  _dragNextY = y;
  if (_dragFrame) return;
  _dragFrame = requestAnimationFrame(() => {
    _dragFrame = 0;
    if (!_dragging) return;
    const dx = _dragNextX - _dragBaseLeft;
    const dy = _dragNextY - _dragBaseTop;
    _dragging.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.025)`;
  });
}

function dragGridItems() {
  const grid = _dragGrid || document.getElementById('grid');
  if (!grid) return [];
  return Array.from(grid.children).filter(el =>
    (el.matches('.card[data-id]') || el.classList.contains('card-slot')) && el !== _dragging
  );
}

function insertionIndexFromPointer(x, y) {
  const items = dragGridItems();
  if (!items.length) return 0;

  const entries = items
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .sort((a, b) => Math.abs(a.rect.top - b.rect.top) > 12
      ? a.rect.top - b.rect.top
      : a.rect.left - b.rect.left);

  const rows = [];
  for (const entry of entries) {
    const row = rows[rows.length - 1];
    if (!row || Math.abs(entry.rect.top - row.top) > 24) {
      rows.push({ top: entry.rect.top, bottom: entry.rect.bottom, items: [entry] });
    } else {
      row.items.push(entry);
      row.top = Math.min(row.top, entry.rect.top);
      row.bottom = Math.max(row.bottom, entry.rect.bottom);
    }
  }

  rows.forEach(row => {
    row.items.sort((a, b) => a.rect.left - b.rect.left);
    row.center = (row.top + row.bottom) / 2;
  });

  if (y < rows[0].top) return 0;
  if (y > rows[rows.length - 1].bottom) return entries.length;

  let rowIndex = 0;
  let closest = Infinity;
  rows.forEach((row, index) => {
    const distance = Math.abs(y - row.center);
    if (distance < closest) {
      closest = distance;
      rowIndex = index;
    }
  });

  const row = rows[rowIndex];
  const rowStart = rows.slice(0, rowIndex).reduce((sum, r) => sum + r.items.length, 0);
  for (let i = 0; i < row.items.length; i++) {
    const rect = row.items[i].rect;
    if (x < rect.left + rect.width / 2) return rowStart + i;
  }
  return rowStart + row.items.length;
}

function movePlaceholderToPointer(x, y) {
  if (!_dragGrid || !_dragPlaceholder) return;
  const items = dragGridItems();
  const currentIndex = items.indexOf(_dragPlaceholder);
  if (currentIndex < 0) return;

  let desiredIndex = insertionIndexFromPointer(x, y);
  desiredIndex = Math.max(0, Math.min(desiredIndex, items.length));

  const withoutSlot = items.filter(el => el !== _dragPlaceholder);
  const refIndex = desiredIndex > currentIndex ? desiredIndex - 1 : desiredIndex;
  const ref = withoutSlot[refIndex] || null;

  if ((_dragPlaceholder.nextSibling || null) === ref) return;
  animateGridReorder(() => _dragGrid.insertBefore(_dragPlaceholder, ref));
}

function onDragMove(e) {
  if (!_dragging || !_dragging.isConnected) return;
  if (!_dragMoved && Math.hypot(e.clientX - _dragStartX, e.clientY - _dragStartY) < 4) return;
  _dragMoved = true;
  beginFloatingDrag();
  updateFloatingDrag(e.clientX - _dragOffX, e.clientY - _dragOffY);

  // nudge the scroll when the cursor gets near the top/bottom edge
  const wrap = document.querySelector('.grid-wrap');
  if (wrap) {
    const wr = wrap.getBoundingClientRect();
    if (e.clientY < wr.top + 60) wrap.scrollTop -= 16;
    else if (e.clientY > wr.bottom - 60) wrap.scrollTop += 16;
  }

  movePlaceholderToPointer(e.clientX, e.clientY);
}

function animateGridReorder(mutator) {
  const items = dragGridItems;
  const first = new Map(items().map(item => [item, item.getBoundingClientRect()]));
  mutator();
  items().forEach(item => {
    const before = first.get(item);
    if (!before) return;
    const after = item.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (!dx && !dy) return;
    item.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  });
}

// Reorder the `accounts` array to match the current on-screen card order.
// Only the slots occupied by currently-visible cards are reassigned; accounts
// hidden by an active search/filter keep their positions, so dragging within a
// filtered view never disturbs the rest of the list.
function _syncAccountsOrderFromDom() {
  const grid = document.getElementById('grid');
  const visIds = Array.from(grid.querySelectorAll('.card[data-id]')).map(c => c.dataset.id);
  const visSet = new Set(visIds);
  const byId = new Map(accounts.filter(a => visSet.has(a.id)).map(a => [a.id, a]));
  const queue = visIds.map(id => byId.get(id)).filter(Boolean);
  let qi = 0;
  accounts = accounts.map(a => (visSet.has(a.id) ? queue[qi++] : a));
}

function resetFloatingCard(card) {
  card.classList.remove('dragging', 'drag-floating', 'drag-list-clone');
  card.style.position = '';
  card.style.left = '';
  card.style.top = '';
  card.style.width = '';
  card.style.height = '';
  card.style.margin = '';
  card.style.zIndex = '';
  card.style.pointerEvents = '';
  card.style.willChange = '';
  card.style.transition = '';
  card.style.transform = '';
}

function persistDraggedOrder() {
  _syncAccountsOrderFromDom();
  clearTimeout(_dragSaveTimer);
  _dragSaveTimer = setTimeout(() => {
    api.reorderAccounts(accounts.map(a => a.id))
      .then(() => toast('Account order saved', 'ok'))
      .catch(() => toast('Could not save account order', 'err'));
  }, 400);
}

function finishDrag(saveOrder) {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (_dragFrame) {
    cancelAnimationFrame(_dragFrame);
    _dragFrame = 0;
  }

  if (_dragging && _dragPlaceholder) {
    const card = _dragging;
    const slot = _dragPlaceholder;
    const grid = _dragGrid || document.getElementById('grid');
    if (!saveOrder || !_dragMoved) {
      grid.insertBefore(card, slot);
      slot.remove();
      resetFloatingCard(card);
      _dragging = null;
      _dragPlaceholder = null;
      _dragGrid = null;
      document.body.classList.remove('account-dragging');
      flushDeferredRender();
      return;
    }

    const slotRect = slot.getBoundingClientRect();
    const dx = slotRect.left - _dragBaseLeft;
    const dy = slotRect.top - _dragBaseTop;
    card.style.transition = 'transform 300ms cubic-bezier(.18,.9,.24,1), box-shadow 260ms ease, opacity 220ms ease';
    card.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1)`;
    window.setTimeout(() => {
      if (!slot.isConnected) return;
      grid.insertBefore(card, slot);
      slot.remove();
      resetFloatingCard(card);
      persistDraggedOrder();
      document.body.classList.remove('account-dragging');
      flushDeferredRender();
    }, 310);
    _dragging = null;
    _dragPlaceholder = null;
    _dragGrid = null;
    return;
  } else if (_dragging) {
    resetFloatingCard(_dragging);
    _dragging = null;
  }

  if (_dragPlaceholder) { _dragPlaceholder.remove(); _dragPlaceholder = null; }
  _dragGrid = null;
  document.body.classList.remove('account-dragging');
  flushDeferredRender();
}

function onDragEnd() {
  finishDrag(true);
}

function loadAvatar(id, uid) {
  if (_avatarCache[uid]) {
    const el = document.getElementById('av-' + id);
    if (el) el.innerHTML = '<img src="' + _avatarCache[uid] + '" alt=""/>';
    return;
  }
  api.getAvatarThumbnails([uid])
    .then(d => {
      const url = d?.data?.[0]?.imageUrl;
      if (url) {
        _avatarCache[uid] = url;
        const el = document.getElementById('av-' + id);
        if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/>';
      }
    }).catch(() => {});
}

// Batched avatar load: one request for every uncached account instead of one per
// account. The thumbnails endpoint takes up to 100 ids per call. Falls back to
// per-account fetches if a batch fails, so behaviour is never worse than before.
async function loadAvatarsBatch(list) {
  const paint = a => {
    if (a.userId && _avatarCache[a.userId]) {
      const el = document.getElementById('av-' + a.id);
      if (el && !el.querySelector('img')) el.innerHTML = '<img src="' + _avatarCache[a.userId] + '" alt=""/>';
    }
  };
  const need = [], seen = new Set();
  for (const a of list) {
    if (!a.userId) continue;
    if (_avatarCache[a.userId]) { paint(a); continue; }
    if (!seen.has(a.userId)) { seen.add(a.userId); need.push(a.userId); }
  }
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const d = await api.getAvatarThumbnails(chunk);
      (d?.data || []).forEach(item => { if (item && item.targetId && item.imageUrl) _avatarCache[item.targetId] = item.imageUrl; });
      list.forEach(paint);
    } catch {
      chunk.forEach(uid => { const a = list.find(x => x.userId === uid); if (a) loadAvatar(a.id, uid); });
    }
  }
}

function loadPkgAvatar(pkgId, accountId, uid, attempt) {
  const elId = 'pkg-av-' + pkgId + '-' + accountId;
  const paint = url => {
    _avatarCache[uid] = url;
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/><span class="pkg-avatar-dot"></span>';
  };
  if (_avatarCache[uid]) { paint(_avatarCache[uid]); return; }
  api.getAvatarThumbnails([uid])
    .then(d => {
      const item = d?.data?.[0];
      if (item && item.imageUrl && item.state === 'Completed') { paint(item.imageUrl); return; }
      // Roblox returns Pending while it generates the thumbnail; retry briefly.
      if (item && item.state === 'Pending' && (attempt || 0) < 3) {
        setTimeout(() => loadPkgAvatar(pkgId, accountId, uid, (attempt || 0) + 1), 1500);
      } else if (item && item.imageUrl) { paint(item.imageUrl); }
    }).catch(() => {});
}

// ── Avatar hover card ───────────────────────────────────────────────────────
const _userInfoCache = {};
function loadUserInfo(uid, cb) {
  if (_userInfoCache[uid]) { cb(_userInfoCache[uid]); return; }
  api.robloxApiGet('https://users.roblox.com/v1/users/' + uid)
    .then(d => { _userInfoCache[uid] = d; cb(d); })
    .catch(() => cb(null));
}

function positionAvTip(av, tip) {
  const rect = av.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 10;
  if (top < 8) top = rect.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function showAvTip(av) {
  const uid = av.dataset.uid || '';
  const uname = av.dataset.uname || '';
  const nick = av.dataset.nick || '';
  const tip = document.getElementById('av-tip');
  tip.dataset.uid = uid;
  document.getElementById('av-tip-name').textContent = nick && nick !== uname ? nick : (uname || 'Unknown');
  document.getElementById('av-tip-uname').textContent = uname ? '@' + uname : (uid ? 'ID ' + uid : '');
  const avEl = document.getElementById('av-tip-av');
  avEl.innerHTML = _avatarCache[uid] ? '<img src="' + _avatarCache[uid] + '" alt=""/>' : (uname || '?')[0].toUpperCase();
  document.getElementById('av-tip-created').textContent = uid ? 'Loading\u2026' : 'Unknown';
  tip.classList.add('show');
  positionAvTip(av, tip);
  if (uid) {
    loadUserInfo(uid, info => {
      if (tip.dataset.uid !== uid || !tip.classList.contains('show')) return;
      const createdEl = document.getElementById('av-tip-created');
      if (info && info.created) {
        const d = new Date(info.created);
        createdEl.textContent = 'Created ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        createdEl.textContent = 'Unknown';
      }
      positionAvTip(av, tip);
    });
  }
}

function hideAvTip() {
  document.getElementById('av-tip').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av) showAvTip(av);
});
document.addEventListener('mouseout', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av && !(e.relatedTarget && av.contains(e.relatedTarget))) hideAvTip();
});
window.addEventListener('scroll', hideAvTip, true);

function _showPanel(panel) {
  ['choose','cookie','browser','bulk'].forEach(p => {
    document.getElementById('login-panel-' + p).style.display = p === panel ? '' : 'none';
  });
  document.getElementById('btn-cookie-add').style.display = panel === 'cookie' ? '' : 'none';
  document.getElementById('btn-bulk-cookie-add').style.display = panel === 'bulk' ? '' : 'none';
  document.getElementById('btn-login-back').style.display = panel === 'choose' ? 'none' : '';
  setStatus('login-status', 'hidden', '');
}

function openLogin() {
  document.getElementById('cookie-input').value = '';
  document.getElementById('bulk-cookie-input').value = '';
  document.getElementById('bulk-cookie-progress').innerHTML = '';
  _showPanel('choose');
  openModal('m-login');
}

function showCookiePanel() {
  _showPanel('cookie');
  setTimeout(() => document.getElementById('cookie-input').focus(), 50);
}

function showBulkCookiePanel() {
  _showPanel('bulk');
  setTimeout(() => document.getElementById('bulk-cookie-input').focus(), 50);
}

function backToChoose() {
  _showPanel('choose');
}

async function startBrowserLogin() {
  _showPanel('browser');
  // Show waiting state by default - only switch to download UI if Chrome needs to be downloaded
  document.getElementById('login-dl').style.display = 'none';
  document.getElementById('login-waiting').style.display = '';
  document.getElementById('dl-bar').style.width = '0%';
  document.getElementById('dl-pct').textContent = '0%';
  const res = await api.openLogin();
  if (!document.getElementById('m-login').classList.contains('open')) return;
  if (!res || !res.success) {
    if (res && res.error && res.error !== 'Login window closed') {
      _showPanel('choose');
      setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.error));
    } else {
      closeModal('m-login');
    }
    return;
  }
  await finishLogin(res);
}

async function addByCookie() {
  let cookie = document.getElementById('cookie-input').value.trim();
  if (!cookie) return;
  cookie = _normalizeCookie(cookie);
  if (!cookie || cookie.length < 100) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>Cookie looks too short - make sure you copied the full value');
    return;
  }
  const btn = document.getElementById('btn-cookie-add');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div>Verifying…';
  setStatus('login-status', 'load', '<div class="spin"></div>Refreshing cookie…');
  const r = await _refreshAndValidateCookie(cookie, (msg) => setStatus('login-status', 'load', '<div class="spin"></div>' + msg));
  btn.disabled = false;
  btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">check</span>Add Account';
  if (!r.ok) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(r.error || 'Invalid cookie - make sure you copied the full .ROBLOSECURITY value'));
    return;
  }
  await finishLogin({ success: true, cookie: r.cookie, username: r.username, userId: r.userId });
}

// Strip a `.ROBLOSECURITY=`/`ROBLOSECURITY=` prefix and surrounding quotes a
// user may have accidentally included when copying the cookie.
function _normalizeCookie(raw) {
  let c = (raw || '').trim();
  if (c.startsWith('.ROBLOSECURITY=')) c = c.slice('.ROBLOSECURITY='.length);
  if (c.startsWith('ROBLOSECURITY=')) c = c.slice('ROBLOSECURITY='.length);
  return c.replace(/^["']|["']$/g, '').trim();
}

// Refresh-then-validate a raw cookie value. Refresh runs first (and always, on
// any add-by-cookie path) so a cookie pasted from another device/location gets
// rotated/bound to this session before it can be invalidated by mismatched
// session state — this does NOT by itself mean the cookie is valid, which is
// why validateCookie still runs afterward. On refresh failure or a 429 the
// original cookie is kept and validation proceeds on it as-is.
async function _refreshAndValidateCookie(cookie, onStatus) {
  onStatus && onStatus('Refreshing cookie…');
  try {
    const rf = await api.refreshCookie(cookie);
    if (rf && rf.cookie && !rf.rateLimited) cookie = rf.cookie;
  } catch {}
  onStatus && onStatus('Verifying cookie…');
  const res = await api.validateCookie(cookie);
  if (!res.ok) return { ok: false, error: res.reason };
  return { ok: true, cookie, username: res.username, userId: res.userId };
}

function cancelLogin() {
  closeModal('m-login');
  api.cancelLogin && api.cancelLogin();
}

// Add several accounts from pasted cookies (one per line). Each is refreshed
// and validated in sequence with a ~2s gap between them — never in parallel —
// so the refresh/validate calls for many accounts don't hit Roblox's rate limit
// at once; still "as soon as possible" otherwise (no gap before the first one).
const BULK_COOKIE_GAP_MS = 2000;
async function addByBulkCookies() {
  const raw = document.getElementById('bulk-cookie-input').value;
  const lines = [...new Set(raw.split(/\r?\n/).map(_normalizeCookie).filter(c => c.length >= 100))];
  if (!lines.length) { toast('Paste at least one .ROBLOSECURITY cookie', 'err'); return; }
  const existing = new Set(accounts.map(a => a.cookie));
  const btn = document.getElementById('btn-bulk-cookie-add');
  btn.disabled = true;
  const progress = document.getElementById('bulk-cookie-progress');
  progress.innerHTML = lines.map((_, i) => `<span class="pkg-chip load" id="bc-chip-${i}"><div class="spin" style="width:9px;height:9px;border-width:2px"></div>Account ${i + 1}</span>`).join('');
  setStatus('login-status', 'load', '<div class="spin"></div>Adding ' + lines.length + ' account' + (lines.length !== 1 ? 's' : '') + '…');
  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, BULK_COOKIE_GAP_MS));
    const chip = document.getElementById('bc-chip-' + i);
    if (existing.has(lines[i])) {
      if (chip) { chip.className = 'pkg-chip err'; chip.title = 'Already added'; chip.innerHTML = '<span class="material-icons-round">info</span>Account ' + (i + 1); }
      continue;
    }
    const r = await _refreshAndValidateCookie(lines[i]);
    if (r.ok) {
      try {
        const a = await api.addAccount({ username: r.username, userId: r.userId, cookie: r.cookie, gameTarget: '' });
        accounts.push(a); render();
        existing.add(r.cookie);
        ok++;
        if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(r.username || ('Account ' + (i + 1))); }
      } catch {
        if (chip) { chip.className = 'pkg-chip err'; chip.innerHTML = '<span class="material-icons-round">error_outline</span>Account ' + (i + 1); }
      }
    } else if (chip) {
      chip.className = 'pkg-chip err'; chip.title = r.error || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>Account ' + (i + 1);
    }
  }
  btn.disabled = false;
  setStatus('login-status', ok === lines.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === lines.length ? 'check_circle' : 'error_outline') + '</span>Added ' + ok + '/' + lines.length);
  toast('Added ' + ok + '/' + lines.length + ' account' + (lines.length !== 1 ? 's' : ''), ok === lines.length ? 'ok' : 'err');
  if (ok > 0) setTimeout(() => { closeModal('m-login'); }, 1200);
}

async function finishLogin(res) {
  setStatus('login-status', 'ok', '<span class="material-icons-round">check_circle</span>Signed in as ' + esc(res.username));
  const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '' });
  accounts.push(a); render();
  setTimeout(() => {
    closeModal('m-login');
    toast('Added ' + esc(res.username), 'ok');
    const grid = document.getElementById('grid');
    if (grid) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 800);
}

function openEdit(id) {
  editAcc = accounts.find(a => a.id === id); if (!editAcc) return;
  document.getElementById('edit-title').textContent = 'Edit - ' + (editAcc.nickname || editAcc.username);
  document.getElementById('in-nickname').value = editAcc.nickname || '';
  document.getElementById('in-target').value = editAcc.gameTarget || '';
  document.getElementById('in-notes').value = accountNotes(editAcc);
  openModal('m-edit');
  setTimeout(() => document.getElementById('in-target').focus(), 220);
}
async function saveEdit() {
  if (!editAcc) return;
  const target = document.getElementById('in-target').value.trim();
  const nickname = document.getElementById('in-nickname').value.trim();
  const notes = document.getElementById('in-notes').value.trim();
  const updated = await api.updateAccount(editAcc.id, { gameTarget: target, nickname, notes });
  if (updated) {
    const idx = accounts.findIndex(a => a.id === editAcc.id);
    if (idx !== -1) {
      accounts[idx] = updated;
      delete _gameNameCache[editAcc.id]; // clear stale name
      render();
      if (target) fetchGameName(editAcc.id, target); // fetch new name immediately
    } else { render(); }
  }
  closeModal('m-edit');
  toast('Saved', 'ok');
}

function confirmAction(message, onConfirm) {
  document.getElementById('m-confirm-delete-msg').textContent = message;
  const btn = document.getElementById('m-confirm-delete-btn');
  const newBtn = btn.cloneNode(true); // clone to remove old listeners
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => { closeModal('m-confirm-delete'); onConfirm(); });
  openModal('m-confirm-delete');
}

async function removeAcc(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  confirmAction('Remove "' + a.username + '"? This cannot be undone.', async () => {
    await api.removeAccount(id); accounts = accounts.filter(x => x.id !== id); render();
    if (packages.some(p => p.accountIds.includes(id))) {
      packages.forEach(p => { p.accountIds = p.accountIds.filter(aid => aid !== id); });
      api.savePackages(packages);
      renderPackages();
    }
    toast('Removed ' + a.username, 'err');
  });
}
async function clearAll() {
  if (!accounts.length) return;
  confirmAction('Remove all ' + accounts.length + ' accounts? This cannot be undone.', async () => {
    for (const a of accounts) await api.removeAccount(a.id);
    accounts = []; render(); document.getElementById('stat-count').textContent = '0';
    packages.forEach(p => { p.accountIds = []; });
    api.savePackages(packages);
    renderPackages();
    toast('All accounts cleared', 'err');
  });
}

// ── Enhanced launch modal ───────────────────────────────────────────────────
let _launchDest = 'home';       // home | place | player | private
let _launchServerJob = null;    // selected specific-server { placeId, jobId }
let _launchFollowUserId = null; // selected player to follow into their game
let _launchPreviewTimer = null;
const LAUNCH_HISTORY_KEY = 'mr-launch-history';
const LAUNCH_FAV_KEY = 'mr-fav-games';
const GAME_META_KEY = 'mr-game-meta';

function openLaunch(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  openLaunchFor([a]);
}
// Open the launch modal for one or many accounts. Seeds the destination from the
// single account's saved gameTarget when there is exactly one.
function openLaunchFor(list) {
  _launchTargets = list.filter(Boolean);
  if (!_launchTargets.length) { toast('No accounts to launch', 'err'); return; }
  _launchServerJob = null;
  const n = _launchTargets.length;
  document.getElementById('launch-title').textContent = n === 1 ? 'Launch Roblox' : `Launch ${n} accounts`;
  document.getElementById('launch-who').textContent = n === 1
    ? (_launchTargets[0].nickname || _launchTargets[0].username || 'Account')
    : n + ' accounts selected';
  document.getElementById('btn-launch-label').textContent = n === 1 ? 'Launch' : `Launch ${n}`;
  // Reset inputs
  document.getElementById('lm-place').value = '';
  document.getElementById('lm-private').value = '';
  document.getElementById('lm-servers').innerHTML = '';
  document.getElementById('lm-preview').style.display = 'none';
  document.getElementById('launch-progress').innerHTML = '';
  setStatus('launch-status', 'hidden', '');
  const btn = document.getElementById('btn-launch'); btn.disabled = false;
  // Seed from a single account's saved target if present.
  let dest = 'home';
  if (n === 1 && _launchTargets[0].gameTarget) {
    const t = _launchTargets[0].gameTarget;
    if (/privateServerLinkCode=/.test(t)) { dest = 'private'; document.getElementById('lm-private').value = t; }
    else { dest = 'place'; document.getElementById('lm-place').value = t; }
  }
  launchSetDest(dest);
  openModal('m-launch');
}
function launchSetDest(dest) {
  _launchDest = dest;
  document.querySelectorAll('.lm-tab').forEach(t => t.classList.toggle('active', t.dataset.dest === dest));
  document.querySelectorAll('.lm-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById('lm-pane-' + dest);
  if (pane) pane.classList.add('active');
  document.getElementById('lm-preview').style.display = 'none';
  // Games gallery is relevant when picking a place (with or without a server).
  document.getElementById('lm-gallery-wrap').style.display = 'none';
  if (dest === 'place') renderGallery();
  if (dest === 'player') { document.getElementById('lm-player-res').innerHTML = ''; renderInGameAccounts(); }
  launchUpdateFavBtn();
  launchPlaceInput();
}
// Resolve the current place-id-ish input for whichever destination is active.
function _currentPlaceInput() {
  if (_launchDest === 'place') return document.getElementById('lm-place').value.trim();
  if (_launchDest === 'private') return document.getElementById('lm-private').value.trim();
  return '';
}
function launchPlaceInput() {
  _launchServerJob = null;
  _launchFollowUserId = null;
  const serversWrap = document.getElementById('lm-servers');
  if (serversWrap) serversWrap.innerHTML = '';
  launchUpdateFavBtn();
  clearTimeout(_launchPreviewTimer);
  const val = _currentPlaceInput();
  if (!val || _launchDest === 'home' || _launchDest === 'player') { document.getElementById('lm-preview').style.display = 'none'; return; }
  _launchPreviewTimer = setTimeout(() => loadGamePreview(val), 450);
}
async function loadGamePreview(placeOrUrl) {
  const cookie = (_launchTargets[0] || accounts.find(a => a.cookie) || {}).cookie || null;
  try {
    const d = await api.getGameDetails(placeOrUrl, cookie);
    if (!d || !d.ok) { document.getElementById('lm-preview').style.display = 'none'; return; }
    document.getElementById('lm-preview').style.display = 'flex';
    document.getElementById('lm-preview-icon').src = d.iconUrl || '';
    document.getElementById('lm-preview-name').textContent = d.name || ('Place ' + d.placeId);
    document.getElementById('lm-preview-creator').textContent = d.creator ? ('by ' + d.creator) : '';
    document.getElementById('lm-preview-playing').textContent = d.playing ? (d.playing.toLocaleString() + ' playing now') : '';
  } catch { document.getElementById('lm-preview').style.display = 'none'; }
}
// Lists public servers (with their jobId) for the place ID currently typed
// into the Place tab's own input, so picking a specific server never needs a
// second "Server" section — it's just a refinement of the Place destination.
async function launchLoadServers() {
  const place = _currentPlaceInput();
  const pid = (place.match(/\/games\/(\d+)/) || place.match(/^(\d+)$/) || [])[1] || place;
  if (!/^\d+$/.test(pid)) { toast('Enter a numeric place ID first', 'err'); return; }
  const wrap = document.getElementById('lm-servers');
  wrap.innerHTML = '<div class="lm-note"><div class="spin" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle"></div> Loading servers…</div>';
  loadGamePreview(pid);
  try {
    const res = await api.robloxApiGet(`https://games.roblox.com/v1/games/${pid}/servers/Public?sortOrder=Asc&limit=100`);
    const servers = (res && res.data) || [];
    if (!servers.length) { wrap.innerHTML = '<div class="lm-note">No public servers found (or the place has none joinable).</div>'; return; }
    wrap.innerHTML = servers.slice(0, 50).map(s => {
      const pct = s.maxPlayers ? Math.round((s.playing / s.maxPlayers) * 100) : 0;
      return `<div class="lm-server" data-place="${pid}" data-job="${esc(s.id)}" onclick="launchPickServer(this)">
        <div style="flex:1;min-width:0">
          <div class="lm-server-txt">${s.playing}/${s.maxPlayers} players${s.ping ? ' · ' + s.ping + 'ms' : ''}</div>
          <div class="lm-server-bar"><div class="lm-server-fill" style="width:${pct}%"></div></div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = '<div class="lm-note">Could not load servers. The place ID may be invalid or the API is rate-limited.</div>';
  }
}
function launchPickServer(el) {
  const already = el.classList.contains('sel');
  document.querySelectorAll('.lm-server.sel').forEach(s => s.classList.remove('sel'));
  if (already) { _launchServerJob = null; return; } // click again to deselect -> plain place launch
  el.classList.add('sel');
  _launchServerJob = { placeId: el.dataset.place, jobId: el.dataset.job };
}
// Build the launch target string for the current destination selection.
function _buildLaunchTarget() {
  if (_launchDest === 'home') return null;
  if (_launchDest === 'private') return document.getElementById('lm-private').value.trim() || null;
  if (_launchDest === 'player') {
    if (_launchFollowUserId) return `https://www.roblox.com/home?followUserId=${_launchFollowUserId}`;
    if (_launchServerJob) return `https://www.roblox.com/games/${_launchServerJob.placeId}?gameId=${_launchServerJob.jobId}`;
    return undefined; // needs a player / account pick
  }
  // place — a picked specific server refines the same place-id input rather
  // than needing a separate destination.
  if (_launchServerJob) return `https://www.roblox.com/games/${_launchServerJob.placeId}?gameId=${_launchServerJob.jobId}`;
  return document.getElementById('lm-place').value.trim() || null;
}
async function doLaunch() {
  const btn = document.getElementById('btn-launch');
  if (btn.disabled) return;
  const target = _buildLaunchTarget();
  if (target === undefined) { toast('Pick a server from the list first', 'err'); return; }
  const members = _launchTargets.slice();
  if (!members.length) return;

  // Save to recent history (skip Home).
  if (target) saveLaunchHistory(target);

  btn.disabled = true;
  const single = members.length === 1;
  setStatus('launch-status', 'load', '<div class="spin"></div>' + (single ? 'Getting auth ticket…' : `Launching ${members.length} accounts…`));
  const progress = document.getElementById('launch-progress');
  progress.innerHTML = members.map(m => `<span class="pkg-chip load" id="lm-chip-${m.id}"><div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}</span>`).join('');

  let ok = 0;
  await Promise.all(members.map(async (m) => {
    const t = target || m.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${m.username || m.id}...`, { accountId: m.id, username: m.username || null, userId: m.userId || null, target: t || 'Roblox home' });
    const res = await api.launchRoblox(m.id, m.cookie, t);
    const chip = document.getElementById('lm-chip-' + m.id);
    if (res && res.success) {
      ok++;
      logEntry('ok', 'launch', `Roblox launched as ${m.username || m.id}`, { accountId: m.id, username: m.username || null });
      markLaunched(m.id);
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else {
      logEntry('err', 'launch', `Launch failed for ${m.username || m.id}: ${res?.error}`, { accountId: m.id });
      _flagCookieMaybeDead(m.id, res?.error);
      if (chip) { chip.className = 'pkg-chip err'; chip.title = res?.error || ''; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); }
    }
  }));

  if (single && ok === 1) {
    setStatus('launch-status', 'ok', '<span class="material-icons-round">check_circle</span>Launched as ' + esc(members[0].username || ''));
    setTimeout(() => { closeModal('m-launch'); toast('Launched as ' + (members[0].username || ''), 'ok'); }, 700);
  } else {
    setStatus('launch-status', ok === members.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === members.length ? 'check_circle' : 'error_outline') + '</span>Launched ' + ok + '/' + members.length);
    btn.disabled = false;
    toast('Launched ' + ok + '/' + members.length + ' accounts', ok === members.length ? 'ok' : 'err');
  }
}

// ── Game metadata cache (name + icon per place id) ──────────────────────────
function _loadGameMeta() { try { return JSON.parse(localStorage.getItem(GAME_META_KEY) || '{}'); } catch { return {}; } }
function _saveGameMeta(meta) { try { localStorage.setItem(GAME_META_KEY, JSON.stringify(meta)); } catch {} }
function _placeIdOf(target) {
  const m = String(target).match(/\/games\/(\d+)/) || String(target).match(/^(\d+)$/);
  return m ? m[1] : null;
}
// Resolve name + icon for a place id, caching to localStorage. Invokes cb when ready.
async function getGameMeta(placeId, cb) {
  const meta = _loadGameMeta();
  if (meta[placeId]) { cb && cb(meta[placeId]); return meta[placeId]; }
  try {
    const cookie = (accounts.find(a => a.cookie) || {}).cookie || null;
    const d = await api.getGameDetails(placeId, cookie);
    if (d && d.ok) {
      const rec = { name: d.name || ('Place ' + placeId), icon: d.iconUrl || '', creator: d.creator || '' };
      const all = _loadGameMeta(); all[placeId] = rec; _saveGameMeta(all);
      cb && cb(rec);
      return rec;
    }
  } catch {}
  return null;
}

// ── Launch history (recent) + favorites ─────────────────────────────────────
function _loadLaunchHistory() { try { return JSON.parse(localStorage.getItem(LAUNCH_HISTORY_KEY) || '[]'); } catch { return []; } }
function _loadFavGames() { try { return JSON.parse(localStorage.getItem(LAUNCH_FAV_KEY) || '[]'); } catch { return []; } }
function _saveFavGames(list) { try { localStorage.setItem(LAUNCH_FAV_KEY, JSON.stringify(list)); } catch {} }

function saveLaunchHistory(target) {
  if (!target) return;
  const pid = _placeIdOf(target);
  // Only place / server targets go to the games gallery; keep raw others too.
  let hist = _loadLaunchHistory().filter(h => h.target !== target);
  const label = (pid && _loadGameMeta()[pid]?.name) || _gameNameCache[target] || extractTargetLabel(target) || target;
  hist.unshift({ target, placeId: pid, label, at: Date.now() });
  hist = hist.slice(0, 18);
  try { localStorage.setItem(LAUNCH_HISTORY_KEY, JSON.stringify(hist)); } catch {}
  if (pid) getGameMeta(pid); // warm the cache for the icon/name
}

// Favorite the currently-entered place. Toggles on/off.
function _currentPlaceId() {
  const val = _currentPlaceInput();
  return _placeIdOf(val);
}
function launchToggleFav() {
  const pid = _currentPlaceId();
  if (!pid) { toast('Enter a place ID first', 'err'); return; }
  let favs = _loadFavGames();
  if (favs.some(f => f.placeId === pid)) {
    favs = favs.filter(f => f.placeId !== pid);
    toast('Removed from favorites', 'ok');
  } else {
    favs.unshift({ placeId: pid, at: Date.now() });
    toast('Added to favorites', 'ok');
    getGameMeta(pid, () => renderGallery());
  }
  _saveFavGames(favs);
  launchUpdateFavBtn();
  renderGallery();
}
function launchUpdateFavBtn() {
  const btn = document.getElementById('lm-fav-btn');
  if (!btn) return;
  const pid = _currentPlaceId();
  const on = pid && _loadFavGames().some(f => f.placeId === pid);
  btn.querySelector('.material-icons-round').textContent = on ? 'star' : 'star_border';
  btn.classList.toggle('on', !!on);
}

function renderGallery() {
  const wrap = document.getElementById('lm-gallery-wrap');
  const grid = document.getElementById('lm-gallery');
  const favs = _loadFavGames();
  const hist = _loadLaunchHistory().filter(h => h.placeId);
  // Merge: favorites first, then recent place-id games not already favorited.
  const favIds = new Set(favs.map(f => f.placeId));
  const items = [
    ...favs.map(f => ({ placeId: f.placeId, fav: true })),
    ...hist.filter(h => !favIds.has(h.placeId)).map(h => ({ placeId: h.placeId, fav: false })),
  ];
  // De-dup by placeId preserving order.
  const seen = new Set(); const uniq = [];
  items.forEach(it => { if (!seen.has(it.placeId)) { seen.add(it.placeId); uniq.push(it); } });
  if (!uniq.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const meta = _loadGameMeta();
  grid.innerHTML = uniq.map(it => {
    const m = meta[it.placeId] || {};
    return `<div class="lm-game" data-place="${it.placeId}" onclick="launchUseGame('${it.placeId}')">
      ${it.fav ? '<span class="lm-game-badge"><span class="material-icons-round">star</span></span>' : ''}
      <button class="lm-game-fav ${it.fav ? 'on' : ''}" onclick="event.stopPropagation();launchFavGame('${it.placeId}')" title="Favorite"><span class="material-icons-round">${it.fav ? 'star' : 'star_border'}</span></button>
      <img class="lm-game-icon" src="${esc(m.icon || '')}" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="lm-game-name">${esc(m.name || ('Place ' + it.placeId))}</div>
    </div>`;
  }).join('');
  // Warm any missing metadata, then repaint once resolved.
  uniq.forEach(it => { if (!meta[it.placeId]) getGameMeta(it.placeId, () => renderGallery()); });
}
function launchUseGame(placeId) {
  // Route into place tab with the id filled and preview loaded.
  launchSetDest('place');
  document.getElementById('lm-place').value = placeId;
  launchPlaceInput();
}
function launchFavGame(placeId) {
  let favs = _loadFavGames();
  if (favs.some(f => f.placeId === placeId)) favs = favs.filter(f => f.placeId !== placeId);
  else { favs.unshift({ placeId, at: Date.now() }); getGameMeta(placeId, () => renderGallery()); }
  _saveFavGames(favs);
  renderGallery();
  launchUpdateFavBtn();
}
function launchClearHistory() {
  try { localStorage.removeItem(LAUNCH_HISTORY_KEY); } catch {}
  renderGallery();
}

// ── Player join: follow a user, or join where one of your accounts already is ─
async function launchFindPlayer() {
  const raw = document.getElementById('lm-player').value.trim();
  const res = document.getElementById('lm-player-res');
  if (!raw) { toast('Enter a username or user ID', 'err'); return; }
  res.innerHTML = '<div class="lm-note"><div class="spin" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle"></div> Looking up player…</div>';
  _launchFollowUserId = null;
  let uid = raw;
  if (!/^\d+$/.test(raw)) {
    try {
      const r = await api.robloxApiGet(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(raw)}&limit=10`);
      const hit = (r && r.data || []).find(u => (u.name || '').toLowerCase() === raw.toLowerCase()) || (r && r.data || [])[0];
      if (!hit) { res.innerHTML = '<div class="lm-note">User not found.</div>'; return; }
      uid = String(hit.id);
    } catch { res.innerHTML = '<div class="lm-note">Could not resolve that username.</div>'; return; }
  }
  // Fetch presence to preview the game they are in.
  let pres = null;
  try { const p = await api.getPresence([uid], (accounts.find(a => a.cookie) || {}).cookie || null); pres = (p && p.userPresences || [])[0]; } catch {}
  const type = pres ? pres.userPresenceType : 0;
  if (type !== 2 || !pres.placeId) {
    res.innerHTML = '<div class="lm-note">That player isn\u2019t in a joinable game right now (offline, in menus, or joins are private).</div>';
    return;
  }
  _launchFollowUserId = uid;
  const meta = await getGameMeta(String(pres.placeId));
  res.innerHTML = `<div class="lm-join-row" style="border-color:var(--ac)">
    <div class="lm-join-av"><img src="${esc((meta && meta.icon) || '')}" onerror="this.style.display='none'"/></div>
    <div class="lm-join-info">
      <div class="lm-join-name">Follow into ${esc((meta && meta.name) || ('place ' + pres.placeId))}</div>
      <div class="lm-join-game">${esc(pres.lastLocation || 'In game')}</div>
    </div>
    <span class="material-icons-round" style="color:var(--ac)">check_circle</span>
  </div>
  <div class="field-hint" style="margin-top:6px">Press Launch to drop the selected account(s) into this player\u2019s server.</div>`;
}

// List added accounts currently in-game so the user can join their server.
function renderInGameAccounts() {
  const wrap = document.getElementById('lm-ingame');
  const inGame = accounts.filter(a => {
    const p = a.userId ? _presence[a.userId] : null;
    return p && p.type === 2 && p.placeId;
  });
  if (!inGame.length) { wrap.innerHTML = '<div class="lm-ingame-empty">None of your accounts are in a joinable game right now.</div>'; return; }
  wrap.innerHTML = inGame.map(a => {
    const p = _presence[a.userId];
    const meta = _loadGameMeta()[String(p.placeId)] || {};
    return `<div class="lm-join-row">
      <div class="lm-join-av" id="ig-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</div>
      <div class="lm-join-info">
        <div class="lm-join-name">${esc(a.nickname || a.username || 'Account')}</div>
        <div class="lm-join-game">In: ${esc(meta.name || ('place ' + p.placeId))}</div>
      </div>
      <button class="btn btn-primary lm-join-btn" onclick="launchJoinAccount('${a.id}')">Join server</button>
    </div>`;
  }).join('');
  // Warm metadata + avatars.
  inGame.forEach(a => {
    const p = _presence[a.userId];
    getGameMeta(String(p.placeId), () => { if (_launchDest === 'player') renderInGameAccounts(); });
    if (a.userId) api.getAvatarThumbnails([a.userId]).then(d => {
      const url = d?.data?.[0]?.imageUrl, el = document.getElementById('ig-av-' + a.id);
      if (url && el) el.innerHTML = '<img src="' + esc(url) + '"/>';
    }).catch(() => {});
  });
}
// Join the server that account `id` is currently in. The account itself has no
// jobId in presence for privacy, but presence exposes gameId when public — use it.
async function launchJoinAccount(id) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  const p = _presence[a.userId];
  if (!p || !p.placeId) { toast('That account is no longer in a game', 'err'); return; }
  // Presence gameId is the jobId; if absent, fall back to following the account.
  if (p.gameId) { _launchFollowUserId = null; _launchServerJob = { placeId: String(p.placeId), jobId: p.gameId }; }
  else { _launchServerJob = null; _launchFollowUserId = String(a.userId); }
  toast('Server selected — press Launch', 'ok');
  document.querySelectorAll('.lm-join-row').forEach(r => r.style.borderColor = '');
  const btn = document.querySelector(`.lm-join-btn[onclick="launchJoinAccount('${id}')"]`);
  if (btn) btn.closest('.lm-join-row').style.borderColor = 'var(--ac)';
}

// ── Account actions: friend request / password / display name ───────────────
async function doFriendRequest() {
  const btn = document.getElementById('btn-friend');
  if (btn.disabled) return;
  const raw = document.getElementById('friend-target').value.trim();
  if (!raw) { toast('Enter a user ID or username', 'err'); return; }
  const members = _launchTargets.slice();
  if (!members.length) return;
  btn.disabled = true;
  setStatus('friend-status', 'load', '<div class="spin"></div>Resolving target…');
  // Resolve username -> id if not numeric.
  let targetId = raw;
  if (!/^\d+$/.test(raw)) {
    try {
      const res = await api.robloxApiGet(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(raw)}&limit=10`);
      const hit = (res && res.data || []).find(u => (u.name || '').toLowerCase() === raw.toLowerCase()) || (res && res.data || [])[0];
      if (hit && hit.id) targetId = String(hit.id);
      else { setStatus('friend-status', 'err', '<span class="material-icons-round">error_outline</span>User not found'); btn.disabled = false; return; }
    } catch { setStatus('friend-status', 'err', '<span class="material-icons-round">error_outline</span>Could not resolve username'); btn.disabled = false; return; }
  }
  const progress = document.getElementById('friend-progress');
  progress.innerHTML = members.map(m => `<span class="pkg-chip load" id="fr-chip-${m.id}"><div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}</span>`).join('');
  setStatus('friend-status', 'load', '<div class="spin"></div>Sending…');
  let ok = 0;
  for (const m of members) {
    const chip = document.getElementById('fr-chip-' + m.id);
    try {
      const r = await api.sendFriendRequest(m.cookie, targetId);
      if (r && r.ok) { ok++; if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); } }
      else if (chip) { chip.className = 'pkg-chip err'; chip.title = r?.error || ''; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); }
      logEntry(r?.ok ? 'ok' : 'err', 'system', `Friend request from ${m.username || m.id} to ${targetId}: ${r?.ok ? 'sent' : (r?.error || 'failed')}`, { accountId: m.id });
    } catch (e) { if (chip) { chip.className = 'pkg-chip err'; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); } }
    await new Promise(r => setTimeout(r, 300));
  }
  setStatus('friend-status', ok === members.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === members.length ? 'check_circle' : 'error_outline') + '</span>Sent ' + ok + '/' + members.length);
  btn.disabled = false;
}

function openPasswordFor(list) {
  _launchTargets = list.filter(Boolean);
  const n = _launchTargets.length;
  document.getElementById('password-who').textContent = n === 1
    ? ('For ' + (_launchTargets[0].nickname || _launchTargets[0].username || _launchTargets[0].id) + '.')
    : ('For ' + n + ' selected accounts (same current password for all).');
  document.getElementById('password-current').value = '';
  document.getElementById('password-new').value = '';
  setStatus('password-status', 'hidden', '');
  document.getElementById('password-progress').innerHTML = '';
  const b = document.getElementById('btn-password'); b.disabled = false; b.textContent = 'Change';
  openModal('m-password');
}
async function doChangePassword() {
  const btn = document.getElementById('btn-password');
  if (btn.disabled) return;
  const cur = document.getElementById('password-current').value;
  const nw = document.getElementById('password-new').value;
  if (!cur || !nw) { toast('Fill both password fields', 'err'); return; }
  if (nw.length < 6) { toast('New password is too short', 'err'); return; }
  const members = _launchTargets.slice();
  if (!members.length) return;
  btn.disabled = true;
  const progress = document.getElementById('password-progress');
  progress.innerHTML = members.map(m => `<span class="pkg-chip load" id="pw-chip-${m.id}"><div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}</span>`).join('');
  setStatus('password-status', 'load', '<div class="spin"></div>Changing…');
  let ok = 0, challenge = false;
  for (const m of members) {
    const chip = document.getElementById('pw-chip-' + m.id);
    try {
      const r = await api.changePassword(m.cookie, cur, nw);
      if (r && r.ok) { ok++; if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); } }
      else { if (r?.challenge) challenge = true; if (chip) { chip.className = 'pkg-chip err'; chip.title = r?.error || ''; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); } }
      logEntry(r?.ok ? 'ok' : 'err', 'system', `Password change for ${m.username || m.id}: ${r?.ok ? 'ok' : (r?.error || 'failed')}`, { accountId: m.id });
    } catch (e) { if (chip) { chip.className = 'pkg-chip err'; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); } }
    await new Promise(r => setTimeout(r, 500));
  }
  const msg = challenge && ok < members.length
    ? 'Changed ' + ok + '/' + members.length + ' — some need a browser challenge'
    : 'Changed ' + ok + '/' + members.length;
  setStatus('password-status', ok === members.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === members.length ? 'check_circle' : 'error_outline') + '</span>' + msg);
  btn.disabled = false;
}

function openDisplayNameFor(list) {
  _launchTargets = list.filter(Boolean);
  const n = _launchTargets.length;
  document.getElementById('displayname-who').textContent = n === 1
    ? ('For ' + (_launchTargets[0].nickname || _launchTargets[0].username || _launchTargets[0].id) + '.')
    : ('Sets the same display name for ' + n + ' selected accounts.');
  document.getElementById('displayname-new').value = '';
  setStatus('displayname-status', 'hidden', '');
  document.getElementById('displayname-progress').innerHTML = '';
  const b = document.getElementById('btn-displayname'); b.disabled = false; b.textContent = 'Change';
  openModal('m-displayname');
}
async function doChangeDisplayName() {
  const btn = document.getElementById('btn-displayname');
  if (btn.disabled) return;
  const name = document.getElementById('displayname-new').value.trim();
  if (name.length < 3 || name.length > 20) { toast('Display name must be 3-20 characters', 'err'); return; }
  const members = _launchTargets.filter(a => a.userId);
  if (!members.length) { toast('Selected account(s) have no user id', 'err'); return; }
  btn.disabled = true;
  const single = members.length === 1;
  const progress = document.getElementById('displayname-progress');
  progress.innerHTML = single ? '' : members.map(m => `<span class="pkg-chip load" id="dn-chip-${m.id}"><div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}</span>`).join('');
  setStatus('displayname-status', 'load', '<div class="spin"></div>Changing…');
  let ok = 0;
  for (const m of members) {
    const chip = document.getElementById('dn-chip-' + m.id);
    try {
      const r = await api.changeDisplayName(m.cookie, m.userId, name);
      if (r && r.ok) { ok++; if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); } }
      else if (chip) { chip.className = 'pkg-chip err'; chip.title = r?.error || ''; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); }
      logEntry(r?.ok ? 'ok' : 'err', 'system', `Display name change for ${m.username || m.id}: ${r?.ok ? 'ok' : (r?.error || 'failed')}`, { accountId: m.id });
    } catch (e) { if (chip) { chip.className = 'pkg-chip err'; chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || ''); } }
    if (members.length > 1) await new Promise(r => setTimeout(r, 400));
  }
  if (single && ok === 1) {
    setStatus('displayname-status', 'ok', '<span class="material-icons-round">check_circle</span>Display name changed');
    setTimeout(() => closeModal('m-displayname'), 800);
  } else {
    setStatus('displayname-status', ok === members.length ? 'ok' : 'err', '<span class="material-icons-round">' + (ok === members.length ? 'check_circle' : 'error_outline') + '</span>Changed ' + ok + '/' + members.length);
    btn.disabled = false;
  }
}

// ── Quick login (per-account) ───────────────────────────────────────────────
let _quickLoginAcc = null;
function ctxQuickLogin(id) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id); if (!a) return;
  _quickLoginAcc = a;
  document.getElementById('ql-who').textContent = 'Authorize a login with ' + (a.nickname || a.username || a.id) + '.';
  document.getElementById('ql-code').value = '';
  setStatus('ql-status', 'hidden', '');
  const b = document.getElementById('btn-quicklogin'); b.disabled = false; b.textContent = 'Authorize';
  openModal('m-quicklogin');
}
async function doQuickLogin() {
  const btn = document.getElementById('btn-quicklogin');
  if (btn.disabled || !_quickLoginAcc) return;
  const code = document.getElementById('ql-code').value.trim();
  if (!code) { toast('Enter the login code', 'err'); return; }
  btn.disabled = true;
  setStatus('ql-status', 'load', '<div class="spin"></div>Authorizing…');
  try {
    const r = await api.quickLogin(_quickLoginAcc.cookie, code);
    if (r && r.ok) {
      setStatus('ql-status', 'ok', '<span class="material-icons-round">check_circle</span>Authorized — the other device is signing in');
      logEntry('ok', 'system', `Quick login authorized by ${_quickLoginAcc.username || _quickLoginAcc.id}`, { accountId: _quickLoginAcc.id });
      setTimeout(() => closeModal('m-quicklogin'), 1000);
    } else {
      setStatus('ql-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(r?.error || 'Failed'));
      btn.disabled = false;
    }
  } catch (e) {
    setStatus('ql-status', 'err', '<span class="material-icons-round">error_outline</span>Request failed');
    btn.disabled = false;
  }
}

// ── Packages ──────────────────────────────────────────────────────────────
function renderPackages() {
  const list = document.getElementById('pkg-list'), empty = document.getElementById('pkg-empty');
  if (!list) return;
  if (!packages.length) { list.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  list.innerHTML = packages.map((p, i) => {
    const members = (p.accountIds || []).map(id => accounts.find(a => a.id === id)).filter(Boolean);
    const shown = members.slice(0, 6);
    const extra = members.length - shown.length;
    const avatarsHtml = shown.map(m => `<div class="pkg-avatar${_launchedIds.has(m.id) ? ' online' : ''}" id="pkg-av-${p.id}-${m.id}" data-acc-id="${m.id}" data-uid="${m.userId || ''}" data-uname="${esc(m.username || '')}" data-nick="${esc(m.nickname || '')}">${(m.username || '?')[0].toUpperCase()}<span class="pkg-avatar-dot"></span></div>`).join('')
      + (extra > 0 ? `<div class="pkg-avatar more">+${extra}</div>` : '');
    return `
    <div class="pkg-card" data-id="${p.id}" style="animation-delay:${i * 18}ms">
      <div class="pkg-card-top">
        <div class="pkg-card-info">
          <div class="pkg-name">${esc(p.name)}</div>
          <div class="pkg-meta">${members.length} account${members.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="pkg-avatars">${avatarsHtml}</div>
        <div class="pkg-card-actions">
          <button class="btn btn-edit" onclick="openEditPackage('${p.id}')" title="Manage accounts">
            <span class="material-icons-round">group</span>
          </button>
          <button class="btn btn-del" onclick="deletePackage('${p.id}')" title="Delete package">
            <span class="material-icons-round">delete_outline</span>
          </button>
        </div>
      </div>
      <div class="pkg-link-row">
        <div class="pkg-link-field">
          <span class="material-icons-round pkg-link-icon">link</span>
          <input type="text" class="pkg-link-input" id="pkg-link-${p.id}" placeholder="Game ID or server link for everyone to join…"
            value="${esc(p.link || '')}" onchange="setPackageLink('${p.id}', this.value)"
            onkeydown="if(event.key==='Enter'){this.blur();launchPackage('${p.id}');}"/>
        </div>
        <button class="btn btn-launch pkg-launch-btn" onclick="launchPackage('${p.id}')" ${members.length ? '' : 'disabled'}>
          Launch All
        </button>
      </div>
      <div class="pkg-progress" id="pkg-progress-${p.id}"></div>
    </div>`;
  }).join('');
  packages.forEach(p => {
    (p.accountIds || []).slice(0, 6).forEach(id => {
      const m = accounts.find(a => a.id === id);
      if (m && m.userId) loadPkgAvatar(p.id, m.id, m.userId);
    });
  });
  refreshPkgAvatarStatus();
}

function openCreatePackage() {
  editingPackageId = null;
  document.getElementById('pkg-modal-title').textContent = 'New group';
  document.getElementById('in-pkg-name').value = '';
  renderPackagePicker([]);
  openModal('m-package');
  setTimeout(() => document.getElementById('in-pkg-name').focus(), 220);
}

function openEditPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  editingPackageId = id;
  document.getElementById('pkg-modal-title').textContent = 'Edit group';
  document.getElementById('in-pkg-name').value = p.name || '';
  renderPackagePicker(p.accountIds || []);
  openModal('m-package');
}

function renderPackagePicker(selectedIds) {
  const wrap = document.getElementById('pkg-account-picker');
  if (!accounts.length) {
    wrap.innerHTML = '<div class="pkg-pick-empty">No accounts yet. Add one from the Accounts tab first.</div>';
    updatePkgCount();
    return;
  }
  wrap.innerHTML = accounts.map(a => `
    <label class="pm-row">
      <input type="checkbox" value="${a.id}" ${selectedIds.includes(a.id) ? 'checked' : ''}/>
      <span class="pm-av">${esc((a.username || '?')[0].toUpperCase())}</span>
      <span class="pm-info">
        <span class="pm-name">${esc(a.nickname || a.username || 'Unknown')}</span>
        <span class="pm-meta">${a.userId ? 'ID ' + a.userId : 'No ID'}</span>
      </span>
      <span class="pm-check"><span class="material-icons-round">check</span></span>
    </label>`).join('');
  updatePkgCount();
}

function updatePkgCount() {
  const el = document.getElementById('pkg-count');
  if (!el) return;
  const n = document.querySelectorAll('#pkg-account-picker input:checked').length;
  el.textContent = n + ' selected';
}

function savePackageModal() {
  const name = document.getElementById('in-pkg-name').value.trim();
  if (!name) { toast('Give the group a name', 'err'); return; }
  const checked = Array.from(document.querySelectorAll('#pkg-account-picker input:checked')).map(c => c.value);
  if (editingPackageId) {
    const p = packages.find(x => x.id === editingPackageId);
    if (p) { p.name = name; p.accountIds = checked; }
  } else {
    packages.push({ id: Date.now().toString(), name, accountIds: checked, link: '' });
  }
  api.savePackages(packages);
  renderPackages();
  closeModal('m-package');
  toast('Group saved', 'ok');
}

function deletePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  confirmAction('Delete package "' + p.name + '"? The accounts themselves won\u2019t be removed.', () => {
    packages = packages.filter(x => x.id !== id);
    api.savePackages(packages);
    renderPackages();
    toast('Group deleted', 'err');
  });
}

function setPackageLink(id, value) {
  const p = packages.find(x => x.id === id); if (!p) return;
  p.link = value.trim();
  api.savePackages(packages);
}

async function launchPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = (p.accountIds || []).map(aid => accounts.find(a => a.id === aid)).filter(Boolean);
  if (!members.length) { toast('This group has no accounts yet', 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-launch-btn') : null;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching\u2026'; }
  if (progress) {
    progress.innerHTML = members.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  const link = (p.link || '').trim();
  let okCount = 0;
  await Promise.all(members.map(async (m) => {
    const target = link || m.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null, target: target || 'Roblox home' });
    const res = await api.launchRoblox(m.id, m.cookie, target);
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res.success) {
      okCount++;
      logEntry('ok', 'launch', `Launched as ${m.username || m.id} (package)`, { accountId: m.id, username: m.username || null });
      markLaunched(m.id);
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      chip.className = 'pkg-chip err';
      chip.title = res.error || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || '');
      _flagCookieMaybeDead(m.id, res.error);
    }
  }));

  if (btn) { btn.disabled = false; btn.innerHTML = 'Launch All'; }
  toast('Launched ' + okCount + '/' + members.length + ' accounts in "' + p.name + '"', okCount === members.length ? 'ok' : 'err');
}

function toggleKeyVisibility() {
  const input = document.getElementById('custom-key'), icon = document.getElementById('key-vis-icon');
  if (input.type === 'password') { input.type = 'text'; icon.textContent = 'visibility_off'; }
  else { input.type = 'password'; icon.textContent = 'visibility'; }
}
let _saveKeyTimer;
function onKeyInput() {
  const btn = document.getElementById('btn-save-key');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}
async function saveKeySettings() {
  const keyVal = document.getElementById('custom-key').value;
  const btn = document.getElementById('btn-save-key');
  if (btn.disabled) return;
  clearTimeout(_saveKeyTimer);
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  _saveKeyTimer = setTimeout(async () => {
    try {
      await api.saveSettings({ encryptionType: selectedEnc });
      // enc:setKey changes the key and re-encrypts accounts in one step.
      const r = await api.encSetKey(keyVal);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not update key');
      if (!keyVal.trim()) throw new Error('Encryption key cannot be empty.');
      settings.encryptionType = selectedEnc; settings.keySet = true;
      document.getElementById('custom-key').value = '';
      // Reload accounts so the renderer holds cookies under the new key.
      try { accounts = await api.loadAccounts(); render(); } catch {}
      toast('Encryption key updated', 'ok');
      applySettings();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }, 300);
}

function toggleDonutTokenVisibility() {
  const input = document.getElementById('donut-token'), icon = document.getElementById('donut-token-vis-icon');
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; icon.textContent = 'visibility_off'; }
  else { input.type = 'password'; icon.textContent = 'visibility'; }
}
function onDonutTokenInput() {
  const btn = document.getElementById('btn-save-donut-token');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}
// Persist a new Donut_API_Token (Req 9.2, 9.4). The plaintext value is sent once to
// the main process, which encrypts and stores it; the field is cleared afterward and
// only the configured boolean state is ever reflected back (Req 9.7).
async function saveDonutToken() {
  const input = document.getElementById('donut-token');
  const btn = document.getElementById('btn-save-donut-token');
  if (!input || !btn || btn.disabled) return;
  const tokenVal = input.value;
  if (!tokenVal.trim()) { toast('Enter a token, or use Clear to delete it', 'err'); return; }
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  try {
    const r = await api.saveDonutToken(tokenVal);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not save token');
    settings.donutApiTokenConfigured = !!r.donutApiTokenConfigured;
    input.value = '';
    toast('Donut API token saved', 'ok');
    applySettings();
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}
// Delete the stored Donut_API_Token (Req 9.5) by submitting an empty value.
async function clearDonutToken() {
  const input = document.getElementById('donut-token');
  try {
    const r = await api.saveDonutToken('');
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not clear token');
    settings.donutApiTokenConfigured = !!r.donutApiTokenConfigured;
    if (input) input.value = '';
    toast('Donut API token cleared', 'ok');
    applySettings();
  } catch (e) {
    toast('Clear failed: ' + e.message, 'err');
  }
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function setStatus(id, type, html) { const el = document.getElementById(id); el.className = 'mst ' + type; el.innerHTML = html; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg, type) {
  type = type || '';
  const el = document.getElementById('toast'), icon = type === 'ok' ? 'check_circle' : 'cancel';
  el.innerHTML = '<span class="material-icons-round">' + icon + '</span>' + esc(msg);
  el.className = 'toast show ' + type; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
}

async function refreshMultiStatus() {
  const s = await api.multiInstanceStatus();
  if (!s.enabled) { await api.saveSettings({ multiInstance: true }); settings.multiInstance = true; }
}

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('mousedown', e => {
    if (e.target === o && o.dataset.backdropClose === 'true') o.classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+F opens native-style find on the logs page.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && document.getElementById('page-logs')?.classList.contains('active')) {
    e.preventDefault(); openLogFind(); return;
  }
  // Find-bar keys: Enter = next, Shift+Enter = previous, Esc = close.
  if (e.target && e.target.id === 'log-find-input') {
    if (e.key === 'Enter') { e.preventDefault(); logFind(e.shiftKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeLogFind(); return; }
  }
  if (e.key === 'Escape') {
    const lf = document.getElementById('log-find');
    if (lf && lf.style.display !== 'none') { closeLogFind(); return; }
    closeAllCdd();
    const editEl = document.getElementById('m-edit');
    if (editEl.classList.contains('open')) {
      if (document.activeElement !== document.getElementById('in-target') && document.activeElement !== document.getElementById('in-nickname') && document.activeElement !== document.getElementById('in-notes')) closeModal('m-edit');
    } else document.querySelectorAll('.overlay.open').forEach(m => m.classList.remove('open'));
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openLogin(); }
  // "/" focuses the account search (when not already typing in a field).
  if (e.key === '/' && document.getElementById('page-accounts')?.classList.contains('active')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    document.getElementById('acct-search')?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('m-edit').classList.contains('open')) {
    e.preventDefault(); saveEdit();
  }
});

let chartTab = 'popular';
let allCharts = {};
let chartsLoaded = false;

function switchChartTab(tab) {
  chartTab = tab;
  document.querySelectorAll('#page-charts .tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const s = document.getElementById('chart-search'); if (s) s.value = '';
  _searchMode = false;
  if (chartsLoaded) renderCharts(allCharts[tab] || [], false);
}

async function loadCharts() {
  const grid = document.getElementById('charts-grid');
  const loading = document.getElementById('charts-loading');
  const empty = document.getElementById('charts-empty');
  chartsLoaded = false;
  grid.style.display = 'none'; empty.style.display = 'none'; loading.style.display = 'flex';

  try {
    // Use official Roblox explore-api with a random sessionId per load
    const [popular, trending, favorited] = await Promise.all([
      fetchRobloxGames('top-playing-now'),
      fetchRobloxGames('top-rated'),
      fetchRobloxGames('top-earning'),
    ]);
    allCharts = { popular, trending, favorited };
    chartsLoaded = true;
    loading.style.display = 'none';
    renderCharts(allCharts[chartTab] || [], false);
  } catch(e) {
    console.error('Charts load error:', e);
    loading.style.display = 'none';
    empty.style.display = 'flex';
  }
}

function randomGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchRobloxGames(sortId) {
  // Official Roblox explore API
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${sessionId}&sortId=${sortId}&device=computer&country=all`;
  const d = await api.robloxApiGet(url);
  if (!d) throw new Error('No data');

  // Response shape: { sorts: [{ games: [...] }] } or { games: [...] }
  const games = d.games || (d.sorts && d.sorts[0] && d.sorts[0].games) || [];
  if (!games.length) throw new Error('No games in response');

  // Fetch thumbnails for all universeIds
  let thumbMap = {};
  try {
    const universeIds = games.map(g => g.universeId).filter(Boolean).join(',');
    const thumbData = await api.robloxApiGet(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    ((thumbData && thumbData.data) || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
  } catch {}

  return games.map(g => ({
    universeId: g.universeId,
    placeId: g.rootPlaceId || g.placeId,
    name: g.name,
    playerCount: g.playerCount,
    thumbUrl: thumbMap[g.universeId] || ''
  }));
}

let _chartGameMap = {};
let _searchDebounce = null;
let _searchMode = false;

function renderCharts(games, searchMode) {
  const grid = document.getElementById('charts-grid');
  const emptyEl = document.getElementById('charts-empty');
  const loading = document.getElementById('charts-loading');
  loading.style.display = 'none';
  _chartGameMap = {};
  if (!games || !games.length) {
    emptyEl.style.display = 'flex';
    grid.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = games.map((g, i) => {
    _chartGameMap[i] = g;
    const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
    const rankLabel = searchMode ? `<div class="chart-card-rank">Search result</div>` : `<div class="chart-card-rank">#${i + 1}</div>`;
    const thumb = g.thumbUrl
      ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=chart-card-thumb-ph><span class=material-icons-round>videogame_asset</span></div>'"/>`
      : `<div class="chart-card-thumb-ph"><span class="material-icons-round">videogame_asset</span></div>`;
    return `<div class="chart-card" style="animation-delay:${i * 12}ms" onclick="openGameModal(${i})" title="View game info">
      ${thumb}
      <div class="chart-card-body">
        ${rankLabel}
        <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
        ${players ? `<div class="chart-card-stat"><span class="material-icons-round">people</span>${players}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function searchRobloxGames(query) {
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();

  // Extract game universe IDs from omni-search results
  const contents = d.searchResults || [];
  const gameSection = contents.find(s => s.contentGroupType === 'Game') || contents[0];
  if (!gameSection || !gameSection.contents) return [];

  const universeIds = gameSection.contents.map(c => c.contentId).filter(Boolean);
  if (!universeIds.length) return [];

  // Fetch full game details
  let details = { data: [] };
  try { details = (await api.robloxApiGet(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`)) || { data: [] }; } catch {}
  const detailMap = {};
  (details.data || []).forEach(g => { detailMap[g.id] = g; });

  // Fetch thumbnails
  let thumbMap = {};
  try {
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const td = await thumbRes.json();
      (td.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return universeIds.map(uid => {
    const det = detailMap[uid] || {};
    return {
      universeId: uid,
      placeId: det.rootPlaceId,
      name: det.name,
      playerCount: det.playing,
      thumbUrl: thumbMap[uid] || ''
    };
  }).filter(g => g.placeId);
}

function filterCharts(val) {
  clearTimeout(_searchDebounce);
  const query = val.trim();
  if (!query) {
    _searchMode = false;
    if (chartsLoaded) renderCharts(allCharts[chartTab] || [], false);
    else {
      document.getElementById('charts-grid').style.display = 'none';
      document.getElementById('charts-empty').style.display = 'none';
      document.getElementById('charts-loading').style.display = 'flex';
    }
    return;
  }
  _searchMode = true;
  _searchDebounce = setTimeout(async () => {
    const grid = document.getElementById('charts-grid');
    const loading = document.getElementById('charts-loading');
    const emptyEl = document.getElementById('charts-empty');
    grid.style.display = 'none';
    emptyEl.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const results = await searchRobloxGames(query);
      // Only apply if search box still has same value
      if (document.getElementById('chart-search').value.trim() === query) {
        renderCharts(results, true);
      }
    } catch(e) {
      console.error('Search error:', e);
      loading.style.display = 'none';
      emptyEl.style.display = 'flex';
    }
  }, 420);
}

let _gameModal = {};
function openGameModal(idx) {
  const g = _chartGameMap[idx];
  if (!g) return;
  _gameModal = g;
  const thumb = document.getElementById('game-modal-thumb');
  if (g.thumbUrl) { thumb.src = g.thumbUrl; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
  document.getElementById('game-modal-name').textContent = g.name || 'Unknown';
  document.getElementById('game-modal-id').textContent = g.placeId || '-';
  const stat = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing now' : '';
  document.getElementById('game-modal-stat').textContent = stat;
  openModal('m-game');
}
function copyGameId() {
  const id = String(_gameModal.placeId || '');
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => toast('Place ID copied', 'ok'));
}
function gamePageOpen() {
  if (_gameModal.placeId) api.openExternal('https://www.roblox.com/games/' + _gameModal.placeId);
}


// ── Mixer (graphics / fps / volume / kill) ─────────────────────────────────
// Graphics & FPS are written as global Fast Flags (one shared ClientAppSettings
// file → every instance reads them), so they apply to all instances on next
// launch. Volume is applied live to running clients via the OS audio mixer.
const FF_GFX = 'DFIntDebugFRMQualityLevelOverride';
const FF_FPS = 'DFIntTaskSchedulerTargetFps';
let _volTimer = null, _mixRunning = 0;

async function mixInit() {
  // Pull current values from saved Fast Flags + settings.
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}

  // Graphics
  const gfxRaw = flags[FF_GFX];
  const gfxAuto = (gfxRaw === undefined || gfxRaw === null || gfxRaw === '');
  document.getElementById('mix-gfx-auto').checked = gfxAuto;
  const gfxVal = clampInt(gfxRaw, 1, 21, 10);
  document.getElementById('mix-gfx').value = gfxVal;
  document.getElementById('mix-gfx-val').textContent = gfxAuto ? 'Auto' : gfxVal;
  document.getElementById('mix-gfx').disabled = gfxAuto;

  // FPS - read from GlobalBasicSettings_13.xml via new ipc
  try {
    const fpsCap = await api.readFpsCap();
    const fpsUnl = (fpsCap === 0);
    document.getElementById('mix-fps-unl').checked = fpsUnl;
    document.getElementById('mix-fps').value = fpsUnl ? 60 : Math.max(30, fpsCap || 60);
    document.getElementById('mix-fps-val').textContent = fpsUnl ? '\u221e' : (fpsCap || 60);
    document.getElementById('mix-fps').disabled = fpsUnl;
  } catch {}

  // Volume
  const vol = (typeof settings.masterVolume === 'number') ? settings.masterVolume : 100;
  document.getElementById('mix-vol').value = vol;
  document.getElementById('mix-vol-val').textContent = vol + '%';

  updateSliderFill(document.getElementById('mix-gfx'));
  updateSliderFill(document.getElementById('mix-fps'));
  updateSliderFill(document.getElementById('mix-vol'));
  mixRefreshRunning();
}

// FPS
function mixFpsInput(v) {
  document.getElementById('mix-fps-val').textContent = v;
  updateSliderFill(document.getElementById('mix-fps'));
}
function mixFpsUnlToggle() {
  const unl = document.getElementById('mix-fps-unl').checked;
  document.getElementById('mix-fps').disabled = unl;
  if (unl) {
    document.getElementById('mix-fps-val').textContent = '\u221e';
    api.writeFpsCap(0);
    toast('FPS set to unlimited (next launch)', 'ok');
  } else {
    mixFpsCommit();
  }
}
function mixFpsCommit() {
  if (document.getElementById('mix-fps-unl').checked) return;
  const v = parseInt(document.getElementById('mix-fps').value, 10);
  document.getElementById('mix-fps-val').textContent = v;
  api.writeFpsCap(v);
  toast('FPS cap: ' + v + ' (next launch)', 'ok');
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Updates both the Mixer badge and the always-visible titlebar badge (next to
// the Roblox version hash) so the running count shows everywhere, not just on
// the Mixer page. The titlebar badge goes "live" (green dot) when >0.
function setRunningBadges(n) {
  const txt = n + ' running';
  const tb = document.getElementById('tb-running');
  if (tb) {
    tb.textContent = txt;
    tb.classList.toggle('live', n > 0);
    tb.style.display = n > 0 ? 'inline-flex' : 'none';
  }
}

// Lightweight global poll so the titlebar counter stays current off the Mixer
// page too. Cheap (tasklist under the hood); 3s cadence matches the rest of UI.
let _runningPoll = null;
let _lastCountPushAt = 0;
async function pollRunningCount() {
  // main pushes the count every ~5s while watching; skip our own tasklist
  // call if one of those landed recently.
  if (Date.now() - _lastCountPushAt < 6500) return;
  let n = 0;
  try { n = await api.getRunningCount(); } catch { n = 0; }
  _mixRunning = n;
  setRunningBadges(n);
}
function startRunningPoll() {
  if (_runningPoll) return;
  pollRunningCount();
  _runningPoll = setInterval(pollRunningCount, 3000);
}

async function mixRefreshRunning() {
  try {
    _mixRunning = await api.getRunningCount();
  } catch { _mixRunning = 0; }
  setRunningBadges(_mixRunning);

  // If processes are running but we have no launched IDs (e.g. app restarted),
  // seed _launchedIds from accounts that have been used recently (last 2 hours).
  if (_mixRunning > 0 && _launchedIds.size === 0) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const recentAccounts = accounts.filter(a => a.lastUsed && new Date(a.lastUsed).getTime() > twoHoursAgo);
    const seed = recentAccounts.slice(0, _mixRunning);
    for (const a of seed) {
      markLaunched(a.id);
    }
  }
}

// Merge a single key into the on-disk Fast Flags without disturbing others.
async function mixWriteFlag(key, value) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  if (value === null) delete flags[key];
  else flags[key] = String(value);
  try { await api.writeFFlags(flags); } catch {}
}

// Smoothly fill the slider track up to the current value.
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, v = parseFloat(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background = 'linear-gradient(90deg, var(--ac) ' + pct + '%, var(--s4) ' + pct + '%)';
}

// Graphics
function mixGfxInput(v) {
  document.getElementById('mix-gfx-val').textContent = v;
  updateSliderFill(document.getElementById('mix-gfx'));
}
function mixGfxAutoToggle() {
  const auto = document.getElementById('mix-gfx-auto').checked;
  document.getElementById('mix-gfx').disabled = auto;
  if (auto) {
    document.getElementById('mix-gfx-val').textContent = 'Auto';
    mixWriteFlag(FF_GFX, null);
    toast('Graphics set to Auto', 'ok');
  } else {
    mixGfxCommit();
  }
}
function mixGfxCommit() {
  if (document.getElementById('mix-gfx-auto').checked) return;
  const v = document.getElementById('mix-gfx').value;
  document.getElementById('mix-gfx-val').textContent = v;
  mixWriteFlag(FF_GFX, v);
  toast('Graphics quality: ' + v + ' (next launch)', 'ok');
}

// Volume - applies live while dragging (debounced so we don't spawn the helper
// on every drag tick), and saves + confirms on release.
function mixVolInput(v) {
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  clearTimeout(_volTimer);
  _volTimer = setTimeout(() => { api.setRobloxVolume(parseInt(v, 10)); }, 90);
}
function mixVolCommit() {
  const v = parseInt(document.getElementById('mix-vol').value, 10);
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  settings.masterVolume = v;
  api.saveSettings({ masterVolume: v });
  clearTimeout(_volTimer);
  _volTimer = setTimeout(async () => {
    const res = await api.setRobloxVolume(v);
    if (res && res.ok) {
      toast('Volume ' + v + '%', 'ok');
    } else {
      toast('Couldn\u2019t set volume' + (res && res.error ? ': ' + res.error : ''), 'err');
    }
  }, 60);
}

// Kill all
async function mixKillAll() {
  const btns = Array.from(document.querySelectorAll('.kill-roblox-btn'));
  if (!btns.length || btns[0].disabled) return;
  btns.forEach(b => { b.disabled = true; b.dataset.orig = b.innerHTML; b.innerHTML = '<div class="spin"></div>Stopping\u2026'; });
  const res = await api.killAllRoblox();
  // Reset all dots / launched state.
  _launchedIds.clear();
  document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
  refreshPkgAvatarStatus();
  await mixRefreshRunning();
  btns.forEach(b => { b.disabled = false; b.innerHTML = b.dataset.orig; });
  if (res && res.ok) toast('All Roblox instances closed', 'ok');
  else toast('Kill failed' + (res && res.error ? ': ' + res.error : ''), 'err');
}

// Apply graphics/fps to instances that are already open by relaunching the
// accounts currently marked as launched (each with its saved target).
async function mixApplyAndRelaunch() {
  const btn = document.getElementById('mix-relaunch-btn');
  if (btn.disabled) return;

  // Re-check running count first so a fresh app session still works.
  await mixRefreshRunning();
  let ids = Array.from(_launchedIds);

  // If no tracked IDs but Roblox is actually running, fall back to recently
  // used accounts (sorted newest first, capped to running count).
  if (!ids.length && _mixRunning > 0) {
    const sorted = accounts
      .filter(a => a.lastUsed)
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed))
      .slice(0, _mixRunning);
    ids = sorted.map(a => a.id);
  }

  if (!ids.length) {
    toast('No running accounts to relaunch', 'err');
    return;
  }
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<div class="spin"></div>Relaunching\u2026';

  await api.killAllRoblox();
  _launchedIds.clear();
  document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
  refreshPkgAvatarStatus();

  // Give Roblox a moment to fully exit before relaunching.
  await new Promise(r => setTimeout(r, 1500));

  let ok = 0;
  for (const id of ids) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) continue;
    const res = await api.launchRoblox(acc.id, acc.cookie, acc.gameTarget || null);
    if (res && res.success) {
      ok++;
      markLaunched(acc.id);
    }
  }
  await mixRefreshRunning();
  btn.disabled = false;
  btn.innerHTML = orig;
  toast('Relaunched ' + ok + ' account' + (ok !== 1 ? 's' : '') + ' with new settings', ok ? 'ok' : 'err');
}


function genToggleKey() {
  const inp = document.getElementById('gen-apikey');
  const icon = document.getElementById('gen-eye-icon');
  if (inp.type === 'password') { inp.type = 'text'; icon.textContent = 'visibility_off'; }
  else { inp.type = 'password'; icon.textContent = 'visibility'; }
}

async function genCombo() {
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  try { localStorage.setItem('bloxgen_apikey', document.getElementById('gen-apikey').value); } catch {}
  if (!apiKey || !apiKey.startsWith('BLOX-')) {
    toast('Enter a valid BloxGen API key (starts with BLOX-)', 'err');
    return;
  }

  const btn = document.getElementById('gen-btn');
  const out = document.getElementById('gen-output');
  if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }

  try {
    const resp = await fetch('https://core.bloxgen.net/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, type: 'alt' })
    });
    const data = await resp.json();

    if (!data.success) {
      toast(data.message || data.error || 'Generation failed', 'err');
      if (btn) { btn.textContent = 'Generate'; btn.disabled = false; }
      return;
    }

    const d = data.data;
    out.value = d.username + ':' + d.password;
    out.select();

    // Store in history
    _lastGenData = d;
    _genHistory.unshift({ username: d.username, password: d.password, cookie: d.cookie });
    if (_genHistory.length > 500) _genHistory.length = 500; // bound the persisted history
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();

    // Copy cookie to clipboard if available, else username:password
    const toCopy = d.cookie || (d.username + ':' + d.password);
    navigator.clipboard.writeText(toCopy).catch(() => {});

    if (btn) { btn.textContent = 'Generate'; btn.disabled = false; }

  } catch (e) {
    toast('Network error: ' + e.message, 'err');
    if (btn) { btn.textContent = 'Generate'; btn.disabled = false; }
  }
}

let _genHistory = [];
let _lastGenData = null;

const GH_ITEM_H = 36;
const GH_VISIBLE = 4;
const GH_BATCH = 40;
let _ghRendered = 0;

function genRenderHistory() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  if (_genHistory.length === 0) { sc.style.display = 'none'; return; }
  sc.style.display = '';
  if (_genHistory.length > GH_VISIBLE) {
    list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  } else {
    list.style.maxHeight = '';
  }
  _ghRendered = 0;
  list.innerHTML = '';
  _ghAppendBatch(list);
  list.onscroll = () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 20) _ghAppendBatch(list);
  };
}

function _ghAppendBatch(list) {
  const end = Math.min(_ghRendered + GH_BATCH, _genHistory.length);
  if (_ghRendered >= end) return;
  const frag = document.createDocumentFragment();
  for (let i = _ghRendered; i < end; i++) {
    const h = _genHistory[i];
    const row = document.createElement('div');
    row.className = 'gen-hist-item';
    row.dataset.idx = i;
    row.innerHTML =
      '<span class="gh-user"><span style="color:var(--t3)">User:</span> ' + esc(h.username) + '  <span style="color:var(--t3)">Pass:</span> ' + esc(h.password) + '</span>' +
      '<div class="gh-actions">' +
        '<button class="btn btn-ghost" title="Copy combo"><span class="material-icons-round" style="font-size:15px">content_copy</span></button>' +
        '<button class="btn btn-ghost" title="Add to accounts"><span class="material-icons-round" style="font-size:15px">person_add</span></button>' +
      '</div>';
    const btns = row.querySelectorAll('button');
    btns[0].onclick = () => genHistCopy(i);
    btns[1].onclick = () => genHistAdd(i);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  _ghRendered = end;
}

function _ghPrepend() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  sc.style.display = '';
  if (_genHistory.length > GH_VISIBLE) list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  // Re-index existing rows so their onclick indices stay correct
  list.querySelectorAll('.gen-hist-item').forEach(row => {
    const old = +row.dataset.idx;
    const ni = old + 1;
    row.dataset.idx = ni;
    const btns = row.querySelectorAll('button');
    btns[0].onclick = () => genHistCopy(ni);
    btns[1].onclick = () => genHistAdd(ni);
  });
  _ghRendered++;
  const h = _genHistory[0];
  const row = document.createElement('div');
  row.className = 'gen-hist-item';
  row.dataset.idx = 0;
  row.innerHTML =
    '<span class="gh-user"><span style="color:var(--t3)">User:</span> ' + esc(h.username) + '  <span style="color:var(--t3)">Pass:</span> ' + esc(h.password) + '</span>' +
    '<div class="gh-actions">' +
      '<button class="btn btn-ghost" title="Copy combo"><span class="material-icons-round" style="font-size:15px">content_copy</span></button>' +
      '<button class="btn btn-ghost" title="Add to accounts"><span class="material-icons-round" style="font-size:15px">person_add</span></button>' +
    '</div>';
  const btns = row.querySelectorAll('button');
  btns[0].onclick = () => genHistCopy(0);
  btns[1].onclick = () => genHistAdd(0);
  list.insertBefore(row, list.firstChild);
  list.scrollTop = 0;
}

function genHistCopy(i) {
  const h = _genHistory[i];
  if (!h) return;
  navigator.clipboard.writeText(h.username + ':' + h.password).then(() => toast('Copied ' + h.username, 'ok'));
}

async function genHistAdd(i) {
  const h = _genHistory[i];
  if (!h || !h.cookie) { toast('No cookie available for this account', 'err'); return; }
  try {
    const res = await api.validateCookie(h.cookie);
    if (!res || !res.username) { toast('Cookie invalid or expired', 'err'); return; }
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: h.cookie, gameTarget: '', nickname: '' });
    if (a) { accounts.push(a); render(); toast('Added ' + res.username + ' to accounts', 'ok'); }
  } catch(e) { toast('Failed to add: ' + e.message, 'err'); }
}

async function genAddToAccounts() {
  if (!_lastGenData || !_lastGenData.cookie) { toast('No cookie available', 'err'); return; }
  const btn = document.getElementById('gen-add-btn');
  if (btn) { btn.disabled = true; }
  try {
    const res = await api.validateCookie(_lastGenData.cookie);
    if (!res || !res.username) { toast('Cookie invalid or expired', 'err'); if(btn)btn.disabled=false; return; }
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: _lastGenData.cookie, gameTarget: '', nickname: '' });
    if (a) { accounts.push(a); render(); toast('Added ' + res.username + ' to accounts!', 'ok'); }
    if(btn)btn.disabled=false;
  } catch(e) { toast('Failed: ' + e.message, 'err'); if(btn)btn.disabled=false; }
}

function genClearHistory() {
  _genHistory = [];
  _lastGenData = null;
  api.clearGenHistory().catch(() => {});
  genRenderHistory();
  toast('History cleared', 'ok');
}

function genDetailsCopy() {
  const details = document.getElementById('gen-details');
  const text = details ? details.innerText.replace('copy', '').trim() : '';
  if (!text) { toast('No details to copy', 'err'); return; }
  const btn = document.getElementById('gen-details-copy-btn');
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const s = btn.querySelector('span:last-child'); if(s){s.textContent='done'; setTimeout(()=>{s.textContent='details';},1500);} }
    toast('Details copied', 'ok');
  });
}

function genCopy() {
  const val = document.getElementById('gen-output').value;
  if (!val) { toast('Nothing to copy', 'err'); return; }
  const btn = document.getElementById('gen-copy-btn');
  navigator.clipboard.writeText(val).then(() => {
    if (btn) {
      const icon = btn.querySelector('.material-icons-round');
      if (icon) { icon.textContent = 'check'; setTimeout(() => { icon.textContent = 'content_copy'; }, 1500); }
    }
    toast('Copied to clipboard', 'ok');
  });
}

// ── Sound Effects ──────────────────────────────────────────────────────────
(function() {
  let _audioCtx = null;
  function _ctx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return _audioCtx;
  }

  // ── Synth helpers ─────────────────────────────────────────────────────────
  function _playBuf(buf, vol) {
    const ctx = _ctx();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(ctx.destination);
    src.start(); src.stop(ctx.currentTime + buf.duration);
  }

  function _makeBuf(durationSec, fillFn) {
    const ctx = _ctx();
    const sr = ctx.sampleRate;
    const len = Math.ceil(sr * durationSec);
    const buf = ctx.createBuffer(1, len, sr);
    fillFn(buf.getChannelData(0), sr, len);
    return buf;
  }

  function _noise(d) { return Math.random() * 2 - 1; }

  // ── Synth voice helpers ───────────────────────────────────────────────────
  function _osc(ctx, type, freq, t, duration, gainStart, gainEnd) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gainStart, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gainEnd, 0.0001), t + duration);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + duration + 0.005);
    return { o, g };
  }
  function _filt(ctx, type, freq, Q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (Q !== undefined) f.Q.value = Q;
    return f;
  }

  // ── Sound profiles ────────────────────────────────────────────────────────
  const SOUND_PROFILES = {
    clicky: {
      label: 'Clicky',
      icon: 'keyboard',
      desc: 'Cherry MX Blue - sharp tactile snap',
      play(vol) {
        const ctx = _ctx(); const t = ctx.currentTime;
        // 1) Sharp high-freq click transient (the "tick" of the leaf spring)
        const clickBuf = _makeBuf(0.008, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i / sr;
            d[i] = (_noise() * 0.7 + Math.sin(2*Math.PI*3200*x) * 0.3) * Math.exp(-x * 1800);
          }
        });
        const clickSrc = ctx.createBufferSource(); clickSrc.buffer = clickBuf;
        const hp1 = _filt(ctx, 'highpass', 3500);
        const g1 = ctx.createGain(); g1.gain.setValueAtTime(vol * 2.5, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.008);
        clickSrc.connect(hp1); hp1.connect(g1); g1.connect(ctx.destination);
        clickSrc.start(t); clickSrc.stop(t + 0.01);

        // 2) Mid-range body snap (plastic housing resonance)
        const snapBuf = _makeBuf(0.025, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i / sr;
            d[i] = (_noise() * 0.5 + Math.sin(2*Math.PI*1100*x) * 0.4 + Math.sin(2*Math.PI*2200*x) * 0.1)
                  * Math.exp(-x * 350);
          }
        });
        const snapSrc = ctx.createBufferSource(); snapSrc.buffer = snapBuf;
        const bp1 = _filt(ctx, 'bandpass', 1400, 1.2);
        const g2 = ctx.createGain(); g2.gain.setValueAtTime(vol * 1.8, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
        snapSrc.connect(bp1); bp1.connect(g2); g2.connect(ctx.destination);
        snapSrc.start(t); snapSrc.stop(t + 0.03);

        // 3) Low-end bottom-out thud
        const thudBuf = _makeBuf(0.035, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i / sr;
            d[i] = (_noise() * 0.3 + Math.sin(2*Math.PI*180*x) * 0.7) * Math.exp(-x * 180);
          }
        });
        const thudSrc = ctx.createBufferSource(); thudSrc.buffer = thudBuf;
        const lp1 = _filt(ctx, 'lowpass', 600);
        const g3 = ctx.createGain(); g3.gain.setValueAtTime(vol * 0.6, t + 0.004); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        thudSrc.connect(lp1); lp1.connect(g3); g3.connect(ctx.destination);
        thudSrc.start(t + 0.004); thudSrc.stop(t + 0.045);
      }
    },

    thocky: {
      label: 'Thocky',
      icon: 'piano',
      desc: 'NK Cream - deep marbly thud',
      play(vol) {
        const ctx = _ctx(); const t = ctx.currentTime;
        // 1) Deep pitched thud (stem hitting the bottom housing)
        const thudBuf = _makeBuf(0.12, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i / sr;
            // Pitch starts high and drops (impact character)
            const freq = 95 + 280 * Math.exp(-x * 60);
            d[i] = (Math.sin(2*Math.PI*freq*x) * 0.65
                  + Math.sin(2*Math.PI*freq*1.6*x) * 0.2
                  + _noise() * 0.15)
                  * Math.exp(-x * 65);
          }
        });
        const thudSrc = ctx.createBufferSource(); thudSrc.buffer = thudBuf;
        const lp2 = _filt(ctx, 'lowpass', 700);
        const g1 = ctx.createGain(); g1.gain.setValueAtTime(vol * 1.8, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        thudSrc.connect(lp2); lp2.connect(g1); g1.connect(ctx.destination);
        thudSrc.start(t); thudSrc.stop(t + 0.13);

        // 2) Soft high transient (muted click, not snappy)
        const transBuf = _makeBuf(0.015, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            d[i] = _noise() * Math.exp(-(i/sr) * 900);
          }
        });
        const transSrc = ctx.createBufferSource(); transSrc.buffer = transBuf;
        const bp2 = _filt(ctx, 'bandpass', 900, 0.7);
        const g2 = ctx.createGain(); g2.gain.setValueAtTime(vol * 0.7, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
        transSrc.connect(bp2); bp2.connect(g2); g2.connect(ctx.destination);
        transSrc.start(t); transSrc.stop(t + 0.02);

        // 3) Low frequency body resonance for that "marble" feel
        const resBuf = _makeBuf(0.08, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i/sr;
            d[i] = Math.sin(2*Math.PI*55*x) * Math.exp(-x * 90) * 0.9;
          }
        });
        const resSrc = ctx.createBufferSource(); resSrc.buffer = resBuf;
        const lp3 = _filt(ctx, 'lowpass', 200);
        const g3 = ctx.createGain(); g3.gain.setValueAtTime(vol * 0.9, t); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        resSrc.connect(lp3); lp3.connect(g3); g3.connect(ctx.destination);
        resSrc.start(t); resSrc.stop(t + 0.09);
      }
    },

    creamy: {
      label: 'Creamy',
      icon: 'water_drop',
      desc: 'Gateron Yellow - buttery smooth glide',
      play(vol) {
        const ctx = _ctx(); const t = ctx.currentTime;
        // 1) Very soft initial contact (no click, just smooth compression)
        const softBuf = _makeBuf(0.07, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i / sr;
            const freq = 130 + 100 * Math.exp(-x * 40);
            d[i] = (Math.sin(2*Math.PI*freq*x) * 0.55
                  + Math.sin(2*Math.PI*freq*2.1*x) * 0.25
                  + Math.sin(2*Math.PI*freq*3.3*x) * 0.12
                  + _noise() * 0.08)
                  * Math.exp(-x * 110);
          }
        });
        const softSrc = ctx.createBufferSource(); softSrc.buffer = softBuf;
        const bp3 = _filt(ctx, 'bandpass', 280, 0.6);
        const g1 = ctx.createGain(); g1.gain.setValueAtTime(vol * 1.6, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        softSrc.connect(bp3); bp3.connect(g1); g1.connect(ctx.destination);
        softSrc.start(t); softSrc.stop(t + 0.075);

        // 2) Very subtle air/brush noise (lubed stem feel)
        const brushBuf = _makeBuf(0.05, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            d[i] = _noise() * Math.exp(-(i/sr) * 200) * 0.5;
          }
        });
        const brushSrc = ctx.createBufferSource(); brushSrc.buffer = brushBuf;
        const bp4 = _filt(ctx, 'bandpass', 500, 1.5);
        const g2 = ctx.createGain(); g2.gain.setValueAtTime(vol * 0.3, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        brushSrc.connect(bp4); bp4.connect(g2); g2.connect(ctx.destination);
        brushSrc.start(t); brushSrc.stop(t + 0.06);

        // 3) Warm low-end resonance
        const warmBuf = _makeBuf(0.06, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i/sr;
            d[i] = (Math.sin(2*Math.PI*70*x) * 0.6 + Math.sin(2*Math.PI*140*x) * 0.4)
                  * Math.exp(-x * 140);
          }
        });
        const warmSrc = ctx.createBufferSource(); warmSrc.buffer = warmBuf;
        const lp4 = _filt(ctx, 'lowpass', 350);
        const g3 = ctx.createGain(); g3.gain.setValueAtTime(vol * 1.0, t); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        warmSrc.connect(lp4); lp4.connect(g3); g3.connect(ctx.destination);
        warmSrc.start(t); warmSrc.stop(t + 0.07);
      }
    },

    poppy: {
      label: 'Poppy',
      icon: 'bubble_chart',
      desc: 'Light airy pop',
      play(vol) {
        const ctx = _ctx(); const t = ctx.currentTime;
        const buf = _makeBuf(0.025, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i/sr;
            d[i] = _noise() * Math.exp(-x*1100);
          }
        });
        const src = ctx.createBufferSource(); src.buffer = buf;
        const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1800; bp.Q.value=1.2;
        const g = ctx.createGain(); g.gain.setValueAtTime(vol*1.8, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.025);
        src.connect(bp); bp.connect(g); g.connect(ctx.destination);
        src.start(t); src.stop(t+0.025);
      }
    },

    typewriter: {
      label: 'Typewriter',
      icon: 'article',
      desc: 'Vintage key rattle',
      play(vol) {
        const ctx = _ctx(); const t = ctx.currentTime;
        // Main strike
        const buf = _makeBuf(0.035, (d, sr) => {
          for (let i = 0; i < d.length; i++) {
            const x = i/sr;
            d[i] = _noise() * Math.exp(-x*350)
                 + Math.sin(2*Math.PI*280*x) * Math.exp(-x*500) * 0.5;
          }
        });
        const src = ctx.createBufferSource(); src.buffer = buf;
        const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1500;
        const g = ctx.createGain(); g.gain.setValueAtTime(vol*1.6, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.035);
        src.connect(hp); hp.connect(g); g.connect(ctx.destination);
        src.start(t); src.stop(t+0.035);
        // rattle tail
        const buf2 = _makeBuf(0.02, (d, sr) => {
          for (let i = 0; i < d.length; i++) d[i] = _noise() * Math.exp(-(i/sr)*500);
        });
        const src2 = ctx.createBufferSource(); src2.buffer = buf2;
        const hp2 = ctx.createBiquadFilter(); hp2.type='highpass'; hp2.frequency.value=2500;
        const g2 = ctx.createGain(); g2.gain.setValueAtTime(vol*0.5, t+0.018); g2.gain.exponentialRampToValueAtTime(0.001, t+0.038);
        src2.connect(hp2); hp2.connect(g2); g2.connect(ctx.destination);
        src2.start(t+0.018); src2.stop(t+0.04);
      }
    },

    off: {
      label: 'Off',
      icon: 'volume_off',
      desc: 'No sound',
      play() {}
    }
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let _currentProfile = 'clicky';
  let _volume = 0.35;

  try {
    const saved = localStorage.getItem('sound-profile');
    if (saved && SOUND_PROFILES[saved]) _currentProfile = saved;
    const sv = localStorage.getItem('sound-volume');
    if (sv !== null) _volume = parseFloat(sv);
  } catch {}

  // ── Play current ──────────────────────────────────────────────────────────
  window._soundPlay = function() {
    if (_currentProfile.startsWith('__custom__')) {
      const cid = _currentProfile.slice('__custom__'.length);
      const s = _customSounds.find(x => x.id === cid);
      if (s) _playBuf(s.buffer, _volume);
    } else if (SOUND_PROFILES[_currentProfile]) {
      SOUND_PROFILES[_currentProfile].play(_volume);
    }
  };

  // ── Click listener ────────────────────────────────────────────────────────
  const INTERACTIVE = [
    'button','a','.nav-item','.card','.card-add','.theme-card',
    '.tb-btn','.btn','.filter-menu button','.chart-card',
    '[role="button"]','.cdd-trigger','.cdd-option','.pkg-launch-btn',
    'input[type="checkbox"]','input[type="radio"]','.nav-add',
    '.gen-hist-row','.modal-close','.modal .btn','.sound-card'
  ].join(',');

  document.addEventListener('click', e => {
    if (e.target.closest(INTERACTIVE)) window._soundPlay();
  }, true);

  // ── Multi-custom sounds state ─────────────────────────────────────────────
  // _customSounds: Array<{ id: string, name: string, buffer: AudioBuffer }>
  let _customSounds = [];
  let _customSoundIdCounter = 0;

  function _saveCustomSoundMeta() {
    try {
      localStorage.setItem('sound-customs-meta', JSON.stringify(
        _customSounds.map(s => ({ id: s.id, name: s.name }))
      ));
    } catch {}
  }

  // ── Sounds page UI ────────────────────────────────────────────────────────
  window.soundRenderPage = function() {
    const grid = document.getElementById('sound-cards-grid');
    if (!grid) return;

    // Built-in profile cards
    const builtinHtml = Object.entries(SOUND_PROFILES).map(([id, p]) => `
      <div class="sound-card ${_currentProfile === id ? 'sel' : ''}" data-sid="${id}" onclick="soundSelect('${id}')">
        <div class="sound-card-icon"><span class="material-icons-round">${p.icon}</span></div>
        <div class="sound-card-label">${p.label}</div>
        <div class="sound-card-desc">${p.desc}</div>
        <button class="sound-card-preview" onclick="event.stopPropagation();soundPreview('${id}')" title="Preview">
          <span class="material-icons-round">play_arrow</span>
        </button>
      </div>`).join('');

    // Custom sound cards (one per uploaded sound)
    const customHtml = _customSounds.map(s => `
      <div class="sound-card ${_currentProfile === '__custom__' + s.id ? 'sel' : ''}" onclick="soundSelectCustom('${s.id}')">
        <div class="sound-card-icon"><span class="material-icons-round">audiotrack</span></div>
        <div class="sound-card-label" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px" title="${s.name}">${s.name}</div>
        <div class="sound-card-desc">Custom sound</div>
        <div style="display:flex;gap:4px;margin-top:auto">
          <button class="sound-card-preview" onclick="event.stopPropagation();soundPreviewCustom('${s.id}')" title="Preview">
            <span class="material-icons-round">play_arrow</span>
          </button>
          <button class="sound-card-preview" onclick="event.stopPropagation();soundDeleteCustom('${s.id}')" title="Delete" style="background:rgba(255,80,80,.15);color:#ff6b6b">
            <span class="material-icons-round icon-delete">delete</span>
          </button>
        </div>
      </div>`).join('');

    grid.innerHTML = builtinHtml + customHtml;

    const slider = document.getElementById('sound-vol-slider');
    if (slider) slider.value = Math.round(_volume * 100);
    const lbl = document.getElementById('sound-vol-val');
    if (lbl) lbl.textContent = Math.round(_volume * 100) + '%';
  };

  window.soundSelect = function(id) {
    _currentProfile = id;
    try { localStorage.setItem('sound-profile', id); } catch {}
    soundRenderPage();
    SOUND_PROFILES[id]?.play(_volume);
  };

  window.soundSelectCustom = function(cid) {
    const s = _customSounds.find(x => x.id === cid);
    if (!s) return;
    _currentProfile = '__custom__' + cid;
    try { localStorage.setItem('sound-profile', '__custom__' + cid); } catch {}
    soundRenderPage();
    _playBuf(s.buffer, _volume);
  };

  window.soundPreview = function(id) {
    SOUND_PROFILES[id]?.play(_volume);
  };

  window.soundPreviewCustom = function(cid) {
    const s = _customSounds.find(x => x.id === cid);
    if (s) _playBuf(s.buffer, _volume);
  };

  window.soundDeleteCustom = function(cid) {
    const idx = _customSounds.findIndex(x => x.id === cid);
    if (idx === -1) return;
    _customSounds.splice(idx, 1);
    // If deleted sound was active, switch to clicky
    if (_currentProfile === '__custom__' + cid) {
      _currentProfile = 'clicky';
      try { localStorage.setItem('sound-profile', 'clicky'); } catch {}
    }
    _saveCustomSoundMeta();
    soundRenderPage();
    toast('Custom sound removed', 'ok');
  };

  window.soundVolChange = function(val) {
    _volume = val / 100;
    try { localStorage.setItem('sound-volume', _volume); } catch {}
    const lbl = document.getElementById('sound-vol-val');
    if (lbl) lbl.textContent = val + '%';
  };

  window.soundPickCustom = function() {
    document.getElementById('sound-file-input')?.click();
  };

  window.soundFileLoaded = function(input) {
    const file = input.files[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, ''); // strip extension
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const ctx = _ctx();
        const buffer = await ctx.decodeAudioData(e.target.result);
        const cid = 'c' + (++_customSoundIdCounter);
        _customSounds.push({ id: cid, name, buffer });
        _currentProfile = '__custom__' + cid;
        try { localStorage.setItem('sound-profile', '__custom__' + cid); } catch {}
        _saveCustomSoundMeta();
        soundRenderPage();
        _playBuf(buffer, _volume);
        toast('Custom sound loaded!', 'ok');
      } catch {
        toast('Could not decode audio file', 'err');
      }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
  };

  // soundRenderPage is called by settingsTab('sounds') via goTo redirect

  // Restore custom sound IDs from storage (buffers can't be persisted, just names for display)
  try {
    const meta = localStorage.getItem('sound-customs-meta');
    if (meta) {
      const arr = JSON.parse(meta);
      _customSoundIdCounter = arr.length;
      // Note: AudioBuffers can't be stored in localStorage. Show names but they will need re-upload.
    }
  } catch {}

  // Handle legacy single custom sound profile key
  try {
    const saved = localStorage.getItem('sound-profile');
    if (saved && saved.startsWith('__custom__') && !_customSounds.length) {
      _currentProfile = 'clicky';
      try { localStorage.setItem('sound-profile', 'clicky'); } catch {}
    }
  } catch {}

})();
