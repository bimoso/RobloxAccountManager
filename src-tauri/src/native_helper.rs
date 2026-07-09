//! Native_Helper (`RobloxNative.exe`) integration, ported from the legacy JS backend's
//! native-helper section.
//!
//! Task 9.1 implements [`ensure_native_helper`] — the three-step resolution that
//! produces a usable `RobloxNative.exe` path (or an error when none can be
//! produced). Task 9.2 (this file's second half) implements the process
//! lifecycle that runs on top of it: the persistent mutex holder
//! ([`start_mutex_holder`] / [`stop_mutex_holder`] / [`restart_mutex_holder`])
//! and the short-lived per-invocation helpers ([`set_roblox_volume`],
//! [`close_singleton_handles`], [`start_anti_afk`] / [`stop_anti_afk`]), each
//! `tokio::time::timeout`-guarded (Requirement 7.4). The structured stdout/stderr
//! marker parser (Task 9.3) and the command layer (Task 9.7) build on top of
//! these later.
//!
//! ## Process lifecycle port (the legacy JS backend → Task 9.2)
//!
//! The legacy JS build spawns `RobloxNative.exe` in two distinct shapes, which
//! this module reproduces with `tokio::process`:
//!
//! * **Persistent** — the `mutex` subcommand prints `MUTEX_HELD` then blocks,
//!   holding `ROBLOX_singletonMutex` for the whole session. `startMutexHolder`
//!   spawns it once, resolves readiness on `MUTEX_HELD` (with an 8s safety
//!   fallback), and stores the child handle so `stopMutexHolder` can kill it and
//!   `restartMutexHolder` (only ever called after Roblox is verified fully
//!   closed) can re-squat the kernel objects from a clean slate. The anti-AFK
//!   loop (`antiafk <seconds>`) is likewise a long-lived child stored in state.
//! * **Short-lived** — `volume <pct>` (prints `SET:<count>`) and `closehandles`
//!   (prints `HANDLES_DONE`) are spawned per invocation, read to completion, and
//!   torn down.
//!
//! Every wait in both shapes is bounded by a `tokio::time::timeout` so a hung or
//! unexpectedly-terminated helper can never leave a caller awaiting forever
//! (Requirement 7.4) — the Rust analogue of the legacy JS build's per-spawn
//! `setTimeout(..., N)` safety guards (mutex 8s, volume 12s, closehandles 4s).
//!
//! ## Ported behavior
//!
//! The legacy JS build's `ensureNativeHelper()` (the legacy JS backend) resolves the
//! helper executable in three steps, in this exact order:
//!
//! ```js
//! function ensureNativeHelper() {
//!   if (process.platform !== 'win32') return Promise.resolve(null);
//!   // 1. Prefer a prebuilt exe shipped with the app.
//!   try { const b = bundledNativeExePath(); if (fs.existsSync(b)) return b; } catch {}
//!   // 2. Otherwise reuse a cached compile in userData if it's newer than the source.
//!   const src = nativeSrcPath();
//!   if (!fs.existsSync(src)) return null;
//!   const outExe = path.join(app.getPath('userData'), 'RobloxNative.exe');
//!   if (fs.existsSync(outExe) && statSync(outExe).mtimeMs >= statSync(src).mtimeMs) return outExe;
//!   // 3. Fall back to compiling the bundled source with csc.exe, 30s timeout.
//!   const csc = findCsc(); if (!csc) return null;
//!   const proc = spawn(csc, ['/nologo','/optimize+','/platform:x64','/target:exe','/out:'+outExe, src]);
//!   setTimeout(() => { proc.kill(); ... }, 30000);
//!   return code === 0 && fs.existsSync(outExe) ? outExe : null;
//! }
//! ```
//!
//! where `findCsc()` probes the two fixed `%WINDIR%` candidate paths:
//!
//! ```js
//! const win = process.env.WINDIR || 'C:\\Windows';
//! [ path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
//!   path.join(win, 'Microsoft.NET', 'Framework',   'v4.0.30319', 'csc.exe') ]
//! ```
//!
//! ## Differences from the legacy JS build (intentional, per the requirements)
//!
//! `ensureNativeHelper()` returns `null` when the helper is unavailable and the
//! legacy JS runtime callers then no-op or fall back. The migration instead returns an
//! `Err(String)` (Requirement 9.5: a failed/timed-out fallback compile makes the
//! dependent feature report a failure to the user rather than hanging or silently
//! no-op-ing). The three-step order and the candidate paths are otherwise
//! reproduced exactly. In particular, on a compile **timeout** this returns an
//! `Err` (Requirement 9.4/9.5) rather than the legacy JS runtime code's post-kill
//! `fs.existsSync(outExe)` re-check, since a killed compile cannot be trusted to
//! have produced a complete executable.
//!
//! ## Path resolution / testability
//!
//! [`resolve_native_helper`] is the pure, `AppHandle`-free core: it takes a
//! [`NativeHelperPaths`] (the three concrete file locations) plus a csc locator,
//! so the resolution order can be unit-tested against temp directories without a
//! live Tauri app. [`ensure_native_helper`] is the thin `AppHandle` wrapper that
//! fills in those paths from Tauri's resource directory (the bundled exe/source,
//! matching legacy JS runtime's `resourcesPath`/`__dirname`) and the app-data directory
//! (the cached-compile location, matching legacy JS runtime's `userData`).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::logging::send_log;
use crate::AppState;

/// The fallback-compilation timeout, matching the legacy JS build's 30-second
/// `setTimeout` guard on the `csc.exe` child (Requirement 9.4).
pub const COMPILE_TIMEOUT: Duration = Duration::from_secs(30);

/// The Native_Helper executable's file name (`RobloxNative.exe`), used both for
/// the bundled prebuilt exe and for the cached-compile output.
pub const NATIVE_EXE_NAME: &str = "RobloxNative.exe";

/// The Native_Helper C# source file name (`RobloxNative.cs`), compiled by the
/// step-3 fallback when no usable exe is present.
pub const NATIVE_SRC_NAME: &str = "RobloxNative.cs";

/// The three concrete file locations the resolution order works over, kept
/// separate from `AppHandle` path lookup so [`resolve_native_helper`] is
/// unit-testable without a live Tauri app.
#[derive(Debug, Clone)]
pub struct NativeHelperPaths {
    /// Step 1: the prebuilt exe shipped with the app (legacy JS runtime's
    /// `bundledNativeExePath()` — `resourcesPath`/`__dirname` + `RobloxNative.exe`;
    /// here, the Tauri resource dir).
    pub bundled_exe: PathBuf,
    /// Steps 2/3 input: the bundled C# source (legacy JS runtime's `nativeSrcPath()`);
    /// compiled by step 3 when no usable exe exists.
    pub source: PathBuf,
    /// Steps 2/3 output: the cached-compile location in the app-data dir
    /// (legacy JS runtime's `path.join(userData, 'RobloxNative.exe')`).
    pub cached_exe: PathBuf,
}

