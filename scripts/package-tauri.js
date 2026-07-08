// Packaging pipeline for the Tauri_Build (Requirement 12.x).
//
// This script produces the single portable Windows x64 executable for the
// Tauri backend. It intentionally does NOT use Tauri's bundler/NSIS/MSI
// installer output (Requirement 12.1 requires a single PORTABLE .exe, not an
// installer). Instead it builds the raw release binary with cargo and (in a
// later step) copies it into `dist/`.
//
// Pipeline order (this file, Task 19.1):
//   1. Native_Helper build step  -> runs scripts/build-native.js so
//      src/RobloxNative.exe is (re)compiled BEFORE the Rust build. This mirrors
//      the Electron_Build's npm `prebuild` lifecycle and satisfies Requirement
//      12.5 (invoke the Native_Helper build step before packaging) and
//      Requirement 9.2 (prebuild the native helper).
//   2. Release build            -> `cargo build --release
//      --target x86_64-pc-windows-msvc` inside `src-tauri/`, yielding
//      src-tauri/target/x86_64-pc-windows-msvc/release/robloxaccountmanager.exe.
//
// build-native.js is intentionally non-fatal (it warns + exits 0 when csc/host
// is unavailable); we preserve that behavior here and do not modify it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUST_TARGET = 'x86_64-pc-windows-msvc';

const projectRoot = path.join(__dirname, '..');
const buildNativeScript = path.join(__dirname, 'build-native.js');
const srcTauriDir = path.join(projectRoot, 'src-tauri');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

// Source-of-truth locations for the packaging assembly (Task 19.2).
const electronIcon = path.join(srcDir, 'icon.ico'); // the icon the Electron_Build embedded (Req 12.4)
const tauriIcon = path.join(srcTauriDir, 'icons', 'icon.ico'); // what bundle.icon points at / cargo embeds
const releaseBinary = path.join(srcTauriDir, 'target', RUST_TARGET, 'release', 'robloxaccountmanager.exe');
const nativeExeSrc = path.join(srcDir, 'RobloxNative.exe');
const nativeCsSrc = path.join(srcDir, 'RobloxNative.cs');

function fail(message) {
  console.error('[package-tauri] ' + message);
  process.exit(1);
}

// Byte-compare two files (size first, then full content). Returns false if
// either path is missing.
function filesIdentical(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    return false;
  }
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) {
    return false;
  }
  return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
}

// Copy `from` -> `to`, failing the build (non-zero exit) if the source is
// absent. `label` is used only for log/error messages.
function copyRequired(from, to, label) {
  if (!fs.existsSync(from)) {
    fail('required ' + label + ' not found at ' + from + '. Cannot assemble dist/.');
  }
  fs.copyFileSync(from, to);
  console.log('[package-tauri]   ' + label + ': ' + from + ' -> ' + to);
}

