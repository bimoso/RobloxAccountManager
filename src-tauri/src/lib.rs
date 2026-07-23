//! RobloxAccountManager Tauri backend library crate.
//!
//! This crate replaces the legacy JS build's Node.js main process (the legacy JS backend).
//! It is organized one Rust module per logical section of the legacy JS backend (see the
//! design document's module layout). This file (`lib.rs`) owns application
//! wiring: the shared [`AppState`] and the Tauri app builder in [`run`].
//!
//! The per-section modules (`encryption`, `logging`, `accounts`, `settings`,
//! `native_helper`, `roblox_process`, `roblox_api`, `browser_launcher`,
//! `packages`) are added by later tasks; only the scaffold and shared state
//! live here for now.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

/// Serde data models for the Account_Store and Settings_Store (`accounts.json`
/// / `settings.json`), mirroring the legacy JS build's on-disk JSON shapes.
pub mod models;

/// Shared Windows-platform gate (`ensure_windows`/`is_windows`), ported from the
/// legacy JS build's `process.platform !== 'win32'` guards. Every Windows-only
/// entry point (Roblox launch/kill, Native_Helper invocation, "Open in Browser")
/// short-circuits through this so a non-Windows OS gets a graceful
/// "unavailable on this platform" report rather than undefined behavior
/// (Requirement 8.4).
pub mod platform;

/// Field encryption ported from the legacy JS backend's encryption section. Currently
/// provides the raw Windows DPAPI primitives (`safe:` format); the scrypt/legacy
/// formats, passphrase verifier, and tag dispatch are added by later tasks.
pub mod encryption;

/// Session logging: the `send_log` equivalent of the legacy JS backend's `sendLog`, emitting
/// `log://entry` events to the Renderer_UI (redaction is added in Task 4.2).
pub mod logging;

/// Account_Store persistence (`accounts.json`), ported from the legacy JS backend's
/// `loadAccounts`/`saveAccounts` and the `accounts:*` IPC handlers. Currently
/// provides the read path (`load_from_file`/`load_from_dir`) with read-failure
/// classification and per-entry decrypt-error surfacing; save/add/update/remove/
/// reorder and command registration are added by later tasks.
pub mod accounts;

/// Encryption-input resolution for the command layer: resolves
/// `passphrase_mode` / `safe_storage_ready` / `device_key` from the
/// Settings_Store + platform (ports the legacy JS backend's `passphraseMode`,
/// `safeStorageReady`, `getOrCreateDeviceKey`), so the store commands can thread
/// them into `encryption.rs` without those lower layers reading settings.
pub mod crypto_context;

/// Settings_Store persistence ported from the legacy JS backend's `loadSettings`/
/// `saveSettings` section. Currently provides the `load` read path (applying
/// recognized fields, defaulting absent ones with the legacy JS runtime runtime defaults,
/// preserving unrecognized fields, and distinguishing corruption from
/// permission/IO errors); save and the genhistory/fflag/fps helpers are added by
/// later tasks.
pub mod settings;

/// Roblox game client process management, ported from the legacy JS backend's Roblox
/// session-control section. Provides the pure, synchronous launch-target parser
/// (`parse_launch_target` → [`roblox_process::LauncherRequest`], Task 10.1) and
/// the launch-credential pipeline (Task 10.2): the launch-queue serialization
/// and 4-second stagger, the CSRF-token cache (5-minute TTL) and auth-ticket
/// cache (25-second TTL, 8-second minimum gap), each reporting a failure without
/// marking the account launched. Also provides the watch/poll close-detection
/// state machine (Task 10.3): the shared tracking maps, the 5000 ms poll loop,
/// the 15000 ms post-launch grace period, the 4-consecutive-miss close rule with
/// reset-on-present, and the `roblox://closed`/`roblox://count` Renderer_UI
/// notification (behind pluggable presence-probe/notifier traits). The kill
/// paths and command registration are added by later tasks.
pub mod roblox_process;

/// Native_Helper (`RobloxNative.exe`) integration, ported from the legacy JS backend's
/// native-helper section. Provides `ensure_native_helper` (the three-step
/// bundled-exe → cached-compile → `csc.exe`-fallback resolution with a 30-second
/// timeout, Task 9.1) and the `tokio::time::timeout`-guarded process lifecycle
/// (Task 9.2): the persistent mutex holder (`start`/`stop`/`restart_mutex_holder`)
/// and the short-lived per-invocation `set_roblox_volume`, `close_singleton_handles`,
/// and `start`/`stop_anti_afk`, plus the structured marker parser (Task 9.3).
/// The `roblox_set_volume` / `multiinstance_status` / `antiafk_status`
/// `#[tauri::command]` wrappers (Task 9.7) are registered with the Tauri builder
/// in [`run`].
pub mod native_helper;

