//! Settings_Store (`settings.rs`).
//!
//! This module ports the Electron_Build's settings-persistence section from
//! `src/main.js` — specifically the `loadSettings()` read path and the runtime
//! defaults `applySettingsDonutDefaults` layers on top of it. In the
//! Electron_Build:
//!
//! ```js
//! const settingsPath = path.join(app.getPath('userData'), 'settings.json');
//! function loadSettings() {
//!   let s;
//!   try { s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}; } catch { s = {}; }
//!   applySettingsDonutDefaults(s); // donutApiTokenEnc:null, donutApiPort:10108, pendingDonutDeletions:[] when absent
//!   return s;
//! }
//! ```
//!
//! and (`src/account-model.js`):
//!
//! ```js
//! function applySettingsDonutDefaults(s) {
//!   if (s.donutApiTokenEnc === undefined) s.donutApiTokenEnc = null;
//!   if (s.donutApiPort === undefined) s.donutApiPort = 10108;
//!   if (s.pendingDonutDeletions === undefined) s.pendingDonutDeletions = [];
//!   return s;
//! }
//! ```
//!
//! ## What this task (7.1) ports
//!
//! [`load_from_file`] / [`load_from_dir`] read `settings.json` and produce a
//! [`Settings`] where:
//!   * every recognized field **present** in the file keeps the file's value,
//!   * every recognized field **absent** from the file gets its default — using
//!     the Electron_Build's documented *runtime* defaults, not merely Rust's
//!     zero-values (the one default that actually differs is `donutApiPort`,
//!     which defaults to `10108`; see [`apply_runtime_defaults`]), and
//!   * every unrecognized/legacy field is preserved via the
//!     `#[serde(flatten)] extra` catch-all on [`Settings`] (Requirement 11.2).
//!
//! ## Deliberate divergence from the Electron_Build on read failure
//!
//! The Electron_Build's `loadSettings` wraps its read+parse in a bare
//! `try { ... } catch { s = {} }`, so a **corrupt** file (a `JSON.parse` throw)
//! and a **permission/IO** read error both silently collapse to an empty object.
//! Requirement 11.7 explicitly forbids that: an existing store file that cannot
//! be read must NOT be silently replaced by an empty store. So this port:
//!   * treats a **missing** file as "return defaults" (a missing file is not an
//!     unreadable file — this matches Electron's `fs.existsSync(...) ? ... : {}`
//!     branch), but
//!   * returns a distinguishable [`SettingsStoreError`] for a **corrupt** file
//!     (invalid/malformed settings JSON) vs. a **permission/IO** error on an
//!     existing file, and never falls back to an empty/default store in either
//!     failure case (Requirement 11.7).
//!
//! This is the one place the read path intentionally does not mirror
//! Electron's swallow-all behavior, and it does so because the requirements
//! mandate it.
//!
//! ## Secrets
//!
//! `load` returns the [`Settings`] exactly as stored: `donutApiTokenEnc` and
//! `keyVerifier` stay in their encrypted/opaque on-disk form. Decrypting them
//! (and the command-layer scrubbing that prevents secrets reaching the
//! Renderer_UI, Requirement 3.4 / Property 12) are separate concerns handled by
//! `encryption.rs` and the `settings_load` command wiring (Task 7.7), not here.

use std::fmt;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::encryption;
use crate::models::Settings;

/// The Settings_Store file name, unchanged from the Electron_Build
/// (`settings.json`). It lives in the per-user application data directory
/// (`app.getPath('userData')` in Electron, Tauri's `app_data_dir()` configured to
/// the same `%APPDATA%\robloxaccountmanager\` location, Requirement 11.6). The command
/// layer (Task 7.7) resolves that directory from the Tauri `AppHandle` and calls
/// [`load_from_dir`]; the core load logic here takes a plain path so it is
/// unit-testable without a live Tauri app.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// The Electron_Build's documented runtime default for `donutApiPort`
/// (`applySettingsDonutDefaults`: `s.donutApiPort = 10108` when absent). This is
/// the only recognized-field default that differs from the Rust zero-value
/// (`Option::None`), so it is the one [`apply_runtime_defaults`] must set
/// explicitly.
pub const DEFAULT_DONUT_API_PORT: u16 = 10108;

/// A distinguishable Settings_Store read failure, mirroring Requirement 11.7's
/// requirement that a load error identify *which* store failed and *whether* the
/// cause was file corruption or a file-permission/IO error — and never be
/// silently replaced by an empty store.
///
/// A missing file is intentionally NOT represented here: it is not a failure
/// (see the module docs and [`load_from_file`]), it simply yields defaults.
///
/// The type serializes to a tagged object (`{ "store", "cause", "path",
/// "detail" }`) so the command layer can hand the Renderer_UI a structured,
/// user-distinguishable error rather than an opaque string.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "cause", rename_all = "snake_case")]
pub enum SettingsStoreError {
    /// The file exists and was read, but its bytes are not valid/parseable
    /// settings JSON (the corruption case — Electron's `JSON.parse` throw).
    Corruption {
        store: &'static str,
        path: String,
        detail: String,
    },
    /// The file exists but could not be read because the OS denied access
    /// (the file-permission-error case).
    Permission {
        store: &'static str,
        path: String,
        detail: String,
    },
    /// The file exists but could not be read due to some other OS-level IO
    /// error (still a read failure that must never collapse to an empty store).
    Io {
        store: &'static str,
        path: String,
        detail: String,
    },
}

impl SettingsStoreError {
    const STORE: &'static str = "settings";

    /// Builds the corruption variant for a parse/deserialize failure on an
    /// already-read file.
    fn corruption(path: &Path, detail: impl fmt::Display) -> Self {
        SettingsStoreError::Corruption {
            store: Self::STORE,
            path: path.display().to_string(),
            detail: detail.to_string(),
        }
    }

    /// Classifies an [`io::Error`] from reading an existing file into either the
    /// [`SettingsStoreError::Permission`] or [`SettingsStoreError::Io`] variant.
    /// `NotFound` is deliberately handled by the caller as "missing file =>
    /// defaults" and never reaches here.
    fn from_io(path: &Path, err: &io::Error) -> Self {
        let store = Self::STORE;
        let path = path.display().to_string();
        let detail = err.to_string();
        match err.kind() {
            ErrorKind::PermissionDenied => SettingsStoreError::Permission {
                store,
                path,
                detail,
            },
            _ => SettingsStoreError::Io {
                store,
                path,
                detail,
            },
        }
    }

    /// True iff this error is the file-corruption case.
    pub fn is_corruption(&self) -> bool {
        matches!(self, SettingsStoreError::Corruption { .. })
    }

    /// True iff this error is the file-permission case.
    pub fn is_permission(&self) -> bool {
        matches!(self, SettingsStoreError::Permission { .. })
    }
}

impl fmt::Display for SettingsStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsStoreError::Corruption { path, detail, .. } => write!(
                f,
                "the settings store at {path} is corrupted and could not be parsed: {detail}"
            ),
            SettingsStoreError::Permission { path, detail, .. } => write!(
                f,
                "the settings store at {path} could not be read due to a file-permission error: {detail}"
            ),
            SettingsStoreError::Io { path, detail, .. } => write!(
                f,
                "the settings store at {path} could not be read due to a file error: {detail}"
            ),
        }
    }
}

impl std::error::Error for SettingsStoreError {}

/// The Settings_Store file path inside the given per-user application data
/// directory (`<dir>/settings.json`).
pub fn settings_path_in(dir: &Path) -> PathBuf {
    dir.join(SETTINGS_FILE_NAME)
}

/// Applies the Electron_Build's documented runtime defaults to a freshly loaded
/// [`Settings`], leaving any value already present in the file untouched — the
/// direct port of `applySettingsDonutDefaults`.
///
/// Of the three Donut defaults Electron layers on, only `donutApiPort` differs
/// from the Rust struct's own default:
///   * `donutApiTokenEnc` absent => `null`, which is already `Option::None` on
///     the loaded struct, so no action is needed.
///   * `pendingDonutDeletions` absent => `[]`, which is already the empty `Vec`
///     produced by `#[serde(default)]` on the struct, so no action is needed.
///   * `donutApiPort` absent => `10108`; the struct default is `None`, so this
///     is the one default that must be set here to match the Electron_Build.
///
/// The two no-op cases are called out explicitly (rather than silently relying
/// on the struct defaults) so the mapping to `applySettingsDonutDefaults` stays
/// verifiable by inspection.
pub fn apply_runtime_defaults(settings: &mut Settings) {
    // donutApiTokenEnc: absent => null (None) — already the struct default.
    // pendingDonutDeletions: absent => [] — already the struct default.
    if settings.donut_api_port.is_none() {
        settings.donut_api_port = Some(DEFAULT_DONUT_API_PORT);
    }
}

/// The default [`Settings`] returned when no Settings_Store file exists yet —
/// the Rust struct default with the Electron runtime defaults applied. Mirrors
/// `loadSettings()` taking the `{}` branch and then running
/// `applySettingsDonutDefaults`.
pub fn default_settings() -> Settings {
    let mut settings = Settings::default();
    apply_runtime_defaults(&mut settings);
    settings
}

/// Loads the Settings_Store from an explicit file path — the testable core of
/// `loadSettings()`.
///
/// Behavior (see module docs for the rationale):
///   * **Missing file** => [`default_settings`] (missing is not unreadable;
///     matches Electron's `fs.existsSync(...) ? ... : {}`).
///   * **Permission/IO error** on an existing file => `Err` identifying it as a
///     permission or IO failure; never falls back to defaults (Requirement 11.7).
///   * **Corrupt** (unparseable/malformed settings JSON) => `Err` identifying it
///     as corruption; never falls back to defaults (Requirement 11.7). Because
///     the bytes are already in memory when parsing runs, any `serde_json`
///     failure here is a content problem, not an IO one, so it is cleanly the
///     corruption case (a valid-JSON-but-wrong-type value for a recognized field
///     is likewise treated as corruption — the settings file is malformed).
///   * **Success** => every recognized field present in the file is applied,
///     every recognized field absent is defaulted via [`apply_runtime_defaults`],
///     and every unrecognized/legacy field is preserved through the `extra`
///     catch-all (Requirement 11.2). Nothing is written back to disk.
///
/// The returned [`Settings`] keeps `donutApiTokenEnc`/`keyVerifier` exactly as
/// stored (encrypted/opaque); decryption is a separate concern.
pub fn load_from_file(path: &Path) -> Result<Settings, SettingsStoreError> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        // Missing file is the defaults branch, NOT a read failure.
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(default_settings()),
        // Any other read error on an existing file must surface, never fall back.
        Err(err) => return Err(SettingsStoreError::from_io(path, &err)),
    };

    let mut settings: Settings =
        serde_json::from_str(&contents).map_err(|err| SettingsStoreError::corruption(path, err))?;
    apply_runtime_defaults(&mut settings);
    Ok(settings)
}

