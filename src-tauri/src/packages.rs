//! Packages_Store (`packages.json`) persistence, ported from the legacy JS backend's
//! `loadPackages` / `savePackages` section and the `packages:load` /
//! `packages:save` IPC handlers.
//!
//! Packages are named groups of accounts that can be launched together with a
//! single shared join-link. As the legacy JS build comment notes, **no secrets
//! live here** — just names, account-id references, and the last-used link — so,
//! unlike the Account_Store, nothing in this file is encrypted and no
//! decrypt/verify step is involved.
//!
//! The legacy JS build:
//!
//! ```js
//! const packagesPath = path.join(app.getPath('userData'), 'packages.json');
//! function loadPackages() {
//!   try { if (!fs.existsSync(packagesPath)) return []; return JSON.parse(fs.readFileSync(packagesPath, 'utf8')); } catch { return []; }
//! }
//! function savePackages(p) { fs.writeFileSync(packagesPath, JSON.stringify(p, null, 2), { mode: 0o600 }); }
//!
//! legacy command handler('packages:load', () => loadPackages());
//! legacy command handler('packages:save', (_, packages) => {
//!   try { savePackages(packages); return true; } catch (e) { return false; }
//! });
//! ```
//!
//! ## Deliberately permissive, matching the legacy JS build
//!
//! `packages.json` is a **non-critical** store. The design's Error Handling
//! section explicitly keeps the legacy JS build's permissive `catch { ... }`
//! behavior for non-critical files like `genhistory.json` / `packages.json`,
//! and applies the strict "never silently start empty" rule (Requirement 11.7)
//! ONLY to the Account_Store / Settings_Store. So this port intentionally mirrors
//! `loadPackages`'s swallow-all shape:
//!   * a **missing** file yields `[]` (the `!fs.existsSync -> []` branch);
//!   * an **unreadable** file (permission/IO) yields `[]` (the `catch` branch);
//!   * a **corrupt** (non-JSON, or JSON that is not an array) file yields `[]`
//!     (the `catch` / non-array branch).
//!
//! Because the on-disk shape is arbitrary application JSON the Renderer_UI round-
//! trips verbatim (package objects with names, account-id lists, and a last-used
//! link), the store is modeled as a flat `Vec<serde_json::Value>` — exactly what
//! `JSON.parse` / `JSON.stringify` move across the IPC boundary — rather than a
//! typed struct, so no field is ever dropped or reshaped on a round-trip. This is
//! the same approach `settings.rs` uses for the equally-non-critical
//! `genhistory.json`.
//!
//! ## What this task (14.1) ports
//!
//! The load/save *logic* only: [`load_from_file`] / [`load_from_dir`] and
//! [`save_to_file`] / [`save_to_dir`]. The `#[tauri::command]` wrappers
//! (`packages_load` / `packages_save`) and their registration with the Tauri
//! builder are Task 14.2 and are intentionally NOT added here. The command layer
//! will resolve the per-user application-data directory via
//! [`crate::accounts::store_dir`] — the SAME resolution the `accounts_*` /
//! `settings_*` commands use (Requirement 11.6) — and call the `*_dir` wrappers,
//! keeping the core load/save logic here unit-testable without a live Tauri app.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::AppHandle;

use crate::accounts::store_dir;

/// The Packages_Store file name, identical to the legacy JS build's
/// `path.join(app.getPath('userData'), 'packages.json')` leaf. The parent
/// directory (`%APPDATA%\robloxaccountmanager\`) is supplied by the caller so this module
/// stays testable without a live Tauri app (Requirement 11.6: same file name +
/// per-user data location convention).
pub const PACKAGES_FILE_NAME: &str = "packages.json";

/// The Packages_Store file path inside the given per-user application data
/// directory (`<dir>/packages.json`), mirroring
/// `path.join(app.getPath('userData'), 'packages.json')`.
pub fn packages_path_in(dir: &Path) -> PathBuf {
    dir.join(PACKAGES_FILE_NAME)
}