/// Resolve a usable `RobloxNative.exe` path, porting `ensureNativeHelper()`.
///
/// Resolves the bundled exe and source from the Tauri resource directory (the
/// analogue of legacy JS runtime's `resourcesPath`/`__dirname`) and the cached-compile
/// output from the app-data directory (the analogue of legacy JS runtime's `userData`,
/// resolved via [`crate::accounts::store_dir`] so it lands in the same
/// `%APPDATA%\robloxaccountmanager\` folder the rest of the backend uses). Returns
/// `Err` on any non-Windows platform (Requirement 8.4) and when no usable exe
/// can be produced (Requirement 9.5).
pub async fn ensure_native_helper(app: &AppHandle) -> Result<PathBuf, String> {
    if !cfg!(windows) {
        return Err("Native helper is only available on Windows".to_string());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not resolve the resource directory: {e}"))?;
    let data_dir = crate::accounts::store_dir(app)?;

    let paths = NativeHelperPaths {
        bundled_exe: resource_dir.join(NATIVE_EXE_NAME),
        source: resource_dir.join(NATIVE_SRC_NAME),
        cached_exe: data_dir.join(NATIVE_EXE_NAME),
    };

    resolve_native_helper(&paths, find_csc).await
}

/// Pure core of the three-step resolution (no `AppHandle`), so the order and its
/// candidate paths can be exercised in unit tests over temp directories.
///
/// `csc_locator` returns the `csc.exe` path to use for the step-3 fallback
/// compile, or `None` if the .NET Framework compiler is not installed. Production
/// passes [`find_csc`]; tests can inject their own.
pub async fn resolve_native_helper(
    paths: &NativeHelperPaths,
    csc_locator: impl Fn() -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    // Step 1: prefer the prebuilt exe shipped with the app. A stat error is
    // treated as "not present" (legacy JS runtime wraps this `existsSync` in try/catch).
    if file_exists(&paths.bundled_exe) {
        return Ok(paths.bundled_exe.clone());
    }

    // Step 2: fall back to a cached compile in the app-data dir. The source must
    // exist to compile (or to validate a cache against); without it the helper
    // cannot be produced at all.
    if !file_exists(&paths.source) {
        return Err(format!(
            "Native helper source {} not found; cannot produce {}",
            paths.source.display(),
            NATIVE_EXE_NAME
        ));
    }
    // Reuse a cached build if it is at least as new as the source.
    if cached_is_fresh(&paths.cached_exe, &paths.source) {
        return Ok(paths.cached_exe.clone());
    }

    // Step 3: compile the bundled source with csc.exe, bounded by a 30s timeout.
    let csc = csc_locator().ok_or_else(|| {
        "csc.exe (.NET Framework C# compiler) not found; native helper unavailable".to_string()
    })?;
    compile_native_helper(&csc, &paths.source, &paths.cached_exe, COMPILE_TIMEOUT).await
}

/// Compile `source` into `output` via `csc`, bounded by `timeout`, using the same
/// compiler flags as the legacy JS build and `build-native.js`
/// (`/nologo /optimize+ /platform:x64 /target:exe /out:<output> <source>`).
///
/// Production always passes [`COMPILE_TIMEOUT`] (the 30-second guard); the
/// `timeout` parameter is threaded through only so the timeout branch can be
/// exercised deterministically in tests without a 30-second wall-clock wait
/// (design Property 16).
///
/// Returns the `output` path on a clean, in-time success; an `Err` on a non-zero
/// exit, a spawn/wait failure, or a timeout (Requirement 9.4/9.5).
async fn compile_native_helper(
    csc: &Path,
    source: &Path,
    output: &Path,
    timeout: Duration,
) -> Result<PathBuf, String> {
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;

    let mut cmd = Command::new(csc);
    cmd.arg("/nologo")
        .arg("/optimize+")
        .arg("/platform:x64")
        .arg("/target:exe")
        .arg(format!("/out:{}", output.display()))
        .arg(source)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    // Match the legacy JS build's `windowsHide: true` so the transient compiler
    // process never flashes a console window.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch csc.exe at {}: {e}", csc.display()))?;
    let stderr = child.stderr.take();

    match tokio::time::timeout(timeout, child.wait()).await {
        // Compiler finished within the timeout window.
        Ok(Ok(status)) => {
            let mut err_text = String::new();
            if let Some(mut s) = stderr {
                let _ = s.read_to_string(&mut err_text).await;
            }
            if status.success() && file_exists(output) {
                Ok(output.to_path_buf())
            } else {
                let detail = err_text.trim();
                let detail = if detail.is_empty() {
                    format!("csc.exe exited with {status}")
                } else {
                    detail.to_string()
                };
                Err(format!("native helper compilation failed: {detail}"))
            }
        }
        // Waiting on the compiler itself errored.
        Ok(Err(e)) => Err(format!("failed while awaiting csc.exe: {e}")),
        // Timed out: kill the hung compiler and report unavailability (Req 9.5),
        // rather than trusting a possibly-incomplete output file.
        Err(_elapsed) => {
            let _ = child.kill().await;
            Err(format!(
                "native helper compilation timed out after {}s",
                timeout.as_secs()
            ))
        }
    }
}

/// Locate `csc.exe` at the two fixed `%WINDIR%` candidate paths the legacy JS build
/// and `build-native.js` probe, in order, returning the first that exists.
///
/// Falls back to `C:\Windows` when `WINDIR` is unset, matching
/// `process.env.WINDIR || 'C:\\Windows'`.
pub fn find_csc() -> Option<PathBuf> {
    let win_dir = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    csc_candidates(&win_dir).into_iter().find(|c| file_exists(c))
}

/// The ordered `csc.exe` candidate paths under `win_dir`, factored out so the
/// path construction is unit-testable without touching the filesystem:
/// `Microsoft.NET\Framework64\v4.0.30319\csc.exe` then the 32-bit `Framework`.
pub fn csc_candidates(win_dir: &Path) -> Vec<PathBuf> {
    vec![
        win_dir
            .join("Microsoft.NET")
            .join("Framework64")
            .join("v4.0.30319")
            .join("csc.exe"),
        win_dir
            .join("Microsoft.NET")
            .join("Framework")
            .join("v4.0.30319")
            .join("csc.exe"),
    ]
}

/// `fs.existsSync`-equivalent: true only when the path exists AND is a regular
/// file, so a directory named `RobloxNative.exe` cannot masquerade as the helper.
fn file_exists(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// Port of the legacy JS runtime cache-freshness check
/// (`statSync(outExe).mtimeMs >= statSync(src).mtimeMs`): true when `cached`
/// exists and its modified time is at least as recent as `source`'s. Any stat
/// error (missing cache, unreadable) is treated as "not fresh" so resolution
/// falls through to a recompile, matching the legacy JS runtime try/catch.
fn cached_is_fresh(cached: &Path, source: &Path) -> bool {
    fn mtime(p: &Path) -> Option<SystemTime> {
        std::fs::metadata(p).and_then(|m| m.modified()).ok()
    }
    match (mtime(cached), mtime(source)) {
        (Some(c), Some(s)) => c >= s,
        _ => false,
    }
}

// ── Task 9.2: Native_Helper process lifecycle ──────────────────────────────
//
// Ports the legacy JS backend's `startMutexHolder`/`stopMutexHolder`/`restartMutexHolder`,
// `setRobloxVolume`, `closeSingletonHandlesOnly`, and `startAntiAfk`/`stopAntiAfk`,
// each `tokio::time::timeout`-guarded (Requirement 7.4).

/// Readiness timeout for the persistent mutex holder, matching the legacy JS build's
/// `setTimeout(resolve, 8000)` safety fallback in `startMutexHolder`. Readiness
/// resolves on the `MUTEX_HELD` marker or when this elapses, whichever is first;
/// the holder is kept running either way.
pub const MUTEX_READY_TIMEOUT: Duration = Duration::from_secs(8);

/// Overall timeout for a single `volume <pct>` invocation, matching the
/// legacy JS build's 12-second safety timeout in `setRobloxVolume`.
pub const VOLUME_TIMEOUT: Duration = Duration::from_secs(12);

/// Overall timeout for a single `closehandles` invocation, matching the
/// legacy JS build's 4-second safety timeout in `closeSingletonHandlesOnly`.
pub const CLOSE_HANDLES_TIMEOUT: Duration = Duration::from_secs(4);

/// Readiness timeout for the anti-AFK loop's `ANTIAFK_ON` marker. The
/// legacy JS build's `startAntiAfk` does not itself await readiness (it spawns and
/// returns), so this is an added Requirement-7.4 guard: the start call resolves
/// on `ANTIAFK_ON` or after this elapses, and never hangs. The loop keeps running
/// either way. Kept equal to the mutex readiness bound for consistency.
pub const ANTIAFK_READY_TIMEOUT: Duration = Duration::from_secs(8);

/// Bound on how long we wait for a helper child to die when tearing it down, so a
/// stuck kill/reap can never leave a stop/restart awaiting forever (Requirement 7.4).
pub const HELPER_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Result of a [`set_roblox_volume`] call, mirroring the object the legacy JS build's
/// `setRobloxVolume` resolves to (`{ ok, count, error? }`) and that the Renderer_UI
/// branches on (`if (res && res.ok) ... else ... res.error`). `error` is omitted
/// entirely on success, matching the legacy JS build's success payload.
#[derive(Debug, Clone, Serialize)]
pub struct VolumeResult {
    /// Whether the volume set was attempted successfully.
    pub ok: bool,
    /// Number of Roblox audio sessions adjusted (parsed from `SET:<count>`).
    pub count: u32,
    /// Failure detail, present only when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Spawns the Native_Helper `exe` with `args`, piping stdout (all markers are
/// written to `Console.Out`). `pipe_stderr` chooses whether stderr is captured
/// (the anti-AFK loop surfaces stderr warnings to the log; the other subcommands
/// only write diagnostic text there, which the legacy JS build sent to
/// `console.error`, so it is dropped to avoid a pipe that no one drains).
///
/// On Windows the child is created with `CREATE_NO_WINDOW` so the transient helper
/// never flashes a console window, matching the legacy JS build's `windowsHide: true`.
fn spawn_helper(
    exe: &Path,
    args: &[&str],
    pipe_stderr: bool,
) -> std::io::Result<tokio::process::Child> {
    use tokio::process::Command;

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(if pipe_stderr {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        });
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Kill a helper child and reap it, bounded by [`HELPER_KILL_TIMEOUT`] so a stuck
/// teardown can never hang the caller (Requirement 7.4).
async fn kill_child(child: &mut tokio::process::Child) {
    let _ = tokio::time::timeout(HELPER_KILL_TIMEOUT, child.kill()).await;
}

/// Outcome of awaiting a Native_Helper completion marker on a piped stdout stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkerWait {
    /// The awaited completion marker arrived on stdout.
    Marker,
    /// The stream reached EOF before the marker did — the helper exited or closed
    /// stdout mid-operation. A clean, bounded failure the caller reports on
    /// rather than hanging (Requirement 7.4).
    Ended,
    /// The bounded wait elapsed before the marker or EOF. Also a clean, bounded
    /// outcome — the caller tears the (hung) helper down and reports.
    TimedOut,
}

/// Read a helper's piped stdout line-by-line until `is_marker` matches a parsed
/// [`HelperMarker`], the stream reaches EOF, or `timeout` elapses — whichever
/// comes first (Requirement 7.4).
///
/// This is the shared, `AppHandle`-free core of the timeout-guarded read the
/// short-lived helper operations perform (e.g. [`close_singleton_handles`]'s
/// wait for `HANDLES_DONE`). Factoring it out lets Property 15 drive the exact
/// production wait against a fake child-process test double: when the helper
/// terminates before emitting its marker, the wait resolves to
/// [`MarkerWait::Ended`] promptly (on EOF) rather than blocking until `timeout`,
/// so an in-progress operation fails cleanly instead of hanging.
pub(crate) async fn await_helper_marker<R>(
    stdout: R,
    is_marker: impl Fn(HelperMarker) -> bool,
    timeout: Duration,
) -> MarkerWait
where
    R: tokio::io::AsyncRead + Unpin,
{
    let read = async {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(marker) = parse_marker(&line) {
                if is_marker(marker) {
                    return MarkerWait::Marker;
                }
            }
        }
        // `next_line` returned `Ok(None)` (EOF) or an I/O error: the helper's
        // stdout is gone, so the operation can never see its marker.
        MarkerWait::Ended
    };
    tokio::time::timeout(timeout, read)
        .await
        .unwrap_or(MarkerWait::TimedOut)
}

/// Start (or reuse) the persistent mutex holder, porting the legacy JS backend's
/// `startMutexHolder`.
///
/// A holder that is still running is reused (the mutex is never released and
/// re-grabbed); a holder that has since exited is discarded and respawned. On a
/// fresh spawn this resolves readiness on the `MUTEX_HELD` marker, bounded by
/// [`MUTEX_READY_TIMEOUT`] — mirroring the legacy JS build, readiness also resolves
/// when the timeout elapses, and the holder is kept running (stored in
/// [`AppState::mutex_proc`]) either way, so a launch fired before readiness simply
/// reuses the same holder.
///
/// A no-op returning `Ok(())` off Windows (the mutex is a Windows kernel object).
/// On Windows, a failure to resolve/produce the helper propagates as `Err`
/// (Requirement 9.5), rather than the legacy JS build's silent no-op.
pub async fn start_mutex_holder(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }

    // Reuse a live holder; respawn only if the previous one has died.
    {
        let mut guard = state.mutex_proc.lock().await;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => *guard = None, // exited — fall through and respawn
                Ok(None) => return Ok(()),    // still holding the mutex — reuse
                Err(_) => *guard = None,
            }
        }
    }

    let exe = ensure_native_helper(app).await?;
    let mut child = spawn_helper(&exe, &["mutex"], false)
        .map_err(|e| format!("failed to launch mutex holder: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "mutex holder stdout was not captured".to_string())?;

    // Store the persistent holder before awaiting readiness so stop/restart can
    // find it and concurrent launches reuse it.
    {
        let mut guard = state.mutex_proc.lock().await;
        *guard = Some(child);
    }

    // Resolve readiness on MUTEX_HELD, draining stdout in the background so the
    // holder's pipe never fills. Bounded by the timeout (Requirement 7.4).
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let mut tx = Some(tx);
        while let Ok(Some(line)) = lines.next_line().await {
            if matches!(parse_marker(&line), Some(HelperMarker::MutexHeld)) {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(());
                }
            }
        }
    });
    let _ = tokio::time::timeout(MUTEX_READY_TIMEOUT, rx).await;
    Ok(())
}