// Req 9.3 / 12.6 (Native_Helper present + consistent with bundled source):
// After the Native_Helper build step (scripts/build-native.js) runs, verify the
// compiled executable is present AND consistent with the CURRENT
// `RobloxNative.cs` source before we spend time on the cargo release build or
// assemble dist/. Fails the build (non-zero exit) otherwise.
//
// Consistency check semantics (documented, Req 9.3):
//   - Source missing  -> FAIL (Req 9.3: source absent).
//   - Executable missing -> FAIL. build-native.js recompiles the exe from the
//     current source at the top of this pipeline; if the exe is still absent,
//     the compile failed AND no valid prebuilt executable exists.
//   - Executable OLDER than the source -> FAIL. A valid exe must have been
//     produced by compiling the present `RobloxNative.cs`, so it must be at
//     least as new as that source (exe.mtime >= cs.mtime). A stale exe (older
//     than the source) proves it was not produced from the bundled source and
//     is therefore inconsistent.
// This mtime-based freshness check is a practical, faithful proxy for "the
// packaged executable was produced by compiling the bundled RobloxNative.cs"
// without re-running csc here. Takes explicit paths so it is unit-testable.
function assertNativeHelperConsistent(exePath, csPath) {
  if (!fs.existsSync(csPath)) {
    fail('Native_Helper source not found at ' + csPath +
      '. Req 9.3 requires the bundled RobloxNative.cs; cannot package without it.');
  }
  if (!fs.existsSync(exePath)) {
    fail('Native_Helper executable not found at ' + exePath +
      '. The Native_Helper build step did not produce it and no valid prebuilt ' +
      'executable exists (Req 9.3 / 12.6). Failing the build rather than shipping ' +
      'a distributable missing the Native_Helper.');
  }
  const exeMtime = fs.statSync(exePath).mtimeMs;
  const csMtime = fs.statSync(csPath).mtimeMs;
  if (exeMtime < csMtime) {
    fail('Native_Helper executable at ' + exePath + ' is OLDER than its source ' +
      csPath + ' (exe mtime ' + new Date(exeMtime).toISOString() +
      ' < source mtime ' + new Date(csMtime).toISOString() + '). The packaged ' +
      'executable is inconsistent with the bundled RobloxNative.cs (Req 9.3): it ' +
      'was not produced from the present source. Failing the build.');
  }
  console.log('[package-tauri] Native_Helper consistency OK: ' +
    path.basename(exePath) + ' (mtime ' + new Date(exeMtime).toISOString() +
    ') is at least as new as ' + path.basename(csPath) + ' (mtime ' +
    new Date(csMtime).toISOString() + ') -> produced from the bundled source (Req 9.3).');
}

// Req 12.4 (icon embedding): the icon Tauri/winres embeds into the compiled
// exe comes from tauri.conf.json's `bundle.icon` (src-tauri/icons/icon.ico),
// read at cargo-build time via build.rs. To guarantee the embedded icon is the
// SAME one the Electron_Build shipped (src/icon.ico), we mirror src/icon.ico
// into src-tauri/icons/icon.ico BEFORE the release build runs. This keeps the
// local icons/ layout `cargo build` expects while making the embedded icon
// byte-identical to the Electron icon. If the two already match, this is a
// no-op. A missing Electron icon is a hard failure (icon embed cannot satisfy
// Req 12.4).
function ensureElectronIconEmbedded() {
  if (!fs.existsSync(electronIcon)) {
    fail('Electron application icon not found at ' + electronIcon + ' (Req 12.4 requires embedding the same icon).');
  }
  if (filesIdentical(electronIcon, tauriIcon)) {
    console.log('[package-tauri] embedded icon already matches Electron icon (' + electronIcon + ').');
    return;
  }
  fs.mkdirSync(path.dirname(tauriIcon), { recursive: true });
  fs.copyFileSync(electronIcon, tauriIcon);
  console.log('[package-tauri] synced Electron icon into build icon: ' + electronIcon + ' -> ' + tauriIcon + ' (Req 12.4).');
}

// Req 12.3 (asInvoker / no elevation): assert the produced exe does not request
// UAC elevation. Windows exes store their application manifest as an embedded
// RT_MANIFEST resource in plain text, so we scan the binary for a
// `requestedExecutionLevel` entry and reject `requireAdministrator` /
// `highestAvailable`. `asInvoker` (or no requestedExecutionLevel at all) means
// no elevation is requested, which is the MSVC/Tauri default. Fails the build
// (non-zero exit) if elevation IS requested.
function assertNoElevation(exePath) {
  const text = fs.readFileSync(exePath).toString('latin1');
  const reqIdx = text.search(/requestedExecutionLevel/i);
  if (reqIdx === -1) {
    console.log('[package-tauri] no-elevation check: no requestedExecutionLevel manifest entry present -> no elevation requested (asInvoker default). OK.');
    return;
  }
  const window = text.slice(reqIdx, reqIdx + 400);
  const levelMatch = window.match(/level\s*=\s*"([^"]+)"/i);
  const level = levelMatch ? levelMatch[1].toLowerCase() : null;
  if (level === 'requireadministrator' || level === 'highestavailable' ||
      /requireAdministrator|highestAvailable/i.test(text)) {
    fail('no-elevation check FAILED: embedded manifest requests elevation' +
      (level ? ' (requestedExecutionLevel="' + level + '")' : '') +
      '. Req 12.3 requires asInvoker (no admin-elevation prompt).');
  }
  console.log('[package-tauri] no-elevation check: requestedExecutionLevel="' +
    (level || 'asInvoker') + '" -> no elevation requested. OK.');
}

