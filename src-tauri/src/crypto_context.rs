//! Encryption-input resolution for the command layer (`crypto_context.rs`).
//!
//! The store modules (`accounts.rs`, `settings.rs`) and `encryption.rs` are
//! deliberately layered *below* the Settings_Store: their encrypt/decrypt
//! functions take the three settings-derived inputs
//! (`passphrase_mode`, `safe_storage_ready`, `device_key`) as plain parameters
//! rather than reading `settings.json` themselves (see the module docs of
//! `encryption.rs` / `accounts.rs`). Something has to actually resolve those
//! three inputs from the Settings_Store and the platform before a command can
//! call [`crate::accounts::load_from_dir`] / [`crate::accounts::save_to_dir`].
//! In the legacy JS build that resolution is spread across three helpers in
//! the legacy JS backend, which `encryptField`/`decryptField` call inline:
//!
//! ```js
//! function safeStorageReady() {
//!   try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
//! }
//! function passphraseMode() {
//!   const s = loadSettings();
//!   return !!(s.keyVerifier || s.customKeyEnc || (s.customKey && s.customKey.trim()));
//! }
//! function getOrCreateDeviceKey() {
//!   const s = loadSettings();
//!   if (s._deviceKey && s._deviceKey.length === 64) return Buffer.from(s._deviceKey, 'hex');
//!   const key = crypto.randomBytes(KEY_LEN);
//!   saveSettings({ ...s, _deviceKey: key.toString('hex') });
//!   return key;
//! }
//! ```
//!
//! [`resolve`] ports all three into a single [`CryptoContext`] the command layer
//! resolves once (from the same application-data directory the stores live in)
//! and threads into the store calls, matching how the legacy JS backend derives them from
//! `loadSettings()` before every encrypt/decrypt.
//!
//! ## Faithful simplifications (documented)
//!
//!  * **`safe_storage_ready`** is `true` on Windows and `false` elsewhere.
//!    legacy JS runtime's `safeStorage.isEncryptionAvailable()` returns `true` on Windows
//!    (its `safe:` format is Windows DPAPI, which this build also implements via
//!    `windows-rs`); RobloxAccountManager is Windows-only (Requirement 8.1), so a bare
//!    `cfg!(windows)` reproduces the observable value without probing the
//!    keychain.
//!  * **Settings read failure** falls back to default settings for the purpose of
//!    resolving these inputs, matching `loadSettings()`'s `try { ... } catch { s = {} }`
//!    swallow. The *surfacing* of a corrupt/unreadable Settings_Store to the user
//!    (Requirement 11.7) is the `settings_load` command's responsibility
//!    (Task 7.7), not this resolver's — resolving crypto inputs must stay
//!    non-fatal so the account commands behave exactly as the legacy JS build
//!    (which proceeds in device-key mode when settings can't be read).
//!  * **`device_key`** is only materialized (generated + persisted) when it is
//!    actually needed — i.e. when NOT in passphrase mode, the only branch
//!    `encryption.rs` ever consults it in. In the legacy JS backend, `getOrCreateDeviceKey`
//!    is likewise called lazily only from the `!passphraseMode()` arms of
//!    `getEncryptionKey`/`getLegacyKey`, so generating a device key while in
//!    passphrase mode never happens there either. An already-present `_deviceKey`
//!    is always read back (so legacy device-key records still decrypt).

use std::path::Path;

use serde_json::{Map, Value};

use crate::models::Settings;
use crate::settings;

/// Derived-key length in bytes (AES-256), matching `encryption.rs`'s `KEY_LEN`
/// and the legacy JS build's `const KEY_LEN = 32`. A stored `_deviceKey` is this
/// many bytes, i.e. `2 * 32 = 64` hex characters.
const KEY_LEN: usize = 32;

/// The three settings-derived encryption inputs the store modules require,
/// resolved once from the Settings_Store + platform and threaded into
/// [`crate::encryption::encrypt_account`] / [`crate::encryption::decrypt_account`]
/// (via the `accounts.rs` load/save wrappers). Mirrors the trio of values
/// the legacy JS backend's `encryptField`/`decryptField` read inline from `loadSettings()`
/// plus `safeStorage`.
#[derive(Debug, Clone)]
pub struct CryptoContext {
    /// `passphraseMode()`: a passphrase-derived key is configured.
    pub passphrase_mode: bool,
    /// `safeStorageReady()`: the OS keychain (`safe:` / DPAPI) is available.
    pub safe_storage_ready: bool,
    /// `getOrCreateDeviceKey()`: the machine-bound legacy key, when applicable.
    pub device_key: Option<[u8; KEY_LEN]>,
}

