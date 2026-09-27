//! Per-session trace cleanup for the Roblox client's shared local state.
//!
//! Every Roblox client on the machine writes into one `%LOCALAPPDATA%\Roblox`
//! tree, so after account A has played, account B starts on top of A's
//! leftovers: the client cookie jar (`LocalStorage\RobloxCookies.dat`), the
//! client's web-storage blob (`LocalStorage\appStorage.json`), the player logs
//! (which record the signed-in user id and every job joined) and a per-user
//! folder named after the user id (`%LOCALAPPDATA%\Roblox\<userId>`). Those are
//! exactly the artifacts that tie two accounts to one another. This module
//! removes them at the two moments that matter: when an account's client goes
//! away, and right before a fresh client is spawned onto an idle machine.
//!
//! What is deliberately left alone: `GlobalBasicSettings_13.xml` (the user's
//! graphics/FPS settings, which this app itself edits), `ClientSettings`
//! (FFlags), `Versions` / `Downloads` (the installed clients) and the
//! `rbx-storage*` asset cache (hundreds of megabytes that would simply be
//! re-downloaded). Studio logs are never touched either.
//!
//! Every removal is best-effort: a file a still-running client holds open is
//! skipped, never retried, and never reported as an error to the user.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

/// Outcome of one cleanup pass, for the session log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TraceSweep {
    /// Files and folders actually removed.
    pub removed: usize,
    /// Entries that existed but could not be removed (typically still open).
    pub skipped: usize,
}

impl TraceSweep {
    fn absorb(&mut self, other: TraceSweep) {
        self.removed += other.removed;
        self.skipped += other.skipped;
    }

    fn is_empty(self) -> bool {
        self.removed == 0 && self.skipped == 0
    }
}

/// `%LOCALAPPDATA%\Roblox`, the client's shared local-state root.
pub fn roblox_local_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|local| PathBuf::from(local).join("Roblox"))
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| {
                PathBuf::from(home)
                    .join("AppData")
                    .join("Local")
                    .join("Roblox")
            })
        })
}

/// Whether the cleanup is enabled. Absent means enabled: the whole point of an
/// account manager is keeping the accounts apart, so opting out is the choice
/// that has to be explicit.
pub fn is_enabled(app: &AppHandle) -> bool {
    crate::accounts::store_dir(app)
        .ok()
        .and_then(|dir| crate::settings::load_from_dir(&dir).ok())
        .and_then(|settings| settings.clear_traces_on_close)
        .unwrap_or(true)
}

fn remove_file_quiet(path: &Path) -> TraceSweep {
    match fs::remove_file(path) {
        Ok(()) => TraceSweep { removed: 1, skipped: 0 },
        Err(error) if error.kind() == io::ErrorKind::NotFound => TraceSweep::default(),
        Err(_) => TraceSweep { removed: 0, skipped: 1 },
    }
}

fn remove_dir_quiet(path: &Path) -> TraceSweep {
    if !path.is_dir() {
        return TraceSweep::default();
    }
    match fs::remove_dir_all(path) {
        Ok(()) => TraceSweep { removed: 1, skipped: 0 },
        Err(error) if error.kind() == io::ErrorKind::NotFound => TraceSweep::default(),
        Err(_) => TraceSweep { removed: 0, skipped: 1 },
    }
}

/// The session-scoped files the client rewrites for whoever signed in last.
fn shared_trace_files(local: &Path) -> [PathBuf; 2] {
    let storage = local.join("LocalStorage");
    [
        storage.join("RobloxCookies.dat"),
        storage.join("appStorage.json"),
    ]
}

/// True for a Roblox *Player* log file name; Studio logs never match.
pub fn is_player_log_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".log") && lower.contains("_player_")
}

/// True when `user_id` names a per-user state folder this module may remove:
/// a positive numeric Roblox user id, never `0` (the signed-out folder) and
/// never anything that could be a path.
pub fn is_user_state_dir_name(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= 20
        && user_id.bytes().all(|byte| byte.is_ascii_digit())
        && user_id.bytes().any(|byte| byte != b'0')
}

/// Remove the shared cookie jar, web storage and Player logs.
pub fn clear_shared_traces(local: &Path) -> TraceSweep {
    let mut sweep = TraceSweep::default();
    for file in shared_trace_files(local) {
        sweep.absorb(remove_file_quiet(&file));
    }
    if let Ok(entries) = fs::read_dir(local.join("logs")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_file() && is_player_log_name(&name) {
                sweep.absorb(remove_file_quiet(&path));
            }
        }
    }
    sweep
}

/// Remove the per-user folder of one account.
pub fn clear_user_traces(local: &Path, user_id: &str) -> TraceSweep {
    if !is_user_state_dir_name(user_id) {
        return TraceSweep::default();
    }
    remove_dir_quiet(&local.join(user_id))
}