/// Loads the Settings_Store from `<dir>/settings.json`. The command layer
/// (Task 7.7) resolves `dir` from the Tauri `app_data_dir()` (configured to the
/// same `%APPDATA%\robloxaccountmanager\` location as the Electron_Build's
/// `app.getPath('userData')`, Requirement 11.6) and calls this.
pub fn load_from_dir(dir: &Path) -> Result<Settings, SettingsStoreError> {
    load_from_file(&settings_path_in(dir))
}

// ── Settings save (overlay-merge) + Donut_API_Token save ─────────────────────
//
// This section ports `main.js`'s `saveSettings` write primitive and the two IPC
// handlers layered on it: the general `settings:save` (overlay-merge of a partial
// update) and the dedicated `settings:saveDonutToken`.
//
// `main.js`'s write primitive:
//
// ```js
// function saveSettings(s) { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), { mode: 0o600 }); }
// ```
//
// The `{ mode: 0o600 }` is a POSIX permission hint that Node ignores on Windows
// (the app is Windows-only, Requirement 8.1), so the Rust port writes the same
// 2-space-pretty JSON with `fs::write` and does not attempt to reproduce the
// no-op mode bit.

/// The keys `settings:save` destructures out of the incoming update before
/// merging, so a general settings write can never persist or wipe key material
/// or the Donut_API_Token — matching `main.js`:
///
/// ```js
/// const { customKey, customKeyEnc, keyVerifier, donutApiTokenEnc, ...rest } = data;
/// saveSettings({ ...loadSettings(), ...rest });
/// ```
///
/// `keyVerifier` / key material changes go through the encryption handlers
/// (`enc:setKey`, Task 7.7), and the Donut_API_Token only ever goes through
/// [`save_donut_token_to_file`], so both are stripped here. These keys are
/// removed from the *update* only; whatever value they already hold in the
/// existing store is preserved (it comes through the `...loadSettings()` half of
/// the spread), exactly as in the Electron_Build.
pub const STRIPPED_SAVE_KEYS: [&str; 4] =
    ["customKey", "customKeyEnc", "keyVerifier", "donutApiTokenEnc"];

/// A Settings_Store *write* failure (as opposed to the read failures modeled by
/// [`SettingsStoreError`]).
///
/// A [`save`](save_to_file) first has to *read* the existing store (the
/// `...loadSettings()` half of the merge). Where `main.js`'s `loadSettings`
/// silently collapses a corrupt/unreadable file to `{}` and would then overwrite
/// it, Requirement 11.7 forbids that: a save must NOT clobber an existing store
/// it could not read. So a read failure during save surfaces as
/// [`SaveSettingsError::Load`] and no write is performed.
#[derive(Debug)]
pub enum SaveSettingsError {
    /// Reading the existing store (to merge into) failed; the store is left
    /// untouched and no write is performed (Requirement 11.7).
    Load(SettingsStoreError),
    /// The merged update could not be represented as valid [`Settings`] (e.g. a
    /// recognized field was given an incompatible type). The store is left
    /// untouched rather than persisting content the app could not later read.
    InvalidUpdate { detail: String },
    /// Serializing or writing the merged settings to disk failed.
    Write { path: String, detail: String },
}

impl From<SettingsStoreError> for SaveSettingsError {
    fn from(err: SettingsStoreError) -> Self {
        SaveSettingsError::Load(err)
    }
}

impl fmt::Display for SaveSettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SaveSettingsError::Load(err) => {
                write!(f, "could not read the settings store before saving: {err}")
            }
            SaveSettingsError::InvalidUpdate { detail } => write!(
                f,
                "the settings update could not be applied (invalid value): {detail}"
            ),
            SaveSettingsError::Write { path, detail } => {
                write!(f, "could not write the settings store at {path}: {detail}")
            }
        }
    }
}

impl std::error::Error for SaveSettingsError {}