/// Reproduce `safeStorageReady()`. See the module docs for why this is
/// `cfg!(windows)`.
pub fn safe_storage_ready() -> bool {
    cfg!(windows)
}

/// Reproduce `passphraseMode()`:
/// `!!(s.keyVerifier || s.customKeyEnc || (s.customKey && s.customKey.trim()))`.
///
/// `keyVerifier` is a recognized [`Settings`] field; `customKeyEnc` / `customKey`
/// are legacy fields carried in the `extra` catch-all. Each is "truthy" iff it is
/// a present, non-empty string (with `customKey` additionally trimmed, matching
/// the JS `.trim()`).
pub fn compute_passphrase_mode(settings: &Settings) -> bool {
    let key_verifier = settings
        .key_verifier
        .as_deref()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let custom_key_enc = extra_nonempty_str(&settings.extra, "customKeyEnc", false);
    let custom_key = extra_nonempty_str(&settings.extra, "customKey", true);
    key_verifier || custom_key_enc || custom_key
}

/// `true` iff `extra[key]` is a present string that is non-empty (and non-empty
/// after trimming when `trim` is set), matching JavaScript truthiness on the
/// legacy `customKeyEnc` / `customKey` fields.
fn extra_nonempty_str(extra: &Map<String, Value>, key: &str, trim: bool) -> bool {
    match extra.get(key) {
        Some(Value::String(s)) => {
            if trim {
                !s.trim().is_empty()
            } else {
                !s.is_empty()
            }
        }
        _ => false,
    }
}

/// Resolve the [`CryptoContext`] for the application-data directory `dir` (the
/// directory holding `settings.json` / `accounts.json`). Reads the Settings_Store
/// once and derives all three inputs, mirroring the per-call resolution
/// the legacy JS backend performs from `loadSettings()`.
///
/// A Settings_Store read failure is non-fatal here (see the module docs): it
/// falls back to [`settings::default_settings`], exactly as `loadSettings()`
/// falls back to `{}`.
pub fn resolve(dir: &Path) -> CryptoContext {
    let settings = settings::load_from_dir(dir).unwrap_or_else(|_| settings::default_settings());
    let passphrase_mode = compute_passphrase_mode(&settings);
    let safe_storage_ready = safe_storage_ready();
    let device_key = resolve_device_key(dir, &settings, passphrase_mode);
    CryptoContext {
        passphrase_mode,
        safe_storage_ready,
        device_key,
    }
}

/// Port of `getOrCreateDeviceKey()`, resolved against already-loaded `settings`
/// so the Settings_Store is read only once per [`resolve`].
///
///   * If a valid `_deviceKey` (64 hex chars = 32 bytes) is already stored, decode
///     and return it — so accounts encrypted under the legacy device-key path
///     keep decrypting (this happens regardless of `passphrase_mode`, matching
///     the fact that the stored key is always usable once present).
///   * Otherwise, only when NOT in passphrase mode (the sole branch that ever
///     consults the device key), generate a fresh 32-byte key, persist it to
///     `settings.json` as hex (best-effort, matching
///     `saveSettings({ ...s, _deviceKey })`), and return it.
///   * In passphrase mode with no stored key, return `None`: the device key is
///     never used, and generating/persisting one would be a spurious write the
///     legacy JS build never makes in that mode.
fn resolve_device_key(
    dir: &Path,
    settings: &Settings,
    passphrase_mode: bool,
) -> Option<[u8; KEY_LEN]> {
    if let Some(Value::String(hex)) = settings.extra.get("_deviceKey") {
        if hex.len() == KEY_LEN * 2 {
            if let Some(key) = decode_hex_key(hex) {
                return Some(key);
            }
        }
    }

    if passphrase_mode {
        return None;
    }

    let mut key = [0u8; KEY_LEN];
    if getrandom::getrandom(&mut key).is_err() {
        return None;
    }

    // Persist as hex, mirroring `saveSettings({ ...s, _deviceKey: key.toString('hex') })`.
    // Best-effort: a write failure (e.g. an unreadable Settings_Store, which
    // `save_to_dir` refuses to clobber per Requirement 11.7) leaves us with an
    // in-memory key for this run, exactly as usable as legacy JS runtime's would be even
    // if its own `saveSettings` had thrown.
    let mut update = Map::new();
    update.insert("_deviceKey".to_string(), Value::String(encode_hex_key(&key)));
    let _ = settings::save_to_dir(dir, &update);

    Some(key)
}

