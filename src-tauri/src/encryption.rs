//! Field encryption, ported from `main.js`'s encryption section.
//!
//! This module reproduces every on-disk encryption format the Electron_Build
//! produces or consumes, so existing `accounts.json`/`settings.json` values keep
//! decrypting without any migration (Requirement 11.3). Each format is
//! identified by a short prefix tag on the stored string:
//!
//! | tag     | primitive                                    | Electron source        |
//! |---------|----------------------------------------------|------------------------|
//! | `safe:` | Windows DPAPI, current-user scope, no entropy | `safeStorage`          |
//! | `gs:`   | AES-256-GCM, scrypt-derived key              | `encryptGCM` + scrypt  |
//! | `gcm:`  | AES-256-GCM, PBKDF2-HMAC-SHA512 key          | `encryptGCM` + legacy  |
//! | `cbc:`  | AES-256-CBC (read-only)                      | `decryptCBC`           |
//!
//! This task (3.1) implements only the `safe:` primitive at the raw byte layer:
//! [`dpapi_protect`] and [`dpapi_unprotect`]. Electron's
//! `safeStorage.encryptString(p)` returns the raw DPAPI blob, which a higher
//! layer base64-encodes and prefixes with `safe:` (see `encryptField` in
//! `main.js`); `decryptString` is the inverse. The `safe:` tag prefix + base64
//! dispatch lives in `encrypt_field`/`decrypt_field` (task 3.4), so these
//! functions deliberately operate on raw bytes only.
//!
//! Windows DPAPI (`CryptProtectData`) is called with `pOptionalEntropy = null`
//! and no flags, exactly matching Chromium/Electron's `safeStorage`, which also
//! passes no additional entropy. Because DPAPI ties the blob to the current user
//! account, a blob produced by the Electron_Build decrypts here and vice versa.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use sha2::Sha512;
use std::sync::Mutex;

/// Hardcoded key-derivation salt, carried over verbatim from `main.js`'s
/// `const SALT = 'robloxaccountmanager-v1-salt-2025'`. Any deviation would break
/// byte-for-byte decryption of existing data (Requirement 11.3).
const SALT: &[u8] = b"robloxaccountmanager-v1-salt-2025";
/// PBKDF2 iteration count, from `main.js`'s `const ITERATIONS = 210_000`.
const ITERATIONS: u32 = 210_000;
/// Derived-key length in bytes (AES-256), from `main.js`'s `const KEY_LEN = 32`.
const KEY_LEN: usize = 32;
/// scrypt cost parameter `N = 65536 = 2^16`; the `scrypt` crate takes the base-2
/// logarithm (`log_n = 16`) instead of `N` directly. From `main.js`'s
/// `SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 }`.
const SCRYPT_LOG_N: u8 = 16;
/// scrypt block-size parameter `r`, from `SCRYPT_PARAMS.r = 8`.
const SCRYPT_R: u32 = 8;
/// scrypt parallelization parameter `p`, from `SCRYPT_PARAMS.p = 1`.
const SCRYPT_P: u32 = 1;

/// AES-256-CBC decryptor alias (legacy `cbc:` read path only).
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// Derive the current-format (`gs:`) key from a passphrase using scrypt with the
/// exact parameters the Electron_Build uses (`N=2^16, r=8, p=1`, 32-byte output,
/// hardcoded salt), mirroring `deriveScryptKey` /
/// `crypto.scryptSync(p, SALT, KEY_LEN, { N: 65536, r: 8, p: 1 })`. Returns
/// `Err` rather than panicking if the parameters are somehow rejected.
pub fn derive_scrypt_key(passphrase: &str) -> Result<[u8; KEY_LEN], String> {
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .map_err(|e| format!("scrypt params invalid: {e}"))?;
    let mut key = [0u8; KEY_LEN];
    scrypt::scrypt(passphrase.as_bytes(), SALT, &params, &mut key)
        .map_err(|e| format!("scrypt derivation failed: {e}"))?;
    Ok(key)
}

/// Derive the legacy (`gcm:` / `cbc:`) key from a passphrase using
/// PBKDF2-HMAC-SHA512 with 210,000 iterations, a 32-byte output, and the same
/// hardcoded salt, mirroring `deriveLegacyKey` /
/// `crypto.pbkdf2Sync(p, SALT, 210000, KEY_LEN, 'sha512')`. PBKDF2 has no
/// fallible path for these fixed inputs, so this is infallible.
pub fn derive_legacy_key(passphrase: &str) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<Sha512>(passphrase.as_bytes(), SALT, ITERATIONS, &mut key);
    key
}

/// AES-256-GCM encrypt, reproducing `encryptGCM(p, k, tag)` byte-for-byte:
/// a fresh 12-byte random IV, a 16-byte authentication tag, and the output
/// string laid out as `"<tag>:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>"`.
///
/// `tag` is the format prefix (`"gs"` for scrypt-keyed, `"gcm"` for legacy-keyed);
/// the caller supplies the matching key. The tag prefix / format dispatch across
/// the four on-disk formats is layered on top in task 3.4, so this function is
/// confined to producing the exact inner byte layout Electron writes.
pub fn encrypt_gcm(plaintext: &str, key: &[u8; KEY_LEN], tag: &str) -> Result<String, String> {
    // 12-byte random IV, matching Node's `crypto.randomBytes(12)`.
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut iv).map_err(|e| format!("IV generation failed: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("GCM key setup failed: {e}"))?;
    let nonce = Nonce::from_slice(&iv);

    // GCM produces ciphertext plus a detached 16-byte auth tag; Node stores them
    // as separate base64 fields (iv:tag:ciphertext), so we keep the tag detached.
    let mut buffer = plaintext.as_bytes().to_vec();
    let auth_tag = cipher
        .encrypt_in_place_detached(nonce, b"", &mut buffer)
        .map_err(|e| format!("GCM encryption failed: {e}"))?;

    Ok(format!(
        "{tag}:{}:{}:{}",
        STANDARD.encode(iv),
        STANDARD.encode(auth_tag.as_slice()),
        STANDARD.encode(&buffer),
    ))
}

/// AES-256-GCM decrypt, the inverse of [`encrypt_gcm`] and the equivalent of
/// `decryptGCM(ct, k, tag)`: strip the `<tag>:` prefix, split on `':'` into
/// `iv`, `authTag`, `ciphertext` (base64), then authenticate-and-decrypt.
/// Returns `Err` on a malformed layout, bad base64, wrong IV/tag length, or a
/// failed authentication check, rather than panicking.
pub fn decrypt_gcm(ciphertext: &str, key: &[u8; KEY_LEN], tag: &str) -> Result<String, String> {
    let prefix = format!("{tag}:");
    let body = ciphertext.strip_prefix(&prefix).unwrap_or(ciphertext);
    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() < 3 {
        return Err("decrypt_gcm: malformed value (expected iv:tag:ciphertext)".to_string());
    }

    let iv = STANDARD
        .decode(parts[0])
        .map_err(|e| format!("decrypt_gcm: IV base64 decode failed: {e}"))?;
    let auth_tag = STANDARD
        .decode(parts[1])
        .map_err(|e| format!("decrypt_gcm: auth tag base64 decode failed: {e}"))?;
    let data = STANDARD
        .decode(parts[2])
        .map_err(|e| format!("decrypt_gcm: ciphertext base64 decode failed: {e}"))?;

    if iv.len() != 12 {
        return Err(format!("decrypt_gcm: IV must be 12 bytes, got {}", iv.len()));
    }
    if auth_tag.len() != 16 {
        return Err(format!(
            "decrypt_gcm: auth tag must be 16 bytes, got {}",
            auth_tag.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("GCM key setup failed: {e}"))?;
    let nonce = Nonce::from_slice(&iv);
    let tag_arr = Tag::from_slice(&auth_tag);

    let mut buffer = data;
    cipher
        .decrypt_in_place_detached(nonce, b"", &mut buffer, tag_arr)
        .map_err(|_| "decrypt_gcm: authentication failed (wrong key or corrupt data)".to_string())?;

    String::from_utf8(buffer).map_err(|e| format!("decrypt_gcm: plaintext is not valid UTF-8: {e}"))
}

/// Legacy AES-256-CBC decrypt (read-only; never written), the equivalent of
/// `decryptCBC(ct, k)`: strip the `cbc:` prefix, split on `':'` into `iv` and
/// `ciphertext` (base64), then decrypt with PKCS#7 padding (Node's default for
/// `createDecipheriv('aes-256-cbc', ...)`). Returns `Err` on a malformed layout,
/// bad base64, wrong IV length, or a padding/decrypt failure, rather than
/// panicking. Kept so existing `cbc:` values decrypt and migrate forward.
pub fn decrypt_cbc(ciphertext: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let body = ciphertext.strip_prefix("cbc:").unwrap_or(ciphertext);
    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() < 2 {
        return Err("decrypt_cbc: malformed value (expected iv:ciphertext)".to_string());
    }

    let iv = STANDARD
        .decode(parts[0])
        .map_err(|e| format!("decrypt_cbc: IV base64 decode failed: {e}"))?;
    let data = STANDARD
        .decode(parts[1])
        .map_err(|e| format!("decrypt_cbc: ciphertext base64 decode failed: {e}"))?;

    if iv.len() != 16 {
        return Err(format!("decrypt_cbc: IV must be 16 bytes, got {}", iv.len()));
    }

    let decryptor = Aes256CbcDec::new_from_slices(key, &iv)
        .map_err(|e| format!("decrypt_cbc: cipher init failed: {e}"))?;
    let plaintext = decryptor
        .decrypt_padded_vec_mut::<Pkcs7>(&data)
        .map_err(|_| "decrypt_cbc: decryption/padding failed (wrong key or corrupt data)".to_string())?;

    String::from_utf8(plaintext)
        .map_err(|e| format!("decrypt_cbc: plaintext is not valid UTF-8: {e}"))
}

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

/// Encrypt raw bytes with Windows DPAPI (current-user scope, no entropy),
/// producing the raw DPAPI blob — the byte-for-byte equivalent of Electron's
/// `safeStorage.encryptString(p)` return value (before its base64/`safe:`
/// wrapping). Returns `Err` with a descriptive message on any FFI failure.
#[cfg(windows)]
pub fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    // SAFETY: `in_blob` borrows `plaintext` for the duration of the call only;
    // DPAPI does not retain the pointer. `out_blob` is populated by DPAPI with a
    // buffer it allocates with `LocalAlloc`, which we copy out of and free with
    // `LocalFree` before returning (never handing the raw pointer to the caller).
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();

        CryptProtectData(
            &in_blob,
            PCWSTR::null(), // szDataDescr: none, matching safeStorage
            None,           // pOptionalEntropy: none, matching safeStorage
            None,           // pvReserved
            None,           // pPromptStruct: no UI
            0,              // dwFlags: none, matching safeStorage
            &mut out_blob,
        )
        .map_err(|e| format!("CryptProtectData failed: {e}"))?;

        Ok(take_and_free_blob(&out_blob))
    }
}

/// Decrypt a raw DPAPI blob produced by [`dpapi_protect`] (or by Electron's
/// `safeStorage.encryptString`) back to the original bytes — the equivalent of
/// `safeStorage.decryptString`. Returns `Err` with a descriptive message on any
/// FFI failure (e.g. the blob was produced under a different user account).
#[cfg(windows)]
pub fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    // SAFETY: same contract as `dpapi_protect`: the input blob is borrowed for
    // the call only, and DPAPI's output buffer is copied out and `LocalFree`d.
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();

        CryptUnprotectData(
            &in_blob,
            None, // ppszDataDescr: don't retrieve the description
            None, // pOptionalEntropy: none, matching safeStorage
            None, // pvReserved
            None, // pPromptStruct: no UI
            0,    // dwFlags: none, matching safeStorage
            &mut out_blob,
        )
        .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;

        Ok(take_and_free_blob(&out_blob))
    }
}