/// Stop the persistent mutex holder if one is running, porting `stopMutexHolder`.
/// Releasing the process closes `ROBLOX_singletonMutex`/`ROBLOX_singletonEvent`
/// outright (Windows closes a dead process's handles). The kill is
/// [`HELPER_KILL_TIMEOUT`]-bounded. A no-op when no holder is tracked.
pub async fn stop_mutex_holder(state: &AppState) {
    let mut guard = state.mutex_proc.lock().await;
    if let Some(mut child) = guard.take() {
        kill_child(&mut child).await;
    }
}

/// Fully re-squat the singleton mutex/event pair, porting `restartMutexHolder`.
///
/// Killing the old holder releases those kernel objects so the fresh one starts
/// from a clean slate. As in the legacy JS build this is ONLY safe to call once
/// zero real Roblox processes are confirmed running (see `killAllRoblox`); doing
/// it while a real instance could be racing the holder is what corrupts that
/// instance's install pipeline.
pub async fn restart_mutex_holder(app: &AppHandle, state: &AppState) -> Result<(), String> {
    stop_mutex_holder(state).await;
    start_mutex_holder(app, state).await
}

/// Apply an OS-level volume (0–100) to every running Roblox audio session at
/// once, porting the legacy JS backend's `setRobloxVolume`. Returns the number of sessions
/// adjusted (parsed from the helper's `SET:<count>` marker).
///
/// A short-lived per-invocation spawn, bounded by [`VOLUME_TIMEOUT`]: on timeout
/// the helper is killed and `{ ok: true, count: 0 }` is returned (matching the
/// legacy JS build's timeout branch). `percent` is clamped to `0..=100`
/// (`Math.max(0, Math.min(100, ...))`). Off Windows, or when the helper cannot be
/// produced, or when the spawn fails, returns `ok: false` with a reason rather
/// than erroring, so the Renderer_UI's `res.error` branch renders the cause.
pub async fn set_roblox_volume(app: &AppHandle, percent: i64) -> Result<VolumeResult, String> {
    if let Err(e) = crate::platform::ensure_windows() {
        return Ok(VolumeResult {
            ok: false,
            count: 0,
            error: Some(e),
        });
    }
    let pct = percent.clamp(0, 100);

    let exe = match ensure_native_helper(app).await {
        Ok(exe) => exe,
        Err(e) => {
            return Ok(VolumeResult {
                ok: false,
                count: 0,
                error: Some(e),
            })
        }
    };

    let mut child = match spawn_helper(&exe, &["volume", &pct.to_string()], false) {
        Ok(child) => child,
        Err(_) => {
            return Ok(VolumeResult {
                ok: false,
                count: 0,
                error: Some("spawn failed".to_string()),
            })
        }
    };

    // Reading stdout to EOF completes when the helper prints SET:<count> and
    // exits. Keep `child` out of the read future so it can be killed on timeout.
    let stdout = child.stdout.take();
    let read_out = async move {
        use tokio::io::AsyncReadExt;
        let mut out = String::new();
        if let Some(mut so) = stdout {
            let _ = so.read_to_string(&mut out).await;
        }
        out
    };

    match tokio::time::timeout(VOLUME_TIMEOUT, read_out).await {
        Ok(out) => {
            // Reap the (now-exited) helper, still bounded so a stuck reap can't hang.
            let _ = tokio::time::timeout(HELPER_KILL_TIMEOUT, child.wait()).await;
            Ok(VolumeResult {
                ok: true,
                count: parse_set_count(&out).unwrap_or(0),
                error: None,
            })
        }
        Err(_) => {
            kill_child(&mut child).await;
            Ok(VolumeResult {
                ok: true,
                count: 0,
                error: None,
            })
        }
    }
}