/// Roblox HTTPS API calls ported from the legacy JS backend's Roblox networking section:
/// client version, cookie validation (`fetch_user_info`), game name resolution,
/// and the share-link/private-server resolution chain (`resolve_share_link`,
/// `get_access_code`, `follow_redirect`). Uses `reqwest`. The command wrappers
/// (`roblox_get_version`/`roblox_validate_cookie`/`roblox_get_game_name`) are
/// registered with the Tauri builder in [`run`] (Task 11.3).
pub mod roblox_api;

/// Account_Browser_Launcher (`browser_launcher.rs`), ported from the legacy JS backend's
/// account-browser-launcher subsystem. Currently provides the Donut_Browser_API
/// plain-HTTP transport (`donut_request`, `reqwest`-based, `Authorization: Bearer`,
/// 5-second timeout, reproducing the legacy Donut HTTP helper's three-way
/// `unreachable`/`http`/success classification) plus the `get_donut_base_url` /
/// `get_donut_token` resolvers (Task 13.1), the availability preflight and Donut
/// profile lifecycle (13.2), the CDP login/cookie-injection flows (13.3/13.4),
/// per-account session tracking + Copy Cookie (13.5), and the command layer
/// (Task 13.7): the `browser_open` / `browser_copy_cookie` `#[tauri::command]`
/// wrappers (registered in [`run`]), the concrete
/// `tauri-plugin-clipboard-manager`-backed `TauriClipboard`, and the canonical
/// `browser://session-state` / `chrome://download-progress` event-name constants
/// (`browser://notify` is owned by `accounts_remove` in `accounts.rs`).
pub mod browser_launcher;

/// Standalone Wayfern provider: manifest resolution, streaming portable
/// installation, per-account profiles and CDP launch/cookie injection.
pub mod wayfern;

/// BloxGen account-generation API client. Runs server-side because the webview
/// blocks a direct `fetch` to `core.bloxgen.net` under CORS ("Failed to fetch").
pub mod bloxgen;

/// Humanized keystroke timing for the credential auto-login flow: a
/// dependency-free, deterministic-given-a-seed delay model that jitters the
/// per-character cadence when [`browser_launcher`] auto-fills the Roblox login
/// form, so a bulk `user:pass` fill does not type like a bot.
pub mod humanize;

/// Windows Roblox client discovery, protocol-handler presets, release lookup,
/// and verified managed deployment installation.
pub mod roblox_installations;

/// Settings_Store + encryption Tauri command layer (Task 7.7). Hosts the
/// `settings_*` / `enc_*` / `genhistory_*` / `fflag_*` / `fps_*` `#[tauri::command]`
/// wrappers that orchestrate `settings.rs`, `encryption.rs`, `accounts.rs`, and
/// `crypto_context.rs`, resolving the app-data directory via
/// [`accounts::store_dir`] exactly like the `accounts_*` commands.
pub mod commands;

/// Packages_Store persistence (`packages.json`), ported from the legacy JS backend's
/// `loadPackages`/`savePackages` and the `packages:*` IPC handlers. Packages are
/// named, secret-free groups of accounts, so this store is deliberately
/// permissive (a missing/unreadable/corrupt file reads as `[]`, matching the
/// legacy JS build). Currently provides the load/save logic
/// (`load_from_file`/`load_from_dir` and `save_to_file`/`save_to_dir`); the
/// `packages_load`/`packages_save` command wrappers are added by Task 14.2.
pub mod packages;

/// Roblox game-window grid layout (the multi-instance "Window layout" feature):
/// enumerates the visible top-level windows belonging to live
/// `RobloxPlayerBeta.exe` processes and arranges them into a grid — either
/// sized from the desktop work area (auto layout) or from the configured
/// target size / windows-per-row. Provides the `roblox_arrange_windows`
/// command plus a debounced background maintenance pass that re-arranges as
/// instances open and close while the feature is enabled.
pub mod window_layout;

/// Window-control and external-open command layer (Task 16.1), ported from
/// the legacy JS backend's `window-minimize` / `window-maximize` / `window-close` /
/// `open-external` IPC handlers. Hosts the `window_minimize` / `window_maximize`
/// / `window_close` / `open_external` `#[tauri::command]` wrappers (registered in
/// [`run`]); `open_external` uses the `tauri-plugin-opener` plugin as the Tauri v2
/// replacement for legacy JS runtime's `shell.openExternal`.
pub mod window;