/// Copy a DPAPI-populated output blob into an owned `Vec<u8>` and release the
/// buffer DPAPI allocated with `LocalFree`. Handles the empty-blob case (null
/// pointer / zero length) without constructing a slice from a null pointer.
#[cfg(windows)]
unsafe fn take_and_free_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let out = if blob.pbData.is_null() || blob.cbData == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
    };
    if !blob.pbData.is_null() {
        // DPAPI allocates the output buffer with LocalAlloc; the caller must
        // free it with LocalFree. A non-null return here would indicate failure,
        // but there is no meaningful recovery, so we intentionally ignore it.
        let _ = LocalFree(HLOCAL(blob.pbData as *mut core::ffi::c_void));
    }
    out
}

// DPAPI is a Windows-only API (Requirement 8.1: the app is Windows-only). On any
// other target these stubs keep the crate compiling for tooling/CI while making
// the unavailability explicit rather than silently succeeding.
#[cfg(not(windows))]
pub fn dpapi_protect(_plaintext: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI (safe: encryption) is only available on Windows".to_string())
}

#[cfg(not(windows))]
pub fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI (safe: decryption) is only available on Windows".to_string())
}

// ── Passphrase verifier + per-boot key session ───────────────────────────────
//
// This section ports `main.js`'s per-boot key session (`_sessionPass`,
// `_cachedKey`, `_cachedLegacyKey`, `VERIFY_TOKEN`, `bootId`, `makeVerifier`,
// `verifyPass`, `initEncryption`, `getEncryptionKey`, `getLegacyKey`,
// `invalidateKeyCache`).
//
// Passphrase mode stores only a *verifier* in `settings.json` (never a usable
// key): `keyVerifier = encryptGCM(VERIFY_TOKEN, scryptKey(pass), 'gs')`. To check
// a passphrase, derive its scrypt key, decrypt the verifier, and confirm the
// plaintext equals `VERIFY_TOKEN`. The unlocked passphrase is held in memory for
// the current process/boot and its two derived keys are cached lazily.
//
// Layering note: in `main.js` these functions read `loadSettings()` directly for
// `keyVerifier`, `passphraseMode()`, and the machine-bound `getOrCreateDeviceKey()`.
// Here `encryption.rs` sits *below* `settings.rs` in the module dependency graph
// (`SET --> ENC`), so it must not call into the settings store. Instead the
// settings-derived inputs are passed in as parameters: [`verify_pass`] takes the
// stored `verifier` string, and [`get_encryption_key`]/[`get_legacy_key`] take
// the caller's already-resolved `passphrase_mode` flag and machine-bound
// `device_key`. This inverts the dependency without changing the caching or
// accept/reject semantics the Electron_Build exhibits.

/// The fixed plaintext sealed under the passphrase key to form the stored
/// verifier, carried over verbatim from `main.js`'s
/// `const VERIFY_TOKEN = 'robloxaccountmanager-verify-v1'`. A passphrase is accepted iff
/// decrypting the stored `keyVerifier` with its derived key yields this exact
/// token.
pub const VERIFY_TOKEN: &str = "robloxaccountmanager-verify-v1";

/// The in-memory per-boot key session — the Rust equivalent of `main.js`'s
/// module-level `_sessionPass` / `_cachedKey` / `_cachedLegacyKey`, plus the
/// `boot_id` the cached passphrase belongs to so a stale pass from a previous
/// boot is never reused (the design's "per-boot session cache tied to
/// `bootId()`").
struct KeySession {
    /// The boot this cached `session_pass` was captured during (see [`boot_id`]).
    boot_id: i64,
    /// The unlocked passphrase for this boot, or `None` when locked / machine-bound.
    session_pass: Option<String>,
    /// Lazily-derived current-format (scrypt / `gs:`) key cache (`_cachedKey`).
    cached_key: Option<[u8; KEY_LEN]>,
    /// Lazily-derived legacy (PBKDF2 / `gcm:`/`cbc:`) key cache (`_cachedLegacyKey`).
    cached_legacy_key: Option<[u8; KEY_LEN]>,
}

/// Process-wide key session. `Mutex::new` is `const`, so this initializes to the
/// locked state with no cached keys, matching `main.js`'s initial
/// `_sessionPass = null` / `_cachedKey = null` / `_cachedLegacyKey = null`.
static KEY_SESSION: Mutex<KeySession> = Mutex::new(KeySession {
    boot_id: 0,
    session_pass: None,
    cached_key: None,
    cached_legacy_key: None,
});

/// Lock the key session, recovering the guard even if a previous holder panicked
/// (a poisoned lock still holds valid data for our purposes; we never leave the
/// session in a half-updated state under a panic because each mutation is a small
/// straight-line sequence).
fn session() -> std::sync::MutexGuard<'static, KeySession> {
    KEY_SESSION.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Compute the boot identity, reproducing `main.js`'s
/// `bootId() { return Math.round(Date.now() / 1000 - os.uptime()); }`.
///
/// `os.uptime()` is seconds since boot; on Windows the equivalent is
/// `GetTickCount64()` (milliseconds since boot). Both `Date.now()/1000` and the
/// uptime share the same `/1000` scale, so the difference is
/// `(now_ms - tick_ms) / 1000` rounded to the nearest integer — the approximate
/// epoch-second timestamp of the last boot, which stays constant for the whole
/// boot session and changes after a reboot. This lets a cached unlocked
/// passphrase survive app restarts but be discarded across reboots.
#[cfg(windows)]
pub fn boot_id() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Win32::System::SystemInformation::GetTickCount64;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0);
    // SAFETY: `GetTickCount64` takes no arguments, reads a global counter, and
    // cannot fail or produce undefined behavior.
    let tick_ms = unsafe { GetTickCount64() } as i128;
    (((now_ms - tick_ms) as f64) / 1000.0).round() as i64
}

/// Non-Windows stub for [`boot_id`]. RobloxAccountManager is Windows-only (Requirement
/// 8.1); this stub exists only so the crate compiles for tooling/CI on other
/// targets. Without a portable uptime source it treats uptime as zero, so the
/// returned value is *not* a stable per-boot identity off Windows — acceptable
/// because the passphrase/session paths are exercised only on Windows.
#[cfg(not(windows))]
pub fn boot_id() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_millis() as f64 / 1000.0).round() as i64)
        .unwrap_or(0)
}

/// Build the stored passphrase verifier, mirroring
/// `makeVerifier(pass) { return encryptGCM(VERIFY_TOKEN, deriveScryptKey(pass), 'gs'); }`.
/// The result is a `gs:`-tagged AES-256-GCM blob sealing [`VERIFY_TOKEN`] under
/// the scrypt-derived key; it is what gets stored as `settings.keyVerifier`.
/// Returns `Err` (rather than panicking) if key derivation or encryption fails.
pub fn make_verifier(passphrase: &str) -> Result<String, String> {
    let key = derive_scrypt_key(passphrase)?;
    encrypt_gcm(VERIFY_TOKEN, &key, "gs")
}

/// Check a passphrase against a stored verifier, mirroring `verifyPass`:
/// `!!v && decryptGCM(v, deriveScryptKey(pass), 'gs') === VERIFY_TOKEN`.
///
/// Returns `true` iff `verifier` is a `gs:` blob that decrypts under the
/// passphrase's scrypt key to exactly [`VERIFY_TOKEN`]; every failure mode (empty
/// verifier, wrong passphrase, malformed/garbage blob, derivation failure) yields
/// `false`, exactly like the Electron_Build's `try { ... } catch { return false }`.
///
/// This function is a pure read: it never touches [`KEY_SESSION`], so a rejected
/// (or accepted) passphrase check performs no partial mutation of cached state
/// (Requirement 3.3 / Property 11).
pub fn verify_pass(passphrase: &str, verifier: &str) -> bool {
    if verifier.is_empty() {
        return false;
    }
    match derive_scrypt_key(passphrase) {
        Ok(key) => matches!(decrypt_gcm(verifier, &key, "gs"), Ok(token) if token == VERIFY_TOKEN),
        Err(_) => false,
    }
}