/// Serialize `settings` to the same 2-space-pretty JSON `main.js`'s
/// `JSON.stringify(s, null, 2)` produces and write it to `path`, mapping any
/// serialize/IO failure to [`SaveSettingsError::Write`].
fn write_settings_pretty(path: &Path, settings: &Settings) -> Result<(), SaveSettingsError> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| SaveSettingsError::Write {
        path: path.display().to_string(),
        detail: e.to_string(),
    })?;
    fs::write(path, json).map_err(|e| SaveSettingsError::Write {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

/// Overlay-merge `update` into `existing`, reproducing `main.js`'s shallow spread
/// `{ ...loadSettings(), ...rest }`:
///   * every key present in `update` (after stripping [`STRIPPED_SAVE_KEYS`])
///     overwrites the corresponding key in `existing`;
///   * every key absent from `update` keeps its existing value;
///   * any key in `update` not recognized by [`Settings`] is still merged (it
///     lands in the `extra` catch-all), matching JS spreading arbitrary keys.
///
/// The merge is performed at the `serde_json` object level (not field-by-field)
/// so it mirrors the JS spread exactly, including for unrecognized/legacy keys.
/// The result is then validated back into a [`Settings`]; if a recognized field
/// was given an incompatible type the merge is rejected
/// ([`SaveSettingsError::InvalidUpdate`]) rather than writing content that could
/// not later be read.
fn merge_settings_update(
    existing: &Settings,
    update: &Map<String, Value>,
) -> Result<Settings, SaveSettingsError> {
    // `Settings` always serializes to a JSON object, so this match is total.
    let mut base = match serde_json::to_value(existing) {
        Ok(Value::Object(map)) => map,
        Ok(other) => {
            return Err(SaveSettingsError::InvalidUpdate {
                detail: format!("existing settings did not serialize to an object: {other}"),
            })
        }
        Err(e) => {
            return Err(SaveSettingsError::InvalidUpdate {
                detail: format!("existing settings could not be serialized: {e}"),
            })
        }
    };

    for (key, value) in update {
        if STRIPPED_SAVE_KEYS.contains(&key.as_str()) {
            continue; // never write key material / the Donut token via this path
        }
        base.insert(key.clone(), value.clone());
    }

    serde_json::from_value(Value::Object(base)).map_err(|e| SaveSettingsError::InvalidUpdate {
        detail: e.to_string(),
    })
}

/// Persist a partial settings `update` to the store at `path`, reproducing the
/// `settings:save` IPC handler's overlay-merge semantics (Requirement 3.1):
/// the update is merged INTO the existing settings, leaving every field ABSENT
/// from the update at its previous value.
///
/// Steps, mirroring `saveSettings({ ...loadSettings(), ...rest })`:
///   1. read the existing store ([`load_from_file`]); on a read failure the
///      store is left untouched and the error is surfaced
///      ([`SaveSettingsError::Load`]) rather than clobbered (Requirement 11.7) —
///      this is the one intentional divergence from `main.js`, which would
///      overwrite an unreadable file with defaults;
///   2. overlay the update (with [`STRIPPED_SAVE_KEYS`] removed) onto it
///      ([`merge_settings_update`]);
///   3. write the merged result as 2-space-pretty JSON.
///
/// Returns the merged [`Settings`] that was written. The `multiInstance` /
/// `antiAfk` side effects the Electron handler triggers after the write
/// (starting/stopping the mutex holder and anti-AFK loop) are Native_Helper
/// concerns handled by the command layer (Task 7.7), not this persistence core.
pub fn save_to_file(
    path: &Path,
    update: &Map<String, Value>,
) -> Result<Settings, SaveSettingsError> {
    let existing = load_from_file(path)?;
    let merged = merge_settings_update(&existing, update)?;
    write_settings_pretty(path, &merged)?;
    Ok(merged)
}

/// Persist a partial settings `update` to `<dir>/settings.json`. The command
/// layer (Task 7.7) resolves `dir` from the Tauri `app_data_dir()` and calls
/// this.
pub fn save_to_dir(dir: &Path, update: &Map<String, Value>) -> Result<Settings, SaveSettingsError> {
    save_to_file(&settings_path_in(dir), update)
}

/// Persist a passphrase change to the Settings_Store — the settings-write half of
/// the `enc:setKey` handler, and the ONLY path permitted to write `keyVerifier`
/// (the general [`save_to_file`] path strips it, see [`STRIPPED_SAVE_KEYS`]).
///
/// Ports the two `saveSettings(...)` calls inside `enc:setKey`:
///
/// ```js
/// // set / change passphrase:
/// const { customKey, customKeyEnc, ...rest } = loadSettings();
/// saveSettings({ ...rest, keyVerifier: makeVerifier(np), encSetupDone: true });
/// // clear passphrase (machine-bound):
/// const { customKey, customKeyEnc, keyVerifier, ...rest } = loadSettings();
/// saveSettings({ ...rest, encSetupDone: true });
/// ```
///
/// Both branches strip the legacy `customKey` / `customKeyEnc` fields and set
/// `encSetupDone = true`. When `verifier` is `Some`, the new `keyVerifier` is
/// written; when `None` (the clear-to-machine-bound case) `keyVerifier` is
/// removed. Every OTHER field — crucially `donutApiTokenEnc`, which lives in
/// `rest` and must survive a passphrase change — is preserved via the JSON-object
/// overlay (matching the JS spread of `...rest`).
///
/// A read failure surfaces rather than clobbering the store (Requirement 11.7);
/// the settings core NEVER falls back to an empty store here either.
pub fn apply_passphrase_change(dir: &Path, verifier: Option<&str>) -> Result<(), String> {
    apply_passphrase_change_at(&settings_path_in(dir), verifier)
}

/// Testable core of [`apply_passphrase_change`] operating on an explicit path.
fn apply_passphrase_change_at(path: &Path, verifier: Option<&str>) -> Result<(), String> {
    let existing = load_from_file(path).map_err(|e| e.to_string())?;

    let mut obj = match serde_json::to_value(&existing) {
        Ok(Value::Object(map)) => map,
        _ => return Err("existing settings did not serialize to a JSON object".to_string()),
    };

    // Strip legacy custom-key material in BOTH branches (the `{ customKey,
    // customKeyEnc, ...rest }` destructure common to set and clear).
    obj.remove("customKey");
    obj.remove("customKeyEnc");

    match verifier {
        // Set / change: write the new verifier.
        Some(v) => {
            obj.insert("keyVerifier".to_string(), Value::String(v.to_string()));
        }
        // Clear (machine-bound): drop the verifier entirely.
        None => {
            obj.remove("keyVerifier");
        }
    }
    obj.insert("encSetupDone".to_string(), Value::Bool(true));

    let merged: Settings = serde_json::from_value(Value::Object(obj))
        .map_err(|e| format!("could not apply the passphrase change to settings: {e}"))?;
    write_settings_pretty(path, &merged).map_err(|e| e.to_string())
}

/// Persist the Donut_API_Token to the store at `path`, reproducing the dedicated
/// `settings:saveDonutToken` IPC handler:
///
/// ```js
/// const s = loadSettings();
/// const trimmed = typeof token === 'string' ? token.trim() : '';
/// if (trimmed) s.donutApiTokenEnc = encryptField(trimmed);
/// else s.donutApiTokenEnc = null;
/// saveSettings(s);
/// return { ok: true, donutApiTokenConfigured: !!s.donutApiTokenEnc };
/// ```
///
/// A non-blank token is encrypted with the same [`encryption::encrypt_field`]
/// mechanism used for `.ROBLOSECURITY` cookies (including its verify-before-
/// persist pass, Requirement 11.5) and stored as `donutApiTokenEnc`, replacing
/// any previously stored token. A blank/whitespace-only token clears the field
/// (`donutApiTokenEnc = null`), deleting the stored token. This path never reads
/// or returns the token in plaintext (Requirement 3.4).
///
/// The encryption inputs (`passphrase_mode`, `safe_storage_ready`, `device_key`)
/// are threaded in as parameters, consistent with `encryption.rs`'s module
/// layering (it sits below the settings store and must not read it); the command
/// layer resolves them from the Settings_Store.
///
/// Returns `Ok(true)` when a token is now configured, `Ok(false)` when it was
/// cleared, and `Err(_)` (carrying the cause) for a read/encrypt/write failure —
/// mirroring the handler's `{ ok:false, error }` branch.
pub fn save_donut_token_to_file(
    path: &Path,
    token: &str,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<bool, String> {
    let mut settings = load_from_file(path).map_err(|e| e.to_string())?;

    let trimmed = token.trim();
    if !trimmed.is_empty() {
        // Encrypt before storing; encrypt_field includes the verify-before-
        // persist round-trip (Requirement 11.5), so an Err here means the value
        // could not be safely encrypted and nothing is written.
        let encrypted =
            encryption::encrypt_field(trimmed, passphrase_mode, safe_storage_ready, device_key)?;
        settings.donut_api_token_enc = Some(encrypted);
    } else {
        settings.donut_api_token_enc = None; // clearing deletes the stored token
    }

    write_settings_pretty(path, &settings).map_err(|e| e.to_string())?;
    Ok(settings.donut_api_token_enc.is_some())
}

/// Persist the Donut_API_Token to `<dir>/settings.json`. See
/// [`save_donut_token_to_file`].
pub fn save_donut_token_to_dir(
    dir: &Path,
    token: &str,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<bool, String> {
    save_donut_token_to_file(
        &settings_path_in(dir),
        token,
        passphrase_mode,
        safe_storage_ready,
        device_key,
    )
}

// ── Generation history (`genhistory.json`) ───────────────────────────────────
//
// Ports `main.js`'s `genhistory:read` / `genhistory:write` / `genhistory:clear`
// handlers. The generation history is its OWN file, `genhistory.json`, in the
// same per-user application data directory as `settings.json`
// (`const genHistoryPath = path.join(app.getPath('userData'), 'genhistory.json')`),
// NOT a field inside the Settings_Store. It holds a flat JSON array capped at
// 500 entries. Every handler swallows failures to a safe default, matching the
// Electron_Build's `try { ... } catch { ... }` shape.

/// The generation-history file name, alongside `settings.json` in the per-user
/// application data directory.
pub const GEN_HISTORY_FILE_NAME: &str = "genhistory.json";

/// The maximum number of generation-history entries kept on write, from
/// `main.js`'s `list.slice(0, 500)`.
pub const GEN_HISTORY_CAP: usize = 500;

/// The generation-history file path inside the given per-user application data
/// directory (`<dir>/genhistory.json`).
pub fn gen_history_path_in(dir: &Path) -> PathBuf {
    dir.join(GEN_HISTORY_FILE_NAME)
}

/// Read the generation history from an explicit path — the testable core of
/// `genhistory:read`:
///
/// ```js
/// if (!fs.existsSync(genHistoryPath)) return [];
/// return JSON.parse(fs.readFileSync(genHistoryPath, 'utf8'));
/// // catch => []
/// ```
///
/// Returns the stored array on success and an empty `Vec` for a missing file or
/// any read/parse failure (the `catch { return [] }` path). A file whose JSON is
/// not an array is treated as the empty history rather than surfaced, keeping the
/// return type a list the Renderer_UI can consume directly.
pub fn read_gen_history_from_file(path: &Path) -> Vec<Value> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(), // missing / unreadable => [] (matches catch)
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(), // parse failure or non-array => []
    }
}

/// Read the generation history from `<dir>/genhistory.json`.
pub fn read_gen_history(dir: &Path) -> Vec<Value> {
    read_gen_history_from_file(&gen_history_path_in(dir))
}

/// Write the generation history to an explicit path — the testable core of
/// `genhistory:write`:
///
/// ```js
/// const capped = Array.isArray(list) ? list.slice(0, 500) : [];
/// fs.writeFileSync(genHistoryPath, JSON.stringify(capped, null, 2), { mode: 0o600 });
/// return true; // catch => false
/// ```
///
/// The list is capped at [`GEN_HISTORY_CAP`] entries (keeping the first 500) and
/// written as 2-space-pretty JSON. Returns `true` on success and `false` on any
/// failure, matching the handler's boolean result. (The `Array.isArray` guard is
/// a command-layer concern — the typed core already receives a slice.)
pub fn write_gen_history_to_file(path: &Path, list: &[Value]) -> bool {
    let capped: Vec<&Value> = list.iter().take(GEN_HISTORY_CAP).collect();
    let json = match serde_json::to_string_pretty(&capped) {
        Ok(json) => json,
        Err(_) => return false,
    };
    fs::write(path, json).is_ok()
}

/// Write the generation history to `<dir>/genhistory.json`.
pub fn write_gen_history(dir: &Path, list: &[Value]) -> bool {
    write_gen_history_to_file(&gen_history_path_in(dir), list)
}

/// Clear the generation history at an explicit path — the testable core of
/// `genhistory:clear`, which writes the literal `[]`:
///
/// ```js
/// fs.writeFileSync(genHistoryPath, '[]', { mode: 0o600 });
/// return true; // catch => false
/// ```
///
/// Writes the exact two-byte `[]` payload (not pretty-printed) to match the
/// Electron_Build byte-for-byte. Returns `true` on success, `false` on failure.
pub fn clear_gen_history_at(path: &Path) -> bool {
    fs::write(path, "[]").is_ok()
}

/// Clear the generation history at `<dir>/genhistory.json`.
pub fn clear_gen_history(dir: &Path) -> bool {
    clear_gen_history_at(&gen_history_path_in(dir))
}

// ── Fast Flags (`ClientAppSettings.json`) ────────────────────────────────────
//
// Ports `main.js`'s `fflag:read` / `fflag:write` handlers and their path
// resolution. Fast Flags are NOT stored in the Settings_Store: they live in the
// installed Roblox client, at
// `<latest version dir>\ClientSettings\ClientAppSettings.json`, where the "latest
// version dir" is whichever `%LOCALAPPDATA%\Roblox\Versions\version-*` folder has
// the most-recently-written `RobloxPlayerBeta.exe` (see [`latest_roblox_version_dir`]).
// The file is a flat JSON object of flag name -> value.

/// The `%LOCALAPPDATA%\Roblox` directory, i.e. `os.homedir()\AppData\Local\Roblox`
/// in `main.js`. Returns `None` if the user profile directory cannot be resolved.
fn roblox_local_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(|home| PathBuf::from(home).join("AppData").join("Local").join("Roblox"))
}

/// Resolve the most-recently-installed Roblox version directory, porting
/// `getLatestRobloxVersionDir()`:
///
/// scans `%LOCALAPPDATA%\Roblox\Versions` for `version-*` folders that contain a
/// `RobloxPlayerBeta.exe`, and returns the one whose executable was written to
/// disk most recently (by mtime) — Roblox's updater touches the exe when it
/// installs a build, so mtime, not the meaningless version hash, identifies the
/// current install. Returns `None` if the versions folder is missing or no
/// candidate has the executable.
pub fn latest_roblox_version_dir() -> Option<PathBuf> {
    let versions_base = roblox_local_dir()?.join("Versions");
    if !versions_base.is_dir() {
        return None;
    }

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&versions_base).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("version-") {
            continue;
        }
        let dir = versions_base.join(name.as_ref());
        let exe = dir.join("RobloxPlayerBeta.exe");
        if !exe.exists() {
            continue;
        }
        if let Ok(mtime) = fs::metadata(&exe).and_then(|m| m.modified()) {
            candidates.push((mtime, dir));
        }
    }

    // Most recent first (descending mtime), matching `.sort((a,b) => b.mtime - a.mtime)`.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, dir)| dir)
}

/// Resolve the Fast Flags file path, porting `getFFlagPath()`:
/// `<latest version dir>\ClientSettings\ClientAppSettings.json`, or `None` when
/// no Roblox install is found.
pub fn fflag_path() -> Option<PathBuf> {
    Some(
        latest_roblox_version_dir()?
            .join("ClientSettings")
            .join("ClientAppSettings.json"),
    )
}

/// Read Fast Flags from an explicit path — the testable core of `fflag:read`:
///
/// ```js
/// if (!p || !fs.existsSync(p)) return {};
/// return JSON.parse(fs.readFileSync(p, 'utf8'));
/// // catch => {}
/// ```
///
/// Returns the stored flag object on success and an empty map for a missing file
/// or any read/parse failure. A file whose JSON is not an object is treated as
/// empty, keeping the return type an object the Renderer_UI can consume.
pub fn read_fflags_from_file(path: &Path) -> Map<String, Value> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return Map::new(),
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Write Fast Flags to an explicit path — the testable core of `fflag:write`:
///
/// ```js
/// fs.mkdirSync(path.dirname(p), { recursive: true });
/// fs.writeFileSync(p, JSON.stringify(flags, null, 2), 'utf8');
/// return true; // catch => false
/// ```
///
/// Creates the parent directory if needed, then writes the flags as 2-space-
/// pretty JSON. Returns `true` on success, `false` on any failure.
pub fn write_fflags_to_file(path: &Path, flags: &Value) -> bool {
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let json = match serde_json::to_string_pretty(flags) {
        Ok(json) => json,
        Err(_) => return false,
    };
    fs::write(path, json).is_ok()
}

/// Read Fast Flags from the current Roblox install, resolving the path via
/// [`fflag_path`]. Returns an empty map when no install / file is found (the
/// `if (!p ...) return {}` branch).
pub fn read_fflags() -> Map<String, Value> {
    match fflag_path() {
        Some(path) => read_fflags_from_file(&path),
        None => Map::new(),
    }
}

/// Write Fast Flags to the current Roblox install, resolving the path via
/// [`fflag_path`]. Returns `false` when no install is found (the `if (!p) return
/// false` branch).
pub fn write_fflags(flags: &Value) -> bool {
    match fflag_path() {
        Some(path) => write_fflags_to_file(&path, flags),
        None => false,
    }
}

// ── FPS cap (`GlobalBasicSettings_13.xml`) ───────────────────────────────────
//
// Ports `main.js`'s `fps:read` / `fps:write` handlers. The FPS cap is NOT stored
// in the Settings_Store: it lives in Roblox's own
// `%LOCALAPPDATA%\Roblox\GlobalBasicSettings_13.xml`, inside an
// `<int name="FramerateCap">VALUE</int>` element (0 = unlimited). Roblox rewrites
// this file on exit, so it must be written while Roblox is not running and takes
// effect on the next launch.

/// The default FPS cap returned when the settings file or the `FramerateCap`
/// element is absent, from `main.js`'s `return 60`.
pub const DEFAULT_FPS_CAP: i64 = 60;