/// WebView2 runtime presence check (Task 19.4, Requirement 12.7). Unlike the
/// legacy JS build's bundled Chromium, the Tauri_Build renders through the OS
/// WebView component — the Microsoft Edge WebView2 runtime on Windows. This
/// module detects that runtime at startup (via [`tauri::webview_version`]) and,
/// when it is absent, reports a clear, actionable error to the user (stderr +
/// native message box) and exits cleanly rather than crashing opaquely during
/// window creation. Wired into [`run`] before the Tauri app is built.
pub mod webview2;

/// A cached, time-limited token (CSRF token or auth ticket) as used by the
/// Roblox launch flow.
///
/// `cached_at` is the epoch-millisecond timestamp at which the value was stored,
/// mirroring the legacy JS backend's `{ token, ts }` / `{ ticket, ts }` cache entries: every
/// freshness/TTL check in the launch flow is expressed as `now - cached_at <
/// SOME_TTL`, and the auth-ticket path additionally needs the original store time
/// to compute the `TICKET_MIN_GAP` back-off, so the store time (not a
/// precomputed deadline) is what is retained.
#[derive(Debug, Clone)]
pub struct CachedToken {
    pub value: String,
    pub cached_at: i64,
}

/// The session-scoped parameters a successful launch was made with, remembered
/// per account so the auto-relaunch feature can restart an unexpectedly closed
/// instance without re-asking the renderer. In-memory only — the plaintext
/// cookie is never persisted through this path (the renderer already holds it
/// for the session).
#[derive(Debug, Clone)]
pub struct LaunchParams {
    pub cookie: String,
    pub target: String,
}

/// Shared, long-lived backend state, registered with Tauri via `app.manage(...)`
/// and injected into command handlers as `tauri::State<'_, AppState>`.
///
/// These are the direct Rust equivalents of the legacy JS backend's module-level mutable
/// variables (the in-memory-only session-tracking maps and process handles).
/// Maps read only from synchronous contexts use `std::sync::Mutex`; maps touched
/// from async command handlers use `tokio::sync::Mutex` so a handler never blocks
/// the async runtime while holding the lock.
pub struct AppState {
    /// `_accountPids`: accountId -> pid of the `RobloxPlayerBeta` process we
    /// spawned for that account.
    pub account_pids: Arc<Mutex<HashMap<String, u32>>>,

    /// `_watchedAccounts`: accountId -> `readyAt` (epoch ms). The watch/poll
    /// state machine does not evaluate an account until its post-launch grace
    /// period (`readyAt`) has elapsed.
    pub watched_accounts: Arc<AsyncMutex<HashMap<String, i64>>>,

    /// `_missCounts`: accountId -> consecutive "process not found" count.
    pub miss_counts: Arc<AsyncMutex<HashMap<String, u32>>>,

    /// `_watchTimer`: whether the single shared watch/poll loop task is currently
    /// running. Mirrors the legacy JS backend's `_watchTimer` (a non-null timer handle means
    /// "the poll is running"): the loop is started on the first armed account and
    /// stops itself once no accounts remain watched, so at most one poll task ever
    /// runs regardless of how many accounts are launched.
    pub watch_loop_running: Arc<AsyncMutex<bool>>,

    /// Account_Browser_Launcher: accountId -> live CDP session
    /// ([`browser_launcher::BrowserSession`], carrying the session `state`, the
    /// backing Donut profile id / CDP port, and — once `open` — the live
    /// connected browser + tracked page). Not persisted: it describes only the
    /// current process's live CDP connections, exactly like the legacy JS backend's
    /// `_browserSessions` map.
    pub browser_sessions: Arc<AsyncMutex<HashMap<String, browser_launcher::BrowserSession>>>,

    /// Prevent duplicate ~1 GB Wayfern downloads when installation and launch
    /// are requested at the same time.
    pub wayfern_install_lock: Arc<AsyncMutex<()>>,

    /// Serializes activation of a managed Roblox deployment. Package downloads
    /// are concurrent within one operation, but two installations must never
    /// race while renaming staging directories into the versions store.
    pub roblox_deployment_install_lock: Arc<AsyncMutex<()>>,

    /// Renderer-supplied operation id -> cancellation token for in-flight or
    /// queued managed Roblox deployment installations.
    pub roblox_deployment_cancellations:
        Arc<AsyncMutex<HashMap<String, tokio_util::sync::CancellationToken>>>,