// -- Packaging pipeline entry point ------------------------------------------
// Wrapped in main() so the helper functions above can be require()'d and
// unit-tested without triggering the Native_Helper build + cargo release build.
// When run as a CLI (`node scripts/package-tauri.js`) the guard at the bottom
// invokes main(), preserving the original top-to-bottom behavior exactly.
function main() {
// -- Step 1: Native_Helper build step (prebuild-before-packaging) ------------
// Run build-native.js in a child Node process using the SAME node executable
// that is running this script. build-native.js is non-fatal by design, so a
// missing csc/non-Windows host will not stop packaging here on its own. What
// makes packaging FAIL (Task 19.3) is the outcome check that follows: if the
// build step leaves no valid RobloxNative.exe, we fail the build.
console.log('[package-tauri] running Native_Helper build step (scripts/build-native.js) ...');
const nativeResult = spawnSync(process.execPath, [buildNativeScript], {
  stdio: 'inherit',
  cwd: projectRoot,
});

if (nativeResult.error) {
  // The Node process itself could not be spawned/ran. build-native.js's own
  // logic never throws to here; this is an environment problem. Not fatal by
  // itself - the consistency check below decides based on the actual outcome
  // (is there a valid, fresh RobloxNative.exe?).
  console.warn('[package-tauri] Native_Helper build step could not run: ' + nativeResult.error.message);
} else if (typeof nativeResult.status === 'number' && nativeResult.status !== 0) {
  // build-native.js always exits 0 by contract; a non-zero here is unexpected.
  console.warn('[package-tauri] Native_Helper build step exited with code ' + nativeResult.status + ' (verifying outcome).');
}

// -- Step 1a: Native_Helper outcome + consistency gate (Req 9.3 / 12.6) ------
// Runs BEFORE the long cargo build so the pipeline fails fast, and well before
// any dist/ assembly so a failure never produces a partial distributable.
// FAILS the build if RobloxNative.exe is missing (build step failed with no
// valid prebuilt exe) or is inconsistent with (older than) the bundled
// RobloxNative.cs source.
console.log('[package-tauri] verifying Native_Helper executable exists and is consistent with RobloxNative.cs (Req 9.3) ...');
assertNativeHelperConsistent(nativeExeSrc, nativeCsSrc);

// -- Step 1b: Icon embedding prep (Req 12.4 / 12.6) --------------------------
// Must run BEFORE the release build so cargo/winres embeds the Electron icon.
// ensureElectronIconEmbedded() hard-fails (process.exit) when src/icon.ico is
// absent. We additionally wrap it so that ANY unexpected error while preparing
// the embedded icon (e.g. a failed mkdir/copy) fails the build with a clear
// message and non-zero exit, rather than silently continuing to build an exe
// without the correct embedded icon (Req 12.6).
console.log('[package-tauri] ensuring Electron application icon is the embedded icon (Req 12.4) ...');
try {
  ensureElectronIconEmbedded();
} catch (err) {
  fail('icon embedding step failed (Req 12.4 / 12.6): ' + (err && err.message ? err.message : String(err)) +
    '. Failing the build rather than producing a distributable without the correct embedded icon.');
}

// -- Step 2: Rust release build ----------------------------------------------
const cargoArgs = ['build', '--release', '--target', RUST_TARGET];
console.log('[package-tauri] building Tauri release binary: cargo ' + cargoArgs.join(' ') + ' (cwd: ' + srcTauriDir + ')');
const cargoResult = spawnSync('cargo', cargoArgs, {
  stdio: 'inherit',
  cwd: srcTauriDir,
});

if (cargoResult.error) {
  fail('failed to invoke cargo (' + cargoResult.error.message + '). Is the Rust toolchain installed and on PATH?');
}
if (cargoResult.status !== 0) {
  fail('cargo build failed (exit ' + cargoResult.status + ').');
}

console.log('[package-tauri] cargo release build complete.');

// -- Step 3: Assemble the portable distributable under dist/ -----------------
// (Task 19.2) The distributable is a single portable exe (Req 12.1) placed
// directly under the project's dist/ (Req 12.2), accompanied by the two
// Native_Helper sidecar files (RobloxNative.exe + RobloxNative.cs, Req 9.2).

// 3a. dist/ must exist. Create it if missing.
fs.mkdirSync(distDir, { recursive: true });

// 3b. Clean ONLY this pipeline's own prior outputs so dist/ ends up with
// exactly the intended set. We deliberately scope removals to these three
// packaging outputs and never wipe unrelated files in dist/.
const distRobloxAccountManager = path.join(distDir, 'RobloxAccountManager.exe');
const distNativeExe = path.join(distDir, 'RobloxNative.exe');
const distNativeCs = path.join(distDir, 'RobloxNative.cs');
for (const stale of [distRobloxAccountManager, distNativeExe, distNativeCs]) {
  if (fs.existsSync(stale)) {
    fs.rmSync(stale, { force: true });
  }
}

// 3c. Copy the release binary -> dist/RobloxAccountManager.exe (Req 12.1). Fail if the
// cargo build did not produce it.
if (!fs.existsSync(releaseBinary)) {
  fail('release binary not found at ' + releaseBinary + '. Did cargo build succeed for target ' + RUST_TARGET + '?');
}
fs.copyFileSync(releaseBinary, distRobloxAccountManager);
console.log('[package-tauri] copied portable exe: ' + releaseBinary + ' -> ' + distRobloxAccountManager);

// 3d. Copy the Native_Helper sidecars alongside the app (Req 9.2). Existence
// and .exe<->.cs consistency were already enforced in Step 1a
// (assertNativeHelperConsistent); copyRequired re-checks existence defensively.
copyRequired(nativeExeSrc, distNativeExe, 'Native_Helper executable (RobloxNative.exe)');
copyRequired(nativeCsSrc, distNativeCs, 'Native_Helper source (RobloxNative.cs)');

// -- Step 4: Assert no elevation manifest (Req 12.3 / asInvoker) --------------
console.log('[package-tauri] verifying ' + path.basename(distRobloxAccountManager) + ' requests no admin elevation (Req 12.3) ...');
assertNoElevation(distRobloxAccountManager);

// -- Step 5: Success summary -------------------------------------------------
console.log('');
console.log('[package-tauri] SUCCESS - portable distributable assembled in ' + distDir + ':');
for (const f of [distRobloxAccountManager, distNativeExe, distNativeCs]) {
  const size = fs.statSync(f).size;
  console.log('[package-tauri]   ' + path.basename(f) + '  (' + size + ' bytes)');
}
console.log('[package-tauri] embedded icon: ' + electronIcon + ' (Req 12.4); execution level: asInvoker / no elevation (Req 12.3).');
}

// Run the pipeline only when invoked directly as a CLI. When require()'d (e.g.
// by tests), only the exported helpers are loaded.
if (require.main === module) {
  main();
}

module.exports = {
  filesIdentical,
  copyRequired,
  ensureElectronIconEmbedded,
  assertNativeHelperConsistent,
  assertNoElevation,
  paths: { electronIcon, tauriIcon, releaseBinary, nativeExeSrc, nativeCsSrc, distDir },
};