/// Close the singleton-event handles on currently-running Roblox processes,
/// porting the legacy JS backend's `closeSingletonHandlesOnly`. This never touches the mutex;
/// it is the lightweight per-launch step that lets a new instance avoid being
/// redirected into an existing one.
///
/// A short-lived per-invocation spawn, bounded by [`CLOSE_HANDLES_TIMEOUT`]:
/// completion resolves on the `HANDLES_DONE` marker (or the helper exiting), and
/// a timeout kills the helper — either way the helper is torn down and `Ok(())`
/// is returned, matching the legacy JS build's best-effort `finish` semantics.
/// A no-op returning `Ok(())` off Windows; a helper that cannot be produced
/// propagates as `Err` (Requirement 9.5).
pub async fn close_singleton_handles(app: &AppHandle) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }
    let exe = ensure_native_helper(app).await?;
    let mut child = spawn_helper(&exe, &["closehandles"], false)
        .map_err(|e| format!("failed to launch closehandles helper: {e}"))?;

    // Resolve on HANDLES_DONE, on the helper exiting/closing stdout before the
    // marker (a clean mid-operation failure), or on the timeout — never hang
    // (Requirement 7.4). The helper is torn down either way.
    if let Some(so) = child.stdout.take() {
        let _ = await_helper_marker(
            so,
            |m| matches!(m, HelperMarker::HandlesDone),
            CLOSE_HANDLES_TIMEOUT,
        )
        .await;
    }
    kill_child(&mut child).await;
    Ok(())
}

/// Ensure the persistent mutex holder is alive, then close singleton handles on
/// running Roblox processes — porting the legacy JS backend's `closeSingletonAndHoldMutex`,
/// the per-launch prelude. `startMutexHolder` here never kills a live holder, so
/// the mutex is never released/re-grabbed at launch time.
pub async fn close_singleton_and_hold_mutex(
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    if cfg!(windows) {
        start_mutex_holder(app, state).await?;
    }
    close_singleton_handles(app).await
}

/// Start (or reuse) the anti-AFK loop, porting the legacy JS backend's `startAntiAfk`.
///
/// The `antiafk <seconds>` subcommand taps a benign key into every running Roblox
/// window on an interval so the ~20-minute idle kick never fires. A loop that is
/// still running is reused; one that has exited is discarded and respawned. The
/// interval is read from the Settings_Store (`antiAfkInterval`), defaulting to
/// 19 minutes when absent or below 60s (matching the legacy JS build). The child
/// is stored in [`AppState::anti_afk_proc`] for later teardown.
///
/// The start logs `Anti-AFK started` immediately after spawn (as the
/// legacy JS build does), streams the helper's stdout tick lines to the log, and
/// surfaces stderr warnings. Readiness on the `ANTIAFK_ON` marker is bounded by
/// [`ANTIAFK_READY_TIMEOUT`] so the start call can never hang (Requirement 7.4),
/// resolving `Ok(())` on the marker or the timeout. A no-op off Windows; a helper
/// that cannot be produced propagates as `Err` (Requirement 9.5).
pub async fn start_anti_afk(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }

    // Reuse a live loop; respawn only if the previous one has died.
    {
        let mut guard = state.anti_afk_proc.lock().await;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => *guard = None, // exited — respawn
                Ok(None) => return Ok(()),    // already running
                Err(_) => *guard = None,
            }
        }
    }

    let exe = ensure_native_helper(app).await?;
    let deadline = anti_afk_deadline(load_anti_afk_interval(app));
    let mut child = spawn_helper(&exe, &["antiafk", &deadline.to_string()], true)
        .map_err(|e| format!("failed to launch anti-AFK helper: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut guard = state.anti_afk_proc.lock().await;
        *guard = Some(child);
    }

    // Logged right after spawn, matching the legacy JS build (before any readiness).
    send_log(
        app,
        "ok",
        "afk",
        &format!(
            "Anti-AFK started (interval: {} min)",
            (deadline as f64 / 60.0).round() as i64
        ),
        serde_json::json!({ "intervalSec": deadline }),
    );

    // Stream stdout tick lines to the log and signal readiness on ANTIAFK_ON,
    // porting the legacy JS build's `_antiAfkProc.stdout.on('data', ...)` handler.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    if let Some(so) = stdout {
        let app_out = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(so).lines();
            let mut tx = Some(tx);
            while let Ok(Some(line)) = lines.next_line().await {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if matches!(parse_marker(t), Some(HelperMarker::AntiAfkOn(_))) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
                if let Some(n) = parse_tapped_windows(t) {
                    let plural = if n == 1 { "" } else { "s" };
                    send_log(
                        &app_out,
                        "info",
                        "afk",
                        &format!("Anti-AFK: tapped {n} Roblox window{plural}"),
                        serde_json::json!({ "windows": n }),
                    );
                } else {
                    send_log(
                        &app_out,
                        "info",
                        "afk",
                        &format!("Anti-AFK: {t}"),
                        serde_json::Value::Null,
                    );
                }
            }
        });
    }

    // Surface stderr warnings, porting the legacy JS build's stderr handler.
    if let Some(se) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(se).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let t = line.trim();
                if !t.is_empty() {
                    send_log(
                        &app_err,
                        "warn",
                        "afk",
                        &format!("Anti-AFK warning: {t}"),
                        serde_json::Value::Null,
                    );
                }
            }
        });
    }

    let _ = tokio::time::timeout(ANTIAFK_READY_TIMEOUT, rx).await;
    Ok(())
}

/// Stop the anti-AFK loop if one is running, porting `stopAntiAfk`. Logs
/// `Anti-AFK stopped` before killing (matching the legacy JS build's order), and
/// only when a loop is actually tracked. The kill is [`HELPER_KILL_TIMEOUT`]-bounded.
pub async fn stop_anti_afk(app: &AppHandle, state: &AppState) {
    let mut guard = state.anti_afk_proc.lock().await;
    if let Some(mut child) = guard.take() {
        send_log(app, "warn", "afk", "Anti-AFK stopped", serde_json::Value::Null);
        kill_child(&mut child).await;
    }
}

/// Resolve the anti-AFK deadline (seconds) the same way the legacy JS backend's `startAntiAfk`
/// does: use the stored `antiAfkInterval` when it is at least 60 seconds,
/// otherwise fall back to 19 minutes (safely under Roblox's ~20-minute idle kick).
/// A missing/`None` interval also falls back (mirroring `!Number.isFinite(...)`).
fn anti_afk_deadline(interval: Option<i64>) -> i64 {
    match interval {
        Some(v) if v >= 60 => v,
        _ => 19 * 60,
    }
}

/// Read `antiAfkInterval` from the Settings_Store, resolving the app-data dir the
/// same way the rest of the backend does. Any failure (dir unresolved, unreadable
/// or corrupt store) yields `None`, so the caller falls back to the default
/// deadline — matching the legacy JS build's resilience where `loadSettings`
/// returns defaults rather than throwing into `startAntiAfk`.
fn load_anti_afk_interval(app: &AppHandle) -> Option<i64> {
    let dir = crate::accounts::store_dir(app).ok()?;
    crate::settings::load_from_dir(&dir)
        .ok()
        .and_then(|s| s.anti_afk_interval)
}

// ── Task 9.3: structured Native_Helper marker parser ───────────────────────
//
// `RobloxNative.exe` communicates results to its parent purely through
// single-line markers on stdout (and diagnostic text on stderr). The legacy JS build
// parsed these ad-hoc at each call site — `data.includes('MUTEX_HELD')`,
// `data.includes('HANDLES_DONE')`, `out.match(/SET:(\d+)/)` — and logged the
// anti-AFK lines. This section replaces those scattered checks with one
// structured parser ([`parse_marker`]) covering all five markers the helper
// emits (Requirement 9.6):
//
// * `MUTEX_HELD`            — mutex acquired; the singleton launch may proceed.
// * `HANDLES_DONE`          — stale singleton-event handle cleanup finished.
// * `SET:<count>`           — volume applied to `<count>` Roblox audio sessions.
// * `ANTIAFK_ON:<seconds>`  — anti-AFK loop started with the given interval.
// * `ANTIAFK_TICK:<pid>`    — an anti-AFK tick fired for process `<pid>`.
//
// The exact emission sites in `RobloxNative.cs` are `Console.Out.WriteLine("MUTEX_HELD")`,
// `"HANDLES_DONE"`, `"SET:" + n`, `"ANTIAFK_ON:" + deadlineSec`, and
// `"ANTIAFK_TICK:" + pid`, so each marker arrives on its own line with the numeric
// payload immediately following the `:`.

/// A parsed Native_Helper stdout/stderr marker (Task 9.3, Requirement 9.6). Each
/// variant identifies one of the five marker formats the helper emits and carries
/// the exact numeric payload present in the line (for the valued markers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "marker", content = "value")]
pub enum HelperMarker {
    /// `MUTEX_HELD` — the persistent holder grabbed `ROBLOX_singletonMutex`; a
    /// singleton launch may proceed.
    MutexHeld,
    /// `HANDLES_DONE` — the per-launch `closehandles` step finished closing stale
    /// singleton-event handles on running Roblox processes.
    HandlesDone,
    /// `SET:<count>` — the volume operation adjusted `<count>` Roblox audio sessions.
    VolumeSet(u32),
    /// `ANTIAFK_ON:<seconds>` — the anti-AFK loop started with a `<seconds>` interval.
    AntiAfkOn(u32),
    /// `ANTIAFK_TICK:<pid>` — an anti-AFK tick tapped the Roblox window owned by
    /// process `<pid>`; used to update last-active tracking.
    AntiAfkTick(u32),
}

