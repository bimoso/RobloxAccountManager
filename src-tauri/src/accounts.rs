//! Account_Store (`accounts.json`) persistence, ported from the legacy JS backend's
//! `loadAccounts` / `saveAccounts` / `decryptAccount` section and the
//! `accounts:*` IPC handlers.
//!
//! This task (6.1) implements the READ path only — [`load_from_file`] /
//! [`load_from_dir`] — matching the legacy JS build's `loadAccounts`:
//!
//! ```js
//! const dataPath = path.join(app.getPath('userData'), 'accounts.json');
//! function loadAccounts() {
//!   try {
//!     if (!fs.existsSync(dataPath)) return [];
//!     return JSON.parse(fs.readFileSync(dataPath, 'utf8')).map(decryptAccount);
//!   } catch { return []; }
//! }
//! ```
//!
//! The legacy JS build collapses *every* failure — a missing file, an
//! unreadable/permission-denied file, a corrupt-JSON file, and even a per-account
//! decrypt failure (`decryptField(...) ?? ''`) — into either an empty array or a
//! silently-blanked cookie. The migration must NOT preserve that lossy behavior
//! for the Account_Store (design "Error Handling" + Property 21 / Property 18):
//!
//!   * A **missing** file still yields an empty store — this is the only case the
//!     legacy JS build's `!fs.existsSync -> []` short-circuit models, and a first
//!     run legitimately has no file yet (Requirement 11.1 talks about an
//!     *existing* file). This is expressed idiomatically here by treating a read
//!     that fails with [`std::io::ErrorKind::NotFound`] as "no store yet",
//!     avoiding the TOCTOU race of a separate `exists()` probe.
//!   * An **existing but unreadable** file (permission/IO error) yields
//!     [`LoadError::Io`] — never an empty store (Requirement 11.7: "SHALL NOT
//!     silently start with an empty store").
//!   * A **corrupt** (non-JSON) file yields [`LoadError::Corrupt`], distinct from
//!     the IO case so the Renderer_UI can say "corrupted file" vs. "permission
//!     error" (Requirement 11.7 distinguishability / Property 21).
//!   * A per-account **decrypt failure** does NOT drop or blank that account:
//!     its stored ciphertext is left byte-for-byte unmodified in the returned
//!     entry, an identifying error is collected for it, and every *other* entry
//!     that decrypts is still made available (Requirement 11.1 / 11.4 /
//!     Property 18).
//!
//! To carry both halves of that per-entry outcome, [`load_from_file`] returns an
//! [`AccountLoad`] `{ accounts, errors }` on success: `accounts` preserves the
//! on-disk order and includes BOTH the successfully-decrypted entries (with their
//! plaintext cookie) and the undecryptable entries (with their original
//! ciphertext intact), while `errors` lists one [`AccountDecryptError`] per
//! undecryptable entry. Only a whole-file read/parse failure is an `Err`.
//!
//! Layering note: like `encryption.rs`, this module does not read the
//! Settings_Store. The settings-derived decryption inputs (`passphrase_mode`,
//! `safe_storage_ready`, `device_key`) are threaded in as parameters, exactly
//! matching [`crate::encryption::decrypt_account`]'s signature; the command layer
//! (Task 6.9) resolves them from the Settings_Store and resolves the on-disk path
//! from Tauri's `app_data_dir()` before calling [`load_from_dir`].

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::crypto_context::{self, CryptoContext};
use crate::encryption::{decrypt_account, encrypt_account};
use crate::logging;
use crate::models::Account;

/// The Account_Store file name, identical to the legacy JS build's
/// `path.join(app.getPath('userData'), 'accounts.json')` leaf. The parent
/// directory (`%APPDATA%\robloxaccountmanager\`, Tauri's `app_data_dir()`) is supplied by
/// the caller so this module stays testable without a live Tauri app
/// (Requirement 11.6: same file name + per-user data location convention).
pub const ACCOUNTS_FILE_NAME: &str = "accounts.json";

/// Which store a [`LoadError`] refers to, so the surfaced message can name it
/// (Requirement 11.7: "identifying which store failed to read"). The
/// Account_Store load always reports [`Store::Accounts`]; the enum is shared so
/// the Settings_Store load (Task 8) can reuse the same classification with
/// [`Store::Settings`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    /// The Account_Store (`accounts.json`).
    Accounts,
    /// The Settings_Store (`settings.json`).
    Settings,
}

impl Store {
    /// Human-readable store name used in surfaced error text.
    pub fn label(self) -> &'static str {
        match self {
            Store::Accounts => "Account_Store (accounts.json)",
            Store::Settings => "Settings_Store (settings.json)",
        }
    }
}

/// A whole-file failure to read an *existing* store file, classified so the
/// Renderer_UI can distinguish corruption from a permission/IO problem
/// (Requirement 11.7 / Property 21).
///
/// A *missing* file is deliberately NOT represented here: it is not a failure but
/// the "no store yet" case, which [`load_from_file`] maps to an empty
/// [`AccountLoad`]. This type therefore only ever describes a file that exists
/// but could not be turned into a valid store, and its presence as an `Err`
/// guarantees the caller never silently substitutes an empty store
/// (Requirement 11.7).
#[derive(Debug)]
pub enum LoadError {
    /// The existing file could not be read due to an OS-level permission or I/O
    /// error (anything other than "not found"). The file is left unmodified.
    Io {
        /// Which store failed to read.
        store: Store,
        /// The path that could not be read.
        path: PathBuf,
        /// The underlying OS error.
        source: std::io::Error,
    },
    /// The file was read successfully but its contents are not valid Account_Store
    /// JSON (corruption). The file is left unmodified.
    Corrupt {
        /// Which store failed to parse.
        store: Store,
        /// The path whose contents did not parse.
        path: PathBuf,
        /// The parse error detail.
        detail: String,
    },
}

impl LoadError {
    /// `true` iff this is the file-corruption case, `false` for the
    /// permission/IO case — the distinguishing bit Requirement 11.7 requires.
    pub fn is_corruption(&self) -> bool {
        matches!(self, LoadError::Corrupt { .. })
    }

    /// `true` iff this is the permission/IO case.
    pub fn is_io(&self) -> bool {
        matches!(self, LoadError::Io { .. })
    }
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io {
                store,
                path,
                source,
            } => write!(
                f,
                "{} could not be read due to a file-permission or I/O error at {}: {}",
                store.label(),
                path.display(),
                source
            ),
            LoadError::Corrupt {
                store,
                path,
                detail,
            } => write!(
                f,
                "{} could not be read due to file corruption (invalid JSON) at {}: {}",
                store.label(),
                path.display(),
                detail
            ),
        }
    }
}

impl std::error::Error for LoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LoadError::Io { source, .. } => Some(source),
            LoadError::Corrupt { .. } => None,
        }
    }
}

/// An identifying error for a single account entry whose stored cookie could not
/// be decrypted under any supported format (Requirement 11.4). The affected
/// entry is still present in [`AccountLoad::accounts`] with its ciphertext
/// unmodified; this record exists so the failure is *reported* rather than
/// silently discarded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountDecryptError {
    /// The `id` of the affected account (its stable identifier).
    pub id: String,
    /// The `nickname` of the affected account, for a human-readable message.
    pub nickname: String,
    /// The underlying decryption error, as reported by
    /// [`crate::encryption::decrypt_account`].
    pub message: String,
}

impl std::fmt::Display for AccountDecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// The result of a successful Account_Store *read* (the file existed or was
/// legitimately absent and any JSON parsed): the full, order-preserving list of
/// accounts plus one error per entry that failed to decrypt.
///
/// `accounts` contains EVERY on-disk entry in its original order:
///   * entries that decrypted carry their plaintext cookie;
///   * entries that failed to decrypt carry their ORIGINAL ciphertext, unmodified
///     (Requirement 11.4 / Property 18 "SHALL NOT omit that entry").
///
/// `errors` has exactly one [`AccountDecryptError`] for each entry in `accounts`
/// whose cookie did not decrypt. An empty `errors` means every entry decrypted
/// (or had no cookie to decrypt).
#[derive(Debug, Clone, Default)]
pub struct AccountLoad {
    /// All account entries, in on-disk order (decrypted where possible,
    /// ciphertext-preserving where not).
    pub accounts: Vec<Account>,
    /// One entry per account whose cookie failed to decrypt.
    pub errors: Vec<AccountDecryptError>,
}

impl AccountLoad {
    /// `true` iff at least one entry failed to decrypt. When this is `true`, the
    /// migration treats it as a defect to be resolved (Requirement 11.4), but the
    /// decryptable entries in [`AccountLoad::accounts`] are still usable
    /// (Requirement 11.1).
    pub fn has_decrypt_errors(&self) -> bool {
        !self.errors.is_empty()
    }
}

/// Resolve the Account_Store path within a per-user application data directory,
/// mirroring `path.join(app.getPath('userData'), 'accounts.json')`.
pub fn accounts_path_in(dir: &Path) -> PathBuf {
    dir.join(ACCOUNTS_FILE_NAME)
}

/// Load the Account_Store from `dir/accounts.json` (see [`accounts_path_in`]).
/// Thin convenience wrapper over [`load_from_file`] for callers that hold the
/// application-data directory (the command layer passes Tauri's
/// `app_data_dir()`); keeps path resolution in one place.
pub fn load_from_dir(
    dir: &Path,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<AccountLoad, LoadError> {
    load_from_file(
        &accounts_path_in(dir),
        passphrase_mode,
        safe_storage_ready,
        device_key,
    )
}

/// Load and decrypt the Account_Store at `path`.
///
/// Behavior (see the module docs for the full rationale):
///   * `path` missing (`NotFound`) -> `Ok(AccountLoad::default())` (empty store),
///     the only case matching the legacy JS build's `!fs.existsSync -> []`;
///   * `path` exists but unreadable (permission/other IO) -> `Err(LoadError::Io)`;
///   * `path` readable but not valid JSON -> `Err(LoadError::Corrupt)`;
///   * `path` parsed -> `Ok(AccountLoad)` with every entry present (decrypted
///     where possible, ciphertext-preserving otherwise) and one
///     [`AccountDecryptError`] per undecryptable entry.
///
/// A read failure never falls through to an empty store (Requirement 11.7), and a
/// per-entry decrypt failure never drops or blanks that entry (Requirement 11.4).
/// The file is only read here, never written, so an unreadable/corrupt file is
/// left byte-for-byte unmodified.
pub fn load_from_file(
    path: &Path,
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<AccountLoad, LoadError> {
    // Read the raw bytes. A `NotFound` error is the legitimate "no store yet"
    // case (first run / never saved), mapped to an empty store — every OTHER io
    // error is a genuine read failure on an existing file and must surface as
    // `LoadError::Io`, never as an empty store (Requirement 11.7). Reading first
    // and matching on `NotFound` (instead of an `exists()` pre-check) also avoids
    // a time-of-check/time-of-use race.
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AccountLoad::default());
        }
        Err(e) => {
            return Err(LoadError::Io {
                store: Store::Accounts,
                path: path.to_path_buf(),
                source: e,
            });
        }
    };

    // Parse the Account_Store JSON array. Any parse failure — invalid UTF-8,
    // malformed JSON, or a shape that is not an array of accounts — is
    // corruption, distinct from the IO case (Requirement 11.7 / Property 21).
    let stored: Vec<Account> = serde_json::from_slice(&bytes).map_err(|e| LoadError::Corrupt {
        store: Store::Accounts,
        path: path.to_path_buf(),
        detail: e.to_string(),
    })?;

    // Decrypt each entry independently. A failure for one entry never affects the
    // others (Requirement 11.1): the successful ones keep their plaintext cookie,
    // and each failing one is kept verbatim (its ciphertext is left unmodified)
    // alongside an identifying error (Requirement 11.4 / Property 18).
    let mut accounts = Vec::with_capacity(stored.len());
    let mut errors = Vec::new();
    for entry in stored {
        match decrypt_account(&entry, passphrase_mode, safe_storage_ready, device_key) {
            Ok(decrypted) => accounts.push(decrypted),
            Err(message) => {
                errors.push(AccountDecryptError {
                    id: entry.id.clone(),
                    nickname: entry.nickname.clone(),
                    message,
                });
                // Preserve the entry with its ciphertext untouched.
                accounts.push(entry);
            }
        }
    }

    Ok(AccountLoad { accounts, errors })
}