/// Read the Packages_Store from an explicit path — the testable core of
/// `loadPackages`:
///
/// ```js
/// try { if (!fs.existsSync(packagesPath)) return []; return JSON.parse(fs.readFileSync(packagesPath, 'utf8')); } catch { return []; }
/// ```
///
/// Returns the stored array on success and an empty `Vec` for a missing,
/// unreadable, corrupt, or non-array file — the deliberately permissive
/// `catch { return [] }` behavior the design keeps for this non-critical store
/// (see the module docs). A file whose top-level JSON is not an array is treated
/// as the empty list rather than surfaced, keeping the return type a list the
/// Renderer_UI can consume directly.
pub fn load_from_file(path: &Path) -> Vec<Value> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(), // missing / unreadable => [] (matches catch)
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(), // parse failure or non-array => []
    }
}

/// Read the Packages_Store from `<dir>/packages.json`. The command layer
/// (Task 14.2) resolves `dir` via [`crate::accounts::store_dir`] and calls this.
pub fn load_from_dir(dir: &Path) -> Vec<Value> {
    load_from_file(&packages_path_in(dir))
}

/// Write the Packages_Store to an explicit path — the testable core of
/// `savePackages` + the `packages:save` handler's `try/catch`:
///
/// ```js
/// function savePackages(p) { fs.writeFileSync(packagesPath, JSON.stringify(p, null, 2), { mode: 0o600 }); }
/// legacy command handler('packages:save', (_, packages) => {
///   try { savePackages(packages); return true; } catch (e) { return false; }
/// });
/// ```
///
/// The list is written as 2-space-pretty JSON, matching
/// `JSON.stringify(p, null, 2)`. Returns `true` on success and `false` on any
/// serialize/IO failure, matching the handler's boolean result. The write is a
/// single, direct (non-atomic) `write`, matching `fs.writeFileSync` — no
/// temp-file+rename is introduced, to keep the exact write semantics of the
/// legacy JS build.
///
/// On Unix the file mode is best-effort set to `0o600` after writing, mirroring
/// the legacy JS build's `{ mode: 0o600 }`; on Windows (the supported target) the
/// mode argument is inert just as it is for Node's `fs.writeFileSync`.
pub fn save_to_file(path: &Path, packages: &[Value]) -> bool {
    let json = match serde_json::to_string_pretty(packages) {
        Ok(json) => json,
        Err(_) => return false,
    };
    if fs::write(path, json).is_err() {
        return false;
    }

    // Best-effort `{ mode: 0o600 }` on Unix; a no-op on the Windows target, just
    // as Node's mode argument is effectively ignored on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    true
}

/// Write the Packages_Store to `<dir>/packages.json`. The command layer
/// (Task 14.2) resolves `dir` via [`crate::accounts::store_dir`] and calls this.
pub fn save_to_dir(dir: &Path, packages: &[Value]) -> bool {
    save_to_file(&packages_path_in(dir), packages)
}

// ── Tauri command layer (Task 14.2) ──────────────────────────────────────────
//
// These two `#[tauri::command]` functions are the direct counterparts of the
// legacy JS runtime `packages:*` IPC handlers (design IPC_Surface mapping table), each
// taking the same parameters, in the same order, as its legacy handler
// (Requirement 10.1):
//
//   packages_load()          <- legacy command handler('packages:load', () => loadPackages())
//   packages_save(packages)  <- legacy command handler('packages:save', (_, packages) => { ... })
//
// Both resolve the per-user application-data directory via
// [`crate::accounts::store_dir`] — the SAME resolution the `accounts_*` /
// `settings_*` commands use so a user's existing `%APPDATA%\robloxaccountmanager\`
// files are found (Requirement 11.6) — then delegate to the load/save logic
// above.