/// Parse a single helper output line into a [`HelperMarker`], or `None` when the
/// line matches none of the five marker formats (Requirement 9.6 / design
/// Property 17).
///
/// The line is trimmed first (helper markers are always written on their own
/// line via `Console.Out.WriteLine`). Valued markers (`SET:`, `ANTIAFK_ON:`,
/// `ANTIAFK_TICK:`) are matched by locating their prefix and reading the run of
/// ASCII digits immediately following it — mirroring the legacy JS build's
/// `/SET:(\d+)/`, which requires at least one digit right after the `:`; a prefix
/// with no following digits (`SET:`), non-numeric text (`SET:abc`), or a value
/// that overflows the payload type yields `None` for that marker. The token
/// markers (`MUTEX_HELD`, `HANDLES_DONE`) are matched by substring, mirroring the
/// legacy JS build's `.includes(...)`. The three valued prefixes are mutually
/// non-overlapping (and none is a substring of the token markers), so a line can
/// only ever match one format; valued markers are checked before token markers
/// purely for determinism.
pub fn parse_marker(line: &str) -> Option<HelperMarker> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(count) = parse_value_after(t, "SET:") {
        return Some(HelperMarker::VolumeSet(count));
    }
    if let Some(seconds) = parse_value_after(t, "ANTIAFK_ON:") {
        return Some(HelperMarker::AntiAfkOn(seconds));
    }
    if let Some(pid) = parse_value_after(t, "ANTIAFK_TICK:") {
        return Some(HelperMarker::AntiAfkTick(pid));
    }
    if t.contains("HANDLES_DONE") {
        return Some(HelperMarker::HandlesDone);
    }
    if t.contains("MUTEX_HELD") {
        return Some(HelperMarker::MutexHeld);
    }
    None
}

/// Parse every marker across a (possibly multi-line) chunk of helper output, in
/// order, skipping lines that match no marker. Used where the caller reads a
/// helper's whole stdout at once (e.g. [`set_roblox_volume`]) rather than
/// line-by-line.
pub fn parse_markers(text: &str) -> Vec<HelperMarker> {
    text.lines().filter_map(parse_marker).collect()
}