/// Decode a lowercase/uppercase hex string of exactly [`KEY_LEN`] bytes into a
/// fixed-size key, returning `None` on any non-hex character or wrong length —
/// the equivalent of `Buffer.from(hex, 'hex')` guarded by the `length === 64`
/// check in `getOrCreateDeviceKey`.
fn decode_hex_key(hex: &str) -> Option<[u8; KEY_LEN]> {
    let bytes = hex.as_bytes();
    if bytes.len() != KEY_LEN * 2 {
        return None;
    }
    let mut out = [0u8; KEY_LEN];
    for (i, chunk) in bytes.chunks_exact(2).enumerate() {
        let hi = hex_digit(chunk[0])?;
        let lo = hex_digit(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

/// Encode a fixed-size key as a lowercase hex string, the equivalent of
/// `key.toString('hex')`.
fn encode_hex_key(key: &[u8; KEY_LEN]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(KEY_LEN * 2);
    for &b in key {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Map a single ASCII hex digit to its 0-15 value, or `None` if not hex.
fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Settings;
    use serde_json::json;

    fn settings_from(value: serde_json::Value) -> Settings {
        serde_json::from_value(value).expect("valid settings fixture")
    }

    #[test]
    fn passphrase_mode_true_when_key_verifier_present() {
        let s = settings_from(json!({ "keyVerifier": "gs:blob" }));
        assert!(compute_passphrase_mode(&s));
    }

    #[test]
    fn passphrase_mode_true_for_legacy_custom_key_enc() {
        let s = settings_from(json!({ "customKeyEnc": "safe:abc" }));
        assert!(compute_passphrase_mode(&s));
    }

    #[test]
    fn passphrase_mode_true_for_legacy_custom_key_when_non_blank() {
        let s = settings_from(json!({ "customKey": "  secret  " }));
        assert!(compute_passphrase_mode(&s));
    }

    #[test]
    fn passphrase_mode_false_for_blank_custom_key() {
        let s = settings_from(json!({ "customKey": "   " }));
        assert!(!compute_passphrase_mode(&s));
    }

    #[test]
    fn passphrase_mode_false_when_absent() {
        let s = settings_from(json!({}));
        assert!(!compute_passphrase_mode(&s));
    }

    #[test]
    fn hex_round_trip_recovers_key() {
        let key: [u8; KEY_LEN] = std::array::from_fn(|i| (i * 7 + 1) as u8);
        let hex = encode_hex_key(&key);
        assert_eq!(hex.len(), KEY_LEN * 2);
        assert_eq!(decode_hex_key(&hex), Some(key));
    }

    #[test]
    fn decode_hex_rejects_bad_length_and_chars() {
        assert_eq!(decode_hex_key("abcd"), None); // too short
        let bad: String = "zz".repeat(KEY_LEN); // right length, non-hex
        assert_eq!(decode_hex_key(&bad), None);
    }

    #[test]
    fn resolve_device_key_reads_existing_valid_key() {
        let key: [u8; KEY_LEN] = std::array::from_fn(|i| i as u8);
        let hex = encode_hex_key(&key);
        let s = settings_from(json!({ "_deviceKey": hex }));
        // Passphrase mode true, but an existing key is still returned.
        let dir = std::env::temp_dir();
        assert_eq!(resolve_device_key(&dir, &s, true), Some(key));
    }

    #[test]
    fn resolve_device_key_none_in_passphrase_mode_without_stored_key() {
        let s = settings_from(json!({ "keyVerifier": "gs:blob" }));
        let dir = std::env::temp_dir();
        assert_eq!(resolve_device_key(&dir, &s, true), None);
    }
}