/// Initialize the per-boot key session at startup, mirroring the session-restore
/// half of `main.js`'s `initEncryption()`.
///
/// It records the current [`boot_id`] and discards any cached passphrase that
/// belongs to a *different* boot (so a stale session never leaks across a
/// reboot), leaving the derived-key caches cleared. In the Electron_Build the
/// session cache is file-backed but currently disabled (`readSessionKey()`
/// returns `null`), so there is nothing to silently restore and the session
/// starts locked; the format-migration half of `initEncryption` (rewriting a
/// legacy `customKeyEnc`/`customKey` into a `keyVerifier`) depends on the
/// settings store and DPAPI and is therefore performed by the higher-level
/// startup wiring, not here.
pub fn init_encryption() {
    let current = boot_id();
    let mut s = session();
    if s.session_pass.is_some() && s.boot_id != current {
        s.session_pass = None;
    }
    s.boot_id = current;
    s.cached_key = None;
    s.cached_legacy_key = None;
}

/// Record an unlocked passphrase for this boot, mirroring the
/// `_sessionPass = pass; invalidateKeyCache();` step performed by the Electron
/// `enc:unlock` / `enc:setKey` handlers after a successful verify. The derived-key
/// caches are cleared so the next [`get_encryption_key`]/[`get_legacy_key`]
/// re-derives under the new passphrase. Callers must verify the passphrase
/// (via [`verify_pass`]) before calling this.
pub fn set_session_pass(passphrase: &str) {
    let current = boot_id();
    let mut s = session();
    s.session_pass = Some(passphrase.to_string());
    s.boot_id = current;
    s.cached_key = None;
    s.cached_legacy_key = None;
}

/// Clear the unlocked passphrase and both derived-key caches, mirroring the
/// `_sessionPass = null; invalidateKeyCache();` path taken when a passphrase is
/// cleared / the session is locked.
pub fn clear_session_pass() {
    let mut s = session();
    s.session_pass = None;
    s.cached_key = None;
    s.cached_legacy_key = None;
}

/// Return the currently unlocked passphrase for this boot, if any — the
/// equivalent of `main.js`'s `getStoredPassphrase()` (`return _sessionPass;`).
pub fn session_pass() -> Option<String> {
    session().session_pass.clone()
}

/// Clear only the two derived-key caches, mirroring `main.js`'s
/// `invalidateKeyCache() { _cachedKey = null; _cachedLegacyKey = null; }`.
///
/// Crucially this does **not** clear `session_pass`: after invalidation an
/// unlocked session stays unlocked and simply re-derives its key on the next
/// access, exactly as the Electron_Build behaves.
pub fn invalidate_key_cache() {
    let mut s = session();
    s.cached_key = None;
    s.cached_legacy_key = None;
}