/// Read the run of ASCII digits immediately following the first occurrence of
/// `prefix` in `line` and parse it into a `u32`. Returns `None` when the prefix is
/// absent, is not immediately followed by a digit, or the digits overflow `u32`.
fn parse_value_after(line: &str, prefix: &str) -> Option<u32> {
    let idx = line.find(prefix)?;
    let digits: String = line[idx + prefix.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Parse a `SET:<count>` volume marker, porting the legacy JS backend's `out.match(/SET:(\d+)/)`.
/// Returns the count carried by the first `SET:<count>` marker in `out`, or `None`
/// if absent. Thin wrapper over the structured [`parse_marker`] (Task 9.3), kept
/// for [`set_roblox_volume`]'s call site.
fn parse_set_count(out: &str) -> Option<u32> {
    parse_markers(out).into_iter().find_map(|m| match m {
        HelperMarker::VolumeSet(count) => Some(count),
        _ => None,
    })
}

/// Port of the legacy JS backend's anti-AFK stdout classification `t.match(/tapped\s+(\d+)\s+window/i)`:
/// returns the tapped-window count when a line matches `tapped <n> window`
/// (case-insensitively, any whitespace run), else `None`. The current
/// `RobloxNative.exe` emits `ANTIAFK_TICK:<pid>` rather than this phrasing, so in
/// practice lines fall through to the verbatim log branch — but the classification
/// is ported exactly so behavior matches the legacy JS build for any helper build.
fn parse_tapped_windows(line: &str) -> Option<u64> {
    let lower = line.to_lowercase();
    let after_tapped = lower.find("tapped")? + "tapped".len();
    // Require at least one whitespace char after "tapped".
    let rest = &line[after_tapped..];
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return None; // no separating whitespace
    }
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let after_digits = trimmed[digits.len()..].trim_start();
    if after_digits.len() == trimmed[digits.len()..].len() {
        return None; // no whitespace between the number and "window"
    }
    if after_digits.to_lowercase().starts_with("window") {
        digits.parse().ok()
    } else {
        None
    }
}

// ── Task 9.7: Tauri command layer ──────────────────────────────────────────
//
// The three `#[tauri::command]` wrappers that expose this module's Native_Helper
// functionality to the Renderer_UI, each mirroring its legacy IPC handler with
// the same parameter order and return shape (design IPC_Surface mapping table,
// Requirement 10.1):
//
// | legacy IPC           | command                  | wraps                          |
// |------------------------|--------------------------|--------------------------------|
// | `roblox:setVolume`     | [`roblox_set_volume`]    | [`set_roblox_volume`]          |
// | `multiinstance:status` | [`multiinstance_status`] | mutex-holder liveness + setting|
// | `antiafk:status`       | [`antiafk_status`]       | anti-AFK-loop liveness + setting|

/// The `{ enabled, active }` object [`multiinstance_status`] and [`antiafk_status`]
/// return, matching the legacy handlers' shape so the Renderer_UI receives the
/// identical payload it already branches on.
#[derive(Debug, Clone, Serialize)]
pub struct HelperStatus {
    /// Whether the feature is enabled in the Settings_Store (`multiInstance` for
    /// multi-instance, `antiAfk` for anti-AFK).
    pub enabled: bool,
    /// Whether the backing Native_Helper process is currently running.
    pub active: bool,
}

/// `roblox:setVolume` — apply an OS-level volume (0–100) to every running Roblox
/// audio session, porting the legacy handler:
///
/// ```js
/// legacy command handler('roblox:setVolume', async (_, percent) => {
///   try { return await setRobloxVolume(percent); }
///   catch (e) { return { ok: false, count: 0, error: e.message }; }
/// });
/// ```
///
/// Delegates to [`set_roblox_volume`], which already resolves every failure mode
/// (non-Windows, helper-unavailable, spawn failure, timeout) to an
/// `Ok(VolumeResult { ok: false, .. })` / timeout `Ok(VolumeResult { ok: true, count: 0 })`,
/// so this wrapper never rejects — matching the legacy handler's
/// always-resolves contract. Any unexpected `Err` is mapped to the same
/// `{ ok: false, count: 0, error }` object the legacy JS runtime `catch` produces.
#[tauri::command]
pub async fn roblox_set_volume(app: AppHandle, percent: i64) -> Result<VolumeResult, String> {
    Ok(set_roblox_volume(&app, percent)
        .await
        .unwrap_or_else(|e| VolumeResult {
            ok: false,
            count: 0,
            error: Some(e),
        }))
}

/// `multiinstance:status` — report whether multi-instance is enabled and whether
/// the singleton-mutex holder is currently running, porting:
///
/// ```js
/// legacy command handler('multiinstance:status', () => ({
///   enabled: isMultiInstanceEnabled(), active: !!_mutexProc,
/// }));
/// ```
///
/// `enabled` reads `multiInstance` from the Settings_Store (defaulting to `false`
/// when the store is unreadable, matching `loadSettings()`'s try/catch that backs
/// `isMultiInstanceEnabled`). `active` reflects the live [`AppState::mutex_proc`]
/// child — `true` only while it is still running; a holder found to have exited
/// is cleared, mirroring the legacy JS build's
/// `_mutexProc.on('exit', () => { _mutexProc = null; })`.
#[tauri::command]
pub async fn multiinstance_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HelperStatus, String> {
    let enabled = setting_enabled(&app, |s| s.multi_instance);
    let active = proc_active(&state.mutex_proc).await;
    Ok(HelperStatus { enabled, active })
}

/// `antiafk:status` — report whether anti-AFK is enabled and whether the anti-AFK
/// loop is currently running, porting:
///
/// ```js
/// legacy command handler('antiafk:status', () => ({
///   enabled: !!loadSettings().antiAfk, active: !!_antiAfkProc,
/// }));
/// ```
///
/// `enabled` reads `antiAfk` from the Settings_Store (defaulting to `false` on an
/// unreadable store). `active` reflects the live [`AppState::anti_afk_proc`]
/// child, cleared-on-exit just like [`multiinstance_status`], mirroring
/// `_antiAfkProc.on('exit', () => { _antiAfkProc = null; })`.
#[tauri::command]
pub async fn antiafk_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HelperStatus, String> {
    let enabled = setting_enabled(&app, |s| s.anti_afk);
    let active = proc_active(&state.anti_afk_proc).await;
    Ok(HelperStatus { enabled, active })
}

/// Read a boolean flag from the Settings_Store, defaulting to `false` on any
/// dir-resolution / read / parse failure. Mirrors the legacy JS runtime status handlers'
/// reliance on `loadSettings()`, whose try/catch hands them default settings
/// rather than throwing, so an unreadable store reports the feature disabled.
fn setting_enabled(app: &AppHandle, pick: impl Fn(&crate::models::Settings) -> bool) -> bool {
    crate::accounts::store_dir(app)
        .ok()
        .and_then(|dir| crate::settings::load_from_dir(&dir).ok())
        .map(|s| pick(&s))
        .unwrap_or(false)
}

/// Whether the Native_Helper child in `slot` is currently alive, clearing the
/// slot when it has already exited so the reported `active` matches the
/// legacy JS build's exit-nulled `!!_mutexProc` / `!!_antiAfkProc` truthiness
/// rather than reporting a dead handle as active.
async fn proc_active(
    slot: &std::sync::Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
) -> bool {
    let mut guard = slot.lock().await;
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None; // exited — clear, matching the legacy JS runtime `on('exit')` handler
                false
            }
            Ok(None) => true, // still running
            Err(_) => false,
        },
        None => false,
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn parse_set_count_reads_first_marker() {
        assert_eq!(parse_set_count("SET:5"), Some(5));
        assert_eq!(parse_set_count("noise\nSET:0\nmore"), Some(0));
        assert_eq!(parse_set_count("prefix SET:42 suffix"), Some(42));
    }

    #[test]
    fn parse_set_count_absent_or_malformed_is_none() {
        assert_eq!(parse_set_count("HANDLES_DONE"), None);
        assert_eq!(parse_set_count(""), None);
        assert_eq!(parse_set_count("SET:"), None);
        assert_eq!(parse_set_count("SET:abc"), None);
    }

    #[test]
    fn anti_afk_deadline_uses_interval_when_at_least_60() {
        assert_eq!(anti_afk_deadline(Some(300)), 300);
        assert_eq!(anti_afk_deadline(Some(60)), 60);
    }

    #[test]
    fn anti_afk_deadline_defaults_when_absent_or_too_small() {
        assert_eq!(anti_afk_deadline(None), 19 * 60);
        assert_eq!(anti_afk_deadline(Some(59)), 19 * 60);
        assert_eq!(anti_afk_deadline(Some(0)), 19 * 60);
        assert_eq!(anti_afk_deadline(Some(-5)), 19 * 60);
    }

    #[test]
    fn parse_tapped_windows_matches_legacy_regex() {
        assert_eq!(parse_tapped_windows("tapped 3 windows"), Some(3));
        assert_eq!(parse_tapped_windows("tapped 1 window"), Some(1));
        assert_eq!(parse_tapped_windows("Tapped  12   Windows"), Some(12));
    }

    #[test]
    fn parse_tapped_windows_ignores_non_matching_lines() {
        assert_eq!(parse_tapped_windows("ANTIAFK_TICK:12345"), None);
        assert_eq!(parse_tapped_windows("ANTIAFK_ON:1140"), None);
        assert_eq!(parse_tapped_windows("tapped windows"), None); // no count
        assert_eq!(parse_tapped_windows("tapped3windows"), None); // no whitespace
    }

    #[test]
    fn parse_marker_classifies_token_markers() {
        assert_eq!(parse_marker("MUTEX_HELD"), Some(HelperMarker::MutexHeld));
        assert_eq!(parse_marker("  MUTEX_HELD  "), Some(HelperMarker::MutexHeld));
        assert_eq!(parse_marker("HANDLES_DONE"), Some(HelperMarker::HandlesDone));
        assert_eq!(parse_marker("\tHANDLES_DONE\r"), Some(HelperMarker::HandlesDone));
    }

    #[test]
    fn parse_marker_classifies_valued_markers_with_exact_value() {
        assert_eq!(parse_marker("SET:0"), Some(HelperMarker::VolumeSet(0)));
        assert_eq!(parse_marker("SET:42"), Some(HelperMarker::VolumeSet(42)));
        assert_eq!(parse_marker("ANTIAFK_ON:1140"), Some(HelperMarker::AntiAfkOn(1140)));
        assert_eq!(parse_marker("ANTIAFK_ON:60"), Some(HelperMarker::AntiAfkOn(60)));
        assert_eq!(
            parse_marker("ANTIAFK_TICK:12345"),
            Some(HelperMarker::AntiAfkTick(12345))
        );
        assert_eq!(
            parse_marker("ANTIAFK_TICK:1"),
            Some(HelperMarker::AntiAfkTick(1))
        );
    }

    #[test]
    fn parse_marker_rejects_non_markers_and_malformed_values() {
        assert_eq!(parse_marker(""), None);
        assert_eq!(parse_marker("   "), None);
        assert_eq!(parse_marker("random diagnostic text"), None);
        // Valued prefixes with no following digits are not that marker.
        assert_eq!(parse_marker("SET:"), None);
        assert_eq!(parse_marker("SET:abc"), None);
        assert_eq!(parse_marker("ANTIAFK_ON:"), None);
        assert_eq!(parse_marker("ANTIAFK_TICK:notanumber"), None);
        // A value that overflows u32 cannot be represented, so it is not matched.
        assert_eq!(parse_marker("ANTIAFK_TICK:99999999999999999999"), None);
    }

    #[test]
    fn parse_marker_never_cross_classifies_distinct_markers() {
        // Each of the five formats classifies as exactly its own variant, never
        // another (design Property 17: a line matching none is classified as none).
        assert!(matches!(
            parse_marker("ANTIAFK_ON:300"),
            Some(HelperMarker::AntiAfkOn(300))
        ));
        assert!(matches!(
            parse_marker("ANTIAFK_TICK:300"),
            Some(HelperMarker::AntiAfkTick(300))
        ));
        // `ANTIAFK_ON:` / `ANTIAFK_TICK:` must not be misread as `SET:`.
        assert!(!matches!(
            parse_marker("ANTIAFK_ON:300"),
            Some(HelperMarker::VolumeSet(_))
        ));
    }

    #[test]
    fn parse_markers_scans_multiline_output_in_order() {
        let out = "noise\nMUTEX_HELD\nSET:3\nANTIAFK_TICK:9\ndiagnostic\nHANDLES_DONE";
        assert_eq!(
            parse_markers(out),
            vec![
                HelperMarker::MutexHeld,
                HelperMarker::VolumeSet(3),
                HelperMarker::AntiAfkTick(9),
                HelperMarker::HandlesDone,
            ]
        );
        assert_eq!(parse_markers(""), Vec::<HelperMarker>::new());
        assert_eq!(parse_markers("nothing here\nor here"), Vec::<HelperMarker>::new());
    }

    #[test]
    fn parse_set_count_reads_via_structured_parser() {
        // Mid-line SET: is still located (matches the legacy JS runtime /SET:(\d+)/ substring).
        assert_eq!(parse_set_count("prefix SET:42 suffix"), Some(42));
        assert_eq!(parse_set_count("SET:0"), Some(0));
        assert_eq!(parse_set_count("noise\nSET:7\nmore"), Some(7));
        assert_eq!(parse_set_count("HANDLES_DONE"), None);
    }

    #[test]
    fn volume_result_omits_error_on_success() {
        let ok = VolumeResult {
            ok: true,
            count: 7,
            error: None,
        };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["count"], serde_json::json!(7));
        assert!(v.get("error").is_none());

        let err = VolumeResult {
            ok: false,
            count: 0,
            error: Some("Windows only".to_string()),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["error"], serde_json::json!("Windows only"));
    }
}

#[cfg(test)]
mod fallback_compile_prop_tests {
    //! Property test for the Native_Helper Step-3 fallback compile
    //! (design Property 16 / Requirements 9.4, 9.5).
    //!
    //! The `csc.exe` invocation is simulated with a platform-appropriate mock
    //! program that ignores its compiler arguments and instead reproduces one of
    //! the real csc outcomes — exit 0 + produce the output exe, exit non-zero,
    //! fail to launch, or run past the timeout. The success/failure/spawn-failure
    //! cases are exercised end to end through the real [`resolve_native_helper`]
    //! abstraction (a `csc_locator` closure + temp dirs) with the production
    //! [`COMPILE_TIMEOUT`]; the mock finishes instantly so there is no wait. The
    //! timeout case drives [`compile_native_helper`] with a small injected timeout
    //! against a mock that sleeps well past it, so the timeout branch is exercised
    //! deterministically without a 30-second wall-clock wait.

