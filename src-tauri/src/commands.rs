//! Settings_Store + encryption Tauri command layer (Task 7.7).
//!
//! These 13 `#[tauri::command]` functions are the direct counterparts of the
//! legacy JS runtime `settings:*` / `enc:*` / `genhistory:*` / `fflag:*` / `fps:*` IPC
//! handlers (design IPC_Surface mapping table). Each takes the same parameters,
//! in the same order, as its legacy handler, and returns the same shape the
//! Renderer_UI already consumes (Requirement 10.1):
//!
//! | legacy IPC              | command                     | Rust core called                     |
//! |---------------------------|-----------------------------|--------------------------------------|
//! | `settings:load`           | [`settings_load`]           | `settings::load_from_dir`            |
//! | `settings:save`           | [`settings_save`]           | `settings::save_to_dir`              |
//! | `settings:saveDonutToken` | [`settings_save_donut_token`] | `settings::save_donut_token_to_dir` |
//! | `enc:status`              | [`enc_status`]              | `crypto_context::compute_passphrase_mode` + `encryption::session_pass` |
//! | `enc:unlock`              | [`enc_unlock`]              | `encryption::verify_pass` / `set_session_pass` |
//! | `enc:setKey`              | [`enc_set_key`]             | re-encryption sequence (see below)   |
//! | `genhistory:read`         | [`genhistory_read`]         | `settings::read_gen_history`         |
//! | `genhistory:write`        | [`genhistory_write`]        | `settings::write_gen_history`        |
//! | `genhistory:clear`        | [`genhistory_clear`]        | `settings::clear_gen_history`        |
//! | `fflag:read`              | [`fflag_read`]              | `settings::read_fflags`              |
//! | `fflag:write`             | [`fflag_write`]             | `settings::write_fflags`             |
//! | `fps:read`                | [`fps_read`]                | `settings::fps_read`                 |
//! | `fps:write`               | [`fps_write`]               | `settings::fps_write`                |
//!
//! Why a dedicated command module rather than adding these to `settings.rs`:
//! the `fps:read`/`fps:write` command names collide with the existing
//! `settings::fps_read`/`settings::fps_write` *core* helpers, and `enc_set_key`
//! orchestrates `settings.rs` + `accounts.rs` + `encryption.rs` + `crypto_context.rs`
//! together (an upward orchestration the layered `encryption.rs` deliberately
//! must not host). Keeping every command wrapper here leaves the lower modules'
//! layering intact while giving each command the exact name the Renderer_UI
//! invokes.
//!
//! The application-data directory is resolved via [`crate::accounts::store_dir`]
//! — the SAME helper the `accounts_*` commands use — so the Settings_Store lands
//! in the identical `%APPDATA%\robloxaccountmanager\` folder (Requirement 11.6), never a
//! divergent path.

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::accounts;
use crate::crypto_context::{self, CryptoContext};
use crate::encryption;
use crate::models::Settings;
use crate::settings;

/// The keys `settings:load` strips before returning settings to the Renderer_UI,
/// so no secret or key material ever reaches the frontend (Requirement 3.4 /
/// Property 12). Mirrors the legacy JS runtime destructure
/// `const { customKeyEnc, customKey, keyVerifier, _deviceKey, donutApiTokenEnc, ...rest } = s;`.
const SETTINGS_LOAD_STRIPPED_KEYS: [&str; 5] = [
    "customKeyEnc",
    "customKey",
    "keyVerifier",
    "_deviceKey",
    "donutApiTokenEnc",
];

// ── settings:load / settings:save / settings:saveDonutToken ──────────────────