/// Resolve an account id to its Roblox user id from the raw store, without
/// decrypting anything: `userId` is stored in the clear.
pub fn user_id_for_account(app: &AppHandle, account_id: &str) -> Option<String> {
    let dir = crate::accounts::store_dir(app).ok()?;
    let raw = fs::read_to_string(crate::accounts::accounts_path_in(&dir)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .as_array()?
        .iter()
        .find(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(account_id))
        .and_then(|entry| entry.get("userId"))
        .and_then(|value| match value {
            serde_json::Value::String(text) => Some(text.clone()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn report(app: &AppHandle, moment: &str, sweep: TraceSweep, shared: bool) {
    if sweep.is_empty() {
        return;
    }
    crate::logging::send_log(
        app,
        "info",
        "traces",
        &format!(
            "Cleared Roblox client traces {moment}: {} removed, {} still in use.",
            sweep.removed, sweep.skipped
        ),
        serde_json::json!({
            "removed": sweep.removed,
            "skipped": sweep.skipped,
            "shared": shared,
        }),
    );
}

/// Cleanup after one or more accounts closed. Per-user folders go right away;
/// the shared cookie jar, storage and logs only once no Roblox client is left
/// running, because a live client still owns them.
pub async fn sweep_after_close(app: &AppHandle, user_ids: Vec<String>) {
    if !is_enabled(app) {
        return;
    }
    let running = crate::roblox_process::count_roblox_processes().await;
    let sweep = tokio::task::spawn_blocking(move || {
        let Some(local) = roblox_local_dir() else {
            return TraceSweep::default();
        };
        let mut sweep = TraceSweep::default();
        for user_id in &user_ids {
            sweep.absorb(clear_user_traces(&local, user_id));
        }
        if running == 0 {
            sweep.absorb(clear_shared_traces(&local));
        }
        sweep
    })
    .await
    .unwrap_or_default();
    report(app, "after close", sweep, running == 0);
}

/// Cleanup right before a client is spawned onto an idle machine, so the new
/// session never inherits the previous account's cookie jar or storage. A
/// no-op while any client is running: the shared files belong to it.
pub async fn sweep_before_launch(app: &AppHandle) {
    if !is_enabled(app) {
        return;
    }
    if crate::roblox_process::count_roblox_processes().await != 0 {
        return;
    }
    let sweep = tokio::task::spawn_blocking(|| {
        roblox_local_dir()
            .map(|local| clear_shared_traces(&local))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    report(app, "before launch", sweep, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "ram-traces-{name}-{}-{stamp}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn player_log_names_are_recognised_and_studio_logs_are_not() {
        assert!(is_player_log_name(
            "0.700.0.7000000_20260927T120000Z_Player_ABCDE_last.log"
        ));
        assert!(is_player_log_name("x_PLAYER_y.LOG"));
        assert!(!is_player_log_name(
            "0.700.0.7000000_20260927T120000Z_Studio_ABCDE_last.log"
        ));
        assert!(!is_player_log_name("_Player_notes.txt"));
    }

    #[test]
    fn user_state_dir_names_are_positive_numeric_ids_only() {
        assert!(is_user_state_dir_name("11204132003"));
        assert!(!is_user_state_dir_name("0"));
        assert!(!is_user_state_dir_name("000"));
        assert!(!is_user_state_dir_name(""));
        assert!(!is_user_state_dir_name("../Versions"));
        assert!(!is_user_state_dir_name("12ab"));
        assert!(!is_user_state_dir_name("123456789012345678901"));
    }

    #[test]
    fn shared_sweep_removes_cookie_jar_storage_and_player_logs_only() {
        let local = temp_dir("shared");
        let storage = local.join("LocalStorage");
        let logs = local.join("logs");
        fs::create_dir_all(&storage).unwrap();
        fs::create_dir_all(&logs).unwrap();
        fs::write(storage.join("RobloxCookies.dat"), b"jar").unwrap();
        fs::write(storage.join("appStorage.json"), b"{}").unwrap();
        fs::write(storage.join("memProfStorage1.json"), b"{}").unwrap();
        fs::write(logs.join("a_Player_1_last.log"), b"log").unwrap();
        fs::write(logs.join("a_Studio_1_last.log"), b"log").unwrap();
        fs::write(local.join("GlobalBasicSettings_13.xml"), b"<xml/>").unwrap();

        let sweep = clear_shared_traces(&local);

        assert_eq!(sweep, TraceSweep { removed: 3, skipped: 0 });
        assert!(!storage.join("RobloxCookies.dat").exists());
        assert!(!storage.join("appStorage.json").exists());
        assert!(storage.join("memProfStorage1.json").exists());
        assert!(!logs.join("a_Player_1_last.log").exists());
        assert!(logs.join("a_Studio_1_last.log").exists());
        assert!(local.join("GlobalBasicSettings_13.xml").exists());
        // Running again over a clean tree touches nothing.
        assert_eq!(clear_shared_traces(&local), TraceSweep::default());
        let _ = fs::remove_dir_all(&local);
    }

    #[test]
    fn user_sweep_removes_only_that_users_folder() {
        let local = temp_dir("user");
        fs::create_dir_all(local.join("11204132003").join("nested")).unwrap();
        fs::create_dir_all(local.join("9507152883")).unwrap();
        fs::create_dir_all(local.join("0")).unwrap();

        assert_eq!(
            clear_user_traces(&local, "11204132003"),
            TraceSweep { removed: 1, skipped: 0 }
        );
        assert!(!local.join("11204132003").exists());
        assert!(local.join("9507152883").exists());
        assert_eq!(clear_user_traces(&local, "0"), TraceSweep::default());
        assert!(local.join("0").exists());
        assert_eq!(clear_user_traces(&local, "missing"), TraceSweep::default());
        let _ = fs::remove_dir_all(&local);
    }
}