    use super::*;
    use proptest::prelude::*;
    use std::fs;
    use std::time::Instant;

    /// The three simulated fallback-compile outcomes design Property 16 enumerates,
    /// with "yields a failure result" split into a non-zero exit and a spawn failure.
    #[derive(Debug, Clone, Copy)]
    enum CompileOutcome {
        /// csc exits 0 and produces the output exe before the timeout.
        SuccessBeforeTimeout,
        /// csc exits non-zero before the timeout (no usable exe produced).
        NonZeroExit,
        /// The located csc path cannot even be launched (spawn error).
        SpawnFailure,
        /// csc runs past the timeout without completing.
        ExceedsTimeout,
    }

    fn arb_outcome() -> impl Strategy<Value = CompileOutcome> {
        prop_oneof![
            Just(CompileOutcome::SuccessBeforeTimeout),
            Just(CompileOutcome::NonZeroExit),
            Just(CompileOutcome::SpawnFailure),
            Just(CompileOutcome::ExceedsTimeout),
        ]
    }

    /// A fresh, unique temp directory (dependency-free, matching the other test
    /// modules in this crate).
    fn unique_temp_dir(tag: &str, id: u64) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mr_native_compile_{}_{}_{}_{}",
            std::process::id(),
            tag,
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Write a platform-appropriate mock "csc" program reproducing `kind`.
    #[cfg(windows)]
    fn make_mock_csc(dir: &Path, kind: CompileOutcome, output: &Path) -> PathBuf {
        let script = dir.join("mock_csc.cmd");
        let body = match kind {
            CompileOutcome::SuccessBeforeTimeout => format!(
                "@echo off\r\n>\"{}\" echo compiled\r\nexit /b 0\r\n",
                output.display()
            ),
            CompileOutcome::NonZeroExit => "@echo off\r\nexit /b 1\r\n".to_string(),
            // ping -n 21 sleeps ~20s, well past the small injected timeout.
            CompileOutcome::ExceedsTimeout => {
                "@echo off\r\nping -n 21 127.0.0.1 >nul\r\nexit /b 0\r\n".to_string()
            }
            CompileOutcome::SpawnFailure => {
                unreachable!("spawn failure uses a non-existent path, not a mock script")
            }
        };
        fs::write(&script, body).expect("write mock csc");
        script
    }

    #[cfg(unix)]
    fn make_mock_csc(dir: &Path, kind: CompileOutcome, output: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("mock_csc.sh");
        let body = match kind {
            CompileOutcome::SuccessBeforeTimeout => {
                format!("#!/bin/sh\necho compiled > '{}'\nexit 0\n", output.display())
            }
            CompileOutcome::NonZeroExit => "#!/bin/sh\nexit 1\n".to_string(),
            CompileOutcome::ExceedsTimeout => "#!/bin/sh\nsleep 20\nexit 0\n".to_string(),
            CompileOutcome::SpawnFailure => {
                unreachable!("spawn failure uses a non-existent path, not a mock script")
            }
        };
        fs::write(&script, body).expect("write mock csc");
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).expect("chmod mock csc");
        script
    }

    // Feature: native-tauri-backend, Property 16: Native_Helper fallback compilation resolves according to its outcome and timeout
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(120))]

        #[test]
        fn fallback_compile_resolves_per_outcome_and_timeout(
            outcome in arb_outcome(),
            id in any::<u64>(),
            small_timeout_ms in 50u64..=250,
        ) {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();

            let dir = unique_temp_dir("prop16", id);
            // Set the three paths so resolution reaches Step 3 (fallback compile):
            // no bundled exe, source present, cached exe absent (so not fresh).
            let bundled = dir.join("bundled_RobloxNative.exe");
            let source = dir.join("RobloxNative.cs");
            let cached = dir.join("cached_RobloxNative.exe");
            fs::write(&source, "// mock native helper source\n").unwrap();

            match outcome {
                CompileOutcome::SuccessBeforeTimeout
                | CompileOutcome::NonZeroExit
                | CompileOutcome::SpawnFailure => {
                    // Exercise the real resolution abstraction end to end with the
                    // production 30s timeout; the mock finishes instantly, no wait.
                    let csc_path = match outcome {
                        CompileOutcome::SpawnFailure => dir.join("no_such_csc_binary"),
                        _ => make_mock_csc(&dir, outcome, &cached),
                    };
                    let paths = NativeHelperPaths {
                        bundled_exe: bundled.clone(),
                        source: source.clone(),
                        cached_exe: cached.clone(),
                    };
                    let csc_for_closure = csc_path.clone();
                    let result = rt.block_on(resolve_native_helper(&paths, move || {
                        Some(csc_for_closure.clone())
                    }));

                    if let CompileOutcome::SuccessBeforeTimeout = outcome {
                        // Only the success-before-timeout case yields a usable exe path.
                        prop_assert!(
                            result.is_ok(),
                            "success outcome must resolve Ok: {:?}",
                            result
                        );
                        let resolved = result.unwrap();
                        prop_assert_eq!(resolved, cached.clone());
                        prop_assert!(file_exists(&cached), "resolved exe must exist on disk");
                    } else {
                        // Non-zero exit and spawn failure both yield a failure result.
                        prop_assert!(
                            result.is_err(),
                            "failure outcome must resolve Err: {:?}",
                            result
                        );
                        prop_assert!(!file_exists(&cached), "no usable exe produced on failure");
                    }
                }
                CompileOutcome::ExceedsTimeout => {
                    // Drive the fallback compile with a small injected timeout against a
                    // mock that sleeps ~20s. It must fail (not hang) and return bounded
                    // to roughly the timeout, far before the mock would have exited.
                    let csc_path = make_mock_csc(&dir, outcome, &cached);
                    let timeout = Duration::from_millis(small_timeout_ms);
                    let start = Instant::now();
                    let result =
                        rt.block_on(compile_native_helper(&csc_path, &source, &cached, timeout));
                    let elapsed = start.elapsed();

                    prop_assert!(result.is_err(), "timeout outcome must fail: {:?}", result);
                    prop_assert!(
                        !file_exists(&cached),
                        "a timed-out compile must not yield a usable exe"
                    );
                    // Bounded to ~timeout (+ kill/reap overhead), well under the mock's sleep.
                    prop_assert!(
                        elapsed < Duration::from_secs(10),
                        "timeout must be bounded, took {:?}",
                        elapsed
                    );
                }
            }

            let _ = fs::remove_dir_all(&dir);
        }
    }
}

// ── Task 9.6: Property 15 — clean failure on mid-operation helper termination ─
//
// Drives the production timeout-guarded wait (`await_helper_marker`, the shared
// core of the short-lived helper operations such as `close_singleton_handles`)
// against a *fake child-process test double*: a real spawned OS process
// (`cmd /C` on Windows, `sh -c` elsewhere) standing in for `RobloxNative.exe`
// that terminates before ever emitting its completion marker. The property is
// that such a termination resolves the awaiting operation cleanly and promptly
// (Requirement 7.4) rather than hanging until the timeout, and that the backend
// remains responsive to a subsequent, unrelated helper operation afterward.
#[cfg(test)]
mod mid_operation_termination_tests {
    use super::*;
    use proptest::prelude::*;
    use std::time::Instant;

    /// The ways the fake helper stand-in can terminate before emitting a marker.
    #[derive(Debug, Clone, Copy)]
    enum FakeScenario {
        /// Exits immediately with no output at all.
        ExitNoOutput,
        /// Prints an unrelated (non-marker) line, then exits.
        NoiseThenExit,
        /// Blocks for a long time (emitting nothing) and is killed mid-wait,
        /// simulating an unexpected termination while an operation is in flight.
        SleeperKilled,
    }

    /// The platform shell used to run the fake helper stand-in scripts.
    fn shell() -> (&'static str, &'static str) {
        if cfg!(windows) {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        }
    }

    /// Spawn `script` in the platform shell with stdout piped (stderr/stdin
    /// discarded), mirroring how the production code spawns `RobloxNative.exe`
    /// with a piped stdout it reads markers from.
    fn spawn_script(script: &str) -> tokio::process::Child {
        use tokio::process::Command;
        let (prog, flag) = shell();
        Command::new(prog)
            .arg(flag)
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn fake helper stand-in")
    }

    /// A script that prints `text` on its own line then exits cleanly.
    fn echo_then_exit(text: &str) -> String {
        if cfg!(windows) {
            format!("echo {text}& exit 0")
        } else {
            format!("printf '%s\\n' '{text}'; exit 0")
        }
    }