// ── Write path: save / add / update / remove / reorder (Task 6.2) ────────────
//
// These port the legacy JS build's `saveAccounts` writer and the `accounts:add`
// / `accounts:update` / `accounts:remove` / `accounts:reorder` IPC handlers'
// store logic:
//
// ```js
// function encryptAccount(a) {
//   const o = { ...a };
//   if (o.cookie && !isEncrypted(o.cookie)) o.cookie = encryptField(o.cookie);
//   applyAccountDonutDefaults(o);
//   o._enc = true;
//   return o;
// }
// function saveAccounts(a) {
//   fs.writeFileSync(dataPath, JSON.stringify(a.map(encryptAccount), null, 2), { mode: 0o600 });
// }
//
// legacy command handler('accounts:add', (_, account) => {
//   const accounts = loadAccounts();
//   const a = { id: Date.now().toString(), ...account, createdAt: ..., lastUsed: null };
//   accounts.push(a); saveAccounts(accounts); return a;
// });
// legacy command handler('accounts:update', (_, id, data) => {
//   const accounts = loadAccounts(), idx = accounts.findIndex(a => a.id === id);
//   if (idx !== -1) { accounts[idx] = { ...accounts[idx], ...data }; saveAccounts(accounts); return accounts[idx]; }
//   return null;
// });
// legacy command handler('accounts:remove', async (_, id) => {
//   const account = loadAccounts().find(a => a.id === id) || null;
//   let cleanup = { pending: false, notice: null };
//   if (account) { try { cleanup = await handleAccountRemovalCleanup(account); } catch { ... } }
//   saveAccounts(loadAccounts().filter(a => a.id !== id));
//   if (cleanup.notice && win && !win.isDestroyed())
//     win.webContents.send('browser:notify', { type: 'warn', message: cleanup.notice });
//   return { ok: true, pending: cleanup.pending, notice: cleanup.notice };
// });
// legacy command handler('accounts:reorder', (_, ids) => {
//   const accounts = loadAccounts();
//   const reordered = ids.map(id => accounts.find(a => a.id === id)).filter(Boolean);
//   const rest = accounts.filter(a => !ids.includes(a.id));
//   saveAccounts([...reordered, ...rest]);
//   return true;
// });
// ```
//
// [`add`] / [`update`] / [`remove`] / [`reorder`] are kept as PURE, IO-free
// transforms over an in-memory `Vec<Account>` (the decrypted store the command
// layer holds after [`load_from_file`]), so they are trivially unit- and
// property-testable without touching disk or encryption. Only [`save_to_file`]
// performs IO + encryption. The command layer (Task 6.9) wires them together —
// load -> transform -> [`save_to_file`] — resolving the encryption inputs from
// the Settings_Store and the path from Tauri's `app_data_dir()`, exactly as each
// legacy handler does `loadAccounts()` -> mutate -> `saveAccounts(...)`.

/// A whole-store failure to WRITE the Account_Store.
///
/// [`SaveError::Encrypt`] is raised BEFORE any bytes are written: if any account
/// fails to encrypt-and-verify (Requirement 11.5 — a secret whose freshly
/// written form does not decrypt back must not be persisted), the entire save is
/// abandoned and the prior on-disk file is left untouched, mirroring the fact
/// that `a.map(encryptAccount)` throws before `fs.writeFileSync` runs.
/// [`SaveError::Io`] is a genuine filesystem write failure.
#[derive(Debug)]
pub enum SaveError {
    /// An account could not be encrypted/verified; nothing was written and the
    /// prior on-disk file is unchanged (Requirement 11.5).
    Encrypt {
        /// The identifying encryption error from [`encrypt_account`].
        message: String,
    },
    /// The store file could not be written due to an OS-level I/O error.
    Io {
        /// Which store failed to write.
        store: Store,
        /// The path that could not be written.
        path: PathBuf,
        /// The underlying OS error.
        source: std::io::Error,
    },
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Encrypt { message } => write!(
                f,
                "refusing to save the Account_Store: an account failed encryption/verification \
                 (prior file left unchanged): {message}"
            ),
            SaveError::Io {
                store,
                path,
                source,
            } => write!(
                f,
                "{} could not be written due to an I/O error at {}: {}",
                store.label(),
                path.display(),
                source
            ),
        }
    }
}

impl std::error::Error for SaveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SaveError::Io { source, .. } => Some(source),
            SaveError::Encrypt { .. } => None,
        }
    }
}

/// The error raised by [`add`] when identifier uniqueness would be violated.
///
/// Requirement 1.1 requires enforcing identifier uniqueness "by rejecting or
/// deduplicating any addition whose identifier already exists". This port
/// chooses the **reject** arm: `add` returns `Err(AddError::DuplicateId)` and
/// leaves the store unchanged. Reject (rather than dedupe) is the correct choice
/// here because the legacy JS build mints each new account's id from
/// `Date.now().toString()` at the command layer, so a collision with an existing
/// id is a genuine anomaly rather than an expected re-add; rejecting surfaces it
/// instead of silently overwriting or duplicating an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddError {
    /// An account with this identifier already exists in the store.
    DuplicateId(String),
}

impl std::fmt::Display for AddError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AddError::DuplicateId(id) => write!(
                f,
                "cannot add account: identifier '{id}' already exists in the Account_Store"
            ),
        }
    }
}

impl std::error::Error for AddError {}