/// `packages:load` — return the stored packages list.
///
/// Ports `legacy command handler('packages:load', () => loadPackages())`. Takes no
/// payload (matching the legacy handler's zero-arg signature) and returns the
/// package objects verbatim. Because the Packages_Store is a non-critical store
/// whose read is deliberately permissive (a missing/unreadable/corrupt file
/// reads as `[]`; see [`load_from_file`]), the only failure this command can
/// surface is an inability to resolve the application-data directory.
#[tauri::command]
pub fn packages_load(app: AppHandle) -> Result<Vec<Value>, String> {
    crate::logging::log_command_result("packages_load", (|| {
        let dir = store_dir(&app)?;
        Ok(load_from_dir(&dir))
    })())
}

/// `packages:save` — persist the packages list, returning whether it was written.
///
/// Ports:
/// ```js
/// legacy command handler('packages:save', (_, packages) => {
///   try { savePackages(packages); return true; } catch (e) { return false; }
/// });
/// ```
///
/// Takes the `packages` array (same single parameter, same position as the
/// legacy handler) and returns `true` on a successful write or `false` on any
/// serialize/IO failure, mirroring the handler's boolean result (see
/// [`save_to_file`]). As with [`packages_load`], the only `Err` this command
/// produces is a failure to resolve the application-data directory.
#[tauri::command]
pub fn packages_save(app: AppHandle, packages: Vec<Value>) -> Result<bool, String> {
    crate::logging::log_command_result("packages_save", (|| {
        let dir = store_dir(&app)?;
        Ok(save_to_dir(&dir, &packages))
    })())
}

#[cfg(test)]
mod tests {
    //! Focused unit tests for Task 14.1's `packages.json` load/save logic:
    //! the round-trip, the permissive missing/unreadable/corrupt => `[]` reads,
    //! and the pretty-print write shape. Dependency-free (no `tempfile` crate),
    //! matching the temp-file approach used by the other store modules here.

    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A unique temp directory for a test case, created fresh.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "mr_packages_test_{tag}_{}_{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = unique_temp_dir("missing");
        // No packages.json written.
        assert_eq!(load_from_dir(&dir), Vec::<Value>::new());
    }

    #[test]
    fn save_then_load_round_trips_verbatim() {
        let dir = unique_temp_dir("roundtrip");
        let packages = vec![
            serde_json::json!({
                "id": "pkg-1",
                "name": "Alt Squad",
                "accountIds": ["1700000000000", "1700000000001"],
                "lastLink": "roblox://placeId=123",
            }),
            serde_json::json!({
                "id": "pkg-2",
                "name": "Testing",
                "accountIds": [],
                "lastLink": null,
            }),
        ];

        assert!(save_to_dir(&dir, &packages));
        assert_eq!(load_from_dir(&dir), packages);
    }

    #[test]
    fn save_writes_two_space_pretty_json() {
        let dir = unique_temp_dir("pretty");
        let packages = vec![serde_json::json!({ "name": "X" })];
        assert!(save_to_dir(&dir, &packages));

        let raw = fs::read_to_string(packages_path_in(&dir)).expect("read back");
        // 2-space-pretty, matching `JSON.stringify(p, null, 2)`.
        assert_eq!(raw, "[\n  {\n    \"name\": \"X\"\n  }\n]");
    }

    #[test]
    fn load_corrupt_file_returns_empty() {
        let dir = unique_temp_dir("corrupt");
        fs::write(packages_path_in(&dir), "{ this is not valid json").expect("write corrupt");
        assert_eq!(load_from_dir(&dir), Vec::<Value>::new());
    }

    #[test]
    fn load_non_array_json_returns_empty() {
        let dir = unique_temp_dir("nonarray");
        // Valid JSON, but an object, not the expected array => [] (matches JS,
        // whose consumers expect an array).
        fs::write(packages_path_in(&dir), "{\"not\":\"an array\"}").expect("write object");
        assert_eq!(load_from_dir(&dir), Vec::<Value>::new());
    }

    #[test]
    fn save_empty_list_writes_empty_array() {
        let dir = unique_temp_dir("empty");
        assert!(save_to_dir(&dir, &[]));
        assert_eq!(load_from_dir(&dir), Vec::<Value>::new());
        let raw = fs::read_to_string(packages_path_in(&dir)).expect("read back");
        assert_eq!(raw, "[]");
    }
}