    /// Spawn a long-running "sleeper" process (~30s, no output) *directly*, with
    /// no intermediate shell. This matters on Windows: a `cmd /C` wrapper would
    /// launch the real sleeper as a grandchild that inherits a copy of the stdout
    /// pipe handle, so killing `cmd` alone would not close the pipe and the read
    /// would block until the grandchild exits. Spawning the sleeper directly means
    /// the killed process is the sole owner of the pipe's write end, so the reader
    /// observes EOF the moment it dies — the exact "helper terminated mid-operation"
    /// condition under test.
    fn spawn_sleeper() -> tokio::process::Child {
        use tokio::process::Command;
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn fake sleeper stand-in")
    }

    /// A script that emits the `HANDLES_DONE` completion marker then exits — the
    /// healthy-helper control used to prove continued responsiveness.
    fn marker_script() -> String {
        echo_then_exit("HANDLES_DONE")
    }

    /// Spawn the fake helper for `scenario`, none of which ever emit the marker.
    fn spawn_terminating(scenario: FakeScenario, noise: &str) -> tokio::process::Child {
        match scenario {
            FakeScenario::ExitNoOutput => spawn_script("exit 0"),
            FakeScenario::NoiseThenExit => spawn_script(&echo_then_exit(noise)),
            FakeScenario::SleeperKilled => spawn_sleeper(),
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        // Feature: native-tauri-backend, Property 15: An in-progress Native_Helper operation fails cleanly if the helper process terminates unexpectedly
        //
        // Validates: Requirements 7.4
        #[test]
        fn helper_termination_mid_operation_fails_cleanly_and_stays_responsive(
            kind in 0u8..3u8,
            noise in "[a-z]{1,20}",
        ) {
            let scenario = match kind {
                0 => FakeScenario::ExitNoOutput,
                1 => FakeScenario::NoiseThenExit,
                _ => FakeScenario::SleeperKilled,
            };

            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build tokio runtime");

            rt.block_on(async move {
                // A generous guard: resolving on it (rather than on the helper
                // dying) would manifest as a large elapsed time, i.e. a hang.
                let guard = Duration::from_secs(10);

                // 1) The helper terminates unexpectedly before emitting its marker.
                let mut child = spawn_terminating(scenario, &noise);
                let stdout = child.stdout.take().expect("piped stdout");

                // Force the unexpected termination shortly after the wait begins:
                // a no-op for the scenarios that exit on their own, and the thing
                // that ends the blocking sleeper mid-operation.
                let killer = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                });

                let started = Instant::now();
                let outcome = await_helper_marker(
                    stdout,
                    |m| matches!(m, HelperMarker::HandlesDone),
                    guard,
                )
                .await;
                let elapsed = started.elapsed();
                let _ = killer.await;

                // Fails cleanly on EOF, having never observed the marker.
                prop_assert_eq!(outcome, MarkerWait::Ended);
                // And resolves because the helper died, not because the guard
                // fired — it did not hang until the timeout.
                prop_assert!(
                    elapsed < Duration::from_secs(5),
                    "wait took {:?}, expected prompt resolution on helper termination",
                    elapsed
                );

                // 2) The backend stays responsive: a subsequent, unrelated wait
                //    against a healthy helper emitting the marker still succeeds.
                let mut ok_child = spawn_script(&marker_script());
                let ok_stdout = ok_child.stdout.take().expect("piped stdout");
                let ok_outcome = await_helper_marker(
                    ok_stdout,
                    |m| matches!(m, HelperMarker::HandlesDone),
                    guard,
                )
                .await;
                let _ = ok_child.wait().await;
                prop_assert_eq!(ok_outcome, MarkerWait::Marker);

                Ok(())
            })?;
        }
    }
}

// ── Task 9.4: marker-parsing correctness (design Property 17 / Requirement 9.6) ──
//
// Property 17 states: for any line matching one of the five marker formats
// (`MUTEX_HELD`, `HANDLES_DONE`, `SET:<count>`, `ANTIAFK_ON:<seconds>`,
// `ANTIAFK_TICK:<pid>`) with an arbitrary valid count/seconds/pid, the parser
// extracts a structured result identifying the correct marker type and carrying
// the exact numeric value; a line matching none of the five formats is not
// classified as any of them. This module drives both directions of that property
// through the production [`parse_marker`].
#[cfg(test)]
mod marker_parse_prop_tests {
    use super::*;
    use proptest::prelude::*;

    /// The five marker prefixes/tokens. A line that contains any of these could
    /// legitimately classify as a marker, so the "matches none" generator excludes
    /// them to guarantee its lines are true non-markers.
    const MARKER_FRAGMENTS: [&str; 5] = [
        "MUTEX_HELD",
        "HANDLES_DONE",
        "SET:",
        "ANTIAFK_ON:",
        "ANTIAFK_TICK:",
    ];

    /// One generated parser case: either a well-formed marker line paired with the
    /// exact [`HelperMarker`] it must parse into, or a line that must parse to `None`.
    #[derive(Debug, Clone)]
    enum MarkerCase {
        /// A line matching exactly one of the five formats, with the expected result.
        Valid { line: String, expected: HelperMarker },
        /// A line matching none of the five formats; must classify as no marker.
        NonMarker { line: String },
    }

    /// Optional surrounding whitespace (spaces/tabs), exercising the parser's
    /// `trim()` — helper markers arrive on their own line but may carry trailing
    /// CR/whitespace from `Console.Out.WriteLine`.
    fn arb_ws() -> impl Strategy<Value = String> {
        proptest::collection::vec(prop_oneof![Just(' '), Just('\t')], 0..4)
            .prop_map(|cs| cs.into_iter().collect())
    }

    /// A token marker (`MUTEX_HELD` / `HANDLES_DONE`) wrapped in optional
    /// whitespace, paired with the variant it must parse into.
    fn arb_token_case() -> impl Strategy<Value = MarkerCase> {
        let tokens = prop_oneof![
            Just(("MUTEX_HELD", HelperMarker::MutexHeld)),
            Just(("HANDLES_DONE", HelperMarker::HandlesDone)),
        ];
        (tokens, arb_ws(), arb_ws()).prop_map(|((tok, expected), lead, trail)| {
            MarkerCase::Valid {
                line: format!("{lead}{tok}{trail}"),
                expected,
            }
        })
    }

    /// A valued marker (`SET:` / `ANTIAFK_ON:` / `ANTIAFK_TICK:`) carrying an
    /// arbitrary `u32` payload, wrapped in optional whitespace, paired with the
    /// variant + exact value it must parse into. The payload is rendered in decimal
    /// (matching the helper's `"SET:" + n` etc.) so it round-trips exactly.
    fn arb_valued_case() -> impl Strategy<Value = MarkerCase> {
        let builders: Vec<fn(u32) -> HelperMarker> = vec![
            HelperMarker::VolumeSet,
            HelperMarker::AntiAfkOn,
            HelperMarker::AntiAfkTick,
        ];
        let prefixes = ["SET:", "ANTIAFK_ON:", "ANTIAFK_TICK:"];
        (0usize..3, any::<u32>(), arb_ws(), arb_ws()).prop_map(move |(i, n, lead, trail)| {
            MarkerCase::Valid {
                line: format!("{lead}{}{n}{trail}", prefixes[i]),
                expected: builders[i](n),
            }
        })
    }

    /// A line guaranteed to match none of the five formats: an ASCII line (no
    /// newline) filtered to contain none of the marker fragments. Empty/whitespace
    /// lines are allowed — they too must classify as no marker.
    fn arb_non_marker_case() -> impl Strategy<Value = MarkerCase> {
        proptest::string::string_regex("[ -~]{0,40}")
            .unwrap()
            .prop_filter("must not contain any marker fragment", |s| {
                !MARKER_FRAGMENTS.iter().any(|frag| s.contains(frag))
            })
            .prop_map(|line| MarkerCase::NonMarker { line })
    }

    fn arb_marker_case() -> impl Strategy<Value = MarkerCase> {
        prop_oneof![arb_token_case(), arb_valued_case(), arb_non_marker_case()]
    }

    // Feature: native-tauri-backend, Property 17: Native_Helper stdout/stderr markers are parsed into the correct structured result
    //
    // Validates: Requirements 9.6
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        #[test]
        fn markers_parse_into_correct_structured_result(case in arb_marker_case()) {
            match case {
                // A well-formed marker parses into exactly its variant, carrying
                // the exact numeric payload for the valued markers.
                MarkerCase::Valid { line, expected } => {
                    prop_assert_eq!(parse_marker(&line), Some(expected));
                }
                // A line matching none of the five formats is classified as none.
                MarkerCase::NonMarker { line } => {
                    prop_assert_eq!(parse_marker(&line), None);
                }
            }
        }
    }
}