/// Encrypt and persist the full Account_Store to `dir/accounts.json`. Thin
/// convenience wrapper over [`save_to_file`] mirroring [`load_from_dir`].
pub fn save_to_dir(
    dir: &Path,
    accounts: &[Account],
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<(), SaveError> {
    save_to_file(
        &accounts_path_in(dir),
        accounts,
        passphrase_mode,
        safe_storage_ready,
        device_key,
    )
}

/// Encrypt each account and write the store to `path`, mirroring
/// `saveAccounts(a) { fs.writeFileSync(dataPath, JSON.stringify(a.map(encryptAccount), null, 2), { mode: 0o600 }); }`.
///
/// Behavior matched to the legacy JS build:
///   * every entry is run through [`encrypt_account`] (cookie encrypted only when
///     non-empty AND not already tagged; `_enc: true` marker re-added), exactly
///     like `a.map(encryptAccount)`;
///   * the output is pretty-printed JSON with 2-space indentation, matching
///     `JSON.stringify(..., null, 2)`;
///   * the write is a single, direct (non-atomic) `write`, matching
///     `fs.writeFileSync` — no temp-file+rename is introduced, to keep the exact
///     write semantics of the legacy JS build.
///
/// Crucially, ALL accounts are encrypted into an in-memory buffer FIRST; if any
/// one fails encryption/verification the function returns [`SaveError::Encrypt`]
/// WITHOUT writing anything, so a failed secret write never truncates or
/// overwrites the prior good file (Requirement 11.5) — this mirrors the fact that
/// `a.map(encryptAccount)` throws before `fs.writeFileSync` is ever reached.
///
/// On Unix the file mode is best-effort set to `0o600` after writing, mirroring
/// the legacy JS build's `{ mode: 0o600 }`; on Windows (the supported target) the
/// mode argument is inert just as it is for Node's `fs.writeFileSync`.
pub fn save_to_file(
    path: &Path,
    accounts: &[Account],
    passphrase_mode: bool,
    safe_storage_ready: bool,
    device_key: Option<[u8; 32]>,
) -> Result<(), SaveError> {
    // Encrypt EVERY entry before touching the filesystem. A single failure aborts
    // the whole save with the prior file left intact (Requirement 11.5).
    let mut encrypted = Vec::with_capacity(accounts.len());
    for account in accounts {
        let enc = encrypt_account(account, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|message| SaveError::Encrypt { message })?;
        encrypted.push(enc);
    }

    // `JSON.stringify(..., null, 2)` — pretty JSON, 2-space indent. serde_json's
    // pretty printer uses the same 2-space indentation.
    let json = serde_json::to_vec_pretty(&encrypted).map_err(|e| SaveError::Encrypt {
        message: format!("serializing the Account_Store to JSON failed: {e}"),
    })?;

    // Single direct write, matching `fs.writeFileSync` (non-atomic by design).
    std::fs::write(path, &json).map_err(|source| SaveError::Io {
        store: Store::Accounts,
        path: path.to_path_buf(),
        source,
    })?;

    // Best-effort `{ mode: 0o600 }` on Unix; a no-op on the Windows target, just
    // as Node's mode argument is effectively ignored on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

/// Add `account` to the in-memory store, enforcing identifier uniqueness
/// (Requirement 1.1), mirroring the store mutation in the `accounts:add`
/// handler (`accounts.push(a)`), with the added uniqueness guard.
///
/// If no existing entry shares `account.id`, the account is appended and returned
/// (the legacy handler returns the added account `a`). If an entry with the
/// same id already exists, the store is left UNCHANGED and
/// [`AddError::DuplicateId`] is returned (see [`AddError`] for why reject, not
/// dedupe). The caller mints `account.id` (e.g. `Date.now().toString()`) and
/// fills `created_at` / `last_used` before calling, exactly as the legacy JS runtime
/// handler builds `a` before pushing.
pub fn add(accounts: &mut Vec<Account>, account: Account) -> Result<Account, AddError> {
    if accounts.iter().any(|a| a.id == account.id) {
        return Err(AddError::DuplicateId(account.id));
    }
    accounts.push(account.clone());
    Ok(account)
}

/// Apply a partial `data` update to the account with `id`, mirroring
/// `accounts:update`:
///
/// ```js
/// const idx = accounts.findIndex(a => a.id === id);
/// if (idx !== -1) { accounts[idx] = { ...accounts[idx], ...data }; return accounts[idx]; }
/// return null;
/// ```
///
/// The merge reproduces JavaScript's `{ ...existing, ...data }` shallow spread
/// exactly: the existing account is turned into a JSON object, every key in
/// `data` overlays the corresponding key (recognized fields AND any
/// unrecognized/legacy field carried in `extra`), and the result is materialized
/// back into an [`Account`]. Overlaying at the JSON layer — rather than
/// field-by-field on the typed struct — is what preserves the exact spread
/// semantics for arbitrary partial payloads the Renderer_UI may send.
///
/// Returns `Some(updated_account)` when `id` exists (matching the handler's
/// `return accounts[idx]`), or `None` when it does not — a NO-OP that leaves the
/// store unchanged (matching `return null`; Requirement 1.2).
pub fn update(accounts: &mut [Account], id: &str, data: &Map<String, Value>) -> Option<Account> {
    let idx = accounts.iter().position(|a| a.id == id)?;

    // { ...existing, ...data }: overlay `data`'s keys onto the existing account's
    // JSON object form, then rebuild the typed Account.
    let mut merged = serde_json::to_value(&accounts[idx]).ok()?;
    if let Value::Object(map) = &mut merged {
        for (key, value) in data {
            map.insert(key.clone(), value.clone());
        }
    }
    let updated: Account = serde_json::from_value(merged).ok()?;

    accounts[idx] = updated.clone();
    Some(updated)
}

/// Remove the account with `id` from the in-memory store, mirroring the store
/// mutation in `accounts:remove` (`accounts.filter(a => a.id !== id)`).
///
/// Returns `Some(removed_account)` when `id` existed, or `None` when it did not —
/// a NO-OP that leaves the store unchanged (Requirement 1.3).
///
/// The returned `Option` is the "notify signal" the task calls for, and is what
/// the command layer (Task 6.9) needs to reproduce the legacy JS runtime `browser:notify`
/// push WITHOUT this module depending on an `AppHandle`. In the legacy handler
/// the `browser:notify` event is emitted only when `cleanup.notice` is truthy,
/// and `cleanup` is produced by `handleAccountRemovalCleanup(account)` which runs
/// **only if the account existed** (`if (account) { ... }`). Since the Donut
/// cleanup lives in `browser_launcher.rs` (Task 13), not here, this function
/// reports the exact precondition for that whole branch — whether an account was
/// actually removed. The command layer then: on `Some(account)`, runs the
/// browser cleanup, and emits `browser://notify` iff that cleanup yields a
/// notice; on `None`, does neither (no cleanup, no notify), preserving the
/// legacy JS runtime condition precisely.
pub fn remove(accounts: &mut Vec<Account>, id: &str) -> Option<Account> {
    let idx = accounts.iter().position(|a| a.id == id)?;
    Some(accounts.remove(idx))
}

/// Reorder the store to the submitted `ids`, MERGING any omitted identifiers
/// after the submitted order while preserving their prior relative order
/// (Requirement 1.4), mirroring `accounts:reorder`:
///
/// ```js
/// const reordered = ids.map(id => accounts.find(a => a.id === id)).filter(Boolean);
/// const rest = accounts.filter(a => !ids.includes(a.id));
/// return [...reordered, ...rest];
/// ```
///
/// Semantics matched exactly:
///   * `reordered`: for each submitted id, in submitted order, the matching
///     account (ids that match no account are skipped — the `.filter(Boolean)`);
///   * `rest`: every account whose id is NOT in `ids`, in the store's PRIOR
///     relative order (never dropped — the criterion's "merge, not remove");
///   * result: `reordered` followed by `rest`.
///
/// This is a pure transform returning a new `Vec`; it does not mutate its input,
/// matching the handler's `saveAccounts([...reordered, ...rest])`.
pub fn reorder(accounts: &[Account], ids: &[String]) -> Vec<Account> {
    let mut reordered: Vec<Account> = ids
        .iter()
        .filter_map(|id| accounts.iter().find(|a| &a.id == id).cloned())
        .collect();
    reordered.extend(accounts.iter().filter(|a| !ids.contains(&a.id)).cloned());
    reordered
}

// ── Tauri command layer (Task 6.9) ───────────────────────────────────────────
//
// These five `#[tauri::command]` functions are the direct counterparts of the
// legacy JS runtime `accounts:*` IPC handlers (design IPC_Surface mapping table). Each
// takes the same parameters, in the same order, as its legacy handler
// (Requirement 10.1):
//
//   accounts_load()               <- legacy command handler('accounts:load', ...)
//   accounts_add(account)         <- legacy command handler('accounts:add',  (_, account) => ...)
//   accounts_remove(id)           <- legacy command handler('accounts:remove',(_, id) => ...)
//   accounts_update(id, data)     <- legacy command handler('accounts:update',(_, id, data) => ...)
//   accounts_reorder(ids)         <- legacy command handler('accounts:reorder',(_, ids) => ...)
//
// Each reproduces its handler's `loadAccounts()` -> mutate -> `saveAccounts(...)`
// flow, resolving the on-disk directory from the Tauri `AppHandle` and the three
// encryption inputs from the Settings_Store (via `crypto_context`), then calling
// the pure store transforms above. Fallible operations return `Err(String)` —
// which `invoke()` surfaces to the Renderer_UI as a rejected promise, the same
// success/failure duality `renderer.js` already branches on (Requirement 7.1
// direction: no `unwrap`/`expect` on fallible paths).

/// The per-user application-data subdirectory holding `accounts.json` /
/// `settings.json`, matching the legacy JS build's `app.getPath('userData')`
/// location. At runtime the legacy JS build resolves `userData` from the app name
/// (`robloxaccountmanager`), i.e. `%APPDATA%\robloxaccountmanager\`. Tauri's identifier-derived
/// `app_data_dir()` would instead point at `%APPDATA%\<bundle identifier>\`,
/// which would NOT find a user's existing files, so [`store_dir`] resolves the
/// roaming-AppData root and joins this fixed name to land on the exact same
/// folder (Requirement 11.6; Windows paths are case-insensitive, so this also
/// matches the packaged build's `%APPDATA%\RobloxAccountManager\`).
pub const STORE_DIR_NAME: &str = "robloxaccountmanager";

/// Tauri event replacing the legacy JS runtime `browser:notify` `webContents` push that
/// `accounts:remove` conditionally sends (design IPC_Surface mapping note).
pub const BROWSER_NOTIFY_EVENT: &str = "browser://notify";

/// The value `accounts_remove` returns, matching the legacy handler's
/// `{ ok: true, pending: cleanup.pending, notice: cleanup.notice }` shape so the
/// Renderer_UI receives the identical payload.
#[derive(Debug, Clone, Serialize)]
pub struct RemoveResult {
    /// Always `true` on a completed removal request (matching legacy JS runtime `ok: true`).
    pub ok: bool,
    /// Whether Donut profile deletion was deferred to the pending-deletion queue.
    pub pending: bool,
    /// A user-facing warning to surface, or `null` when there is nothing to notify.
    pub notice: Option<String>,
}

/// Resolve the application-data directory (`%APPDATA%\robloxaccountmanager\`), creating it
/// if absent, mirroring `path.join(app.getPath('userData'), ...)` where legacy JS runtime
/// guarantees `userData` exists. See [`STORE_DIR_NAME`] for why this is derived
/// from the roaming-AppData root rather than Tauri's identifier-scoped
/// `app_data_dir()`.
///
/// Made `pub` so the Settings_Store / encryption command layer (Task 7.7) resolves
/// the application-data directory the SAME way the `accounts_*` commands do,
/// rather than diverging with its own path logic (Requirement 11.6).
pub fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| format!("could not resolve the application data directory: {e}"))?;
    let dir = base.join(STORE_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the application data directory {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Current time in epoch milliseconds — the equivalent of `Date.now()`, used to
/// mint a new account's `id` (`Date.now().toString()`).
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Produce an ISO-8601 UTC timestamp with millisecond precision and a trailing
/// `Z`, byte-compatible with JavaScript's `new Date().toISOString()` (used for a
/// new account's `createdAt`). Computed without a date-library dependency via the
/// standard days->civil-date conversion.
///
/// Made `pub(crate)` so the Roblox launch flow (`roblox_process.rs`) can stamp an
/// account's `lastUsed` with the same `new Date().toISOString()`-compatible value
/// the legacy JS runtime `_doLaunch` writes, without duplicating the civil-date math.
pub(crate) fn iso8601_utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Convert a day count since the Unix epoch (1970-01-01) into a `(year, month,
/// day)` proleptic-Gregorian date, via Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// `accounts:load` — return the full account list with cookies decrypted.
///
/// Ports `legacy command handler('accounts:load', () => loadAccounts())`. The renderer's
/// `api.loadAccounts()` consumes the resolved value as the account array
/// directly (`[accounts] = await Promise.all([api.loadAccounts(), ...])`), so
/// this returns `Vec<Account>` — the same array shape.
///
/// Decrypt errors are NOT folded into the returned array (that would change the
/// renderer-facing shape): every entry is still returned (undecryptable ones with
/// their ciphertext preserved, per [`load_from_file`] / Requirement 11.4), and
/// each decrypt failure is surfaced out-of-band as a `log://entry` warning
/// (Requirement 11.4's "display an error identifying the affected entry"),
/// exactly the log/event channel the design calls for. A whole-file read failure
/// (corrupt / permission) surfaces as `Err` and never as an empty list
/// (Requirement 11.7).
#[tauri::command]
pub fn accounts_load(app: AppHandle) -> Result<Vec<Account>, String> {
    crate::logging::log_command_result("accounts_load", (|| {
        let dir = store_dir(&app)?;
        let CryptoContext {
            passphrase_mode,
            safe_storage_ready,
            device_key,
        } = crypto_context::resolve(&dir);

        let loaded = load_from_dir(&dir, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?;

        for err in &loaded.errors {
            logging::send_log(
                &app,
                "err",
                "accounts",
                &format!("Could not decrypt account \"{}\": {}", err.nickname, err.message),
                serde_json::json!({ "id": err.id }),
            );
        }

        Ok(loaded.accounts)
    })())
}

/// `accounts:add` — mint identity fields, append, persist, return the new account.
///
/// Ports:
/// ```js
/// const accounts = loadAccounts();
/// const a = { id: Date.now().toString(), ...account, createdAt: new Date().toISOString(), lastUsed: null };
/// accounts.push(a); saveAccounts(accounts); return a;
/// ```
///
/// `account` arrives as an arbitrary JSON object (the renderer sends e.g.
/// `{ username, userId, cookie, gameTarget }` with no `id`/`nickname`), so the
/// minted object is assembled at the JSON layer to reproduce the exact spread
/// order — `id` first, the caller's fields next, then `createdAt`/`lastUsed`
/// last so they always win — before being materialized into an [`Account`].
/// A missing `nickname` (the renderer omits it) defaults to an empty string so
/// the value round-trips; every other field the renderer always supplies.
/// The added account is returned with its plaintext cookie, matching what the
/// renderer pushes into its in-memory list.
#[tauri::command]
pub fn accounts_add(app: AppHandle, account: Value) -> Result<Account, String> {
    crate::logging::log_command_result("accounts_add", (|| {
        let dir = store_dir(&app)?;
        let CryptoContext {
            passphrase_mode,
            safe_storage_ready,
            device_key,
        } = crypto_context::resolve(&dir);

        // Build `{ id, ...account, createdAt, lastUsed: null }` preserving spread order.
        let mut obj = Map::new();
        obj.insert("id".to_string(), Value::String(now_millis().to_string()));
        if let Value::Object(incoming) = account {
            for (key, value) in incoming {
                obj.insert(key, value);
            }
        }
        obj.insert("createdAt".to_string(), Value::String(iso8601_utc_now()));
        obj.insert("lastUsed".to_string(), Value::Null);
        // The renderer omits `nickname` on add; default it so the typed model is
        // complete (legacy JS runtime stored it as `undefined`, which is falsy just like "").
        obj.entry("nickname".to_string())
            .or_insert_with(|| Value::String(String::new()));

        let minted: Account = serde_json::from_value(Value::Object(obj))
            .map_err(|e| format!("invalid account payload: {e}"))?;

        let mut accounts = load_from_dir(&dir, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?
            .accounts;

        let added = add(&mut accounts, minted).map_err(|e| e.to_string())?;
        save_to_dir(&dir, &accounts, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?;
        Ok(added)
    })())
}

/// `accounts:update` — merge a partial update into an existing account.
///
/// Ports:
/// ```js
/// const idx = accounts.findIndex(a => a.id === id);
/// if (idx !== -1) { accounts[idx] = { ...accounts[idx], ...data }; saveAccounts(accounts); return accounts[idx]; }
/// return null;
/// ```
///
/// Returns `Ok(Some(updated))` when `id` exists (persisting the merge) or
/// `Ok(None)` when it does not — a no-op that neither writes nor errors,
/// matching the handler's `return null` (Requirement 1.2). `data` is the same
/// partial object the legacy handler spreads.
#[tauri::command]
pub fn accounts_update(
    app: AppHandle,
    id: String,
    data: Map<String, Value>,
) -> Result<Option<Account>, String> {
    crate::logging::log_command_result("accounts_update", (|| {
        let dir = store_dir(&app)?;
        let CryptoContext {
            passphrase_mode,
            safe_storage_ready,
            device_key,
        } = crypto_context::resolve(&dir);

        let mut accounts = load_from_dir(&dir, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?
            .accounts;

        match update(&mut accounts, &id, &data) {
            Some(updated) => {
                save_to_dir(&dir, &accounts, passphrase_mode, safe_storage_ready, device_key)
                    .map_err(|e| e.to_string())?;
                Ok(Some(updated))
            }
            None => Ok(None), // unknown id: no-op, no write (Requirement 1.2)
        }
    })())
}

/// `accounts:remove` — drop an account and re-persist the remaining list.
///
/// Ports:
/// ```js
/// const account = loadAccounts().find(a => a.id === id) || null;
/// let cleanup = { pending: false, notice: null };
/// if (account) { try { cleanup = await handleAccountRemovalCleanup(account); } catch { ... } }
/// saveAccounts(loadAccounts().filter(a => a.id !== id));
/// if (cleanup.notice && win) win.webContents.send('browser:notify', { type: 'warn', message: cleanup.notice });
/// return { ok: true, pending: cleanup.pending, notice: cleanup.notice };
/// ```
///
/// The store list is always re-saved (matching the unconditional
/// `saveAccounts(... .filter(...))`, so removal is a no-op on an unknown id yet
/// still re-persists the unchanged list; Requirement 1.3).
///
/// INTEGRATION POINT (Task 13): the Donut cleanup `handleAccountRemovalCleanup`
/// lives in `browser_launcher.rs`, which is not implemented yet. Its legacy JS runtime
/// precondition is exactly "an account with this id existed" — the value
/// [`remove`] returns as `Some`. Until it lands, cleanup is the neutral
/// `{ pending: false, notice: None }`, so no `browser://notify` is emitted (the
/// legacy JS runtime event only fires when `cleanup.notice` is truthy). When
/// `browser_launcher` is ready, replace the marked block below with a call into
/// it on the `Some(account)` branch, and this command becomes `async`.
#[tauri::command]
pub fn accounts_remove(app: AppHandle, id: String) -> Result<RemoveResult, String> {
    crate::logging::log_command_result("accounts_remove", (|| {
        let dir = store_dir(&app)?;
        let CryptoContext {
            passphrase_mode,
            safe_storage_ready,
            device_key,
        } = crypto_context::resolve(&dir);

        let mut accounts = load_from_dir(&dir, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?
            .accounts;

        let removed = remove(&mut accounts, &id);

        // ── Donut cleanup integration point (Task 13 / browser_launcher.rs) ──
        // legacy JS runtime: `if (account) cleanup = await handleAccountRemovalCleanup(account)`.
        // `removed.is_some()` is that `if (account)` precondition. No cleanup module
        // yet, so this stays the neutral result.
        let mut pending = false;
        let mut notice: Option<String> = None;
        if let Some(_account) = &removed {
            // TODO(Task 13): cleanup = browser_launcher::handle_account_removal_cleanup(_account).await;
            //   pending = cleanup.pending; notice = cleanup.notice;
            let _ = (&mut pending, &mut notice);
        }
        // ─────────────────────────────────────────────────────────────────────

        // Always re-persist the (possibly unchanged) list, matching the handler's
        // unconditional `saveAccounts(loadAccounts().filter(...))`.
        save_to_dir(&dir, &accounts, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?;

        // Emit `browser://notify` only when cleanup produced a notice, at the same
        // point in the flow as the legacy JS runtime `win.webContents.send('browser:notify', ...)`.
        if let Some(message) = &notice {
            let _ = app.emit(
                BROWSER_NOTIFY_EVENT,
                serde_json::json!({ "type": "warn", "message": message }),
            );
        }

        Ok(RemoveResult {
            ok: true,
            pending,
            notice,
        })
    })())
}

/// `accounts:reorder` — apply a submitted order, merging omitted ids after it.
///
/// Ports:
/// ```js
/// const reordered = ids.map(id => accounts.find(a => a.id === id)).filter(Boolean);
/// const rest = accounts.filter(a => !ids.includes(a.id));
/// saveAccounts([...reordered, ...rest]); return true;
/// ```
///
/// Delegates to the pure [`reorder`] transform (which merges omitted identifiers
/// rather than dropping them; Requirement 1.4) and returns `true`, matching the
/// handler's return value.
#[tauri::command]
pub fn accounts_reorder(app: AppHandle, ids: Vec<String>) -> Result<bool, String> {
    crate::logging::log_command_result("accounts_reorder", (|| {
        let dir = store_dir(&app)?;
        let CryptoContext {
            passphrase_mode,
            safe_storage_ready,
            device_key,
        } = crypto_context::resolve(&dir);

        let accounts = load_from_dir(&dir, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?
            .accounts;

        let reordered = reorder(&accounts, &ids);
        save_to_dir(&dir, &reordered, passphrase_mode, safe_storage_ready, device_key)
            .map_err(|e| e.to_string())?;
        Ok(true)
    })())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the Account_Store load path (Task 6.1):
    //! read-failure distinction (Requirement 11.7) and mixed-validity per-entry
    //! behavior (Requirements 11.1, 11.4).
    //!
    //! These tests avoid any passphrase/DPAPI setup by exercising the two cookie
    //! shapes that decrypt (or fail) deterministically on every platform with the
    //! key session locked:
    //!   * a NO-TAG cookie, which `decrypt_field` passes through unchanged
    //!     (`Ok(Some(value))`), so the entry decrypts to itself; and
    //!   * a `gs:` cookie with no key available (locked, non-passphrase, no
    //!     device key), which `decrypt_field` reports as `Err` — the
    //!     undecryptable case.

    use super::*;
    use serde_json::{json, Map};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Locked, machine-bound-with-no-key inputs: not passphrase mode, keychain
    /// not ready, and no device key. Under these, a tagged cookie has no key to
    /// decrypt with and fails, while a no-tag cookie passes through.
    const LOCKED: (bool, bool, Option<[u8; 32]>) = (false, false, None);

    /// Process-unique temp path helper (no external tempdir dependency).
    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mrbx-accounts-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Build an account JSON object with the given id/nickname/cookie and the
    /// other required fields filled with placeholders.
    fn account_json(id: &str, nickname: &str, cookie: &str) -> serde_json::Value {
        json!({
            "id": id,
            "username": format!("user-{id}"),
            "userId": format!("uid-{id}"),
            "nickname": nickname,
            "cookie": cookie,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        })
    }

    fn write_store(dir: &Path, value: &serde_json::Value) -> PathBuf {
        let path = accounts_path_in(dir);
        std::fs::write(&path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
        path
    }

    #[test]
    fn missing_file_returns_empty_store() {
        // A directory with no accounts.json is the legitimate "no store yet" case.
        let dir = unique_temp_dir("missing");
        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2)
            .expect("missing file must be Ok(empty), not an error");
        assert!(loaded.accounts.is_empty());
        assert!(!loaded.has_decrypt_errors());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_is_reported_as_corruption_not_empty() {
        let dir = unique_temp_dir("corrupt");
        let path = accounts_path_in(&dir);
        std::fs::write(&path, b"{ this is not valid json ]").unwrap();

        let err = load_from_file(&path, LOCKED.0, LOCKED.1, LOCKED.2)
            .expect_err("corrupt file must be an error, never an empty store");
        assert!(err.is_corruption(), "expected Corrupt, got {err:?}");
        assert!(!err.is_io());
        // The file must be left untouched (we never write on read).
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not valid json ]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_existing_file_is_reported_as_io_not_empty() {
        // Simulate an existing-but-unreadable file by pointing the store path at a
        // directory: it exists (so not NotFound) but cannot be read as a file,
        // producing an OS-level IO error rather than a parse error or empty store.
        let dir = unique_temp_dir("io");
        let store_path = accounts_path_in(&dir);
        std::fs::create_dir_all(&store_path).expect("create dir at the accounts.json path");

        let err = load_from_file(&store_path, LOCKED.0, LOCKED.1, LOCKED.2)
            .expect_err("an unreadable existing file must be an error, never an empty store");
        assert!(err.is_io(), "expected Io, got {err:?}");
        assert!(!err.is_corruption());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_array_loads_as_empty_store() {
        let dir = unique_temp_dir("emptyarr");
        write_store(&dir, &json!([]));
        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert!(loaded.accounts.is_empty());
        assert!(!loaded.has_decrypt_errors());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plaintext_cookie_entry_decrypts_to_itself() {
        // A cookie with no format tag is passed through unchanged by decrypt_field.
        let dir = unique_temp_dir("plain");
        write_store(
            &dir,
            &json!([account_json("a1", "Main", "plaintext-cookie-value")]),
        );
        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert_eq!(loaded.accounts.len(), 1);
        assert_eq!(loaded.accounts[0].cookie, "plaintext-cookie-value");
        assert!(!loaded.has_decrypt_errors());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixed_validity_surfaces_decryptable_and_preserves_undecryptable() {
        // Two entries: one plaintext (decrypts to itself) and one `gs:` cookie
        // that cannot decrypt while locked. The decryptable one must be available;
        // the undecryptable one must remain in the result with its ciphertext
        // unmodified and must produce one identifying error (Property 18).
        let dir = unique_temp_dir("mixed");
        let undecryptable_cookie = "gs:AAAA:BBBB:CCCC";
        write_store(
            &dir,
            &json!([
                account_json("ok1", "Good", "plain-good-cookie"),
                account_json("bad1", "Broken", undecryptable_cookie),
            ]),
        );

        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();

        // Neither entry is omitted; on-disk order is preserved.
        assert_eq!(loaded.accounts.len(), 2);
        assert_eq!(loaded.accounts[0].id, "ok1");
        assert_eq!(loaded.accounts[1].id, "bad1");

        // The decryptable entry is available with its (passed-through) plaintext.
        assert_eq!(loaded.accounts[0].cookie, "plain-good-cookie");

        // The undecryptable entry keeps its ORIGINAL ciphertext, unmodified.
        assert_eq!(loaded.accounts[1].cookie, undecryptable_cookie);

        // Exactly one identifying error, naming the affected entry.
        assert_eq!(loaded.errors.len(), 1);
        assert_eq!(loaded.errors[0].id, "bad1");
        assert_eq!(loaded.errors[0].nickname, "Broken");
        assert!(!loaded.errors[0].message.is_empty());
        assert!(loaded.has_decrypt_errors());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undecryptable_entry_does_not_prevent_others_from_loading() {
        // Requirement 11.1: availability of a decryptable entry is independent of
        // how many others fail. Interleave several failing `gs:` entries around a
        // couple of good ones and confirm the good ones still surface.
        let dir = unique_temp_dir("independent");
        write_store(
            &dir,
            &json!([
                account_json("bad1", "B1", "gs:x:y:z"),
                account_json("ok1", "G1", "good-1"),
                account_json("bad2", "B2", "gcm:x:y:z"),
                account_json("ok2", "G2", "good-2"),
                account_json("bad3", "B3", "cbc:x:y"),
            ]),
        );

        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert_eq!(loaded.accounts.len(), 5);
        // Good entries decrypted (passed through).
        assert_eq!(loaded.accounts[1].cookie, "good-1");
        assert_eq!(loaded.accounts[3].cookie, "good-2");
        // Three failures, each identified, ciphertext preserved.
        assert_eq!(loaded.errors.len(), 3);
        let bad_ids: Vec<&str> = loaded.errors.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(bad_ids, vec!["bad1", "bad2", "bad3"]);
        assert_eq!(loaded.accounts[0].cookie, "gs:x:y:z");
        assert_eq!(loaded.accounts[2].cookie, "gcm:x:y:z");
        assert_eq!(loaded.accounts[4].cookie, "cbc:x:y");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entry_without_cookie_is_available_without_error() {
        // An account with an empty cookie has nothing to decrypt and must load
        // cleanly (mirrors `if (o.cookie)` guard in decryptAccount).
        let dir = unique_temp_dir("nocookie");
        let mut obj = Map::new();
        obj.insert("id".into(), json!("n1"));
        obj.insert("username".into(), json!("u"));
        obj.insert("userId".into(), json!("uid"));
        obj.insert("nickname".into(), json!("NoCookie"));
        obj.insert("cookie".into(), json!(""));
        obj.insert("createdAt".into(), json!("2024-01-01T00:00:00.000Z"));
        write_store(&dir, &json!([serde_json::Value::Object(obj)]));

        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert_eq!(loaded.accounts.len(), 1);
        assert_eq!(loaded.accounts[0].cookie, "");
        assert!(!loaded.has_decrypt_errors());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod write_tests {
    //! Unit tests for the Account_Store WRITE path (Task 6.2): `save_to_file`
    //! (Requirement 11.5 — no partial/overwriting write on encryption failure,
    //! `_enc` marker, 2-space JSON), `add` (Requirement 1.1 identifier
    //! uniqueness), `update` (Requirement 1.2 no-op on unknown id + spread
    //! merge), `remove` (Requirement 1.3 no-op on unknown id + removed-account
    //! signal), and `reorder` (Requirement 1.4 merge omitted ids after the
    //! submitted order, preserving prior relative order).
    //!
    //! Cookie encryption uses the same platform-independent shapes as the load
    //! tests: a NO-TAG cookie is passed through by `encrypt_field`'s machine-bound
    //! `gs:` branch only when a key is available, so to keep `save_to_file` tests
    //! deterministic on every platform we save accounts whose cookies are EMPTY
    //! (nothing to encrypt) or ALREADY tagged (left untouched by `encrypt_account`
    //! because `is_encrypted` is true), avoiding any key/DPAPI dependency.

    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const LOCKED: (bool, bool, Option<[u8; 32]>) = (false, false, None);

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mrbx-accounts-write-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Build an `Account` with the given id/nickname/cookie and placeholder
    /// required fields, no extra/legacy keys.
    fn account(id: &str, nickname: &str, cookie: &str) -> Account {
        serde_json::from_value(json!({
            "id": id,
            "username": format!("user-{id}"),
            "userId": format!("uid-{id}"),
            "nickname": nickname,
            "cookie": cookie,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        }))
        .unwrap()
    }

    fn ids_of(accounts: &[Account]) -> Vec<String> {
        accounts.iter().map(|a| a.id.clone()).collect()
    }

    // ── save_to_file ────────────────────────────────────────────────────────

    #[test]
    fn save_then_load_round_trips_and_writes_enc_marker() {
        // Empty and already-tagged cookies need no key, so this is deterministic
        // cross-platform. The `cbc:`/`gs:` cookies are left untouched by
        // encrypt_account (is_encrypted == true); the empty cookie is skipped.
        let dir = unique_temp_dir("roundtrip");
        let store = vec![
            account("a1", "Main", ""),
            account("a2", "Alt", "gs:aa:bb:cc"),
        ];

        save_to_dir(&dir, &store, LOCKED.0, LOCKED.1, LOCKED.2).expect("save should succeed");

        // Raw on-disk JSON: pretty (2-space) and carries the `_enc: true` marker.
        let path = accounts_path_in(&dir);
        let raw = std::fs::read_to_string(&path).unwrap();
        // Top-level is an array; each object is indented one 2-space level in.
        assert!(raw.contains("\n  {"), "expected 2-space pretty JSON, got: {raw}");
        assert!(raw.contains("\n    \"id\""), "expected 2-space pretty JSON, got: {raw}");
        let parsed: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.len(), 2);
        for entry in &parsed {
            assert_eq!(entry.get("_enc"), Some(&Value::Bool(true)));
        }

        // Loading back yields the same ids/cookies (tagged cookies unchanged).
        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert_eq!(ids_of(&loaded.accounts), vec!["a1", "a2"]);
        assert_eq!(loaded.accounts[0].cookie, "");
        assert_eq!(loaded.accounts[1].cookie, "gs:aa:bb:cc");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_does_not_overwrite_prior_file_when_encryption_fails() {
        // A non-empty, UN-tagged cookie while the store is locked (no passphrase,
        // no keychain, no device key) cannot be encrypted -> save must fail with
        // SaveError::Encrypt and must NOT have written/truncated the prior file
        // (Requirement 11.5).
        let dir = unique_temp_dir("encfail");
        let path = accounts_path_in(&dir);

        // Seed a prior good file.
        let prior = vec![account("keep", "Keep", "gs:xx:yy:zz")];
        save_to_dir(&dir, &prior, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        let prior_bytes = std::fs::read(&path).unwrap();

        // Attempt to save an account with a plaintext cookie -> encryption fails.
        let bad = vec![account("new", "New", "plaintext-cookie-cannot-encrypt-while-locked")];
        let err = save_to_dir(&dir, &bad, LOCKED.0, LOCKED.1, LOCKED.2)
            .expect_err("saving an unencryptable cookie while locked must fail");
        assert!(
            matches!(err, SaveError::Encrypt { .. }),
            "expected SaveError::Encrypt, got {err:?}"
        );

        // The prior file is byte-for-byte unchanged.
        assert_eq!(std::fs::read(&path).unwrap(), prior_bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_empty_store_writes_empty_json_array() {
        let dir = unique_temp_dir("emptysave");
        save_to_dir(&dir, &[], LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        let loaded = load_from_dir(&dir, LOCKED.0, LOCKED.1, LOCKED.2).unwrap();
        assert!(loaded.accounts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── add (Requirement 1.1) ─────────────────────────────────────────────────

    #[test]
    fn add_appends_new_account_and_returns_it() {
        let mut store = vec![account("a1", "One", "")];
        let added = add(&mut store, account("a2", "Two", "")).expect("unique id should add");
        assert_eq!(added.id, "a2");
        assert_eq!(ids_of(&store), vec!["a1", "a2"]);
    }

    #[test]
    fn add_rejects_duplicate_identifier_and_leaves_store_unchanged() {
        let mut store = vec![account("dup", "Original", "gs:aa:bb:cc")];
        let before = store.clone();
        let err = add(&mut store, account("dup", "Impostor", "")).expect_err("dup id must reject");
        assert_eq!(err, AddError::DuplicateId("dup".to_string()));
        // Store untouched: same length, same original entry.
        assert_eq!(ids_of(&store), ids_of(&before));
        assert_eq!(store[0].nickname, "Original");
    }

    // ── update (Requirement 1.2) ──────────────────────────────────────────────

    #[test]
    fn update_applies_partial_merge_to_existing_id() {
        let mut store = vec![account("a1", "Old", "gs:aa:bb:cc"), account("a2", "Keep", "")];
        let mut data = Map::new();
        data.insert("nickname".into(), json!("New Name"));
        data.insert("lastUsed".into(), json!("2024-09-09T00:00:00.000Z"));

        let updated = update(&mut store, "a1", &data).expect("existing id updates");
        assert_eq!(updated.nickname, "New Name");
        assert_eq!(updated.last_used.as_deref(), Some("2024-09-09T00:00:00.000Z"));
        // Untouched fields survive the spread merge.
        assert_eq!(updated.cookie, "gs:aa:bb:cc");
        assert_eq!(updated.id, "a1");
        // The store reflects the change; the other account is unaffected.
        assert_eq!(store[0].nickname, "New Name");
        assert_eq!(store[1].nickname, "Keep");
    }

    #[test]
    fn update_merges_unknown_legacy_fields_via_spread() {
        // `{ ...existing, ...data }` must set arbitrary keys the struct does not
        // model (they land in `extra`), matching JS spread.
        let mut store = vec![account("a1", "N", "")];
        let mut data = Map::new();
        data.insert("someLegacyFlag".into(), json!(true));
        let updated = update(&mut store, "a1", &data).unwrap();
        assert_eq!(updated.extra.get("someLegacyFlag"), Some(&json!(true)));
    }

    #[test]
    fn update_unknown_id_is_a_noop_returning_none() {
        let mut store = vec![account("a1", "One", "")];
        let before = store.clone();
        let mut data = Map::new();
        data.insert("nickname".into(), json!("ignored"));
        assert!(update(&mut store, "does-not-exist", &data).is_none());
        // No-op: store unchanged.
        assert_eq!(ids_of(&store), ids_of(&before));
        assert_eq!(store[0].nickname, "One");
    }

    // ── remove (Requirement 1.3) ──────────────────────────────────────────────

    #[test]
    fn remove_existing_id_removes_and_returns_the_account() {
        let mut store = vec![account("a1", "One", ""), account("a2", "Two", "")];
        let removed = remove(&mut store, "a1").expect("existing id removes");
        assert_eq!(removed.id, "a1");
        assert_eq!(ids_of(&store), vec!["a2"]);
    }

    #[test]
    fn remove_unknown_id_is_a_noop_returning_none() {
        let mut store = vec![account("a1", "One", ""), account("a2", "Two", "")];
        let before = store.clone();
        assert!(remove(&mut store, "nope").is_none());
        // No-op: nothing removed, order preserved.
        assert_eq!(ids_of(&store), ids_of(&before));
    }

    // ── reorder (Requirement 1.4) ─────────────────────────────────────────────

    #[test]
    fn reorder_applies_submitted_order_when_all_ids_present() {
        let store = vec![
            account("a", "A", ""),
            account("b", "B", ""),
            account("c", "C", ""),
        ];
        let out = reorder(&store, &["c".into(), "a".into(), "b".into()]);
        assert_eq!(ids_of(&out), vec!["c", "a", "b"]);
    }

    #[test]
    fn reorder_merges_omitted_ids_after_submitted_order_preserving_prior_order() {
        // Submitted order lists only "c" and "a"; "b" and "d" are omitted and must
        // be merged AFTER, in their PRIOR relative order (b before d), not dropped.
        let store = vec![
            account("a", "A", ""),
            account("b", "B", ""),
            account("c", "C", ""),
            account("d", "D", ""),
        ];
        let out = reorder(&store, &["c".into(), "a".into()]);
        assert_eq!(ids_of(&out), vec!["c", "a", "b", "d"]);
    }

    #[test]
    fn reorder_ignores_submitted_ids_that_match_no_account() {
        // An id in the submitted order that matches nothing is skipped
        // (`.filter(Boolean)`); every existing account still appears exactly once.
        let store = vec![account("a", "A", ""), account("b", "B", "")];
        let out = reorder(&store, &["ghost".into(), "b".into(), "a".into()]);
        assert_eq!(ids_of(&out), vec!["b", "a"]);
    }

    #[test]
    fn reorder_empty_ids_preserves_prior_order() {
        let store = vec![account("a", "A", ""), account("b", "B", "")];
        let out = reorder(&store, &[]);
        assert_eq!(ids_of(&out), vec!["a", "b"]);
    }
}

#[cfg(test)]
mod prop_tests {
    //! Property-based tests for the Account_Store read path.
    //!
    //! Uses the module's existing dependency-free temp-dir approach (no
    //! `tempfile` crate), mirroring the unit-test helpers above.

    use super::*;
    use proptest::prelude::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Process-unique temp dir helper (no external tempdir dependency), matching
    /// the unit-test modules.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mrbx-accounts-prop-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Strategy producing byte contents that are NOT a valid Account_Store JSON
    /// array of accounts. Combines three families of "corrupt" inputs:
    ///   * arbitrary raw bytes (garbage / non-UTF-8);
    ///   * arbitrary UTF-8 strings (garbage text / truncated fragments);
    ///   * hand-picked JSON that parses but is the WRONG SHAPE (a scalar, an
    ///     object, a numeric array, or a truncated array) — none of which is a
    ///     `Vec<Account>`.
    ///
    /// The test body additionally `prop_assume!`s that the generated bytes do not
    /// deserialize to `Vec<Account>`, so the rare chance a random input is a
    /// coincidentally-valid store is filtered out and never gives a false failure.
    fn corrupt_store_bytes() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            proptest::collection::vec(any::<u8>(), 0..256),
            any::<String>().prop_map(String::into_bytes),
            prop::sample::select(vec![
                b"".to_vec(),
                b"{}".to_vec(),
                b"null".to_vec(),
                b"true".to_vec(),
                b"42".to_vec(),
                b"\"just a string\"".to_vec(),
                b"{\"accounts\": []}".to_vec(),
                b"[".to_vec(),
                b"[{".to_vec(),
                b"[{\"id\":".to_vec(),
                b"[1, 2, 3]".to_vec(),
                b"{ this is not valid json ]".to_vec(),
            ]),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 21: An unreadable store file is left untouched and its failure cause is reported, never silently treated as empty
        //
        // **Validates: Requirements 11.7**
        //
        // For arbitrary content that is NOT a valid Account_Store JSON array,
        // written to an EXISTING accounts.json, `load_from_file`:
        //   * returns `Err` — never `Ok(empty)` (it must not silently substitute
        //     an empty store for the unreadable file);
        //   * classifies the failure as corruption (`is_corruption()` true,
        //     `is_io()` false), the distinguishing failure cause Req 11.7 needs;
        //   * leaves the file byte-for-byte unmodified (read is never a write).
        #[test]
        fn corrupt_store_file_is_untouched_and_failure_reported(bytes in corrupt_store_bytes()) {
            // Only exercise genuinely-invalid store content: filter out any input
            // that happens to be a valid `Vec<Account>` (e.g. an empty array).
            prop_assume!(serde_json::from_slice::<Vec<Account>>(&bytes).is_err());

            let dir = unique_temp_dir("corrupt");
            let path = accounts_path_in(&dir);
            std::fs::write(&path, &bytes).expect("seed the accounts.json file");

            let result = load_from_file(&path, false, false, None);

            // Never Ok(empty): an unreadable file must surface as an error.
            prop_assert!(
                result.is_err(),
                "corrupt content was silently accepted as a store: {:?}",
                bytes
            );
            let err = result.err().unwrap();

            // The failure cause is reported as corruption, not IO.
            prop_assert!(err.is_corruption(), "expected Corrupt, got {:?}", err);
            prop_assert!(!err.is_io());

            // The file is left byte-for-byte unmodified.
            let after = std::fs::read(&path).expect("re-read the seeded file");
            prop_assert_eq!(&after, &bytes, "load_from_file must not modify the file on failure");

            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Fixed sub-case covering the permission/IO distinction cross-platform:
    /// pointing the store path at a directory makes the path EXIST (so it is not
    /// the `NotFound` "empty store" case) yet it cannot be read as a file,
    /// yielding `Err(LoadError::Io)` — distinct from corruption and never an empty
    /// store (Requirement 11.7).
    #[test]
    fn existing_unreadable_path_is_reported_as_io_not_empty() {
        let dir = unique_temp_dir("io");
        let store_path = accounts_path_in(&dir);
        std::fs::create_dir_all(&store_path).expect("create a directory at the accounts.json path");

        let err = load_from_file(&store_path, false, false, None)
            .expect_err("an existing unreadable path must be an error, never an empty store");
        assert!(err.is_io(), "expected Io, got {err:?}");
        assert!(!err.is_corruption());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod load_prop_tests {
    //! Property-based test for the Account_Store load path (Task 6.7).
    //!
    //! Uses the same platform-independent cookie shapes as the load unit tests:
    //! under LOCKED = (passphrase_mode=false, safe_storage_ready=false,
    //! device_key=None) a no-tag / empty cookie passes through `decrypt_field`
    //! (decryptable, decrypts to itself), while a `gs:` / `gcm:` / `cbc:` tagged
    //! cookie has no key to decrypt with and fails (undecryptable) — regardless of
    //! its suffix, because the missing-key check precedes any ciphertext parsing.

    use super::*;
    use proptest::prelude::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Locked, machine-bound-with-no-key inputs (see the unit-test module).
    const LOCKED: (bool, bool, Option<[u8; 32]>) = (false, false, None);

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mrbx-accounts-prop-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn account_json(id: &str, nickname: &str, cookie: &str) -> serde_json::Value {
        json!({
            "id": id,
            "username": format!("user-{id}"),
            "userId": format!("uid-{id}"),
            "nickname": nickname,
            "cookie": cookie,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        })
    }

    /// One generated entry: its on-disk cookie plus whether that cookie is
    /// expected to decrypt (pass through) or fail under LOCKED.
    #[derive(Debug, Clone)]
    struct EntrySpec {
        cookie: String,
        decryptable: bool,
    }

    /// A decryptable cookie: either empty (nothing to decrypt) or an un-tagged
    /// plaintext value (passed through unchanged by `decrypt_field`). The
    /// `plain-` prefix guarantees it never begins with a recognized format tag
    /// (`safe:`/`gs:`/`gcm:`/`cbc:`), so it can never be mistaken for ciphertext.
    fn decryptable_strategy() -> impl Strategy<Value = EntrySpec> {
        prop_oneof![
            Just(String::new()),
            "plain-[a-zA-Z0-9._-]{0,24}".prop_map(|s| s),
        ]
        .prop_map(|cookie| EntrySpec {
            cookie,
            decryptable: true,
        })
    }

    /// A non-decryptable cookie: a `gs:` / `gcm:` / `cbc:` tagged value. While
    /// LOCKED there is no key available, so decryption fails before the suffix is
    /// ever parsed — any suffix reliably produces the undecryptable case.
    fn undecryptable_strategy() -> impl Strategy<Value = EntrySpec> {
        (
            prop_oneof![Just("gs:"), Just("gcm:"), Just("cbc:")],
            "[a-zA-Z0-9:/+=]{0,24}",
        )
            .prop_map(|(tag, suffix)| EntrySpec {
                cookie: format!("{tag}{suffix}"),
                decryptable: false,
            })
    }

    fn entry_strategy() -> impl Strategy<Value = EntrySpec> {
        prop_oneof![decryptable_strategy(), undecryptable_strategy()]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 18: Loading a mixed-validity Account_Store surfaces every decryptable entry and preserves every non-decryptable one unmodified with an error
        #[test]
        fn mixed_validity_load_surfaces_decryptable_and_preserves_undecryptable(
            specs in prop::collection::vec(entry_strategy(), 0..15)
        ) {
            let dir = unique_temp_dir("mixed");

            // Assign each entry a distinct id by position so errors can be matched
            // back to the exact entry, and write the store in generated order.
            let store_json: Vec<serde_json::Value> = specs
                .iter()
                .enumerate()
                .map(|(i, spec)| {
                    account_json(&format!("acc-{i}"), &format!("Nick {i}"), &spec.cookie)
                })
                .collect();
            let path = accounts_path_in(&dir);
            std::fs::write(&path, serde_json::to_vec_pretty(&store_json).unwrap()).unwrap();

            let loaded = load_from_file(&path, LOCKED.0, LOCKED.1, LOCKED.2)
                .expect("a well-formed store must load without a whole-file error");

            // No entry is omitted, and on-disk order is preserved.
            prop_assert_eq!(loaded.accounts.len(), specs.len());
            for (i, account) in loaded.accounts.iter().enumerate() {
                prop_assert_eq!(&account.id, &format!("acc-{i}"));
            }

            // Per-entry outcomes.
            let mut expected_error_ids: Vec<String> = Vec::new();
            for (i, spec) in specs.iter().enumerate() {
                let id = format!("acc-{i}");
                let account = &loaded.accounts[i];
                if spec.decryptable {
                    // Decryptable entry: available with its expected plaintext
                    // (pass-through value == original cookie), and never an error.
                    prop_assert_eq!(&account.cookie, &spec.cookie);
                    prop_assert!(
                        !loaded.errors.iter().any(|e| e.id == id),
                        "decryptable entry {} must not produce an error",
                        id
                    );
                } else {
                    // Non-decryptable entry: ORIGINAL ciphertext preserved
                    // byte-for-byte.
                    prop_assert_eq!(&account.cookie, &spec.cookie);
                    expected_error_ids.push(id);
                }
            }

            // Exactly one error per non-decryptable entry, each naming its id, and
            // none for decryptable entries.
            prop_assert_eq!(loaded.errors.len(), expected_error_ids.len());
            let mut actual_error_ids: Vec<String> =
                loaded.errors.iter().map(|e| e.id.clone()).collect();
            actual_error_ids.sort();
            let mut expected_sorted = expected_error_ids.clone();
            expected_sorted.sort();
            prop_assert_eq!(actual_error_ids, expected_sorted);
            for err in &loaded.errors {
                prop_assert!(!err.message.is_empty());
            }

            // Independence (Requirement 11.1): every decryptable entry is present
            // with its plaintext regardless of how many others failed.
            let decryptable_count = specs.iter().filter(|s| s.decryptable).count();
            let recovered_decryptable = specs
                .iter()
                .enumerate()
                .filter(|(_, s)| s.decryptable)
                .filter(|(i, s)| loaded.accounts[*i].cookie == s.cookie)
                .count();
            prop_assert_eq!(recovered_decryptable, decryptable_count);

            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod reorder_prop_tests {
    //! Property-based test for the Account_Store `reorder` transform (Task 6.6).
    //!
    //! `reorder` must MERGE omitted identifiers rather than drop them
    //! (Requirement 1.4): the submitted ids (that match an account) come first in
    //! submitted order, then every account whose id was NOT submitted follows in
    //! its prior relative order, and submitted ids matching no account are
    //! ignored. The net effect is a permutation of the original store — no account
    //! is ever dropped or duplicated.

    use super::*;
    use proptest::prelude::*;

    /// Build a minimal, valid [`Account`] carrying only the fields `reorder`
    /// depends on (`id`); the rest are inert placeholders derived from the id so
    /// each generated account is distinguishable and well-formed.
    fn make_account(id: &str) -> Account {
        Account {
            id: id.to_string(),
            username: format!("user-{id}"),
            user_id: format!("uid-{id}"),
            nickname: format!("Nick {id}"),
            cookie: String::new(),
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            last_used: None,
            donut_profile_id: None,
            donut_profile_pending_delete: false,
            extra: serde_json::Map::new(),
        }
    }

    /// Dedup a list of ids preserving first-occurrence order (turns an arbitrary
    /// generated `Vec` into a distinct-id list, matching how both a real store and
    /// a real reorder submission carry each id at most once).
    fn dedup_preserving_order(ids: Vec<String>) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        ids.into_iter().filter(|id| seen.insert(id.clone())).collect()
    }

    /// Store ids drawn from the `[a-f]{1,2}` pool (never starting with `g`), then
    /// deduped so the store holds distinct ids.
    fn store_ids_strategy() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-f]{1,2}", 0..12).prop_map(dedup_preserving_order)
    }

    /// Submitted ids: an arbitrary distinct list mixing values from the store pool
    /// (`[a-f]{1,2}`, which may match an account) and guaranteed-ghost values
    /// (`g[a-f]{1,2}`, which — starting with `g` — can never match a store id).
    /// The empty list is included, covering the "cleared submission" case.
    fn submitted_ids_strategy() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec(
            prop_oneof![
                "[a-f]{1,2}",   // may hit a real account
                "g[a-f]{1,2}",  // ghost: matches no account
            ],
            0..14,
        )
        .prop_map(dedup_preserving_order)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 4: Reordering merges omitted identifiers rather than dropping them
        //
        // **Validates: Requirements 1.4**
        //
        // For an arbitrary store of distinct-id accounts and an arbitrary distinct
        // submitted id list (subset, superset-with-ghosts, permutation, or empty),
        // `reorder`:
        //   * returns a PERMUTATION of the store — same multiset of ids, nothing
        //     dropped and nothing duplicated;
        //   * places accounts whose id was submitted (and exists) first, in
        //     submitted order;
        //   * places every omitted account after them, in prior relative order;
        //   * ignores submitted ids that match no account (no phantom entries).
        #[test]
        fn reorder_merges_omitted_and_never_drops_or_duplicates(
            store_ids in store_ids_strategy(),
            submitted in submitted_ids_strategy(),
        ) {
            let store: Vec<Account> = store_ids.iter().map(|id| make_account(id)).collect();

            let result = reorder(&store, &submitted);

            let store_id_set: std::collections::HashSet<&String> = store_ids.iter().collect();

            // Independent reference ordering of ids:
            //   submitted ids that actually exist (submitted order) ++
            //   store ids not submitted (prior relative order).
            let submitted_set: std::collections::HashSet<&String> = submitted.iter().collect();
            let mut expected_ids: Vec<String> = submitted
                .iter()
                .filter(|id| store_id_set.contains(id))
                .cloned()
                .collect();
            expected_ids.extend(
                store_ids
                    .iter()
                    .filter(|id| !submitted_set.contains(id))
                    .cloned(),
            );

            let result_ids: Vec<String> = result.iter().map(|a| a.id.clone()).collect();

            // Ordering: submitted-existing first (submitted order), omitted after
            // (prior order), ghosts ignored — all captured by this equality.
            prop_assert_eq!(&result_ids, &expected_ids);

            // Permutation: nothing dropped, nothing duplicated. Store ids are
            // distinct, so a sorted-set comparison plus a length/uniqueness check
            // proves the result is exactly the original multiset of ids.
            prop_assert_eq!(result_ids.len(), store_ids.len());
            let result_id_set: std::collections::HashSet<&String> = result_ids.iter().collect();
            prop_assert_eq!(
                result_id_set.len(),
                result_ids.len(),
                "result must not contain a duplicated account"
            );
            prop_assert_eq!(result_id_set, store_id_set);

            // No phantom entries: every id in the result came from the store (so no
            // ghost submitted id leaked through).
            for a in &result {
                prop_assert!(
                    store_ids.contains(&a.id),
                    "result contained an id not present in the original store: {}",
                    a.id
                );
            }
        }
    }
}

#[cfg(test)]
mod remove_prop_tests {
    //! Property-based test for the Account_Store `remove` transform (Task 6.5).
    //!
    //! `remove` is a pure, IO-free transform over an in-memory `Vec<Account>`, so
    //! this test exercises it directly with no disk or encryption involved.

    use super::*;
    use proptest::prelude::*;
    use serde_json::json;

    /// Build an `Account` whose id AND nickname are both derived from `n`, so a
    /// returned/removed entry can be matched back to the exact store slot.
    fn account(n: u32) -> Account {
        serde_json::from_value(json!({
            "id": format!("acc-{n}"),
            "username": format!("user-{n}"),
            "userId": format!("uid-{n}"),
            "nickname": format!("Nick {n}"),
            "cookie": "",
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        }))
        .expect("account fixture must deserialize")
    }

    /// A store of accounts with DISTINCT ids: generate raw index values, dedup
    /// preserving first-occurrence order, and map each to an `Account`.
    fn distinct_store() -> impl Strategy<Value = Vec<Account>> {
        prop::collection::vec(0u32..30, 0..15).prop_map(|raw| {
            let mut seen = Vec::new();
            for n in raw {
                if !seen.contains(&n) {
                    seen.push(n);
                }
            }
            seen.into_iter().map(account).collect()
        })
    }

    /// An arbitrary target id. The `0..35` domain overlaps the store's `0..30`
    /// id domain so BOTH branches — target present and target absent — are
    /// exercised across runs.
    fn target_id() -> impl Strategy<Value = String> {
        (0u32..35).prop_map(|n| format!("acc-{n}"))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        // Feature: native-tauri-backend, Property 3: Removal applies to an existing identifier and no-ops otherwise
        //
        // **Validates: Requirements 1.3**
        //
        // For an arbitrary distinct-id store and an arbitrary target id:
        //   * if the id EXISTS: `remove` returns `Some(that account)`, the entry
        //     is gone, the length shrinks by exactly one, and every OTHER entry
        //     stays in its prior relative order (only that id is removed);
        //   * if the id does NOT exist: `remove` returns `None` and the store is
        //     completely unchanged (length, entries, and order).
        #[test]
        fn remove_applies_to_existing_id_and_no_ops_otherwise(
            mut accounts in distinct_store(),
            target in target_id(),
        ) {
            // Snapshot the prior store as an id sequence (ids are distinct, so the
            // id order fully characterizes the store's contents and ordering).
            let before_ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();
            let existed = before_ids.iter().any(|id| id == &target);

            let removed = remove(&mut accounts, &target);
            let after_ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();

            if existed {
                // Returns the matching account.
                let removed = removed.expect("existing id must yield Some(account)");
                prop_assert_eq!(&removed.id, &target);
                // Its nickname matches the entry that was stored (returns THAT account).
                let n = target.strip_prefix("acc-").unwrap();
                prop_assert_eq!(&removed.nickname, &format!("Nick {n}"));

                // Length shrinks by exactly one and the id is gone.
                prop_assert_eq!(after_ids.len(), before_ids.len() - 1);
                prop_assert!(!after_ids.iter().any(|id| id == &target));

                // Every OTHER entry remains, in its prior relative order, and only
                // the target was removed: the surviving sequence equals the prior
                // sequence with the target filtered out.
                let expected: Vec<String> =
                    before_ids.iter().filter(|id| *id != &target).cloned().collect();
                prop_assert_eq!(after_ids, expected);
            } else {
                // No-op: returns None and the store is byte-for-byte unchanged.
                prop_assert!(removed.is_none(), "absent id must yield None");
                prop_assert_eq!(after_ids, before_ids);
            }
        }
    }
}

#[cfg(test)]
mod add_prop_tests {
    //! Property-based test for [`add`]'s identifier-uniqueness enforcement
    //! (Task 6.3 / Property 1). Pure, IO-free: exercises the in-memory transform
    //! directly over an arbitrary starting store and an arbitrary account to add.

    use super::*;
    use proptest::prelude::*;
    use serde_json::{json, Value};

    /// Build an `Account` with the given id/nickname/cookie and placeholder
    /// required fields, no extra/legacy keys (mirrors the unit-test helper).
    fn account(id: &str, nickname: &str, cookie: &str) -> Account {
        serde_json::from_value(json!({
            "id": id,
            "username": format!("user-{id}"),
            "userId": format!("uid-{id}"),
            "nickname": nickname,
            "cookie": cookie,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        }))
        .unwrap()
    }

    /// `Account` does not implement `PartialEq`; compare stores by their JSON
    /// value form so "unchanged" / "no other entry changed" is checked field-for-
    /// field, order-sensitively.
    fn to_values(accounts: &[Account]) -> Vec<Value> {
        accounts
            .iter()
            .map(|a| serde_json::to_value(a).unwrap())
            .collect()
    }

    /// `true` iff every id in the store is distinct.
    fn all_ids_unique(accounts: &[Account]) -> bool {
        let mut seen = std::collections::HashSet::new();
        accounts.iter().all(|a| seen.insert(a.id.clone()))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 1: Adding an account enforces identifier uniqueness
        //
        // **Validates: Requirements 1.1**
        //
        // For an arbitrary starting store (distinct ids drawn from a small pool so
        // both the collision and no-collision branches are exercised) and an
        // arbitrary account to add:
        //   * id NOT already present -> `Ok(added)`; the account is appended, len
        //     grows by exactly 1, and every prior entry is unchanged (the leading
        //     prefix equals the prior store);
        //   * id ALREADY present -> `Err(AddError::DuplicateId(id))`; the store is
        //     COMPLETELY unchanged (same length, same entries, same order);
        //   * invariant: after `add`, all ids in the store remain unique.
        #[test]
        fn add_enforces_identifier_uniqueness(
            existing_ids in prop::collection::hash_set("id[0-9]", 0..8),
            new_id in "id[0-9]",
            new_nick in "[a-zA-Z0-9 ]{0,12}",
        ) {
            // Deterministic order for the starting store (hash_set guarantees the
            // ids are already distinct).
            let mut ids: Vec<String> = existing_ids.into_iter().collect();
            ids.sort();
            let before: Vec<Account> = ids
                .iter()
                .map(|id| account(id, &format!("Nick {id}"), &format!("plain-{id}")))
                .collect();

            // Generator invariant: the starting store already has unique ids.
            prop_assert!(all_ids_unique(&before));

            let is_present = before.iter().any(|a| a.id == new_id);
            let to_add = account(&new_id, &new_nick, &format!("plain-{new_id}"));
            let to_add_value = serde_json::to_value(&to_add).unwrap();

            let before_values = to_values(&before);
            let mut store = before.clone();
            let result = add(&mut store, to_add.clone());

            if is_present {
                // Duplicate id: rejected with the offending id, store UNCHANGED.
                match result {
                    Err(AddError::DuplicateId(id)) => prop_assert_eq!(&id, &new_id),
                    other => prop_assert!(false, "expected DuplicateId, got {:?}", other),
                }
                prop_assert_eq!(store.len(), before.len());
                prop_assert_eq!(to_values(&store), before_values);
            } else {
                // Unique id: appended and returned; len grows by 1.
                match result {
                    Ok(added) => {
                        prop_assert_eq!(serde_json::to_value(&added).unwrap(), to_add_value.clone())
                    }
                    Err(e) => prop_assert!(false, "expected Ok, got {:?}", e),
                }
                prop_assert_eq!(store.len(), before.len() + 1);
                // No other entry changed: the leading prefix equals the prior store.
                prop_assert_eq!(to_values(&store[..before.len()]), before_values);
                // The new account is the appended last entry.
                prop_assert_eq!(
                    serde_json::to_value(&store[before.len()]).unwrap(),
                    to_add_value.clone()
                );
            }

            // Invariant: ids remain unique after add.
            prop_assert!(all_ids_unique(&store));
        }
    }
}

#[cfg(test)]
mod update_prop_tests {
    //! Property-based test for the Account_Store `update` transform (Task 6.4).
    //!
    //! Property 2: editing applies to an existing identifier (a `{ ...existing,
    //! ...data }` spread merge that returns the updated entry) and is a pure
    //! no-op for an unknown identifier (returns `None`, store byte-for-byte
    //! unchanged). See [`super::update`].

    use super::*;
    use proptest::prelude::*;
    use serde_json::{json, Map, Value};

    /// Build a valid `Account` whose observable fields are derived from `id` (and
    /// a positional `seed`) so that distinct entries differ — letting the test
    /// prove that entries other than the target are left untouched.
    fn account_for(id: &str, seed: usize) -> Account {
        serde_json::from_value(json!({
            "id": id,
            "username": format!("user-{id}"),
            "userId": format!("uid-{id}"),
            "nickname": format!("Nick-{id}-{seed}"),
            "cookie": format!("plain-{id}"),
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": if seed % 2 == 0 { Value::Null } else { json!("2024-05-05T00:00:00.000Z") },
            "donutProfileId": Value::Null,
            "donutProfilePendingDelete": false
        }))
        .unwrap()
    }

    /// A store of accounts with DISTINCT ids (0..8 entries). A `BTreeSet` of id
    /// strings guarantees uniqueness; each id is materialized into an account
    /// with id-derived fields.
    fn store_strategy() -> impl Strategy<Value = Vec<Account>> {
        prop::collection::btree_set("[a-z0-9]{1,6}", 0..8).prop_map(|ids| {
            ids.into_iter()
                .enumerate()
                .map(|(i, id)| account_for(&id, i))
                .collect::<Vec<_>>()
        })
    }

    /// A partial-update payload: a small `Map` of a few KNOWN `Account` keys
    /// (`nickname`, `lastUsed`) and/or an arbitrary LEGACY key, exercising the
    /// spread merge. Values are constrained so the merged object still
    /// deserializes back into an `Account` (`nickname` stays a string, `lastUsed`
    /// stays string-or-null); legacy keys carry an arbitrary JSON scalar and land
    /// in `extra`. The `id` key is deliberately never generated, so the property
    /// "id unchanged" is exercised without the payload trivially rewriting it.
    fn data_strategy() -> impl Strategy<Value = Map<String, Value>> {
        let nickname = prop::option::of("[ -~]{0,20}".prop_map(Value::String));
        let last_used = prop::option::of(prop_oneof![
            Just(Value::Null),
            "[0-9T:.Z-]{0,24}".prop_map(Value::String),
        ]);
        let legacy_scalar = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i32>().prop_map(|n| json!(n)),
            "[ -~]{0,12}".prop_map(Value::String),
        ];
        let legacy = prop::option::of(("legacy[a-zA-Z0-9]{0,6}", legacy_scalar));

        (nickname, last_used, legacy).prop_map(|(nick, last, leg)| {
            let mut map = Map::new();
            if let Some(v) = nick {
                map.insert("nickname".to_string(), v);
            }
            if let Some(v) = last {
                map.insert("lastUsed".to_string(), v);
            }
            if let Some((k, v)) = leg {
                map.insert(k, v);
            }
            map
        })
    }

    /// The store plus an (id, data) update. The target id is either one of the
    /// store's existing ids or a freshly-generated one (which may, harmlessly,
    /// coincide with an existing id — the test decides the branch by actual
    /// membership, not by which arm produced it).
    fn store_and_update() -> impl Strategy<Value = (Vec<Account>, String, Map<String, Value>)> {
        store_strategy().prop_flat_map(|store| {
            let ids: Vec<String> = store.iter().map(|a| a.id.clone()).collect();
            let id_strat = if ids.is_empty() {
                "[a-z0-9]{1,8}".boxed()
            } else {
                prop_oneof![
                    prop::sample::select(ids.clone()),
                    "[a-z0-9]{1,8}",
                ]
                .boxed()
            };
            (Just(store), id_strat, data_strategy())
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        // Feature: native-tauri-backend, Property 2: Editing applies to an existing identifier and no-ops otherwise
        //
        // **Validates: Requirements 1.2**
        #[test]
        fn update_edits_existing_and_noops_otherwise(
            (mut store, id, data) in store_and_update()
        ) {
            // Snapshot the store as JSON so we can compare before/after exactly.
            let before: Vec<Value> = store
                .iter()
                .map(|a| serde_json::to_value(a).unwrap())
                .collect();
            let target_idx = store.iter().position(|a| a.id == id);

            let result = update(&mut store, &id, &data);

            match target_idx {
                Some(idx) => {
                    // Existing id: returns Some, length unchanged.
                    let updated = result.expect("update on an existing id must return Some");
                    prop_assert_eq!(store.len(), before.len());

                    // The updated entry is exactly `{ ...existing, ...data }`:
                    // data keys overlaid, all other fields preserved, id unchanged.
                    let mut expected = before[idx].clone();
                    if let Value::Object(m) = &mut expected {
                        for (k, v) in &data {
                            m.insert(k.clone(), v.clone());
                        }
                    }
                    let updated_value = serde_json::to_value(&updated).unwrap();
                    prop_assert_eq!(&updated_value, &expected);

                    // id is never altered by the merge.
                    prop_assert_eq!(&updated.id, &id);

                    // The store's targeted slot reflects the returned entry.
                    let stored_value = serde_json::to_value(&store[idx]).unwrap();
                    prop_assert_eq!(&stored_value, &updated_value);

                    // Every OTHER entry is byte-for-byte untouched.
                    for (i, prior) in before.iter().enumerate() {
                        if i != idx {
                            let now = serde_json::to_value(&store[i]).unwrap();
                            prop_assert_eq!(&now, prior);
                        }
                    }
                }
                None => {
                    // Unknown id: returns None and the store is unchanged.
                    prop_assert!(result.is_none(), "update on an unknown id must return None");
                    let after: Vec<Value> = store
                        .iter()
                        .map(|a| serde_json::to_value(a).unwrap())
                        .collect();
                    prop_assert_eq!(after, before);
                }
            }
        }
    }
}