/// `settings:load` — return the stored settings with all secret/key material
/// stripped, plus the derived `keySet` / `donutApiTokenConfigured` flags.
///
/// Ports:
/// ```js
/// const s = loadSettings();
/// const { customKeyEnc, customKey, keyVerifier, _deviceKey, donutApiTokenEnc, ...rest } = s;
/// return { ...rest, keySet: passphraseMode(), donutApiTokenConfigured: !!donutApiTokenEnc };
/// ```
///
/// The Donut_API_Token and the passphrase verifier are NEVER returned in any
/// form: `donutApiTokenEnc` (encrypted blob), `keyVerifier`, the legacy
/// `customKey`/`customKeyEnc`, and the machine-bound `_deviceKey` are all removed,
/// and only the boolean `keySet` (a passphrase is configured) and
/// `donutApiTokenConfigured` (a token is stored) are surfaced (Requirement 3.4).
///
/// A whole-file read failure (corrupt / permission) surfaces as `Err` and never
/// as an empty/default object (Requirement 11.7). `keySet` / the configured flag
/// are computed from the ORIGINAL loaded settings, before stripping.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Value, String> {
    crate::logging::log_command_result("settings_load", (|| {
        let dir = accounts::store_dir(&app)?;
        let settings = settings::load_from_dir(&dir).map_err(|e| e.to_string())?;
        redact_settings_for_load(&settings)
    })())
}

/// The pure "strip secrets + derive flags" core of [`settings_load`], factored out
/// so it is testable without an `AppHandle` / app-data-dir resolution. Given the
/// fully loaded [`Settings`], it produces the EXACT JSON object `settings_load`
/// returns to the Renderer_UI:
///
///   * every key in [`SETTINGS_LOAD_STRIPPED_KEYS`] (`donutApiTokenEnc`,
///     `keyVerifier`, `customKey`, `customKeyEnc`, `_deviceKey`) is removed, so no
///     secret or key material — recognized field or legacy `extra` field — ever
///     reaches the frontend (Requirement 3.4 / Property 12);
///   * the derived booleans `keySet` (a passphrase is configured) and
///     `donutApiTokenConfigured` (a token is stored) are computed from the
///     ORIGINAL settings, before stripping, and inserted;
///   * every other (non-secret) recognized field and legacy field passes through
///     untouched.
///
/// [`settings_load`] is now a thin wrapper: resolve dir -> load -> this. Keeping
/// the behavior here keeps the command's output byte-for-byte identical.
pub fn redact_settings_for_load(settings: &Settings) -> Result<Value, String> {
    // Derived flags computed from the full settings (before secrets are stripped).
    let key_set = crypto_context::compute_passphrase_mode(settings);
    let donut_configured = settings.donut_api_token_enc.is_some();

    let mut obj = match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => return Err("settings did not serialize to a JSON object".to_string()),
    };

    for key in SETTINGS_LOAD_STRIPPED_KEYS {
        obj.remove(key);
    }
    obj.insert("keySet".to_string(), Value::Bool(key_set));
    obj.insert(
        "donutApiTokenConfigured".to_string(),
        Value::Bool(donut_configured),
    );

    Ok(Value::Object(obj))
}