/// Resolve the Roblox global-settings file path, porting `getGlobalSettingsPath()`:
/// `%LOCALAPPDATA%\Roblox\GlobalBasicSettings_13.xml`.
pub fn global_settings_path() -> Option<PathBuf> {
    Some(roblox_local_dir()?.join("GlobalBasicSettings_13.xml"))
}

/// The `<int name="FramerateCap">VALUE</int>` element string for `value`, used
/// for both the update-in-place and insert paths of [`fps_write_to_file`].
fn framerate_cap_element(value: i64) -> String {
    format!("<int name=\"FramerateCap\">{value}</int>")
}

/// Locate the first `<int name="FramerateCap">DIGITS</int>` element, emulating
/// `main.js`'s case-insensitive regex
/// `/<int\s+name="FramerateCap"\s*>(\d+)<\/int>/i`.
///
/// Returns `(start, end, value)` — the byte range of the whole matched element
/// and the parsed cap — or `None` if absent. Implemented as a manual scan
/// (rather than pulling in a regex dependency) reproducing the same token
/// sequence the regex matches: `<int` + one-or-more whitespace + `name="FramerateCap"`
/// (case-insensitive) + zero-or-more whitespace + `>` + one-or-more ASCII digits
/// + `</int>`.
fn find_framerate_cap(xml: &str) -> Option<(usize, usize, i64)> {
    let lower = xml.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    const OPEN: &str = "<int";
    const ATTR: &str = "name=\"frameratecap\"";
    const CLOSE: &str = "</int>";

    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(OPEN) {
        let start = search_from + rel;
        let mut i = start + OPEN.len();

        // `\s+` — at least one whitespace char after `<int`.
        let ws_start = i;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == ws_start {
            search_from = start + OPEN.len();
            continue;
        }

        // `name="frameratecap"` (already lowercased for the `i` flag).
        if !lower[i..].starts_with(ATTR) {
            search_from = start + OPEN.len();
            continue;
        }
        i += ATTR.len();

        // `\s*` — optional whitespace before `>`.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        // `>`
        if i >= bytes.len() || bytes[i] != b'>' {
            search_from = start + OPEN.len();
            continue;
        }
        i += 1;

        // `(\d+)`
        let digits_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            search_from = start + OPEN.len();
            continue;
        }

        // `</int>`
        if !lower[i..].starts_with(CLOSE) {
            search_from = start + OPEN.len();
            continue;
        }
        let end = i + CLOSE.len();

        // Parse the digits (from the original string; digits are ASCII so the
        // lowercased and original byte ranges coincide). Overflow => treat as no
        // match and keep scanning, mirroring parseInt never yielding here.
        match xml[digits_start..i].parse::<i64>() {
            Ok(value) => return Some((start, end, value)),
            Err(_) => {
                search_from = start + OPEN.len();
                continue;
            }
        }
    }
    None
}

/// Clamp/round an incoming cap to a non-negative integer, porting
/// `Math.max(0, Math.round(Number(cap) || 0))`. A NaN input is treated as `0`
/// (JS's `Number(cap) || 0`), and negatives clamp to `0`.
fn clamp_fps_cap(cap: f64) -> i64 {
    let n = if cap.is_nan() { 0.0 } else { cap };
    let rounded = n.round();
    if rounded < 0.0 {
        0
    } else {
        rounded as i64
    }
}

/// Read the FPS cap from an explicit path — the testable core of `fps:read`:
///
/// ```js
/// if (!fs.existsSync(p)) return 60;
/// const m = xml.match(/<int\s+name="FramerateCap"\s*>(\d+)<\/int>/i);
/// return m ? parseInt(m[1], 10) : 60;
/// // catch => 60
/// ```
///
/// Returns the parsed cap, or [`DEFAULT_FPS_CAP`] for a missing/unreadable file
/// or when no `FramerateCap` element is present.
pub fn fps_read_from_file(path: &Path) -> i64 {
    let xml = match fs::read_to_string(path) {
        Ok(xml) => xml,
        Err(_) => return DEFAULT_FPS_CAP, // missing / unreadable => 60
    };
    match find_framerate_cap(&xml) {
        Some((_, _, value)) => value,
        None => DEFAULT_FPS_CAP,
    }
}