    /// `_mutexProc`: the persistent Native_Helper child process holding the
    /// Roblox singleton mutex for the lifetime of a multi-instance hold.
    pub mutex_proc: Arc<AsyncMutex<Option<tokio::process::Child>>>,

    /// `_antiAfkProc`: the Native_Helper child process running the anti-AFK loop.
    pub anti_afk_proc: Arc<AsyncMutex<Option<tokio::process::Child>>>,

    /// Serializes the launch queue (`_launchQueue`) so concurrent launches are
    /// staggered rather than all hammering auth.roblox.com at once.
    pub launch_lock: Arc<AsyncMutex<()>>,

    /// `_lastLaunchTs`: epoch-ms timestamp of the most recent launch, used to
    /// enforce the 4-second launch stagger.
    pub last_launch_ts: Arc<Mutex<i64>>,

    /// `_csrfCache`: cookie -> cached CSRF token (5-minute TTL). Keyed per
    /// cookie because a CSRF token is only valid for the session cookie it was
    /// minted against, so distinct accounts must not share one entry — matching
    /// the legacy JS backend's `_csrfCache = new Map()` keyed by cookie.
    pub csrf_cache: Arc<AsyncMutex<HashMap<String, CachedToken>>>,

    /// Cached per-account auth tickets (25-second TTL).
    pub ticket_cache: Arc<AsyncMutex<HashMap<String, CachedToken>>>,

    /// The cancel `Sender` for an in-progress cookie-capture login window, held
    /// while `roblox_open_login` awaits `run_login_flow` and cleared afterward.
    /// `login_cancel` takes and fires it to trip the flow's `cancel_rx`,
    /// replacing the legacy JS build's `legacy one-shot IPC listener('login:cancel', ...)`. `None`
    /// whenever no login is in progress.
    pub login_cancel_tx: Arc<AsyncMutex<Option<tokio::sync::oneshot::Sender<()>>>>,

    /// accountId -> the cookie/target its last successful launch used, so an
    /// unexpected close can be auto-relaunched. The kill paths clear entries (a
    /// manual kill means "stay closed"); session-scoped, never persisted.
    pub launch_params: Arc<Mutex<HashMap<String, LaunchParams>>>,

    /// Accounts with an auto-relaunch currently in flight, guarding against a
    /// duplicate relaunch being spawned for the same detected close.
    pub relaunching: Arc<Mutex<HashSet<String>>>,

    /// Whether the single debounced window-layout maintenance pass is running
    /// (`window_layout::schedule_layout_pass` spawns at most one).
    pub layout_pass_running: Arc<AtomicBool>,