/// Resolve the primary (current-format, scrypt / `gs:`) encryption key, mirroring
/// `getEncryptionKey()`:
///
/// 1. return the cached key if present (`_cachedKey`);
/// 2. otherwise, if a passphrase is unlocked, derive + cache its scrypt key;
/// 3. otherwise, if not in passphrase mode, cache + return the machine-bound
///    `device_key` (the `getOrCreateDeviceKey()` branch, whose value the caller
///    supplies since it lives in the settings store);
/// 4. otherwise return `Ok(None)` — locked.
///
/// `passphrase_mode` and `device_key` are the settings-derived inputs the caller
/// resolves (see the module layering note). Returns `Err` only if scrypt
/// derivation itself fails.
pub fn get_encryption_key(
    passphrase_mode: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Result<Option<[u8; KEY_LEN]>, String> {
    let mut s = session();
    if let Some(k) = s.cached_key {
        return Ok(Some(k));
    }
    if let Some(pass) = s.session_pass.clone() {
        let k = derive_scrypt_key(&pass)?;
        s.cached_key = Some(k);
        return Ok(Some(k));
    }
    if !passphrase_mode {
        if let Some(dk) = device_key {
            s.cached_key = Some(dk);
            return Ok(Some(dk));
        }
    }
    Ok(None) // locked
}

/// Resolve the legacy (PBKDF2-HMAC-SHA512, `gcm:`/`cbc:`) key, mirroring
/// `getLegacyKey()` with the same three-branch precedence as
/// [`get_encryption_key`] but using [`derive_legacy_key`] for the passphrase
/// branch. Derived lazily only when an old `gcm:`/`cbc:` record is read. Legacy
/// key derivation is infallible, so this returns `Option` rather than `Result`;
/// `None` means locked.
pub fn get_legacy_key(
    passphrase_mode: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Option<[u8; KEY_LEN]> {
    let mut s = session();
    if let Some(k) = s.cached_legacy_key {
        return Some(k);
    }
    if let Some(pass) = s.session_pass.clone() {
        let k = derive_legacy_key(&pass);
        s.cached_legacy_key = Some(k);
        return Some(k);
    }
    if !passphrase_mode {
        if let Some(dk) = device_key {
            s.cached_legacy_key = Some(dk);
            return Some(dk);
        }
    }
    None // locked
}

// ── Tag dispatch, field encryption, account encryption ───────────────────────
//
// This section ports `main.js`'s `isEncrypted`, `encryptField`, `decryptField`,
// `encryptAccount`, and `decryptAccount`. Two structural differences from
// `main.js`, both forced by the module layering (`SET --> ENC`: `encryption.rs`
// sits *below* `settings.rs` and must not read the settings store):
//
//   1. The settings-derived inputs `encryptField`/`decryptField` read directly in
//      `main.js` — `passphraseMode()`, `safeStorageReady()`, and the machine-bound
//      device key (`getOrCreateDeviceKey()`) — are threaded in here as the
//      `passphrase_mode`, `safe_storage_ready`, and `device_key` parameters,
//      exactly as [`get_encryption_key`] already does. The unlocked passphrase is
//      still read from the process-wide [`KEY_SESSION`] via [`session_pass`].
//
//   2. `main.js`'s `decryptField` swallows every failure into `null`
//      (`try { ... } catch { return null }`). The migration must instead *surface*
//      an identifying error for a value it cannot decrypt (Requirement 11.4/11.7),
//      so [`decrypt_field`] returns `Result<Option<String>, String>`: `Ok(None)`
//      mirrors the `null`-for-empty / `safe:`-unavailable cases that are not
//      failures, `Ok(Some(_))` is a decrypted (or passed-through) value, and
//      `Err(_)` is a hard decryption failure carrying its cause. The tag-dispatch
//      table itself is reproduced exactly.

/// Format-tag test, mirroring `main.js`'s
/// `isEncrypted(v) = typeof v === 'string' && (v.startsWith('safe:') || ... )`.
/// Returns `true` iff `value` carries one of the four on-disk format tags.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with("safe:")
        || value.starts_with("gs:")
        || value.starts_with("gcm:")
        || value.starts_with("cbc:")
}

/// Encrypt a single field to the CURRENT write format, mirroring `encryptField`:
///
/// ```text
/// if (_sessionPass) return encryptGCM(p, getEncryptionKey(), 'gs'); // unlocked passphrase
/// if (passphraseMode()) throw new Error('locked');                  // never write with the wrong key
/// if (safeStorageReady()) return 'safe:' + safeStorage.encryptString(p).toString('base64');
/// return encryptGCM(p, getEncryptionKey(), 'gs');                   // machine-bound, no keychain
/// ```
///
/// The write-format selection is therefore, in order:
///   1. unlocked passphrase (`session_pass()` is `Some`) -> `gs:` (scrypt key);
///   2. otherwise passphrase mode but locked -> `Err("locked")` (never write with a
///      key that cannot be verified);
///   3. otherwise `safe_storage_ready` -> `safe:` + base64 of the raw DPAPI blob,
///      byte-for-byte matching Electron's
///      `'safe:' + safeStorage.encryptString(p).toString('base64')`;
///   4. otherwise machine-bound `gs:` (scrypt key resolved from `device_key`).
///
/// After producing the value, this performs the decrypt-verification pass
/// required by Requirement 11.5 / Property 20: it immediately [`decrypt_field`]s
/// the freshly-encrypted value and confirms it reproduces the original
/// `plaintext`. On any mismatch it returns `Err` (discarding the value) so the
/// caller never persists an unverifiable secret and keeps the prior on-disk
/// value instead. `passphrase_mode`, `safe_storage_ready`, and `device_key` are
/// the settings-derived inputs the caller resolves (see the module layering note).
pub fn encrypt_field(
    plaintext: &str,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Result<String, String> {
    // Produce the write-format value (see the four-branch order documented
    // above). The locked branch returns `Err("locked")` straight from the
    // encrypt closure, which `verify_before_persist` propagates verbatim before
    // any verification is attempted — matching the prior early `return`.
    let encrypt = || -> Result<String, String> {
        if session_pass().is_some() {
            // 1. Unlocked passphrase: current-format scrypt-keyed GCM.
            let key = get_encryption_key(passphrase_mode, device_key)?
                .ok_or_else(|| "locked".to_string())?;
            encrypt_gcm(plaintext, &key, "gs")
        } else if passphrase_mode {
            // 2. Passphrase set but locked: refuse to write with the wrong key.
            Err("locked".to_string())
        } else if safe_storage_ready {
            // 3. Machine-bound, OS keychain (DPAPI) available: `safe:` + base64.
            let blob = dpapi_protect(plaintext.as_bytes())?;
            Ok(format!("safe:{}", STANDARD.encode(&blob)))
        } else {
            // 4. Machine-bound, no keychain: device-key-derived scrypt GCM.
            let key = get_encryption_key(passphrase_mode, device_key)?
                .ok_or_else(|| "locked".to_string())?;
            encrypt_gcm(plaintext, &key, "gs")
        }
    };

    // Verify-before-persist (Requirement 11.5 / Property 20): delegate to the
    // shared helper, which re-decrypts the freshly-produced value under the same
    // inputs used to read it back and returns the value only if the round-trip
    // reproduces the original plaintext exactly; on any divergence it returns
    // Err (discarding the value) so the caller keeps the prior on-disk value.
    verify_before_persist(plaintext, encrypt, |value| {
        decrypt_field(value, passphrase_mode, safe_storage_ready, device_key)
    })
}

/// Enforce the verify-before-persist invariant (Requirement 11.5 / Property 20)
/// shared by every [`encrypt_field`] write path: produce a value with `encrypt`,
/// immediately re-decrypt it with `decrypt`, and return the value **only** when
/// the round-trip reproduces the original `plaintext` exactly. On ANY divergence
/// — a decrypt that yields a different value, an empty/unavailable decrypt
/// (`Ok(None)`), or a decrypt error — it returns `Err` and yields no value, so a
/// caller never persists a secret it could not itself read back. An `encrypt`
/// failure (e.g. a locked session) is propagated verbatim, before verification.
///
/// This is factored out of [`encrypt_field`] (whose behavior is unchanged) so
/// the property test can drive the invariant across arbitrary faithful/faulty
/// decrypt closures without having to force a real cryptographic round-trip to
/// fail.
fn verify_before_persist<E, D>(plaintext: &str, encrypt: E, decrypt: D) -> Result<String, String>
where
    E: FnOnce() -> Result<String, String>,
    D: FnOnce(&str) -> Result<Option<String>, String>,
{
    let value = encrypt()?;
    match decrypt(&value) {
        Ok(Some(round_trip)) if round_trip == plaintext => Ok(value),
        Ok(Some(_)) => Err(
            "encryption verification failed: re-decrypting the new value did not \
             reproduce the original; discarding the write"
                .to_string(),
        ),
        Ok(None) => Err(
            "encryption verification failed: the new value could not be re-decrypted \
             (empty/unavailable); discarding the write"
                .to_string(),
        ),
        Err(e) => Err(format!(
            "encryption verification failed: re-decrypt errored ({e}); discarding the write"
        )),
    }
}

/// Decrypt a single field, dispatching on the format tag, mirroring
/// `decryptField`'s tag table exactly:
///
/// | prefix   | primitive                                    |
/// |----------|----------------------------------------------|
/// | `safe:`  | base64-decode, then DPAPI [`dpapi_unprotect`] |
/// | `gs:`    | [`decrypt_gcm`] under the scrypt key         |
/// | `gcm:`   | [`decrypt_gcm`] under the legacy key         |
/// | `cbc:`   | [`decrypt_cbc`] under the legacy key         |
/// | (none)   | passed through unchanged                     |
///
/// Return mapping (see the module layering note for why this returns a `Result`
/// where `main.js` returns `null`):
///   * empty input -> `Ok(None)` (mirrors `if (!ct) return null`);
///   * `safe:` when `safe_storage_ready` is false -> `Ok(None)` (mirrors the
///     `if (!safeStorageReady()) return null` guard);
///   * a value with no recognized tag -> `Ok(Some(value))` (mirrors `return ct`);
///   * a successful decrypt -> `Ok(Some(plaintext))`;
///   * a locked session or any decrypt/parse failure -> `Err(_)` carrying the
///     cause (where `main.js` would have caught and returned `null`).
///
/// `passphrase_mode` and `device_key` are the settings-derived inputs used to
/// resolve the scrypt / legacy keys (locked -> `Err`).
pub fn decrypt_field(
    ciphertext: &str,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Result<Option<String>, String> {
    if ciphertext.is_empty() {
        return Ok(None);
    }

    if let Some(rest) = ciphertext.strip_prefix("safe:") {
        if !safe_storage_ready {
            return Ok(None);
        }
        let blob = STANDARD
            .decode(rest)
            .map_err(|e| format!("decrypt_field: safe: base64 decode failed: {e}"))?;
        let bytes = dpapi_unprotect(&blob)?;
        let plain = String::from_utf8(bytes)
            .map_err(|e| format!("decrypt_field: safe: plaintext is not valid UTF-8: {e}"))?;
        return Ok(Some(plain));
    }

    if ciphertext.starts_with("gs:") {
        let key = get_encryption_key(passphrase_mode, device_key)?
            .ok_or_else(|| "decrypt_field: locked (no key available for gs:)".to_string())?;
        return decrypt_gcm(ciphertext, &key, "gs").map(Some);
    }

    if ciphertext.starts_with("gcm:") {
        let key = get_legacy_key(passphrase_mode, device_key)
            .ok_or_else(|| "decrypt_field: locked (no key available for gcm:)".to_string())?;
        return decrypt_gcm(ciphertext, &key, "gcm").map(Some);
    }

    if ciphertext.starts_with("cbc:") {
        let key = get_legacy_key(passphrase_mode, device_key)
            .ok_or_else(|| "decrypt_field: locked (no key available for cbc:)".to_string())?;
        return decrypt_cbc(ciphertext, &key).map(Some);
    }

    // No recognized tag: pass through unchanged (mirrors `return ct`).
    Ok(Some(ciphertext.to_string()))
}

/// Encrypt an [`Account`] for persistence, mirroring `encryptAccount`:
///
/// ```text
/// const o = { ...a };
/// if (o.cookie && !isEncrypted(o.cookie)) o.cookie = encryptField(o.cookie);
/// applyAccountDonutDefaults(o);
/// o._enc = true;
/// return o;
/// ```
///
/// The cookie is encrypted only when it is non-empty AND not already encrypted
/// (idempotent — a re-save of an already-encrypted account leaves the ciphertext
/// untouched). `donut_profile_id` / `donut_profile_pending_delete` are left as
/// they are (stored unencrypted, like `id`/`username`); the `Account` struct
/// already carries their defaults, so the `applyAccountDonutDefaults` step is a
/// no-op at the type level. The `_enc = true` marker the Electron_Build writes is
/// reproduced in the `extra` catch-all so the on-disk JSON shape matches.
///
/// The `encrypt_field` call includes the verify-before-persist pass, so an
/// `Err` here means the freshly-encrypted cookie failed its own re-decrypt check
/// (or the store is locked); the caller must discard the write and keep the prior
/// on-disk account value (Requirement 11.5).
pub fn encrypt_account(
    account: &crate::models::Account,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Result<crate::models::Account, String> {
    let mut o = account.clone();
    if !o.cookie.is_empty() && !is_encrypted(&o.cookie) {
        o.cookie = encrypt_field(&o.cookie, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| format!("account '{}' ({}): {}", o.id, o.nickname, e))?;
    }
    // Mirror `o._enc = true;` so the persisted JSON keeps the Electron marker.
    o.extra
        .insert("_enc".to_string(), serde_json::Value::Bool(true));
    Ok(o)
}

/// Decrypt an [`Account`] read from disk, mirroring `decryptAccount`:
///
/// ```text
/// const o = { ...a };
/// if (o.cookie) o.cookie = decryptField(o.cookie) ?? '';
/// applyAccountDonutDefaults(o);
/// return o;
/// ```
///
/// The cookie is decrypted only when non-empty. `main.js` coalesces a failed
/// decrypt to `''` (`?? ''`) and relies on its callers to detect the failure by
/// noticing a previously non-empty cookie is now empty. The migration surfaces
/// that condition directly: a non-empty cookie that does not decrypt yields an
/// `Err` identifying the affected account, so a caller (the Account_Store load in
/// a later task) can leave that entry's stored ciphertext unmodified and report
/// the error rather than silently blanking it (Requirement 11.4). A successfully
/// decrypting account is returned with its plaintext cookie.
pub fn decrypt_account(
    account: &crate::models::Account,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; KEY_LEN]>,
) -> Result<crate::models::Account, String> {
    let mut o = account.clone();
    if !o.cookie.is_empty() {
        match decrypt_field(&o.cookie, passphrase_mode, safe_storage_ready, device_key) {
            Ok(Some(plain)) => o.cookie = plain,
            Ok(None) => {
                return Err(format!(
                    "account '{}' ({}): stored cookie could not be decrypted \
                     (empty result or keychain unavailable)",
                    o.id, o.nickname
                ))
            }
            Err(e) => {
                return Err(format!("account '{}' ({}): {}", o.id, o.nickname, e))
            }
        }
    }
    Ok(o)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trips_plaintext() {
        let plaintext = b"robloxaccountmanager-.ROBLOSECURITY-cookie-sample";
        let blob = dpapi_protect(plaintext).expect("protect should succeed");
        // The DPAPI blob must not equal the plaintext (it is actually encrypted).
        assert_ne!(blob.as_slice(), plaintext.as_slice());
        let recovered = dpapi_unprotect(&blob).expect("unprotect should succeed");
        assert_eq!(recovered.as_slice(), plaintext.as_slice());
    }

    #[test]
    fn dpapi_round_trips_empty_input() {
        let blob = dpapi_protect(b"").expect("protect of empty should succeed");
        let recovered = dpapi_unprotect(&blob).expect("unprotect should succeed");
        assert!(recovered.is_empty());
    }

    #[test]
    fn dpapi_unprotect_rejects_garbage() {
        // A random, non-DPAPI byte string is not a valid blob and must error,
        // not panic.
        let result = dpapi_unprotect(b"not a valid dpapi blob at all");
        assert!(result.is_err());
    }
}

// Cross-platform tests for the passphrase-derived formats (`gs:`, `gcm:`, `cbc:`).
// These have no OS dependency, so they run on any target (unlike the DPAPI tests).
#[cfg(test)]
mod kdf_tests {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    #[test]
    fn scrypt_key_is_deterministic_and_32_bytes() {
        let a = derive_scrypt_key("correct horse battery staple").unwrap();
        let b = derive_scrypt_key("correct horse battery staple").unwrap();
        assert_eq!(a, b, "same passphrase must derive the same key");
        assert_eq!(a.len(), 32);
        let c = derive_scrypt_key("a different passphrase").unwrap();
        assert_ne!(a, c, "different passphrases must derive different keys");
    }

    #[test]
    fn legacy_key_is_deterministic_and_32_bytes() {
        let a = derive_legacy_key("correct horse battery staple");
        let b = derive_legacy_key("correct horse battery staple");
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        // scrypt and PBKDF2 over the same passphrase/salt must differ.
        let s = derive_scrypt_key("correct horse battery staple").unwrap();
        assert_ne!(a, s);
    }

    #[test]
    fn gcm_round_trips_for_gs_tag() {
        let key = derive_scrypt_key("pass-gs").unwrap();
        let secret = "_|WARNING:-DO-NOT-SHARE-THIS.---.ROBLOSECURITY";
        let blob = encrypt_gcm(secret, &key, "gs").unwrap();
        assert!(blob.starts_with("gs:"), "blob must carry the gs: prefix");
        assert_eq!(blob.split(':').count(), 4, "layout is tag:iv:authtag:ciphertext");
        let recovered = decrypt_gcm(&blob, &key, "gs").unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn gcm_round_trips_for_gcm_tag() {
        let key = derive_legacy_key("pass-gcm");
        let secret = "another-cookie-value-123";
        let blob = encrypt_gcm(secret, &key, "gcm").unwrap();
        assert!(blob.starts_with("gcm:"));
        let recovered = decrypt_gcm(&blob, &key, "gcm").unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn gcm_uses_a_fresh_iv_each_call() {
        let key = derive_scrypt_key("pass").unwrap();
        let a = encrypt_gcm("same plaintext", &key, "gs").unwrap();
        let b = encrypt_gcm("same plaintext", &key, "gs").unwrap();
        assert_ne!(a, b, "random IV should make two encryptions of the same input differ");
    }

    #[test]
    fn gcm_wrong_key_fails_authentication() {
        let key = derive_scrypt_key("right").unwrap();
        let wrong = derive_scrypt_key("wrong").unwrap();
        let blob = encrypt_gcm("secret", &key, "gs").unwrap();
        assert!(decrypt_gcm(&blob, &wrong, "gs").is_err());
    }

    #[test]
    fn gcm_empty_plaintext_round_trips() {
        let key = derive_scrypt_key("pass").unwrap();
        let blob = encrypt_gcm("", &key, "gs").unwrap();
        assert_eq!(decrypt_gcm(&blob, &key, "gs").unwrap(), "");
    }

    #[test]
    fn gcm_rejects_malformed_layout() {
        let key = derive_scrypt_key("pass").unwrap();
        assert!(decrypt_gcm("gs:onlyonepart", &key, "gs").is_err());
        assert!(decrypt_gcm("gs:not_base64!:@@@:###", &key, "gs").is_err());
    }

    #[test]
    fn cbc_decrypts_a_node_style_blob() {
        // Reproduce exactly how Node's createCipheriv('aes-256-cbc', k, iv)
        // stores a value: cbc:<base64 iv>:<base64 pkcs7-padded ciphertext>.
        let key = derive_legacy_key("legacy-pass");
        let iv = [7u8; 16];
        let plaintext = b"legacy cbc secret payload";
        let ct = Aes256CbcEnc::new_from_slices(&key, &iv)
            .unwrap()
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext);
        let blob = format!("cbc:{}:{}", STANDARD.encode(iv), STANDARD.encode(&ct));

        let recovered = decrypt_cbc(&blob, &key).unwrap();
        assert_eq!(recovered.as_bytes(), plaintext);
    }

    #[test]
    fn cbc_rejects_malformed_layout() {
        let key = derive_legacy_key("pass");
        assert!(decrypt_cbc("cbc:onlyonepart", &key).is_err());
        // IV of the wrong length must be rejected, not panic.
        let bad = format!("cbc:{}:{}", STANDARD.encode([0u8; 8]), STANDARD.encode([0u8; 16]));
        assert!(decrypt_cbc(&bad, &key).is_err());
    }
}

// Cross-platform tests for the passphrase verifier, boot id, and per-boot key
// session. These exercise the process-wide `KEY_SESSION` static, so they take a
// shared `SESSION_TEST_LOCK` to run one-at-a-time — otherwise parallel tests
// would clobber each other's session state. Each test restores the locked state
// (`clear_session_pass`) at the start so it is self-contained regardless of
// order.
#[cfg(test)]
mod session_tests {
    use super::*;

    /// Serializes the session-state tests, since they mutate the global session.
    static SESSION_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let g = SESSION_TEST_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        clear_session_pass();
        g
    }

    #[test]
    fn verify_token_matches_electron_constant() {
        assert_eq!(VERIFY_TOKEN, "robloxaccountmanager-verify-v1");
    }

    #[test]
    fn make_verifier_produces_gs_blob_accepted_by_verify_pass() {
        let _g = guard();
        let verifier = make_verifier("correct horse battery staple").unwrap();
        assert!(verifier.starts_with("gs:"), "verifier is a gs: GCM blob");
        assert!(verify_pass("correct horse battery staple", &verifier));
    }

    #[test]
    fn verify_pass_accepts_only_the_matching_passphrase() {
        let _g = guard();
        let verifier = make_verifier("the-right-passphrase").unwrap();
        assert!(verify_pass("the-right-passphrase", &verifier));
        assert!(!verify_pass("the-wrong-passphrase", &verifier));
        assert!(!verify_pass("", &verifier));
    }

    #[test]
    fn verify_pass_rejects_empty_or_garbage_verifier() {
        let _g = guard();
        // Empty verifier -> false (mirrors `!!v` short-circuit in verifyPass).
        assert!(!verify_pass("any", ""));
        // Non-gs / malformed / not-base64 blobs must reject, not panic.
        assert!(!verify_pass("any", "not-a-verifier"));
        assert!(!verify_pass("any", "gs:only:two"));
        assert!(!verify_pass("any", "gs:@@@:###:%%%"));
    }

    #[test]
    fn verify_pass_rejects_verifier_sealed_under_a_different_passphrase() {
        let _g = guard();
        let verifier = make_verifier("passphrase-A").unwrap();
        assert!(!verify_pass("passphrase-B", &verifier));
    }

    #[test]
    fn verify_pass_does_not_mutate_session_state() {
        let _g = guard();
        // Start unlocked with a known passphrase and a warmed cache.
        set_session_pass("unlocked-pass");
        let _ = get_encryption_key(true, None).unwrap(); // populate cached_key
        let before = session_pass();

        let verifier = make_verifier("some-other-pass").unwrap();
        // Both an accepting and a rejecting check must leave the session intact
        // (Property 11: no partial mutation on verify, especially on reject).
        let _ = verify_pass("some-other-pass", &verifier); // accept path
        let _ = verify_pass("definitely-wrong", &verifier); // reject path

        assert_eq!(session_pass(), before, "verify_pass must not change session_pass");
        // The previously warmed key cache must still be present and unchanged.
        assert!(get_encryption_key(true, None).unwrap().is_some());
    }

    #[test]
    fn boot_id_is_positive_and_stable_within_a_boot() {
        // boot_id is the approximate epoch-second of the last boot: a large
        // positive number that does not move (beyond rounding) between calls.
        let a = boot_id();
        let b = boot_id();
        assert!(a > 0, "boot id should be a positive epoch-second value");
        assert!((a - b).abs() <= 1, "boot id must be stable across calls (±1 rounding)");
    }

    #[test]
    fn locked_session_yields_no_key() {
        let _g = guard();
        // Passphrase mode + no unlocked pass + no device key = locked.
        assert!(get_encryption_key(true, None).unwrap().is_none());
        assert!(get_legacy_key(true, None).is_none());
    }

    #[test]
    fn unlocked_session_derives_and_caches_scrypt_key() {
        let _g = guard();
        set_session_pass("unlock-me");
        let k1 = get_encryption_key(true, None).unwrap().expect("unlocked -> Some");
        // The cached key must equal a fresh scrypt derivation of the passphrase.
        assert_eq!(k1, derive_scrypt_key("unlock-me").unwrap());
        // Second call returns the cached value (same bytes).
        let k2 = get_encryption_key(true, None).unwrap().expect("cached -> Some");
        assert_eq!(k1, k2);
    }

    #[test]
    fn unlocked_session_uses_legacy_kdf_for_legacy_key() {
        let _g = guard();
        set_session_pass("unlock-me");
        let k = get_legacy_key(true, None).expect("unlocked -> Some");
        assert_eq!(k, derive_legacy_key("unlock-me"));
    }

    #[test]
    fn machine_bound_mode_returns_and_caches_device_key() {
        let _g = guard();
        // Not passphrase mode: getEncryptionKey falls back to the device key.
        let device = [0x5Au8; KEY_LEN];
        let got = get_encryption_key(false, Some(device)).unwrap().expect("device key");
        assert_eq!(got, device);
        // Cached now: a subsequent call with no device key still returns it.
        let cached = get_encryption_key(false, None).unwrap().expect("cached device key");
        assert_eq!(cached, device);

        // Same for the legacy key getter.
        clear_session_pass();
        let gotl = get_legacy_key(false, Some(device)).expect("device legacy key");
        assert_eq!(gotl, device);
    }

    #[test]
    fn invalidate_key_cache_clears_derived_keys_but_keeps_session_pass() {
        let _g = guard();
        set_session_pass("still-unlocked");
        let _ = get_encryption_key(true, None).unwrap();
        let _ = get_legacy_key(true, None);

        invalidate_key_cache();

        // Session stays unlocked (session_pass preserved), matching main.js.
        assert_eq!(session_pass().as_deref(), Some("still-unlocked"));
        // Keys are re-derivable (still returns Some because the pass is present).
        assert!(get_encryption_key(true, None).unwrap().is_some());
        assert!(get_legacy_key(true, None).is_some());
    }

    #[test]
    fn clear_session_pass_locks_the_session() {
        let _g = guard();
        set_session_pass("temp");
        assert!(session_pass().is_some());
        clear_session_pass();
        assert!(session_pass().is_none());
        assert!(get_encryption_key(true, None).unwrap().is_none());
    }

    #[test]
    fn init_encryption_starts_locked_and_records_boot_id() {
        let _g = guard();
        init_encryption();
        // Nothing to silently restore (file cache disabled) -> locked.
        assert!(session_pass().is_none());
        assert!(get_encryption_key(true, None).unwrap().is_none());
    }

    // ── is_encrypted / encrypt_field / decrypt_field / account tests ─────────
    //
    // These live in this module (not a separate one) so they share the
    // `SESSION_TEST_LOCK` guard — they read/mutate the process-wide key session,
    // and running alongside the other session tests without the shared lock would
    // race on that global state.

    /// A minimal `Account` fixture with a plaintext cookie, for the account
    /// encrypt/decrypt tests.
    fn sample_account(cookie: &str) -> crate::models::Account {
        crate::models::Account {
            id: "acc_1".to_string(),
            username: "user".to_string(),
            user_id: "123".to_string(),
            nickname: "Main".to_string(),
            cookie: cookie.to_string(),
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            last_used: None,
            donut_profile_id: None,
            donut_profile_pending_delete: false,
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn is_encrypted_matches_the_four_tags_and_rejects_others() {
        assert!(is_encrypted("safe:abc"));
        assert!(is_encrypted("gs:abc"));
        assert!(is_encrypted("gcm:abc"));
        assert!(is_encrypted("cbc:abc"));
        // Untagged / empty / partial-prefix values are not encrypted.
        assert!(!is_encrypted(""));
        assert!(!is_encrypted("plaintext cookie"));
        assert!(!is_encrypted("safepractice")); // no colon boundary tag
        assert!(!is_encrypted("SAFE:abc")); // case-sensitive, like startsWith
    }

    #[test]
    fn encrypt_field_unlocked_passphrase_writes_gs_and_round_trips() {
        let _g = guard();
        set_session_pass("unlock-me");
        let secret = ".ROBLOSECURITY=SAMPLE_TOKEN_abcdef";
        // passphrase_mode=true, safe not consulted on the unlocked path.
        let value = encrypt_field(secret, true, false, None).unwrap();
        assert!(value.starts_with("gs:"), "unlocked passphrase writes gs:");
        let back = decrypt_field(&value, true, false, None).unwrap();
        assert_eq!(back.as_deref(), Some(secret));
    }

    #[test]
    fn encrypt_field_locked_passphrase_refuses_to_write() {
        let _g = guard();
        // Passphrase mode, session locked (no session pass) -> "locked", never
        // writes with a key it cannot verify (mirrors `throw new Error('locked')`).
        let err = encrypt_field("secret", true, true, None).unwrap_err();
        assert_eq!(err, "locked");
    }

    #[test]
    fn encrypt_field_machine_bound_without_keychain_writes_gs_and_round_trips() {
        let _g = guard();
        // Not passphrase mode, no keychain -> device-key scrypt GCM (`gs:`).
        let device = [0x11u8; KEY_LEN];
        let secret = "machine-bound-secret";
        let value = encrypt_field(secret, false, false, Some(device)).unwrap();
        assert!(value.starts_with("gs:"));
        let back = decrypt_field(&value, false, false, Some(device)).unwrap();
        assert_eq!(back.as_deref(), Some(secret));
    }

    #[cfg(windows)]
    #[test]
    fn encrypt_field_machine_bound_with_keychain_writes_safe_and_round_trips() {
        let _g = guard();
        // Not passphrase mode, keychain available -> `safe:` DPAPI blob.
        let secret = "keychain-secret-value";
        let value = encrypt_field(secret, false, true, None).unwrap();
        assert!(value.starts_with("safe:"), "keychain path writes safe:");
        let back = decrypt_field(&value, false, true, None).unwrap();
        assert_eq!(back.as_deref(), Some(secret));
    }

    #[test]
    fn decrypt_field_passes_through_untagged_and_handles_empty() {
        let _g = guard();
        // No recognized tag -> returned unchanged (mirrors `return ct`).
        assert_eq!(
            decrypt_field("just-a-plain-value", false, false, None).unwrap().as_deref(),
            Some("just-a-plain-value")
        );
        // Empty input -> Ok(None) (mirrors `if (!ct) return null`).
        assert_eq!(decrypt_field("", false, false, None).unwrap(), None);
    }

    #[test]
    fn decrypt_field_safe_without_keychain_is_none() {
        let _g = guard();
        // safe: value but keychain unavailable -> Ok(None) (mirrors the
        // `if (!safeStorageReady()) return null` guard), not an error.
        assert_eq!(
            decrypt_field("safe:AQIDBA==", false, false, None).unwrap(),
            None
        );
    }

    #[test]
    fn decrypt_field_locked_gs_surfaces_error() {
        let _g = guard();
        // Passphrase mode, locked: a gs: value cannot be decrypted -> Err
        // (where main.js would have caught and returned null).
        let err = decrypt_field("gs:AQID:BQY=:Bwg=", true, false, None).unwrap_err();
        assert!(err.contains("locked"), "expected a locked error, got: {err}");
    }

    #[test]
    fn encrypt_account_encrypts_cookie_sets_marker_and_is_idempotent() {
        let _g = guard();
        let device = [0x22u8; KEY_LEN];
        let acct = sample_account("plaintext-cookie");
        let enc = encrypt_account(&acct, false, false, Some(device)).unwrap();
        // Cookie is now encrypted (gs: machine-bound), and the `_enc` marker is set.
        assert!(is_encrypted(&enc.cookie));
        assert_eq!(enc.extra.get("_enc"), Some(&serde_json::Value::Bool(true)));

        // Re-encrypting an already-encrypted account leaves the ciphertext
        // untouched (idempotent — mirrors `!isEncrypted(o.cookie)` guard).
        let enc2 = encrypt_account(&enc, false, false, Some(device)).unwrap();
        assert_eq!(enc2.cookie, enc.cookie);
    }

    #[test]
    fn encrypt_account_leaves_empty_cookie_and_donut_id_untouched() {
        let _g = guard();
        let device = [0x33u8; KEY_LEN];
        let mut acct = sample_account("");
        acct.donut_profile_id = Some("profile-xyz".to_string());
        let enc = encrypt_account(&acct, false, false, Some(device)).unwrap();
        // Empty cookie stays empty (never encrypted), donut id stays plaintext.
        assert_eq!(enc.cookie, "");
        assert_eq!(enc.donut_profile_id.as_deref(), Some("profile-xyz"));
    }

    #[test]
    fn encrypt_then_decrypt_account_round_trips_the_cookie() {
        let _g = guard();
        let device = [0x44u8; KEY_LEN];
        let acct = sample_account("_|WARNING:-.ROBLOSECURITY=ROUNDTRIP");
        let enc = encrypt_account(&acct, false, false, Some(device)).unwrap();
        let dec = decrypt_account(&enc, false, false, Some(device)).unwrap();
        assert_eq!(dec.cookie, "_|WARNING:-.ROBLOSECURITY=ROUNDTRIP");
    }

    #[test]
    fn decrypt_account_surfaces_error_for_undecryptable_cookie() {
        let _g = guard();
        // A gs: cookie that cannot be decrypted while locked must yield an
        // identifying Err (Requirement 11.4), naming the affected account.
        let mut acct = sample_account("gs:AQID:BQY=:Bwg=");
        acct.id = "acc_bad".to_string();
        let err = decrypt_account(&acct, true, false, None).unwrap_err();
        assert!(err.contains("acc_bad"), "error must identify the account: {err}");
    }

    #[test]
    fn set_session_pass_invalidates_previous_cached_key() {
        let _g = guard();
        set_session_pass("first-pass");
        let k_first = get_encryption_key(true, None).unwrap().unwrap();
        // Switching the passphrase must drop the old cached key and derive anew.
        set_session_pass("second-pass");
        let k_second = get_encryption_key(true, None).unwrap().unwrap();
        assert_ne!(k_first, k_second);
        assert_eq!(k_second, derive_scrypt_key("second-pass").unwrap());
    }

    // Feature: electron-to-tauri-migration, Property 11: Passphrase verification accepts exactly the matching passphrase and never partially mutates on reject
    //
    // Validates: Requirements 3.3
    //
    // This test lives in `session_tests` (rather than a standalone module) so it
    // shares `SESSION_TEST_LOCK` with the other session tests — it reads the
    // process-wide `KEY_SESSION` before/after each verify to prove no mutation, so
    // it must not run concurrently with any test that mutates that global state.
    //
    // Performance: scrypt (N=2^16) costs ~10s per derivation in a debug build, and
    // both `make_verifier` and `verify_pass` derive a scrypt key. Paying that per
    // proptest case would blow up (100 cases × ~10s). So the REAL `verify_pass` is
    // run a BOUNDED number of times up front — once per (attempt × verifier) pair
    // over a small fixed candidate set — building a truth table while asserting
    // accept/reject correctness AND no-mutation around each genuine call. The
    // >=100-case proptest loop then randomizes over that table with zero further
    // scrypt cost, and re-checks the global session still matches the baseline.
    #[test]
    fn property_11_verify_pass_accepts_only_matching_and_never_mutates_session() {
        use proptest::prelude::*;
        use std::collections::BTreeMap;

        // Acquire the shared session lock and start from a cleared session.
        let _g = guard();

        // Two correct passphrases, each sealed into its own verifier once.
        let correct = ["passphrase-alpha", "passphrase-bravo"];
        let verifiers: Vec<String> = correct
            .iter()
            .map(|p| make_verifier(p).expect("make_verifier"))
            .collect();
        for v in &verifiers {
            assert!(v.starts_with("gs:"), "verifier must be a gs: GCM blob");
        }

        // Establish a non-trivial unlocked session with a warmed key cache — the
        // exact state we assert `verify_pass` never disturbs. Because `verify_pass`
        // is a pure read it must leave this intact, so it legitimately persists
        // across every real call and every generated case.
        set_session_pass("session-holder-passphrase");
        let _ = get_encryption_key(true, None).unwrap(); // populate cached_key
        let baseline_pass = session_pass();
        let baseline_has_cached_key = session().cached_key.is_some();
        assert_eq!(baseline_pass.as_deref(), Some("session-holder-passphrase"));
        assert!(baseline_has_cached_key, "cache must be warmed before the loop");

        // Fixed attempt candidates: both matching passphrases (accept paths), a
        // non-matching passphrase, and the empty string (reject paths).
        let attempts = ["passphrase-alpha", "passphrase-bravo", "not-the-passphrase", ""];

        // Build the truth table with the real `verify_pass`, one call per pair,
        // asserting the accept-exactly-matching relation and no-partial-mutation on
        // every genuine call (this is where `verify_pass` is actually exercised).
        let mut table: BTreeMap<(usize, usize), bool> = BTreeMap::new();
        for (a, attempt) in attempts.iter().enumerate() {
            for (v, verifier) in verifiers.iter().enumerate() {
                let before_pass = session_pass();
                let before_has_cached_key = session().cached_key.is_some();

                let accepted = verify_pass(attempt, verifier);

                // Accept IFF the attempt is exactly the passphrase that sealed
                // verifier[v]; scrypt is deterministic + collision-resistant, so a
                // matching key (hence acceptance) occurs exactly when strings match.
                assert_eq!(
                    accepted,
                    *attempt == correct[v],
                    "verify_pass accept/reject mismatch for attempt {attempt:?} vs verifier {v}"
                );
                // No-partial-mutation-on-reject (and on accept): the pure-read
                // verify must not touch the unlocked passphrase or the cached key.
                assert_eq!(session_pass(), before_pass, "verify_pass mutated session_pass");
                assert_eq!(
                    session().cached_key.is_some(),
                    before_has_cached_key,
                    "verify_pass mutated the cached key"
                );

                table.insert((a, v), accepted);
            }
        }

        // Randomized coverage: >=100 cases pick an (attempt, verifier) pair, then
        // re-assert the accept-exactly-matching relation over the observed results
        // and confirm the global session STILL equals the pre-test baseline (no
        // accumulated mutation from any verify).
        proptest!(ProptestConfig::with_cases(100), |(
            a in 0usize..attempts.len(),
            v in 0usize..verifiers.len(),
        )| {
            let observed = table[&(a, v)];
            prop_assert_eq!(observed, attempts[a] == correct[v]);
            prop_assert_eq!(session_pass(), baseline_pass.clone());
            prop_assert_eq!(session().cached_key.is_some(), baseline_has_cached_key);
        });
    }
}

// Property-based test for Property 19 (design's Correctness Properties). It
// exercises every supported encrypted-field format across many arbitrary
// plaintexts, confirming each round-trips and that a value only decrypts under
// the key/tag it was sealed with (cross-decryption fails). scrypt (`N=2^16`) is
// expensive, so the two scrypt/legacy key sets are derived ONCE up front and the
// per-case body only performs the cheap AES-GCM/AES-CBC/DPAPI work — keeping the
// >=100 iterations fast.
#[cfg(test)]
mod proptest_encryption {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use proptest::prelude::*;

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    // Feature: electron-to-tauri-migration, Property 19: Every supported encryption format round-trips and cross-decrypts correctly
    //
    // Validates: Requirements 11.3
    #[test]
    fn property_19_every_format_round_trips_and_cross_decrypts() {
        // Derive the key material once (outside the per-case loop) so the 100+
        // proptest cases never pay the scrypt cost. Three distinct passphrases
        // give us distinct keys to cross-decrypt against.
        let passphrases = ["alpha-passphrase", "beta-passphrase", "gamma-passphrase"];
        let scrypt_keys: Vec<[u8; KEY_LEN]> = passphrases
            .iter()
            .map(|p| derive_scrypt_key(p).expect("scrypt derivation"))
            .collect();
        let legacy_keys: Vec<[u8; KEY_LEN]> =
            passphrases.iter().map(|p| derive_legacy_key(p)).collect();

        proptest!(ProptestConfig::with_cases(100), |(
            pt in "(?s).{0,64}",
            i in 0usize..3,
            j in 0usize..3,
        )| {
            let s_key = &scrypt_keys[i];
            let l_key = &legacy_keys[i];

            // gs: scrypt-derived AES-256-GCM must round-trip exactly.
            let gs_blob = encrypt_gcm(&pt, s_key, "gs").unwrap();
            prop_assert!(gs_blob.starts_with("gs:"));
            prop_assert_eq!(decrypt_gcm(&gs_blob, s_key, "gs").unwrap(), pt.clone());

            // gcm: legacy PBKDF2-HMAC-SHA512 AES-256-GCM must round-trip exactly.
            let gcm_blob = encrypt_gcm(&pt, l_key, "gcm").unwrap();
            prop_assert!(gcm_blob.starts_with("gcm:"));
            prop_assert_eq!(decrypt_gcm(&gcm_blob, l_key, "gcm").unwrap(), pt.clone());

            // cbc: read-only format (encrypt is never implemented in the port).
            // Construct a Node-compatible blob in-test — AES-256-CBC + PKCS#7
            // under the legacy key, laid out as cbc:<b64 iv>:<b64 ciphertext> —
            // exactly how the Electron_Build wrote cbc: values, and confirm
            // decrypt_cbc recovers the original plaintext.
            let mut iv = [0u8; 16];
            getrandom::getrandom(&mut iv).unwrap();
            let ct = Aes256CbcEnc::new_from_slices(l_key, &iv)
                .unwrap()
                .encrypt_padded_vec_mut::<Pkcs7>(pt.as_bytes());
            let cbc_blob = format!("cbc:{}:{}", STANDARD.encode(iv), STANDARD.encode(&ct));
            prop_assert_eq!(decrypt_cbc(&cbc_blob, l_key).unwrap(), pt.clone());

            // Cross-decryption: a GCM value sealed under a scrypt key must never
            // decrypt under the *legacy* key of the same passphrase (a different
            // KDF yields different key bytes), so authentication must fail.
            prop_assert!(
                decrypt_gcm(&gs_blob, l_key, "gs").is_err(),
                "scrypt-keyed gs blob must not decrypt under the legacy key"
            );

            // Cross-decryption under a different passphrase's key must fail (or,
            // for CBC where wrong-key decryption can occasionally pass padding,
            // must not recover the original plaintext).
            if i != j {
                prop_assert!(
                    decrypt_gcm(&gs_blob, &scrypt_keys[j], "gs").is_err(),
                    "gs blob must not decrypt under a different scrypt key"
                );
                prop_assert!(
                    decrypt_gcm(&gcm_blob, &legacy_keys[j], "gcm").is_err(),
                    "gcm blob must not decrypt under a different legacy key"
                );
                let cbc_other = decrypt_cbc(&cbc_blob, &legacy_keys[j]);
                prop_assert!(
                    cbc_other.as_deref() != Ok(pt.as_str()),
                    "cbc blob must not recover the original plaintext under a different key"
                );
            }

            // safe: Windows DPAPI round-trip (Windows-only primitive).
            #[cfg(windows)]
            {
                let safe_blob = dpapi_protect(pt.as_bytes()).unwrap();
                let recovered = dpapi_unprotect(&safe_blob).unwrap();
                prop_assert_eq!(recovered.as_slice(), pt.as_bytes());
            }
        });
    }
}

// ── Golden ciphertext fixtures (Task 3.8, Requirement 11.3) ───────────────────
//
// These are GENUINE Electron_Build-format ciphertext blobs, produced by running
// Node's `crypto` with the *exact* salt / iteration count / scrypt parameters /
// key length / digest that `src/main.js` uses (`SALT = 'robloxaccountmanager-v1-salt-2025'`,
// PBKDF2 210_000 iters SHA-512, scrypt N=2^16 r=8 p=1, 32-byte keys), via the
// same `encryptGCM(p, k, tag)` layout (`<tag>:b64(iv):b64(authTag):b64(ct)`) and
// the same `cbc:b64(iv):b64(ct)` layout `decryptCBC` reads. The blobs below were
// captured from that Node script (then the script was deleted) and are pinned
// here as static constants, so these tests prove byte-for-byte cross-decryption:
// the Rust `decrypt_gcm`/`decrypt_cbc` must recover the exact plaintext the
// Electron_Build sealed, for a `gs:`, a `gcm:`, and a `cbc:` value.
//
// The random IV in each blob means these exact bytes are not reproducible, but
// they are still authentic Electron-format ciphertext for a known passphrase and
// known plaintext — which is precisely what a golden fixture needs to be.
//
// `safe:` (DPAPI) has no portable static fixture: a `safe:` blob is bound to the
// Windows user/machine that produced it (`CryptProtectData`), so a blob captured
// on one machine will not decrypt on another and cannot be committed as a stable
// constant. Electron's `safeStorage` on Windows *is* DPAPI with no extra entropy,
// identical to this crate's `dpapi_protect`/`dpapi_unprotect`, so the `safe:`
// cross-compatibility coverage is a `#[cfg(windows)]` round-trip through
// `dpapi_protect` → `dpapi_unprotect` (see `safe_dpapi_round_trip_is_electron_compatible`).
#[cfg(test)]
mod golden_fixture_tests {
    use super::*;

    /// The passphrase the golden `gs:`/`gcm:`/`cbc:` blobs below were sealed under.
    const GOLDEN_PASSPHRASE: &str = "correct horse battery staple";
    /// The plaintext the golden blobs below decrypt to (a realistic .ROBLOSECURITY-
    /// shaped value, including the `:` and `=` characters that exercise the split
    /// logic without breaking it — GCM/CBC ciphertext base64 never contains `:`).
    const GOLDEN_PLAINTEXT: &str =
        "_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you.--.ROBLOSECURITY=SAMPLE_TOKEN_1234567890abcdef";

    /// Genuine Electron_Build `gs:` blob (AES-256-GCM, scrypt-derived key).
    const GOLDEN_GS: &str = "gs:V0Z4XoX+F/I8HYFC:tYI3Pa6MMdoUA26suC8cOQ==:ch2xMD6Ahjj3xLa2XHSOy0S5ml0dCpTx7xSkiiFQN1QvJukFJwGJZIJDjsfEBLoq7iSx3fTzXkrPjA1EccMrMYnEnyGqduktDYwJA80nu0crn6rhcbcA8T+JUQ8r4b10bik5x+qxpcENUv85B+8R6wWRNn23bPaK505ukMth";
    /// Genuine Electron_Build `gcm:` blob (AES-256-GCM, legacy PBKDF2-SHA512 key).
    const GOLDEN_GCM: &str = "gcm:c+8Yd24lAYaPRlO4:NNF3DNPYsuwiUlzb04o+gg==:YuYFtZsCM+1m9krEobmG7AMXOEqEFVmsGaHy8g9x4/kCX3n1hNlcjfssqPwWoRYpzUL5UMgtctrJQdDC2jQgFsxl+Vt0DdsMcV85E/5Ofok5NOIK36+wJ7D7iPSOr4onjk0nLvq6KFwyGADYHg+fVkvkvz4rOkUuqizGSqZa";
    /// Genuine Electron_Build `cbc:` blob (AES-256-CBC, legacy PBKDF2-SHA512 key).
    const GOLDEN_CBC: &str = "cbc:HWC/VU5LQDnnPZwQ8fjQGw==:zeJx5VR77HbymXXZkTG+Xx/9AMJvrRVxMQb65wJ6HIllUNKxGp48WJfKtdKjzV/4SvRdGqz6osSYA+Ht/nL07iQ4WYTHK+MosqHCsWy8TO73z8jLLPvuZ2HmiHSbQHk/3a7XV9aComXtbMD+KDVEzY+2nt2KWijvL3LzGUm6tKw=";

    #[test]
    fn gs_golden_fixture_decrypts_to_known_plaintext() {
        // scrypt-derived key path (`gs:`): the current-format Electron blob must
        // decrypt to the exact plaintext under the same passphrase-derived key.
        let key = derive_scrypt_key(GOLDEN_PASSPHRASE).unwrap();
        let recovered = decrypt_gcm(GOLDEN_GS, &key, "gs")
            .expect("golden gs: blob must decrypt with the scrypt key");
        assert_eq!(recovered, GOLDEN_PLAINTEXT);
    }

    #[test]
    fn gcm_golden_fixture_decrypts_to_known_plaintext() {
        // legacy PBKDF2 key path (`gcm:`): the Electron legacy-format blob must
        // decrypt to the exact plaintext under the PBKDF2-SHA512-derived key.
        let key = derive_legacy_key(GOLDEN_PASSPHRASE);
        let recovered = decrypt_gcm(GOLDEN_GCM, &key, "gcm")
            .expect("golden gcm: blob must decrypt with the legacy key");
        assert_eq!(recovered, GOLDEN_PLAINTEXT);
    }

    #[test]
    fn cbc_golden_fixture_decrypts_to_known_plaintext() {
        // legacy CBC read path (`cbc:`): the Electron legacy-format blob must
        // decrypt to the exact plaintext under the PBKDF2-SHA512-derived key.
        let key = derive_legacy_key(GOLDEN_PASSPHRASE);
        let recovered = decrypt_cbc(GOLDEN_CBC, &key)
            .expect("golden cbc: blob must decrypt with the legacy key");
        assert_eq!(recovered, GOLDEN_PLAINTEXT);
    }

    #[test]
    fn golden_fixtures_reject_the_wrong_key() {
        // Cross-compatibility must be key-specific: the golden blobs must NOT
        // decrypt under a mismatched passphrase-derived key (authentication /
        // padding failure), confirming the fixtures aren't accidentally trivial.
        let wrong_scrypt = derive_scrypt_key("the-wrong-passphrase").unwrap();
        let wrong_legacy = derive_legacy_key("the-wrong-passphrase");
        assert!(decrypt_gcm(GOLDEN_GS, &wrong_scrypt, "gs").is_err());
        assert!(decrypt_gcm(GOLDEN_GCM, &wrong_legacy, "gcm").is_err());
        assert!(decrypt_cbc(GOLDEN_CBC, &wrong_legacy).is_err());
    }

    /// `safe:` coverage. Electron's `safeStorage` on Windows is DPAPI
    /// (`CryptProtectData`, current-user scope, no entropy) — byte-for-byte the
    /// same wire format this crate's `dpapi_protect`/`dpapi_unprotect` produce and
    /// consume. A `safe:` blob is user/machine-bound and therefore cannot be
    /// pinned as a portable static fixture, so the golden coverage for `safe:` is
    /// a round-trip on this machine: protect a known plaintext, then unprotect it
    /// and assert the exact bytes come back — the same operation Electron would
    /// perform against a value it sealed.
    #[cfg(windows)]
    #[test]
    fn safe_dpapi_round_trip_is_electron_compatible() {
        let blob = dpapi_protect(GOLDEN_PLAINTEXT.as_bytes())
            .expect("DPAPI protect (safe:) should succeed on Windows");
        assert_ne!(blob.as_slice(), GOLDEN_PLAINTEXT.as_bytes(), "blob must be encrypted");
        let recovered = dpapi_unprotect(&blob).expect("DPAPI unprotect (safe:) should succeed");
        assert_eq!(recovered.as_slice(), GOLDEN_PLAINTEXT.as_bytes());
    }
}

// Property-based test for Property 20 (design's Correctness Properties). It
// drives the verify-before-persist invariant that `encrypt_field` delegates to
// `verify_before_persist`: a secret write whose post-write re-decrypt fails to
// reproduce the original plaintext must be discarded (Err, no retained value),
// while a faithful re-decrypt yields the produced ciphertext. The seam used to
// inject a verification failure is the `decrypt` closure the helper accepts —
// the same closure `encrypt_field` fills with the real `decrypt_field`, so the
// property exercises the exact production code path.
#[cfg(test)]
mod proptest_verify_before_persist {
    use super::*;
    use proptest::prelude::*;
    use std::cell::RefCell;

    // Feature: electron-to-tauri-migration, Property 20: A secret write that fails its own verification is never retained
    //
    // Validates: Requirements 11.5
    #[test]
    fn property_20_write_failing_verification_is_never_retained() {
        // `fault` selects how the post-write re-decrypt diverges from a faithful
        // round-trip: 0 = returns a *different* plaintext, 1 = returns None
        // (empty/unavailable), 2 = returns an error. `other` supplies the wrong
        // plaintext for the mismatch case (forced unequal to `pt`).
        proptest!(ProptestConfig::with_cases(200), |(
            pt in "(?s).{0,64}",
            other in "(?s).{0,64}",
            fault in 0u8..3,
        )| {
            // The value the (stubbed) encrypt step produces. Its exact bytes are
            // irrelevant to the invariant — only whether it survives verification.
            let cipher = format!("ct::{pt}");

            // A store standing in for the persisted-secret slot. The caller only
            // ever writes it on Ok(value); an Err must leave it untouched. This
            // makes "never retained" observable rather than merely implied by the
            // Result type.
            let store: RefCell<Option<String>> = RefCell::new(None);

            // ── Faithful decrypt: verification succeeds, value is returned and
            // would be persisted, and it re-decrypts back to the original.
            {
                let cipher_ok = cipher.clone();
                let pt_ok = pt.clone();
                let res = verify_before_persist(
                    &pt,
                    move || Ok(cipher_ok.clone()),
                    move |_v: &str| Ok(Some(pt_ok.clone())),
                );
                prop_assert_eq!(res.as_deref(), Ok(cipher.as_str()));
                if let Ok(v) = &res {
                    *store.borrow_mut() = Some(v.clone());
                }
                let persisted = store.borrow().clone();
                prop_assert_eq!(persisted.as_deref(), Some(cipher.as_str()));
            }

            // ── Faulty decrypt: whatever the failure mode, the helper must
            // return Err and yield no value, so nothing new is persisted (the
            // slot keeps whatever the faithful step left — never the unverified
            // write).
            let before = store.borrow().clone();
            let cipher_bad = cipher.clone();
            // Force the wrong-plaintext case to actually differ from `pt`.
            let wrong = if other == pt { format!("{other}#") } else { other.clone() };
            let wrong_for_closure = wrong.clone();

            let res = match fault {
                0 => verify_before_persist(
                    &pt,
                    move || Ok(cipher_bad.clone()),
                    move |_v: &str| Ok(Some(wrong_for_closure.clone())),
                ),
                1 => verify_before_persist(
                    &pt,
                    move || Ok(cipher_bad.clone()),
                    move |_v: &str| Ok(None),
                ),
                _ => verify_before_persist(
                    &pt,
                    move || Ok(cipher_bad.clone()),
                    move |_v: &str| Err("injected re-decrypt failure".to_string()),
                ),
            };

            prop_assert!(
                res.is_err(),
                "a write whose verification fails (mode {}) must return Err",
                fault
            );
            // The failing write is discarded: persist only happens on Ok, so the
            // slot is unchanged from before the faulty attempt (never the
            // unverified `cipher`).
            if let Ok(v) = &res {
                *store.borrow_mut() = Some(v.clone());
            }
            prop_assert_eq!(store.borrow().clone(), before);

            // ── Also: an encrypt-stage failure short-circuits before any
            // verification and likewise yields no value to retain.
            let res_enc = verify_before_persist(
                &pt,
                || Err::<String, String>("locked".to_string()),
                |_v: &str| Ok(Some(pt.clone())),
            );
            prop_assert_eq!(res_enc, Err("locked".to_string()));
        });
    }
}