/// Write the FPS cap to an explicit path — the testable core of `fps:write`:
///
/// ```js
/// if (!fs.existsSync(p)) return { ok:false, error:'...not found...' };
/// const value = Math.max(0, Math.round(Number(cap) || 0));
/// if (/<int\s+name="FramerateCap"\s*>\d+<\/int>/i.test(xml)) xml = xml.replace(..., `<int name="FramerateCap">${value}</int>`);
/// else xml = xml.replace(/(<\/Item>)/, `\t\t<int name="FramerateCap">${value}</int>\n$1`);
/// fs.writeFileSync(p, xml, 'utf8');
/// return { ok:true }; // catch => { ok:false, error }
/// ```
///
/// If the file does not exist, returns the same actionable error the
/// Electron_Build reports. Otherwise it updates an existing `FramerateCap`
/// element in place, or (if none exists) inserts one immediately before the
/// first `</Item>` block — case-sensitive, matching the un-flagged `/(<\/Item>)/`
/// regex. If there is no `</Item>` the XML is written back unchanged, exactly as
/// the JS `replace` no-ops. Returns `Ok(())` on success, `Err(_)` on any failure.
pub fn fps_write_to_file(path: &Path, cap: f64) -> Result<(), String> {
    if !path.exists() {
        return Err(
            "GlobalBasicSettings_13.xml not found - launch Roblox once to create it.".to_string(),
        );
    }
    let xml = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value = clamp_fps_cap(cap);

    let new_xml = if let Some((start, end, _)) = find_framerate_cap(&xml) {
        // Update existing element (replace the first match, like `xml.replace`).
        format!("{}{}{}", &xml[..start], framerate_cap_element(value), &xml[end..])
    } else if let Some(idx) = xml.find("</Item>") {
        // Insert before the first `</Item>` (case-sensitive: no `i` flag on the
        // JS insert regex), reproducing `\t\t<int ...>\n$1`.
        format!(
            "{}\t\t{}\n{}",
            &xml[..idx],
            framerate_cap_element(value),
            &xml[idx..]
        )
    } else {
        // No `</Item>` to anchor to: JS `replace` would be a no-op, so write back unchanged.
        xml
    };

    fs::write(path, new_xml).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the FPS cap from the Roblox global-settings file, resolving the path via
/// [`global_settings_path`]. Returns [`DEFAULT_FPS_CAP`] when the path cannot be
/// resolved.
pub fn fps_read() -> i64 {
    match global_settings_path() {
        Some(path) => fps_read_from_file(&path),
        None => DEFAULT_FPS_CAP,
    }
}

/// Write the FPS cap to the Roblox global-settings file, resolving the path via
/// [`global_settings_path`]. Returns the same not-found error as the
/// Electron_Build when the path cannot be resolved or the file is absent.
pub fn fps_write(cap: f64) -> Result<(), String> {
    match global_settings_path() {
        Some(path) => fps_write_to_file(&path, cap),
        None => Err(
            "GlobalBasicSettings_13.xml not found - launch Roblox once to create it.".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    //! Focused unit tests for Task 7.1's load path: the
    //! missing-vs-corrupt-vs-unreadable distinction (Requirement 11.7) and the
    //! present-applied / absent-defaulted / legacy-preserved behavior
    //! (Requirements 3.2, 11.2).

    use super::*;
    use serde_json::{json, Value};
    use std::io;

    /// Writes `contents` to a uniquely named temp file and returns its path.
    /// Kept dependency-free (no `tempfile` crate) since the module only reads.
    fn write_temp(name: &str, contents: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "mr_settings_test_{}_{}_{}.json",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::write(&path, contents).expect("write temp settings file");
        path
    }

    #[test]
    fn missing_file_returns_defaults_not_error() {
        // A path that does not exist is the defaults branch (missing != unreadable).
        let mut path = std::env::temp_dir();
        path.push(format!("mr_settings_absent_{}.json", std::process::id()));
        let _ = fs::remove_file(&path); // ensure absent

        let settings = load_from_file(&path).expect("missing file must yield defaults, not an error");

        // Electron runtime defaults applied.
        assert_eq!(settings.donut_api_port, Some(DEFAULT_DONUT_API_PORT));
        assert!(settings.pending_donut_deletions.is_empty());
        assert_eq!(settings.donut_api_token_enc, None);
        // Nothing legacy invented.
        assert!(settings.extra.is_empty());
    }

    #[test]
    fn present_fields_applied_absent_fields_defaulted_and_legacy_preserved() {
        // A partial settings file: some recognized fields present, donutApiPort
        // absent (so it must default to 10108), plus a legacy/unrecognized field.
        let path = write_temp(
            "partial",
            r#"{
                "multiInstance": true,
                "antiAfk": true,
                "antiAfkInterval": 300,
                "donutApiTokenEnc": "gcm:AQID.storedtoken",
                "keyVerifier": "gs:AQID.verifier",
                "_deviceKey": "legacy-device-key-blob",
                "someRemovedFlag": 7
            }"#,
        );

        let settings = load_from_file(&path).expect("valid partial file must load");
        let _ = fs::remove_file(&path);

        // Present recognized fields keep the file's value.
        assert_eq!(settings.multi_instance, true);
        assert_eq!(settings.anti_afk, true);
        assert_eq!(settings.anti_afk_interval, Some(300));
        // Stored secrets are returned exactly as stored (never decrypted here).
        assert_eq!(
            settings.donut_api_token_enc.as_deref(),
            Some("gcm:AQID.storedtoken")
        );
        assert_eq!(settings.key_verifier.as_deref(), Some("gs:AQID.verifier"));

        // Absent recognized field gets the Electron runtime default.
        assert_eq!(settings.donut_api_port, Some(DEFAULT_DONUT_API_PORT));
        assert!(settings.pending_donut_deletions.is_empty());

        // Unrecognized/legacy fields survive via the catch-all (Req 11.2).
        assert_eq!(
            settings.extra.get("_deviceKey"),
            Some(&Value::String("legacy-device-key-blob".to_string()))
        );
        assert_eq!(settings.extra.get("someRemovedFlag"), Some(&json!(7)));
    }

    #[test]
    fn present_donut_api_port_is_not_overwritten_by_default() {
        let path = write_temp("port", r#"{ "donutApiPort": 20200 }"#);
        let settings = load_from_file(&path).expect("valid file must load");
        let _ = fs::remove_file(&path);
        // A value present in the file wins over the runtime default.
        assert_eq!(settings.donut_api_port, Some(20200));
    }

    #[test]
    fn corrupt_json_returns_corruption_error_without_falling_back() {
        let path = write_temp("corrupt", "{ this is not valid json ]");
        let before = fs::read_to_string(&path).unwrap();

        let err = load_from_file(&path).expect_err("corrupt file must be an error, not defaults");
        assert!(
            err.is_corruption(),
            "expected a corruption error, got: {err:?}"
        );
        assert!(!err.is_permission());

        // The file must be left unmodified (Req 11.7: leave the file untouched).
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "load must never write to the store file");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn valid_json_but_wrong_field_type_is_treated_as_corruption() {
        // Valid JSON, but a recognized field has an incompatible type. This is a
        // malformed settings file, classified as corruption (not a silent reset).
        let path = write_temp("wrongtype", r#"{ "donutApiPort": "not-a-number" }"#);
        let err = load_from_file(&path).expect_err("type-mismatched field must error");
        assert!(err.is_corruption(), "expected corruption, got: {err:?}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn io_error_classification_distinguishes_permission_from_other() {
        // The classifier maps PermissionDenied -> Permission and everything else
        // -> Io, keeping the two distinguishable as Req 11.7 demands.
        let path = Path::new("C:/some/settings.json");

        let perm = SettingsStoreError::from_io(
            path,
            &io::Error::new(ErrorKind::PermissionDenied, "access denied"),
        );
        assert!(perm.is_permission());
        assert!(!perm.is_corruption());

        let other = SettingsStoreError::from_io(
            path,
            &io::Error::new(ErrorKind::Other, "disk on fire"),
        );
        assert!(!other.is_permission());
        assert!(!other.is_corruption());
        assert!(matches!(other, SettingsStoreError::Io { .. }));
    }

    #[test]
    fn errors_serialize_with_distinguishable_cause_tag() {
        // The command layer relies on the serialized `cause` tag to tell the
        // Renderer_UI apart corruption vs permission (Req 11.7 distinguishability).
        let corruption = SettingsStoreError::corruption(Path::new("s.json"), "bad token");
        let v = serde_json::to_value(&corruption).unwrap();
        assert_eq!(v["cause"], json!("corruption"));
        assert_eq!(v["store"], json!("settings"));

        let permission = SettingsStoreError::from_io(
            Path::new("s.json"),
            &io::Error::new(ErrorKind::PermissionDenied, "nope"),
        );
        let v = serde_json::to_value(&permission).unwrap();
        assert_eq!(v["cause"], json!("permission"));
    }

    #[test]
    fn empty_object_file_yields_only_defaults() {
        let path = write_temp("empty", "{}");
        let settings = load_from_file(&path).expect("empty object is valid");
        let _ = fs::remove_file(&path);
        assert_eq!(settings.donut_api_port, Some(DEFAULT_DONUT_API_PORT));
        assert!(settings.pending_donut_deletions.is_empty());
        assert!(settings.extra.is_empty());
    }

    #[test]
    fn load_from_dir_reads_settings_json_in_dir() {
        // load_from_dir must look for `<dir>/settings.json`.
        let mut dir = std::env::temp_dir();
        dir.push(format!("mr_settings_dir_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = settings_path_in(&dir);
        fs::write(&file, r#"{ "masterVolume": 42.0 }"#).unwrap();

        let settings = load_from_dir(&dir).expect("dir load must find settings.json");
        assert_eq!(settings.master_volume, Some(42.0));
        assert_eq!(settings.donut_api_port, Some(DEFAULT_DONUT_API_PORT));

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }
}

#[cfg(test)]
mod save_tests {
    //! Focused unit tests for Task 7.2: the overlay-merge save semantics
    //! (Requirement 3.1 — absent fields preserved, present fields overwritten,
    //! forbidden keys stripped, legacy fields preserved), the Donut_API_Token
    //! save path, and the genhistory / fflag / fps read-write helpers.

    use super::*;
    use crate::encryption;
    use serde_json::{json, Map, Value};

    /// A unique temp directory for a test, created fresh. Dependency-free (no
    /// `tempfile` crate) to match the existing module tests.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mr_settings_save_{}_{}_{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Read a settings file back as a raw JSON object for assertions.
    fn read_json_object(path: &Path) -> Map<String, Value> {
        let contents = fs::read_to_string(path).expect("read settings file");
        match serde_json::from_str::<Value>(&contents).expect("valid json") {
            Value::Object(map) => map,
            other => panic!("expected object, got {other}"),
        }
    }

    fn update_from(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("update fixture must be an object, got {other}"),
        }
    }

    #[test]
    fn save_overlay_merge_preserves_absent_fields_and_overwrites_present() {
        let dir = unique_temp_dir("merge");
        let path = settings_path_in(&dir);
        // Seed an existing store with several recognized fields + a legacy field.
        fs::write(
            &path,
            r#"{
                "multiInstance": true,
                "antiAfk": true,
                "antiAfkInterval": 300,
                "masterVolume": 0.5,
                "donutApiPort": 20200,
                "_legacyFlag": "keep-me"
            }"#,
        )
        .unwrap();

        // Partial update: change antiAfkInterval, add multiRobloxGroupId. Every
        // other field must stay at its previous value.
        let update = update_from(json!({
            "antiAfkInterval": 120,
            "multiRobloxGroupId": "group-9"
        }));
        let merged = save_to_dir(&dir, &update).expect("save must succeed");

        // Present-in-update fields overwritten.
        assert_eq!(merged.anti_afk_interval, Some(120));
        assert_eq!(merged.multi_roblox_group_id.as_deref(), Some("group-9"));
        // Absent-from-update fields preserved at prior values.
        assert_eq!(merged.multi_instance, true);
        assert_eq!(merged.anti_afk, true);
        assert_eq!(merged.master_volume, Some(0.5));
        assert_eq!(merged.donut_api_port, Some(20200));
        // Legacy field preserved via the catch-all.
        assert_eq!(
            merged.extra.get("_legacyFlag"),
            Some(&json!("keep-me"))
        );

        // And the same is true on disk.
        let on_disk = read_json_object(&path);
        assert_eq!(on_disk["antiAfkInterval"], json!(120));
        assert_eq!(on_disk["multiRobloxGroupId"], json!("group-9"));
        assert_eq!(on_disk["multiInstance"], json!(true));
        assert_eq!(on_disk["masterVolume"], json!(0.5));
        assert_eq!(on_disk["donutApiPort"], json!(20200));
        assert_eq!(on_disk["_legacyFlag"], json!("keep-me"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_strips_key_material_and_donut_token_from_update() {
        let dir = unique_temp_dir("strip");
        let path = settings_path_in(&dir);
        // Existing store already has a keyVerifier and a donut token.
        fs::write(
            &path,
            r#"{
                "keyVerifier": "gs:existing.verifier",
                "donutApiTokenEnc": "safe:existingtoken",
                "customKey": "legacy-existing-key",
                "multiInstance": false
            }"#,
        )
        .unwrap();

        // The update tries to overwrite/wipe the protected fields — all must be
        // ignored, leaving the existing values intact, while the ordinary field
        // still applies.
        let update = update_from(json!({
            "keyVerifier": "gs:ATTACKER.verifier",
            "donutApiTokenEnc": "safe:attackertoken",
            "customKey": "attacker-key",
            "customKeyEnc": "attacker-key-enc",
            "multiInstance": true
        }));
        let merged = save_to_dir(&dir, &update).expect("save must succeed");

        // Protected fields keep their EXISTING values (update stripped).
        assert_eq!(merged.key_verifier.as_deref(), Some("gs:existing.verifier"));
        assert_eq!(
            merged.donut_api_token_enc.as_deref(),
            Some("safe:existingtoken")
        );
        assert_eq!(
            merged.extra.get("customKey"),
            Some(&json!("legacy-existing-key"))
        );
        // customKeyEnc was not in the existing file and is stripped from the
        // update, so it must not appear at all.
        assert!(merged.extra.get("customKeyEnc").is_none());
        // The ordinary field applies.
        assert_eq!(merged.multi_instance, true);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_into_missing_store_applies_defaults_then_update() {
        // No file yet: save should merge onto the default settings and create it.
        let dir = unique_temp_dir("missing");
        let update = update_from(json!({ "antiAfk": true }));
        let merged = save_to_dir(&dir, &update).expect("save must create the store");
        assert_eq!(merged.anti_afk, true);
        // Electron runtime default applied via the loaded defaults.
        assert_eq!(merged.donut_api_port, Some(DEFAULT_DONUT_API_PORT));
        assert!(settings_path_in(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_refuses_to_clobber_a_corrupt_existing_store() {
        // Req 11.7: a save must not overwrite an existing store it could not read.
        let dir = unique_temp_dir("corruptsave");
        let path = settings_path_in(&dir);
        let corrupt = "{ not valid json ]";
        fs::write(&path, corrupt).unwrap();

        let update = update_from(json!({ "antiAfk": true }));
        let err = save_to_dir(&dir, &update).expect_err("save must fail on corrupt store");
        assert!(matches!(err, SaveSettingsError::Load(ref e) if e.is_corruption()));
        // The file is left untouched.
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_donut_token_clear_sets_null_and_preserves_other_fields() {
        let dir = unique_temp_dir("donutclear");
        let path = settings_path_in(&dir);
        fs::write(
            &path,
            r#"{
                "donutApiTokenEnc": "safe:previoustoken",
                "multiInstance": true,
                "_legacy": "x"
            }"#,
        )
        .unwrap();

        // A blank / whitespace-only token clears the stored token. Encryption
        // inputs are irrelevant on the clear path (no encryption happens).
        let configured =
            save_donut_token_to_dir(&dir, "   ", false, false, None).expect("clear must succeed");
        assert_eq!(configured, false);

        let on_disk = read_json_object(&path);
        assert_eq!(on_disk["donutApiTokenEnc"], Value::Null);
        // Other fields preserved.
        assert_eq!(on_disk["multiInstance"], json!(true));
        assert_eq!(on_disk["_legacy"], json!("x"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn save_donut_token_nonblank_encrypts_via_safe_storage_and_round_trips() {
        // On Windows, safe_storage_ready=true routes encrypt_field through DPAPI
        // (the `safe:` format), which is stateless (tied to the user account) and
        // therefore does not touch the process-wide key session — keeping this
        // test independent of any other test's encryption state.
        let dir = unique_temp_dir("donutset");
        let path = settings_path_in(&dir);
        fs::write(&path, "{}").unwrap();

        let configured = save_donut_token_to_dir(&dir, "  my-secret-token  ", false, true, None)
            .expect("encrypt+save must succeed");
        assert!(configured, "a non-blank token must be configured");

        let on_disk = read_json_object(&path);
        let stored = on_disk["donutApiTokenEnc"].as_str().expect("token stored as string");
        // Stored in encrypted `safe:` form, never plaintext (Req 3.4 / 11.2).
        assert!(stored.starts_with("safe:"), "expected safe: form, got {stored}");
        assert!(!stored.contains("my-secret-token"));

        // It decrypts back to the trimmed original (verify-before-persist already
        // proved this internally; re-check end to end).
        let decrypted = encryption::decrypt_field(stored, false, true, None)
            .expect("decrypt must not error")
            .expect("decrypt must yield a value");
        assert_eq!(decrypted, "my-secret-token");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gen_history_read_missing_is_empty_and_write_read_round_trips() {
        let dir = unique_temp_dir("genhist");
        // Missing file => [].
        assert!(read_gen_history(&dir).is_empty());

        let list = vec![json!({ "prompt": "a" }), json!({ "prompt": "b" })];
        assert!(write_gen_history(&dir, &list));
        let read_back = read_gen_history(&dir);
        assert_eq!(read_back, list);

        // Pretty-printed (2-space) on disk, matching JSON.stringify(x, null, 2).
        let raw = fs::read_to_string(gen_history_path_in(&dir)).unwrap();
        assert!(raw.contains("\n  "), "expected 2-space pretty JSON, got: {raw}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gen_history_write_caps_at_500_entries() {
        let dir = unique_temp_dir("gencap");
        let list: Vec<Value> = (0..600).map(|i| json!(i)).collect();
        assert!(write_gen_history(&dir, &list));
        let read_back = read_gen_history(&dir);
        assert_eq!(read_back.len(), GEN_HISTORY_CAP);
        // Keeps the FIRST 500 (list.slice(0, 500)).
        assert_eq!(read_back.first(), Some(&json!(0)));
        assert_eq!(read_back.last(), Some(&json!(499)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gen_history_clear_writes_empty_array_literal() {
        let dir = unique_temp_dir("genclear");
        write_gen_history(&dir, &[json!(1), json!(2)]);
        assert!(clear_gen_history(&dir));
        let raw = fs::read_to_string(gen_history_path_in(&dir)).unwrap();
        assert_eq!(raw, "[]");
        assert!(read_gen_history(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gen_history_read_non_array_or_corrupt_is_empty() {
        let dir = unique_temp_dir("genbad");
        let path = gen_history_path_in(&dir);
        // Corrupt JSON => [].
        fs::write(&path, "{ not json ]").unwrap();
        assert!(read_gen_history(&dir).is_empty());
        // Valid JSON but not an array => [].
        fs::write(&path, r#"{ "notAnArray": true }"#).unwrap();
        assert!(read_gen_history(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fflags_read_missing_is_empty_and_write_read_round_trips() {
        let dir = unique_temp_dir("fflag");
        // Point at a nested path that does not exist yet; write must mkdir -p.
        let path = dir.join("ClientSettings").join("ClientAppSettings.json");
        assert!(read_fflags_from_file(&path).is_empty());

        let flags = json!({ "DFIntTaskSchedulerTargetFps": 120, "FFlagFoo": "true" });
        assert!(write_fflags_to_file(&path, &flags));
        assert!(path.exists(), "parent dirs must be created");

        let read_back = read_fflags_from_file(&path);
        assert_eq!(read_back.get("DFIntTaskSchedulerTargetFps"), Some(&json!(120)));
        assert_eq!(read_back.get("FFlagFoo"), Some(&json!("true")));

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\n  "), "expected 2-space pretty JSON");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fflags_read_non_object_or_corrupt_is_empty() {
        let dir = unique_temp_dir("fflagbad");
        let path = dir.join("ClientAppSettings.json");
        fs::write(&path, "{ not json ]").unwrap();
        assert!(read_fflags_from_file(&path).is_empty());
        fs::write(&path, "[1, 2, 3]").unwrap();
        assert!(read_fflags_from_file(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_read_missing_returns_default() {
        let dir = unique_temp_dir("fpsmiss");
        let path = dir.join("GlobalBasicSettings_13.xml");
        assert_eq!(fps_read_from_file(&path), DEFAULT_FPS_CAP);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_read_parses_existing_framerate_cap() {
        let dir = unique_temp_dir("fpsread");
        let path = dir.join("GlobalBasicSettings_13.xml");
        fs::write(
            &path,
            "<roblox><Item class=\"UserGameSettings\">\
             <int name=\"FramerateCap\">144</int></Item></roblox>",
        )
        .unwrap();
        assert_eq!(fps_read_from_file(&path), 144);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_read_defaults_when_no_framerate_element() {
        let dir = unique_temp_dir("fpsnoelem");
        let path = dir.join("GlobalBasicSettings_13.xml");
        fs::write(&path, "<roblox><Item class=\"UserGameSettings\"></Item></roblox>").unwrap();
        assert_eq!(fps_read_from_file(&path), DEFAULT_FPS_CAP);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_write_updates_existing_element_in_place() {
        let dir = unique_temp_dir("fpsupdate");
        let path = dir.join("GlobalBasicSettings_13.xml");
        fs::write(
            &path,
            "<roblox><Item class=\"UserGameSettings\">\
             <int name=\"FramerateCap\">60</int>\
             <bool name=\"Other\">true</bool></Item></roblox>",
        )
        .unwrap();

        fps_write_to_file(&path, 240.0).expect("write must succeed");
        let xml = fs::read_to_string(&path).unwrap();
        assert!(xml.contains("<int name=\"FramerateCap\">240</int>"));
        // The old value is gone and the surrounding element is preserved.
        assert!(!xml.contains(">60</int>"));
        assert!(xml.contains("<bool name=\"Other\">true</bool>"));
        // Read-back agrees.
        assert_eq!(fps_read_from_file(&path), 240);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_write_inserts_element_before_first_item_when_absent() {
        let dir = unique_temp_dir("fpsinsert");
        let path = dir.join("GlobalBasicSettings_13.xml");
        fs::write(
            &path,
            "<roblox>\n\t<Item class=\"UserGameSettings\">\n\t\t<bool name=\"X\">false</bool>\n\t</Item>\n</roblox>",
        )
        .unwrap();

        fps_write_to_file(&path, 30.0).expect("write must succeed");
        let xml = fs::read_to_string(&path).unwrap();
        assert!(xml.contains("<int name=\"FramerateCap\">30</int>"));
        // Inserted before the first </Item>.
        let elem_idx = xml.find("<int name=\"FramerateCap\">30</int>").unwrap();
        let close_idx = xml.find("</Item>").unwrap();
        assert!(elem_idx < close_idx, "element must be inserted before </Item>");
        assert_eq!(fps_read_from_file(&path), 30);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_write_clamps_negative_and_rounds() {
        let dir = unique_temp_dir("fpsclamp");
        let path = dir.join("GlobalBasicSettings_13.xml");
        fs::write(
            &path,
            "<roblox><Item><int name=\"FramerateCap\">60</int></Item></roblox>",
        )
        .unwrap();

        // Negative clamps to 0.
        fps_write_to_file(&path, -5.0).expect("write");
        assert_eq!(fps_read_from_file(&path), 0);
        // Fractional rounds (2.7 -> 3).
        fps_write_to_file(&path, 2.7).expect("write");
        assert_eq!(fps_read_from_file(&path), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fps_write_missing_file_reports_actionable_error() {
        let dir = unique_temp_dir("fpswritemiss");
        let path = dir.join("GlobalBasicSettings_13.xml");
        let err = fps_write_to_file(&path, 60.0).expect_err("missing file must error");
        assert!(err.contains("not found"), "expected actionable error, got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_framerate_cap_is_case_insensitive_and_flexible_whitespace() {
        // Mirrors the /i regex with \s+ and \s*.
        let xml = "<INT   name=\"frameratecap\"  >75</INT>";
        let found = find_framerate_cap(xml);
        assert!(found.is_some());
        assert_eq!(found.unwrap().2, 75);
    }

    // ── apply_passphrase_change (enc:setKey settings-write half, Task 7.7) ────

    #[test]
    fn apply_passphrase_change_set_writes_verifier_and_preserves_donut_token() {
        let dir = unique_temp_dir("passchange_set");
        let path = settings_path_in(&dir);
        // Seed an existing store carrying the Donut token, a legacy customKey/
        // customKeyEnc, and an ordinary recognized field.
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "multiInstance": true,
                "donutApiTokenEnc": "safe:existing-token-blob",
                "customKey": "legacy-plain",
                "customKeyEnc": "safe:legacy-enc",
            }))
            .unwrap(),
        )
        .unwrap();

        apply_passphrase_change_at(&path, Some("gs:new-verifier-blob"))
            .expect("set passphrase should succeed");

        let obj = read_json_object(&path);
        // Verifier written; legacy key material stripped; encSetupDone set.
        assert_eq!(obj.get("keyVerifier").and_then(|v| v.as_str()), Some("gs:new-verifier-blob"));
        assert!(!obj.contains_key("customKey"));
        assert!(!obj.contains_key("customKeyEnc"));
        assert_eq!(obj.get("encSetupDone"), Some(&Value::Bool(true)));
        // Crucially, the Donut token and other fields survive the passphrase change.
        assert_eq!(
            obj.get("donutApiTokenEnc").and_then(|v| v.as_str()),
            Some("safe:existing-token-blob")
        );
        assert_eq!(obj.get("multiInstance"), Some(&Value::Bool(true)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_passphrase_change_clear_removes_verifier_and_preserves_donut_token() {
        let dir = unique_temp_dir("passchange_clear");
        let path = settings_path_in(&dir);
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "keyVerifier": "gs:old-verifier",
                "donutApiTokenEnc": "safe:existing-token-blob",
                "customKey": "legacy-plain",
            }))
            .unwrap(),
        )
        .unwrap();

        apply_passphrase_change_at(&path, None).expect("clear passphrase should succeed");

        let obj = read_json_object(&path);
        // Verifier cleared (machine-bound): the typed Option serializes to null
        // (or is absent) — either way it loads back as None, so passphrase mode
        // is off. What must NOT happen is a lingering non-empty verifier string.
        let verifier = obj.get("keyVerifier");
        assert!(
            verifier.map_or(true, |v| v.is_null()),
            "keyVerifier must be null/absent after clear, got: {verifier:?}"
        );
        // And a fresh load agrees: passphrase mode is cleared.
        let reloaded = load_from_file(&path).expect("reload after clear");
        assert!(!crate::crypto_context::compute_passphrase_mode(&reloaded));
        // Legacy material stripped, flag set.
        assert!(!obj.contains_key("customKey"));
        assert_eq!(obj.get("encSetupDone"), Some(&Value::Bool(true)));
        // Donut token still preserved through the clear.
        assert_eq!(
            obj.get("donutApiTokenEnc").and_then(|v| v.as_str()),
            Some("safe:existing-token-blob")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_passphrase_change_refuses_to_clobber_a_corrupt_store() {
        let dir = unique_temp_dir("passchange_corrupt");
        let path = settings_path_in(&dir);
        fs::write(&path, "{ this is not valid json").unwrap();

        // A corrupt existing store must surface an error, never be overwritten
        // (Requirement 11.7).
        let err = apply_passphrase_change_at(&path, Some("gs:v")).unwrap_err();
        assert!(err.contains("corrupt") || err.contains("could not"), "got: {err}");
        // The corrupt file is left byte-for-byte unmodified.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not valid json");
        let _ = fs::remove_dir_all(&dir);
    }

    // ── Property 9: settings save overlay-merge semantics ────────────────────

    use proptest::prelude::*;

    /// A small, always-JSON-serializable value for legacy / protected update
    /// keys (which land in the `extra` catch-all or are stripped, so any JSON
    /// shape is valid). Deliberately excludes non-finite floats so every value
    /// round-trips through disk unchanged.
    fn arb_small_json() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            (-100_000i64..100_000).prop_map(Value::from),
            "[a-zA-Z0-9 ]{0,12}".prop_map(Value::from),
            prop::collection::vec("[a-z]{0,5}", 0..3).prop_map(|v| json!(v)),
        ]
    }

    /// One recognized Settings field paired with a TYPE-VALID value, so the
    /// object always deserializes back into `Settings` (an incompatible type
    /// would be rejected by the merge and is out of scope for this property).
    fn arb_recognized_pair() -> impl Strategy<Value = (String, Value)> {
        prop_oneof![
            any::<bool>().prop_map(|b| ("multiInstance".to_string(), json!(b))),
            any::<bool>().prop_map(|b| ("antiAfk".to_string(), json!(b))),
            prop::option::of(0i64..100_000)
                .prop_map(|o| ("antiAfkInterval".to_string(), o.map_or(Value::Null, |n| json!(n)))),
            (0u16..=65535u16).prop_map(|p| ("donutApiPort".to_string(), json!(p))),
            // Low-precision decimals (0.000..=1.000) so the value serializes to a
            // short literal that parses back to the identical f64. Full-precision
            // random f64s are avoided only because serde_json's default parser can
            // shift them by 1 ULP on read-back — an artifact unrelated to the
            // overlay-merge semantics under test.
            (0u32..=1000u32)
                .prop_map(|n| ("masterVolume".to_string(), json!(n as f64 / 1000.0))),
            any::<bool>().prop_map(|b| ("encSetupDone".to_string(), json!(b))),
            prop::option::of("[a-z]{1,8}")
                .prop_map(|o| ("multiRobloxGroupId".to_string(), o.map_or(Value::Null, |s| json!(s)))),
            prop::collection::vec("[a-z]{1,6}", 0..4)
                .prop_map(|v| ("pendingDonutDeletions".to_string(), json!(v))),
        ]
    }

    /// Legacy / unrecognized keys (prefixed so they never collide with a
    /// recognized field name); these must survive via the `extra` catch-all.
    fn arb_legacy_pairs() -> impl Strategy<Value = Vec<(String, Value)>> {
        let entry = ("[a-z]{1,6}", arb_small_json())
            .prop_map(|(k, v)| (format!("legacy_{k}"), v));
        prop::collection::vec(entry, 0..4)
    }

    /// Protected keys that a save MUST strip from the update
    /// ([`STRIPPED_SAVE_KEYS`]).
    fn arb_protected_pairs() -> impl Strategy<Value = Vec<(String, Value)>> {
        let entry = (
            prop::sample::select(STRIPPED_SAVE_KEYS.to_vec()),
            arb_small_json(),
        )
            .prop_map(|(k, v)| (k.to_string(), v));
        prop::collection::vec(entry, 0..3)
    }

    /// Build a JSON object from ordered (key, value) groups; later duplicates of
    /// a key overwrite earlier ones, mirroring an object literal.
    fn to_object(groups: Vec<Vec<(String, Value)>>) -> Map<String, Value> {
        let mut map = Map::new();
        for group in groups {
            for (k, v) in group {
                map.insert(k, v);
            }
        }
        map
    }

    /// An arbitrary EXISTING settings object: a mix of recognized fields (incl.
    /// the recognized protected fields `keyVerifier`/`donutApiTokenEnc` as valid
    /// strings), legacy fields, and occasionally the legacy protected fields
    /// `customKey`/`customKeyEnc`, so preservation of prior protected values is
    /// exercised.
    fn arb_existing() -> impl Strategy<Value = Map<String, Value>> {
        (
            prop::collection::vec(arb_recognized_pair(), 0..6),
            arb_legacy_pairs(),
            prop::option::of("[a-zA-Z0-9:.]{1,16}"),
            prop::option::of("[a-zA-Z0-9:.]{1,16}"),
            prop::option::of("[a-zA-Z0-9:.]{1,16}"),
            prop::option::of("[a-zA-Z0-9:.]{1,16}"),
        )
            .prop_map(|(recognized, legacy, kv, tok, ck, cke)| {
                let mut protected: Vec<(String, Value)> = Vec::new();
                if let Some(v) = kv {
                    protected.push(("keyVerifier".to_string(), json!(v)));
                }
                if let Some(v) = tok {
                    protected.push(("donutApiTokenEnc".to_string(), json!(v)));
                }
                if let Some(v) = ck {
                    protected.push(("customKey".to_string(), json!(v)));
                }
                if let Some(v) = cke {
                    protected.push(("customKeyEnc".to_string(), json!(v)));
                }
                to_object(vec![recognized, legacy, protected])
            })
    }

    /// An arbitrary partial UPDATE map: recognized fields, legacy fields, and
    /// occasionally protected fields (which must be stripped).
    fn arb_update() -> impl Strategy<Value = Map<String, Value>> {
        (
            prop::collection::vec(arb_recognized_pair(), 0..6),
            arb_legacy_pairs(),
            arb_protected_pairs(),
        )
            .prop_map(|(recognized, legacy, protected)| {
                to_object(vec![recognized, legacy, protected])
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: electron-to-tauri-migration, Property 9: Settings save merges the update into the existing settings
        //
        // Validates: Requirements 3.1
        //
        // For an arbitrary existing settings object seeded to settings.json and an
        // arbitrary partial update map, `save_to_file` overlay-merges the update:
        //   * present-fields-overwritten: every update key EXCEPT the stripped
        //     protected keys appears in the saved settings with the update's value;
        //   * absent-fields-preserved: every existing key NOT overwritten by the
        //     (effective) update keeps its previous value;
        //   * stripped protected keys in the update are NOT applied — the prior
        //     existing value is preserved, or the key stays absent.
        // Assertions run against the on-disk JSON read back after the save.
        #[test]
        fn save_overlay_merges_update_into_existing(
            existing in arb_existing(),
            update in arb_update(),
        ) {
            let dir = unique_temp_dir("prop9");
            let path = settings_path_in(&dir);
            fs::write(&path, serde_json::to_string_pretty(&existing).unwrap())
                .expect("seed existing settings");

            // Baseline = exactly what the save reads and merges onto: the loaded
            // settings (recognized fields defaulted) serialized to an object.
            let loaded = load_from_file(&path).expect("seeded settings must load");
            let baseline = match serde_json::to_value(&loaded).unwrap() {
                Value::Object(m) => m,
                other => panic!("settings did not serialize to an object: {other}"),
            };

            save_to_file(&path, &update).expect("overlay-merge save must succeed");

            // Read the merged result back from disk.
            let disk = match serde_json::from_str::<Value>(
                &fs::read_to_string(&path).unwrap(),
            )
            .unwrap()
            {
                Value::Object(m) => m,
                other => panic!("saved settings is not an object: {other}"),
            };

            // The effective update is the update minus the stripped protected keys.
            let effective: Map<String, Value> = update
                .iter()
                .filter(|(k, _)| !STRIPPED_SAVE_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();

            // (1) present-fields-overwritten.
            for (k, v) in &effective {
                prop_assert_eq!(
                    disk.get(k),
                    Some(v),
                    "update key `{}` was not written with the update's value",
                    k
                );
            }

            // (2) absent-fields-preserved: any baseline key not in the effective
            // update keeps its prior value. This also covers stripped protected
            // keys present in the existing store (they are never in `effective`).
            for (k, v) in &baseline {
                if !effective.contains_key(k) {
                    prop_assert_eq!(
                        disk.get(k),
                        Some(v),
                        "existing key `{}` was not preserved at its prior value",
                        k
                    );
                }
            }

            // (3) stripped protected keys in the update are never applied: for a
            // protected key that was NOT already present in the existing store,
            // the update must not introduce it.
            for k in STRIPPED_SAVE_KEYS {
                if update.contains_key(k) && !baseline.contains_key(k) {
                    prop_assert!(
                        !disk.contains_key(k),
                        "stripped protected key `{}` was wrongly applied from the update",
                        k
                    );
                }
            }

            // No key is invented or dropped: the saved key set is exactly the
            // baseline keys unioned with the effective-update keys.
            let mut expected_keys: std::collections::BTreeSet<&String> =
                baseline.keys().collect();
            expected_keys.extend(effective.keys());
            let disk_keys: std::collections::BTreeSet<&String> = disk.keys().collect();
            prop_assert_eq!(
                disk_keys,
                expected_keys,
                "saved key set differs from baseline ∪ effective-update"
            );

            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod load_property_tests {
    //! Property-based test for Task 7.4 / Property 10: the settings *load* path's
    //! present-applied / absent-defaulted / legacy-preserved contract
    //! (Requirements 3.2, 11.2). Complements the focused unit tests in `tests`
    //! by exercising the behavior across a mix of arbitrary seeded stores.

    use super::*;
    use proptest::prelude::*;
    use serde_json::{json, Map, Value};
    use std::collections::BTreeSet;

    /// Every recognized Settings field name (the exact JSON keys). A loaded
    /// `Settings` always serializes all of these (no `skip_serializing_if`), so
    /// each appears in the round-tripped object either with the stored value or
    /// with its default.
    const RECOGNIZED_KEYS: [&str; 10] = [
        "multiInstance",
        "antiAfk",
        "antiAfkInterval",
        "keyVerifier",
        "donutApiTokenEnc",
        "donutApiPort",
        "pendingDonutDeletions",
        "multiRobloxGroupId",
        "masterVolume",
        "encSetupDone",
    ];

    /// The value a recognized field takes when it is ABSENT from the stored file:
    /// the Rust struct default, with the Electron runtime default applied to
    /// `donutApiPort` (`10108`). This mirrors [`default_settings`] serialized.
    fn default_recognized_value(key: &str) -> Value {
        match key {
            "multiInstance" | "antiAfk" => json!(false),
            "donutApiPort" => json!(DEFAULT_DONUT_API_PORT),
            "pendingDonutDeletions" => Value::Array(Vec::new()),
            // Every other recognized field is an Option that defaults to None,
            // which serializes to JSON null.
            _ => Value::Null,
        }
    }

    /// A small, always-round-trip-safe JSON value for legacy / unrecognized keys
    /// (they land in the `extra` catch-all, so any JSON shape is valid). Excludes
    /// non-finite floats so every value survives a write-to-disk / read-back
    /// unchanged.
    fn arb_small_json() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            (-100_000i64..100_000).prop_map(Value::from),
            "[a-zA-Z0-9 ]{0,12}".prop_map(Value::from),
            prop::collection::vec("[a-z]{0,5}", 0..3).prop_map(|v| json!(v)),
        ]
    }

    /// Legacy / unrecognized keys, prefixed `legacy_` so they can never collide
    /// with a recognized field name. These must survive load via `extra`.
    fn arb_legacy_pairs() -> impl Strategy<Value = Vec<(String, Value)>> {
        let entry =
            ("[a-z]{1,6}", arb_small_json()).prop_map(|(k, v)| (format!("legacy_{k}"), v));
        prop::collection::vec(entry, 0..4)
    }

    /// An arbitrary stored settings object: for each recognized field, EITHER a
    /// present, type-valid, round-trip-safe value OR absence (a mix per case),
    /// plus a set of legacy/unrecognized keys. Numeric/float values are
    /// constrained so they read back bit-identically (e.g. `masterVolume` uses
    /// low-precision decimals to avoid full-precision f64 read-back artifacts).
    fn arb_seeded() -> impl Strategy<Value = Map<String, Value>> {
        let multi_instance = prop::option::of(any::<bool>())
            .prop_map(|o| o.map(|b| ("multiInstance".to_string(), json!(b))));
        let anti_afk = prop::option::of(any::<bool>())
            .prop_map(|o| o.map(|b| ("antiAfk".to_string(), json!(b))));
        let anti_afk_interval = prop::option::of(0i64..100_000)
            .prop_map(|o| o.map(|n| ("antiAfkInterval".to_string(), json!(n))));
        let key_verifier = prop::option::of("[a-zA-Z0-9:.]{1,16}")
            .prop_map(|o| o.map(|s| ("keyVerifier".to_string(), json!(s))));
        let donut_token = prop::option::of("[a-zA-Z0-9:.]{1,16}")
            .prop_map(|o| o.map(|s| ("donutApiTokenEnc".to_string(), json!(s))));
        let donut_port = prop::option::of(0u16..=65535u16)
            .prop_map(|o| o.map(|p| ("donutApiPort".to_string(), json!(p))));
        let pending = prop::option::of(prop::collection::vec("[a-z]{1,6}", 0..4))
            .prop_map(|o| o.map(|v| ("pendingDonutDeletions".to_string(), json!(v))));
        let group_id = prop::option::of("[a-z]{1,8}")
            .prop_map(|o| o.map(|s| ("multiRobloxGroupId".to_string(), json!(s))));
        // Low-precision decimals in [0.000, 1.000] so the literal parses back to
        // the identical f64 (full-precision random f64s can shift by 1 ULP on
        // read-back — an artifact unrelated to the load semantics under test).
        let master_volume = prop::option::of(0u32..=1000u32)
            .prop_map(|o| o.map(|n| ("masterVolume".to_string(), json!(n as f64 / 1000.0))));
        let enc_setup = prop::option::of(any::<bool>())
            .prop_map(|o| o.map(|b| ("encSetupDone".to_string(), json!(b))));

        (
            (
                multi_instance,
                anti_afk,
                anti_afk_interval,
                key_verifier,
                donut_token,
                donut_port,
                pending,
                group_id,
                master_volume,
                enc_setup,
            ),
            arb_legacy_pairs(),
        )
            .prop_map(|(recognized, legacy)| {
                let (a, b, c, d, e, f, g, h, i, j) = recognized;
                let mut map = Map::new();
                for opt in [a, b, c, d, e, f, g, h, i, j] {
                    if let Some((k, v)) = opt {
                        map.insert(k, v);
                    }
                }
                for (k, v) in legacy {
                    map.insert(k, v);
                }
                map
            })
    }

    /// A unique temp directory for a test case. Dependency-free (no `tempfile`
    /// crate), matching the other test modules here.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mr_settings_loadprop_{}_{}_{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: electron-to-tauri-migration, Property 10: Settings load applies every recognized stored value and defaults every absent one
        //
        // Validates: Requirements 3.2, 11.2
        //
        // For an arbitrary settings object seeded to settings.json (a mix of some
        // recognized fields present with type-valid values, some absent, plus
        // arbitrary legacy/unrecognized keys), `load_from_file`:
        //   * present-applied: every recognized field PRESENT in the file is
        //     reflected in the loaded Settings with the stored value;
        //   * absent-defaulted: every recognized field ABSENT from the file takes
        //     its Rust default, with the Electron runtime default
        //     (donutApiPort=10108) applied when absent;
        //   * legacy-preserved: every unrecognized/legacy key survives via the
        //     `extra` catch-all and reappears on re-serialize (round-trip).
        // Assertions compare the loaded Settings (serialized to a JSON object)
        // against expectations derived from the seeded object.
        #[test]
        fn load_applies_present_defaults_absent_and_preserves_legacy(
            seeded in arb_seeded(),
        ) {
            let dir = unique_temp_dir("prop10");
            let path = settings_path_in(&dir);
            fs::write(
                &path,
                serde_json::to_string_pretty(&Value::Object(seeded.clone())).unwrap(),
            )
            .expect("seed settings file");

            let loaded = load_from_file(&path).expect("seeded settings must load");
            let loaded_obj = match serde_json::to_value(&loaded).unwrap() {
                Value::Object(m) => m,
                other => panic!("loaded settings did not serialize to an object: {other}"),
            };

            // (1) present-applied + (2) absent-defaulted, over every recognized field.
            for key in RECOGNIZED_KEYS {
                let expected = match seeded.get(key) {
                    Some(v) => v.clone(),
                    None => default_recognized_value(key),
                };
                prop_assert_eq!(
                    loaded_obj.get(key),
                    Some(&expected),
                    "recognized field `{}` was not applied/defaulted as expected",
                    key
                );
            }

            // (3) legacy-preserved: every unrecognized key in the file reappears
            // untouched on the loaded Settings' re-serialization.
            for (k, v) in &seeded {
                if !RECOGNIZED_KEYS.contains(&k.as_str()) {
                    prop_assert_eq!(
                        loaded_obj.get(k),
                        Some(v),
                        "legacy field `{}` was not preserved via the catch-all",
                        k
                    );
                }
            }

            // No key is invented or dropped: the loaded key set is exactly the
            // full recognized set (always serialized) unioned with the seeded
            // legacy keys.
            let mut expected_keys: BTreeSet<String> =
                RECOGNIZED_KEYS.iter().map(|s| s.to_string()).collect();
            for k in seeded.keys() {
                expected_keys.insert(k.clone());
            }
            let loaded_keys: BTreeSet<String> = loaded_obj.keys().cloned().collect();
            prop_assert_eq!(
                loaded_keys,
                expected_keys,
                "loaded key set differs from recognized ∪ seeded-legacy keys"
            );

            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod unreadable_property_tests {
    //! Property-based test for Task 7.6 / Property 21: an unreadable
    //! Settings_Store file is left untouched and its failure cause is reported,
    //! never silently treated as empty/default (Requirement 11.7).
    //!
    //! Uses the module's existing dependency-free temp-dir approach (no
    //! `tempfile` crate), matching the other test modules here.

    use super::*;
    use proptest::prelude::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A unique temp directory for a test case. Dependency-free (no `tempfile`
    /// crate), matching the other test modules here.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mr_settings_unreadprop_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Strategy producing file content that is NOT a valid `Settings` document.
    ///
    /// `Settings` carries `#[serde(default)]` plus a `#[serde(flatten)] extra`
    /// catch-all, so MANY JSON objects (including `{}` and objects full of
    /// unknown keys) parse successfully. To reliably exercise the unreadable
    /// path this strategy deliberately targets content that genuinely fails to
    /// deserialize:
    ///   * arbitrary garbage text / non-JSON;
    ///   * truncated JSON;
    ///   * non-object JSON (arrays / scalars);
    ///   * an object with a recognized field of the WRONG TYPE (e.g.
    ///     `donutApiPort` as a string, `multiInstance` as a number).
    ///
    /// The test body additionally `prop_assume!`s the content does not
    /// deserialize to `Settings`, filtering out anything that happens to parse
    /// so a coincidentally-valid document never yields a false failure.
    fn corrupt_settings_content() -> impl Strategy<Value = String> {
        prop_oneof![
            // Arbitrary garbage text (almost never valid settings JSON).
            any::<String>(),
            // Hand-picked genuinely-invalid inputs across every corrupt family.
            prop::sample::select(vec![
                // Non-JSON / garbage.
                String::new(),
                "not json at all".to_string(),
                "{ this is not valid json ]".to_string(),
                // Truncated JSON.
                "{".to_string(),
                "{\"multiInstance\":".to_string(),
                "[".to_string(),
                "[1, 2, 3".to_string(),
                // Non-object JSON (scalars / arrays).
                "null".to_string(),
                "true".to_string(),
                "42".to_string(),
                "\"just a string\"".to_string(),
                "[]".to_string(),
                "[1, 2, 3]".to_string(),
                // Recognized field, WRONG TYPE.
                "{\"multiInstance\": 5}".to_string(),
                "{\"multiInstance\": \"yes\"}".to_string(),
                "{\"antiAfk\": 3}".to_string(),
                "{\"donutApiPort\": \"nope\"}".to_string(),
                "{\"donutApiPort\": 999999}".to_string(),
                "{\"donutApiPort\": -1}".to_string(),
                "{\"pendingDonutDeletions\": \"nope\"}".to_string(),
                "{\"pendingDonutDeletions\": 7}".to_string(),
                "{\"masterVolume\": \"loud\"}".to_string(),
                "{\"encSetupDone\": \"maybe\"}".to_string(),
            ]),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: electron-to-tauri-migration, Property 21: An unreadable store file is left untouched and its failure cause is reported, never silently treated as empty
        //
        // **Validates: Requirements 11.7**
        //
        // For arbitrary content that is NOT a valid `Settings` document, written
        // to an EXISTING settings.json, `load_from_file`:
        //   * returns `Err` — never `Ok(defaults)` (it must not silently
        //     substitute an empty/default store for the unreadable file);
        //   * classifies the failure as corruption (`is_corruption()` true,
        //     `is_permission()` false), the distinguishing failure cause Req 11.7
        //     needs for an unparseable/wrong-shape file;
        //   * leaves the file byte-for-byte unmodified (a read is never a write).
        #[test]
        fn corrupt_settings_file_is_untouched_and_failure_reported(
            content in corrupt_settings_content(),
        ) {
            // Only exercise genuinely-invalid content: filter out anything that
            // happens to be a valid `Settings` (e.g. `{}` or an unknown-keys-only
            // object absorbed by the flatten catch-all).
            prop_assume!(serde_json::from_str::<Settings>(&content).is_err());

            let dir = unique_temp_dir("corrupt");
            let path = settings_path_in(&dir);
            let bytes = content.as_bytes().to_vec();
            fs::write(&path, &bytes).expect("seed the settings.json file");

            let result = load_from_file(&path);

            // Never Ok(defaults): an unreadable file must surface as an error and
            // must not be silently treated as empty/default (Req 11.7).
            prop_assert!(
                result.is_err(),
                "corrupt content was silently accepted as a store: {:?}",
                content
            );
            let err = result.err().unwrap();

            // The failure cause is reported as corruption, not a permission error.
            prop_assert!(err.is_corruption(), "expected Corruption, got {:?}", err);
            prop_assert!(!err.is_permission());

            // The file is left byte-for-byte unmodified.
            let after = fs::read(&path).expect("re-read the seeded file");
            prop_assert_eq!(
                &after,
                &bytes,
                "load_from_file must not modify the file on failure"
            );

            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// Fixed IO sub-case: pointing the store path at a directory makes the path
    /// EXIST (so it is not the `NotFound` "return defaults" branch) yet it cannot
    /// be read as a file. `load_from_file` must surface an `Err` — never an
    /// empty/default store — and it is not classified as corruption (Req 11.7).
    #[test]
    fn existing_unreadable_path_is_reported_not_defaulted() {
        let dir = unique_temp_dir("io");
        let store_path = settings_path_in(&dir);
        fs::create_dir_all(&store_path).expect("create a directory at the settings.json path");

        let err = load_from_file(&store_path)
            .expect_err("an existing unreadable path must be an error, never a default store");
        assert!(!err.is_corruption(), "expected a permission/IO error, got {err:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