    /// The window set + config the last layout pass arranged, so a maintenance
    /// tick only re-arranges when instances actually opened/closed or the
    /// layout configuration changed (never fighting the user's manual moves).
    pub layout_last: Arc<Mutex<Option<window_layout::LayoutStamp>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            account_pids: Arc::new(Mutex::new(HashMap::new())),
            watched_accounts: Arc::new(AsyncMutex::new(HashMap::new())),
            miss_counts: Arc::new(AsyncMutex::new(HashMap::new())),
            watch_loop_running: Arc::new(AsyncMutex::new(false)),
            browser_sessions: Arc::new(AsyncMutex::new(HashMap::new())),
            wayfern_install_lock: Arc::new(AsyncMutex::new(())),
            roblox_deployment_install_lock: Arc::new(AsyncMutex::new(())),
            roblox_deployment_cancellations: Arc::new(AsyncMutex::new(HashMap::new())),
            mutex_proc: Arc::new(AsyncMutex::new(None)),
            anti_afk_proc: Arc::new(AsyncMutex::new(None)),
            launch_lock: Arc::new(AsyncMutex::new(())),
            last_launch_ts: Arc::new(Mutex::new(0)),
            csrf_cache: Arc::new(AsyncMutex::new(HashMap::new())),
            ticket_cache: Arc::new(AsyncMutex::new(HashMap::new())),
            login_cancel_tx: Arc::new(AsyncMutex::new(None)),
            launch_params: Arc::new(Mutex::new(HashMap::new())),
            relaunching: Arc::new(Mutex::new(HashSet::new())),
            layout_pass_running: Arc::new(AtomicBool::new(false)),
            layout_last: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_native_window_material(window: &tauri::WebviewWindow) {
    use window_vibrancy::{apply_mica, apply_tabbed};

    if apply_tabbed(window, Some(true)).is_ok() {
        return;
    }

    if let Err(err) = apply_mica(window, Some(true)) {
        eprintln!("Windows 11 Mica material unavailable: {err:?}");
    }
}

/// Application entry point. Builds the Tauri app, registers the shared
/// [`AppState`], and runs the event loop. Commands and events are registered
/// here by later tasks; for now this establishes the single frameless main
/// window and managed state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The Tauri_Build renders through the OS WebView2 runtime rather than a
    // bundled Chromium. Verify that runtime is present before building the app so
    // that, when it is missing, the user gets a clear, actionable report instead
    // of an opaque window-creation crash (Requirement 12.7).
    webview2::ensure_webview2_runtime();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // Persists the main window's size/position/maximized state to disk on
        // close and restores it on the next launch, so the app reopens at
        // whatever dimensions the user last resized it to instead of always
        // resetting to the built-in default below.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState::default())
        .setup(|app| {
            // Tauri has no equivalent of the legacy JS runtime's
            // `webPreferences.preload`. The canonical `src-tauri/preload.js` builds
            // the flat `window.api.*` surface consumed by the React frontend and is
            // injected here as a webview *initialization script*, guaranteed to run
            // at document-start before the application bundle. Because an init script can
            // only be attached at window-creation time, the main window is built in
            // Rust here (and removed from `tauri.conf.json`'s `windows` list) rather
            // than auto-created from config. Requirements 10.1, 10.2, 10.3.
            use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("RobloxAccountManager")
                .inner_size(1120.0, 760.0)
                .min_inner_size(900.0, 680.0)
                .resizable(true)
                .transparent(true)
                .decorations(false)
                .initialization_script(include_str!("../preload.js"))
                .build()?;
            #[cfg(target_os = "windows")]
            apply_native_window_material(&win);
            // Apply the previously saved size/position/maximized state (if any)
            // now that the window exists. Falling back silently on the very
            // first run, when there is nothing saved yet, is intended.
            use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
            let _ = win.restore_state(StateFlags::all());
            let app_for_state = app.handle().clone();
            win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    let _ = app_for_state.save_window_state(StateFlags::all());
                    let state = app_for_state.state::<AppState>();
                    tauri::async_runtime::block_on(native_helper::shutdown_native_helpers(&state));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            accounts::accounts_load,
            accounts::accounts_add,
            accounts::accounts_update,
            accounts::accounts_remove,
            accounts::accounts_reorder,
            commands::settings_load,
            commands::settings_save,
            commands::settings_save_donut_token,
            commands::enc_status,
            commands::enc_unlock,
            commands::enc_set_key,
            commands::genhistory_read,
            commands::genhistory_write,
            commands::genhistory_clear,
            commands::fflag_read,
            commands::fflag_write,
            commands::fps_read,
            commands::fps_write,
            roblox_api::roblox_get_version,
            roblox_api::roblox_validate_cookie,
            roblox_api::roblox_moderation_info,
            bloxgen::bloxgen_generate,
            roblox_api::roblox_get_game_name,
            roblox_api::roblox_get_avatar_thumbnails,
            roblox_api::roblox_refresh_cookie,
            roblox_api::roblox_api_get,
            roblox_api::roblox_get_presence,
            roblox_api::roblox_game_details,
            roblox_api::roblox_send_friend_request,
            roblox_api::roblox_change_password,
            roblox_api::roblox_change_display_name,
            roblox_api::roblox_quick_login,
            roblox_process::roblox_launch,
            roblox_process::roblox_kill_all,
            roblox_process::roblox_kill_one,
            roblox_process::roblox_running_count,
            window_layout::roblox_arrange_windows,
            window_layout::roblox_window_count,
            native_helper::roblox_set_volume,
            native_helper::multiinstance_status,
            native_helper::antiafk_status,
            browser_launcher::browser_open,
            browser_launcher::browser_open_batch,
            browser_launcher::browser_copy_cookie,
            wayfern::browser_wayfern_status,
            wayfern::browser_wayfern_install,
            roblox_installations::roblox_installations_scan,
            roblox_installations::roblox_custom_preset_add,
            roblox_installations::roblox_custom_preset_remove,
            roblox_installations::roblox_protocol_state,
            roblox_installations::roblox_protocol_activate,
            roblox_installations::roblox_protocol_restore,
            roblox_installations::roblox_release_latest,
            roblox_installations::roblox_deployments_list,
            roblox_installations::roblox_deployment_install,
            roblox_installations::roblox_deployment_cancel,
            browser_launcher::roblox_open_login,
            browser_launcher::roblox_login_credentials,
            browser_launcher::login_cancel,
            packages::packages_load,
            packages::packages_save,
            window::window_minimize,
            window::window_maximize,
            window::window_close,
            window::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the RobloxAccountManager Tauri application");
}