/// `settings:save` — overlay-merge a partial update into the stored settings.
///
/// Ports:
/// ```js
/// const { customKey, customKeyEnc, keyVerifier, donutApiTokenEnc, ...rest } = data;
/// saveSettings({ ...loadSettings(), ...rest });
/// if ('encryptionType' in data) invalidateKeyCache();
/// if ('multiInstance' in data) { ... startMutexHolder()/stopMutexHolder() ... }
/// if ('antiAfk' in data) { ... startAntiAfk()/stopAntiAfk() ... }
/// return true;
/// ```
///
/// The merge (with key material / the Donut token stripped from the *update*)
/// lives in [`settings::save_to_dir`] (Requirement 3.1). The `encryptionType`
/// change invalidates the derived-key cache. The `multiInstance` / `antiAfk`
/// side effects drive the Native_Helper (Task 9, `native_helper.rs`) and are
/// wired in when that module lands — noted below so the parity gap is explicit.
/// Returns `true`, matching the handler.
#[tauri::command]
pub fn settings_save(app: AppHandle, data: Map<String, Value>) -> Result<bool, String> {
    crate::logging::log_command_result("settings_save", (|| {
    let dir = accounts::store_dir(&app)?;
    settings::save_to_dir(&dir, &data).map_err(|e| e.to_string())?;

    if data.contains_key("encryptionType") {
        encryption::invalidate_key_cache();
    }

    // Window-layout side effect: a change to any layout-affecting key re-runs
    // the arrangement right away (the pass itself exits immediately while the
    // feature is disabled). Clearing `layout_last` forces the next pass to
    // re-arrange even when the window set itself did not change.
    const LAYOUT_KEYS: [&str; 5] = [
        "windowLayoutEnabled",
        "windowAutoLayout",
        "windowTargetWidth",
        "windowTargetHeight",
        "windowPerRow",
    ];
    if LAYOUT_KEYS.iter().any(|k| data.contains_key(*k)) {
        use tauri::Manager;
        if let Some(state) = app.try_state::<crate::AppState>() {
            *state
                .layout_last
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
        }
        crate::window_layout::schedule_layout_pass(&app, 0);
    }

    // Launch-plan side effect: the cached installation sweep is what the launch
    // path maps `robloxLaunchPresetId` against, so a change to either key must
    // not be answered from a sweep taken under the previous selection.
    const LAUNCH_PLAN_KEYS: [&str; 2] = ["robloxLaunchPresetId", "robloxLaunchMode"];
    if LAUNCH_PLAN_KEYS.iter().any(|k| data.contains_key(*k)) {
        crate::roblox_installations::invalidate_install_scan_for(&app);
    }

    // NOTE (Task 9 / native_helper.rs): the legacy handler also starts/stops the
    // Native_Helper mutex holder on `multiInstance` and the anti-AFK loop on
    // `antiAfk` / `antiAfkInterval` here. Those side effects are wired in when
    // `native_helper.rs` is implemented; the persisted setting itself is already
    // written above, so the stored state matches the legacy JS build now.

    Ok(true)
    })())
}

/// The value [`settings_save_donut_token`] returns, matching the legacy JS runtime
/// handler's `{ ok, donutApiTokenConfigured }` (success) and `{ ok, error }`
/// (failure) shapes so the Renderer_UI receives the identical payload.
#[derive(Debug, Clone, Serialize)]
pub struct SaveDonutTokenResult {
    /// `true` on a successful save/clear, `false` on a read/encrypt/write error.
    pub ok: bool,
    /// Whether a token is now stored. Present only on success.
    #[serde(
        rename = "donutApiTokenConfigured",
        skip_serializing_if = "Option::is_none"
    )]
    pub donut_api_token_configured: Option<bool>,
    /// The failure cause. Present only on error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `settings:saveDonutToken` — encrypt-and-store (or clear) the Donut_API_Token.
///
/// Ports:
/// ```js
/// const s = loadSettings();
/// const trimmed = typeof token === 'string' ? token.trim() : '';
/// if (trimmed) s.donutApiTokenEnc = encryptField(trimmed); else s.donutApiTokenEnc = null;
/// saveSettings(s);
/// return { ok: true, donutApiTokenConfigured: !!s.donutApiTokenEnc };
/// // catch => { ok: false, error }
/// ```
///
/// A non-blank token is encrypted with the same [`encryption::encrypt_field`]
/// mechanism (and its verify-before-persist pass, Requirement 11.5) used for
/// cookies; a blank/whitespace token clears the stored token. The plaintext
/// token is never read back or returned (Requirement 3.4). The three encryption
/// inputs are resolved once via [`crypto_context::resolve`], the SAME resolver
/// the account commands use. A non-string `token` (JSON `null`/absent) is treated
/// as the empty string, exactly like the legacy JS runtime `typeof token === 'string'`
/// guard.
#[tauri::command]
pub fn settings_save_donut_token(
    app: AppHandle,
    token: Option<String>,
) -> Result<SaveDonutTokenResult, String> {
    let dir = accounts::store_dir(&app)?;
    let CryptoContext {
        passphrase_mode,
        safe_storage_ready,
        device_key,
    } = crypto_context::resolve(&dir);

    let token = token.unwrap_or_default();
    match settings::save_donut_token_to_dir(
        &dir,
        &token,
        passphrase_mode,
        safe_storage_ready,
        device_key,
    ) {
        Ok(configured) => Ok(SaveDonutTokenResult {
            ok: true,
            donut_api_token_configured: Some(configured),
            error: None,
        }),
        Err(e) => Ok(SaveDonutTokenResult {
            ok: false,
            donut_api_token_configured: None,
            error: Some(e),
        }),
    }
}

// ── enc:status / enc:unlock / enc:setKey ─────────────────────────────────────

/// The value [`enc_status`] returns, matching the legacy handler's `{ mode }`
/// shape. `mode` is one of `"setup"`, `"locked"`, or `"unlocked"`.
#[derive(Debug, Clone, Serialize)]
pub struct EncStatus {
    /// `"setup"` (no passphrase configured), `"locked"` (configured, not unlocked
    /// this boot), or `"unlocked"` (configured and unlocked this boot).
    pub mode: String,
}

/// The value [`enc_unlock`] returns, matching the legacy handler's `{ ok }`.
#[derive(Debug, Clone, Serialize)]
pub struct EncUnlockResult {
    /// `true` iff the passphrase verified and the session is now unlocked.
    pub ok: bool,
}

/// The value [`enc_set_key`] returns, matching the legacy handler's
/// `{ ok }` (success) / `{ ok, error }` (failure) shapes.
#[derive(Debug, Clone, Serialize)]
pub struct EncSetKeyResult {
    /// `true` on a successful set/change/clear, `false` otherwise.
    pub ok: bool,
    /// The failure cause. Present only on error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `enc:status` — report the passphrase state so the Renderer_UI can decide
/// between the setup popup, the unlock popup, or proceeding.
///
/// Ports:
/// ```js
/// if (!passphraseMode()) return { mode: 'setup' };
/// return { mode: _sessionPass ? 'unlocked' : 'locked' };
/// ```
///
/// A Settings_Store read failure is swallowed to default settings here, matching
/// the legacy JS runtime `passphraseMode()` (`loadSettings()` in a `try/catch`), which
/// yields `{ mode: 'setup' }` rather than surfacing — the distinct
/// error-surfacing path is [`settings_load`] (Requirement 11.7). This is a pure
/// read: it never mutates key-session or device-key state.
#[tauri::command]
pub fn enc_status(app: AppHandle) -> Result<EncStatus, String> {
    crate::logging::log_command_result("enc_status", (|| {
        let dir = accounts::store_dir(&app)?;
        // Swallow a read failure to defaults, matching `passphraseMode()`'s try/catch.
        let settings =
            settings::load_from_dir(&dir).unwrap_or_else(|_| settings::default_settings());

        let mode = if !crypto_context::compute_passphrase_mode(&settings) {
            "setup"
        } else if encryption::session_pass().is_some() {
            "unlocked"
        } else {
            "locked"
        };

        Ok(EncStatus {
            mode: mode.to_string(),
        })
    })())
}

/// `enc:unlock` — verify a passphrase against the stored verifier and, on
/// success, unlock the session for this boot.
///
/// Ports:
/// ```js
/// if (!pass || !verifyPass(pass)) return { ok: false };
/// _sessionPass = pass; invalidateKeyCache(); writeSessionKey(pass);
/// return { ok: true };
/// ```
///
/// On REJECT (empty passphrase or a verifier mismatch) the prior locked/unlocked
/// state is left completely unchanged — [`encryption::verify_pass`] is a pure
/// read that never touches the key session, so there is no partial mutation
/// (Requirement 3.3 / Property 11). On success [`encryption::set_session_pass`]
/// records the unlocked passphrase and invalidates the derived-key cache. The
/// legacy JS runtime `writeSessionKey` is a no-op (session caching is disabled — it always
/// returns `null` on read), so it is intentionally not reproduced. A settings
/// read failure is swallowed to defaults (an absent verifier => reject), matching
/// `verifyPass`'s reliance on `loadSettings()`'s try/catch.
#[tauri::command]
pub fn enc_unlock(app: AppHandle, pass: Option<String>) -> Result<EncUnlockResult, String> {
    crate::logging::log_command_result("enc_unlock", (|| {
        let pass = pass.unwrap_or_default();
        if pass.is_empty() {
            return Ok(EncUnlockResult { ok: false });
        }

        let dir = accounts::store_dir(&app)?;
        let settings =
            settings::load_from_dir(&dir).unwrap_or_else(|_| settings::default_settings());
        let verifier = settings.key_verifier.clone().unwrap_or_default();

        if !encryption::verify_pass(&pass, &verifier) {
            // Reject: no mutation of session/cache state (Requirement 3.3).
            return Ok(EncUnlockResult { ok: false });
        }

        encryption::set_session_pass(&pass);
        Ok(EncUnlockResult { ok: true })
    })())
}

/// `enc:setKey` — set, change, or clear the passphrase, re-encrypting every
/// existing account under the new key in one step.
///
/// Ports (abridged):
/// ```js
/// const np = (pass || '').trim();
/// const raw   = existing accounts.json (ciphertext);
/// const accts = raw.map(decryptAccount);            // decrypt with the CURRENT key
/// for (i) if (raw[i].cookie && !accts[i].cookie) return { ok:false, error:'decrypt failed' };
/// if (np) { _sessionPass = np; invalidateKeyCache();
///           saveSettings({ ...rest(-customKey,-customKeyEnc), keyVerifier: makeVerifier(np), encSetupDone:true }); }
/// else    { _sessionPass = null; invalidateKeyCache();
///           saveSettings({ ...rest(-customKey,-customKeyEnc,-keyVerifier), encSetupDone:true }); }
/// invalidateKeyCache();
/// saveAccounts(accts);                              // re-encrypt with the NEW key (or machine-bound)
/// return { ok:true };
/// ```
///
/// ## Re-encryption sequence (ported faithfully)
///
/// 1. **Decrypt-before-mutate guard.** Load + decrypt the store with the CURRENT
///    crypto context ([`crypto_context::resolve`]). If ANY entry with a stored
///    cookie fails to decrypt (surfaced as [`accounts::AccountLoad`] errors —
///    the Rust equivalent of `raw[i].cookie && !accts[i].cookie`), abort with
///    `{ ok:false, error:"decrypt failed" }` BEFORE touching any state, so a bad
///    current key never causes re-encryption of garbage / data loss.
/// 2. **Switch the key session.** For a non-empty passphrase, build the verifier
///    first ([`encryption::make_verifier`]) — if that fails, nothing has been
///    mutated yet — then [`encryption::set_session_pass`]. For an empty passphrase,
///    [`encryption::clear_session_pass`] (machine-bound mode).
/// 3. **Persist the passphrase change** via [`settings::apply_passphrase_change`]
///    (the only writer permitted to touch `keyVerifier`; it preserves
///    `donutApiTokenEnc` and every other field, strips legacy `customKey`/
///    `customKeyEnc`, sets `encSetupDone`).
/// 4. **Re-encrypt + save accounts** with a FRESHLY resolved crypto context (now
///    reflecting the new passphrase/verifier). With the passphrase unlocked in the
///    key session, [`accounts::save_to_dir`] re-encrypts each plaintext cookie
///    under the new `gs:` key; in the cleared case it re-encrypts machine-bound
///    (`safe:` on Windows). The save's verify-before-persist pass (Requirement
///    11.5) guards against writing an unverifiable secret.
///
/// The legacy JS runtime `writeSessionKey`/`clearSessionKey` calls are no-ops (session
/// caching disabled) and are intentionally not reproduced. This command never
/// returns `Err`: like the legacy JS runtime `try/catch`, every failure resolves to
/// `{ ok:false, error }` so the Renderer_UI branch on `r.ok` works unchanged.
#[tauri::command]
pub fn enc_set_key(app: AppHandle, pass: Option<String>) -> Result<EncSetKeyResult, String> {
    match enc_set_key_inner(&app, pass) {
        Ok(()) => Ok(EncSetKeyResult {
            ok: true,
            error: None,
        }),
        Err(error) => Ok(EncSetKeyResult {
            ok: false,
            error: Some(error),
        }),
    }
}

/// Fallible core of [`enc_set_key`]; every `Err(msg)` becomes `{ ok:false, error:msg }`.
fn enc_set_key_inner(app: &AppHandle, pass: Option<String>) -> Result<(), String> {
    let dir = accounts::store_dir(app)?;
    let np = pass.unwrap_or_default().trim().to_string();

    // (1) Decrypt with the CURRENT key while we still can, and abort if any
    //     account that had a stored cookie fails to decrypt (never re-encrypt
    //     garbage). `load_from_dir` reports per-entry decrypt failures as errors;
    //     a whole-file read/corruption failure surfaces as Err and aborts too.
    let before = crypto_context::resolve(&dir);
    let loaded = accounts::load_from_dir(
        &dir,
        before.passphrase_mode,
        before.safe_storage_ready,
        before.device_key,
    )
    .map_err(|e| e.to_string())?;

    if loaded.has_decrypt_errors() {
        return Err("decrypt failed".to_string());
    }
    let accts = loaded.accounts;

    // (2) + (3) Switch the key session and persist the passphrase change.
    if !np.is_empty() {
        // Build the verifier BEFORE mutating session state so a derivation
        // failure leaves everything untouched.
        let verifier = encryption::make_verifier(&np)?;
        encryption::set_session_pass(&np);
        settings::apply_passphrase_change(&dir, Some(&verifier))?;
    } else {
        encryption::clear_session_pass();
        settings::apply_passphrase_change(&dir, None)?;
    }
    encryption::invalidate_key_cache();

    // (4) Re-encrypt every account under the NEW key (or machine-bound) and save.
    //     Resolve the crypto context fresh so it reflects the just-written
    //     verifier / cleared state.
    let after = crypto_context::resolve(&dir);
    accounts::save_to_dir(
        &dir,
        &accts,
        after.passphrase_mode,
        after.safe_storage_ready,
        after.device_key,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ── genhistory:read / genhistory:write / genhistory:clear ────────────────────

/// `genhistory:read` — return the generation history array (`[]` on any failure,
/// matching the handler's `catch { return [] }`). Delegates to
/// [`settings::read_gen_history`].
#[tauri::command]
pub fn genhistory_read(app: AppHandle) -> Result<Vec<Value>, String> {
    crate::logging::log_command_result("genhistory_read", (|| {
        let dir = accounts::store_dir(&app)?;
        Ok(settings::read_gen_history(&dir))
    })())
}

/// `genhistory:write` — persist the generation history (capped at 500 entries),
/// returning `true`/`false` for success/failure, matching the handler.
/// Delegates to [`settings::write_gen_history`]. A non-array payload the legacy JS runtime
/// handler coerces to `[]` (`Array.isArray(list) ? ... : []`) is enforced by the
/// typed `Vec<Value>` parameter — a malformed payload is rejected at
/// deserialization, which `invoke()` surfaces as a rejected promise.
#[tauri::command]
pub fn genhistory_write(app: AppHandle, list: Vec<Value>) -> Result<bool, String> {
    crate::logging::log_command_result("genhistory_write", (|| {
        let dir = accounts::store_dir(&app)?;
        Ok(settings::write_gen_history(&dir, &list))
    })())
}

/// `genhistory:clear` — overwrite the generation history with `[]`, returning
/// `true`/`false`, matching the handler. Delegates to
/// [`settings::clear_gen_history`].
#[tauri::command]
pub fn genhistory_clear(app: AppHandle) -> Result<bool, String> {
    crate::logging::log_command_result("genhistory_clear", (|| {
        let dir = accounts::store_dir(&app)?;
        Ok(settings::clear_gen_history(&dir))
    })())
}

// ── fflag:read / fflag:write ─────────────────────────────────────────────────

/// `fflag:read` — read the Fast Flags object from the current Roblox install
/// (`{}` when no install/file is found or on any failure), matching the handler.
/// Delegates to [`settings::read_fflags`], which resolves the Roblox client path
/// itself (independent of the Settings_Store), so no app-data dir is needed.
#[tauri::command]
pub fn fflag_read() -> Result<Map<String, Value>, String> {
    Ok(settings::read_fflags())
}

/// `fflag:write` — write the Fast Flags object to the current Roblox install,
/// returning `true`/`false`, matching the handler. Delegates to
/// [`settings::write_fflags`] (creates the `ClientSettings` dir as needed).
#[tauri::command]
pub fn fflag_write(flags: Value) -> Result<bool, String> {
    Ok(settings::write_fflags(&flags))
}

// ── fps:read / fps:write ─────────────────────────────────────────────────────

/// The value [`fps_write`] returns, matching the legacy handler's
/// `{ ok }` / `{ ok, error }` shapes.
#[derive(Debug, Clone, Serialize)]
pub struct FpsWriteResult {
    /// `true` when the cap was written, `false` otherwise.
    pub ok: bool,
    /// The failure cause (e.g. the settings file not existing). Present only on error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `fps:read` — read the FPS cap from Roblox's `GlobalBasicSettings_13.xml`
/// (defaulting to `60` when absent / unreadable / no `FramerateCap` element),
/// matching the handler. Delegates to the [`settings::fps_read`] core (which
/// resolves the Roblox settings path itself).
#[tauri::command]
pub fn fps_read() -> Result<i64, String> {
    Ok(settings::fps_read())
}

/// `fps:write` — write the FPS cap into Roblox's `GlobalBasicSettings_13.xml`,
/// returning `{ ok: true }` on success or `{ ok: false, error }` when the file is
/// absent or the write fails, matching the handler. Delegates to the
/// [`settings::fps_write`] core (clamp/round `Math.max(0, Math.round(...))`,
/// update-in-place-or-insert semantics). The `cap` parameter is `f64` to mirror
/// the legacy JS runtime `Number(cap)` coercion.
#[tauri::command]
pub fn fps_write(cap: f64) -> Result<FpsWriteResult, String> {
    match settings::fps_write(cap) {
        Ok(()) => Ok(FpsWriteResult {
            ok: true,
            error: None,
        }),
        Err(error) => Ok(FpsWriteResult {
            ok: false,
            error: Some(error),
        }),
    }
}

#[cfg(test)]
mod tests {
    //! Property test for `settings:load`'s secret-stripping (Requirement 3.4).
    //!
    //! Exercises [`redact_settings_for_load`] — the pure core `settings_load`
    //! delegates to — so the AppHandle / app-data-dir resolution is not needed.

    use super::{redact_settings_for_load, Settings, SETTINGS_LOAD_STRIPPED_KEYS};
    use proptest::prelude::*;
    use serde_json::{Map, Value};

    /// A distinctive secret-looking string. Every generated secret carries the
    /// `SECRET_` marker so the "no secret value leaks" assertion can never be
    /// tripped by a coincidental collision with a non-secret pass-through value
    /// (those are generated from lowercase letters only, below).
    fn secret_value() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9]{1,24}".prop_map(|s| format!("SECRET_{s}"))
    }

    /// An optionally-present secret (covers both the present and absent branches,
    /// so the derived `keySet` / `donutApiTokenConfigured` flags are checked in
    /// both states).
    fn opt_secret() -> impl Strategy<Value = Option<String>> {
        prop_oneof![Just(None), secret_value().prop_map(Some)]
    }

    /// A non-secret string: lowercase letters only, so it can never contain the
    /// `SECRET_` marker and never equals a generated secret value.
    fn non_secret_value() -> impl Strategy<Value = String> {
        "[a-z]{1,12}"
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 12: Settings load never returns a stored secret in plaintext
        #[test]
        fn settings_load_never_returns_secrets(
            key_verifier in opt_secret(),
            donut_token_enc in opt_secret(),
            custom_key in opt_secret(),
            custom_key_enc in opt_secret(),
            device_key in secret_value(),           // always-present legacy secret
            multi_instance in any::<bool>(),
            group_id in non_secret_value(),          // non-secret recognized field
            legacy_non_secret in non_secret_value(), // non-secret legacy field
        ) {
            // Build an arbitrary Settings carrying populated secret/key fields
            // (recognized `keyVerifier`/`donutApiTokenEnc` + legacy `customKey`/
            // `customKeyEnc`/`_deviceKey`) alongside non-secret fields.
            let mut obj = Map::new();
            obj.insert("multiInstance".to_string(), Value::Bool(multi_instance));
            obj.insert("multiRobloxGroupId".to_string(), Value::String(group_id.clone()));
            obj.insert("legacyNonSecret".to_string(), Value::String(legacy_non_secret.clone()));
            obj.insert("_deviceKey".to_string(), Value::String(device_key.clone()));
            if let Some(v) = &key_verifier {
                obj.insert("keyVerifier".to_string(), Value::String(v.clone()));
            }
            if let Some(v) = &donut_token_enc {
                obj.insert("donutApiTokenEnc".to_string(), Value::String(v.clone()));
            }
            if let Some(v) = &custom_key {
                obj.insert("customKey".to_string(), Value::String(v.clone()));
            }
            if let Some(v) = &custom_key_enc {
                obj.insert("customKeyEnc".to_string(), Value::String(v.clone()));
            }

            let settings: Settings = serde_json::from_value(Value::Object(obj))
                .expect("hand-built settings object must deserialize");

            let view = redact_settings_for_load(&settings)
                .expect("redaction must succeed for a valid settings object");
            let map = view.as_object().expect("the load view must be a JSON object");

            // (1) None of the stripped keys survive in the returned view.
            for key in SETTINGS_LOAD_STRIPPED_KEYS {
                prop_assert!(
                    !map.contains_key(key),
                    "stripped key `{key}` leaked into the settings-load view"
                );
            }

            // (2) No raw secret VALUE appears anywhere in the serialized output —
            //     not under its original key, and not under any other key.
            let serialized = serde_json::to_string(&view)
                .expect("the load view must serialize");
            let secrets = [
                key_verifier.as_deref(),
                donut_token_enc.as_deref(),
                custom_key.as_deref(),
                custom_key_enc.as_deref(),
                Some(device_key.as_str()),
            ];
            for secret in secrets.into_iter().flatten() {
                prop_assert!(
                    !serialized.contains(secret),
                    "secret value `{secret}` leaked into the settings-load output"
                );
            }

            // (3) Derived booleans are correct. `keySet` reflects passphrase mode
            //     (any of keyVerifier / customKeyEnc / customKey present & non-empty);
            //     `donutApiTokenConfigured` reflects a stored donutApiTokenEnc.
            let expected_key_set =
                key_verifier.is_some() || custom_key_enc.is_some() || custom_key.is_some();
            prop_assert_eq!(
                map.get("keySet"),
                Some(&Value::Bool(expected_key_set)),
                "keySet did not reflect passphrase mode"
            );
            prop_assert_eq!(
                map.get("donutApiTokenConfigured"),
                Some(&Value::Bool(donut_token_enc.is_some())),
                "donutApiTokenConfigured did not reflect a stored token"
            );

            // (4) Non-secret recognized + legacy fields pass through untouched.
            prop_assert_eq!(map.get("multiInstance"), Some(&Value::Bool(multi_instance)));
            prop_assert_eq!(
                map.get("multiRobloxGroupId"),
                Some(&Value::String(group_id))
            );
            prop_assert_eq!(
                map.get("legacyNonSecret"),
                Some(&Value::String(legacy_non_secret))
            );
        }
    }
}
