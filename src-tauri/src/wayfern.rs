//! Standalone Wayfern browser provider.
//!
//! Wayfern is installed from the official Donut manifest as a portable Windows
//! build. The archive is streamed to disk (it is currently about 1 GB), then
//! extracted on a blocking worker so neither RAM nor the async runtime gets
//! hammered. Each Roblox account receives its own persistent user-data folder.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::accounts;
use crate::browser_launcher::{
    self, BrowserSession, OpenBatchItemResult, OpenBatchResult, OpenResult, SessionState,
};
use crate::logging;
use crate::AppState;

pub const WAYFERN_MANIFEST_URL: &str = "https://donutbrowser.com/wayfern.json";
pub const WAYFERN_PROGRESS_EVENT: &str = "wayfern://download-progress";
const WAYFERN_DOWNLOAD_HOST: &str = "download.wayfern.com";
const DEVTOOLS_PORT_FILE: &str = "DevToolsActivePort";

#[derive(Debug, Clone, Deserialize)]
struct WayfernManifest {
    version: String,
    downloads: WayfernDownloads,
}

#[derive(Debug, Clone, Deserialize)]
struct WayfernDownloads {
    #[serde(rename = "windows-x64")]
    windows_x64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledWayfern {
    version: String,
    executable: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WayfernStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WayfernProgress {
    stage: &'static str,
    version: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
}

fn wayfern_root(dir: &Path) -> PathBuf {
    dir.join("wayfern")
}

fn installed_metadata_path(dir: &Path) -> PathBuf {
    wayfern_root(dir).join("installed.json")
}

fn read_installed(dir: &Path) -> Option<(InstalledWayfern, PathBuf)> {
    let root = wayfern_root(dir);
    let raw = fs::read_to_string(installed_metadata_path(dir)).ok()?;
    let metadata: InstalledWayfern = serde_json::from_str(&raw).ok()?;
    let executable = root.join(&metadata.executable);
    if executable.is_file() {
        Some((metadata, executable))
    } else {
        None
    }
}

fn status_from(dir: &Path, latest: Option<String>) -> WayfernStatus {
    let installed = read_installed(dir);
    let version = installed
        .as_ref()
        .map(|(metadata, _)| metadata.version.clone());
    let update_available = match (&version, &latest) {
        (Some(current), Some(latest)) => current != latest,
        _ => false,
    };
    WayfernStatus {
        installed: installed.is_some(),
        version,
        latest_version: latest,
        update_available,
    }
}

async fn fetch_manifest() -> Result<WayfernManifest, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Could not create the Wayfern download client: {e}"))?;
    let response = client
        .get(WAYFERN_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("Could not load the Wayfern manifest: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The Wayfern manifest returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read the Wayfern manifest: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("The Wayfern manifest is invalid: {e}"))
}

fn validated_download_url(manifest: &WayfernManifest) -> Result<String, String> {
    let raw = manifest
        .downloads
        .windows_x64
        .as_deref()
        .ok_or_else(|| "The Wayfern manifest has no windows-x64 download.".to_string())?;
    let parsed =
        url::Url::parse(raw).map_err(|e| format!("The Wayfern windows-x64 URL is invalid: {e}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(WAYFERN_DOWNLOAD_HOST) {
        return Err("The Wayfern manifest returned an untrusted download URL.".to_string());
    }
    Ok(raw.to_string())
}

fn emit_progress(
    app: &AppHandle,
    stage: &'static str,
    version: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| (downloaded_bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
    let _ = app.emit(
        WAYFERN_PROGRESS_EVENT,
        WayfernProgress {
            stage,
            version: version.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    );
}

fn safe_version(version: &str) -> Result<&str, String> {
    if !version.is_empty()
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    {
        Ok(version)
    } else {
        Err("The Wayfern manifest contained an unsafe version string.".to_string())
    }
}

fn find_wayfern_executable(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    let mut fallback = None;
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if name == "wayfern.exe" {
                return Some(path);
            }
            if name.ends_with(".exe") && name.contains("wayfern") && fallback.is_none() {
                fallback = Some(path);
            }
        }
    }
    fallback
}

fn extract_portable_zip(archive: &Path, destination: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(destination)
        .map_err(|e| format!("Could not prepare the Wayfern extraction folder: {e}"))?;
    let file = File::open(archive)
        .map_err(|e| format!("Could not open the downloaded Wayfern archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("The downloaded Wayfern ZIP is invalid: {e}"))?;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("Could not read Wayfern ZIP entry {index}: {e}"))?;
        // enclosed_name rejects absolute paths and ../ traversal (Zip Slip).
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|e| format!("Could not create a Wayfern folder: {e}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create a Wayfern folder: {e}"))?;
        }
        let mut out = File::create(&output)
            .map_err(|e| format!("Could not extract {}: {e}", output.display()))?;
        io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Could not extract {}: {e}", output.display()))?;
    }

    find_wayfern_executable(destination)
        .ok_or_else(|| "The Wayfern archive did not contain wayfern.exe.".to_string())
}

async fn download_and_install(
    app: &AppHandle,
    dir: &Path,
    manifest: &WayfernManifest,
) -> Result<PathBuf, String> {
    let version = safe_version(&manifest.version)?.to_string();
    let download_url = validated_download_url(manifest)?;
    let root = wayfern_root(dir);
    let downloads = root.join("downloads");
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|e| format!("Could not create the Wayfern download folder: {e}"))?;

    let archive = downloads.join(format!("wayfern-{version}.zip.part"));
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(4 * 60 * 60))
        .build()
        .map_err(|e| format!("Could not create the Wayfern download client: {e}"))?;
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Could not start the Wayfern download: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The Wayfern download returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| format!("Could not create the Wayfern archive: {e}"))?;
    let mut downloaded = 0_u64;
    emit_progress(app, "downloading", &version, downloaded, total);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The Wayfern download was interrupted: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not write the Wayfern archive: {e}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        emit_progress(app, "downloading", &version, downloaded, total);
    }
    file.flush()
        .await
        .map_err(|e| format!("Could not finish the Wayfern archive: {e}"))?;
    drop(file);

    emit_progress(app, "extracting", &version, downloaded, total);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let staging = root.join(format!("staging-{version}-{}-{nonce}", std::process::id()));
    let archive_for_worker = archive.clone();
    let staging_for_worker = staging.clone();
    let extracted_executable = tokio::task::spawn_blocking(move || {
        extract_portable_zip(&archive_for_worker, &staging_for_worker)
    })
    .await
    .map_err(|e| format!("The Wayfern extraction worker failed: {e}"))??;

    let final_dir = root.join("versions").join(&version);
    tokio::fs::create_dir_all(final_dir.parent().expect("versions has a parent"))
        .await
        .map_err(|e| format!("Could not create the Wayfern versions folder: {e}"))?;
    if final_dir.exists() {
        tokio::fs::remove_dir_all(&final_dir)
            .await
            .map_err(|e| format!("Could not replace the incomplete Wayfern version: {e}"))?;
    }
    tokio::fs::rename(&staging, &final_dir)
        .await
        .map_err(|e| format!("Could not activate the Wayfern version: {e}"))?;

    let relative_in_staging = extracted_executable
        .strip_prefix(&staging)
        .map_err(|_| "The extracted Wayfern executable escaped its staging folder.".to_string())?;
    let executable = final_dir.join(relative_in_staging);
    let relative_to_root = executable
        .strip_prefix(&root)
        .map_err(|_| "The Wayfern executable is outside its install folder.".to_string())?;
    let metadata = InstalledWayfern {
        version: version.clone(),
        executable: relative_to_root.to_string_lossy().into_owned(),
    };
    let metadata_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|e| format!("Could not serialize the Wayfern install metadata: {e}"))?;
    tokio::fs::write(installed_metadata_path(dir), metadata_json)
        .await
        .map_err(|e| format!("Could not save the Wayfern install metadata: {e}"))?;
    let _ = tokio::fs::remove_file(&archive).await;
    emit_progress(app, "ready", &version, downloaded, total);
    Ok(executable)
}

async fn ensure_installed(
    app: &AppHandle,
    dir: &Path,
    install_lock: Arc<AsyncMutex<()>>,
    allow_existing_offline: bool,
) -> Result<PathBuf, String> {
    let _guard = install_lock.lock().await;
    if allow_existing_offline {
        if let Some((metadata, executable)) = read_installed(dir) {
            emit_progress(app, "ready", &metadata.version, 0, None);
            return Ok(executable);
        }
    }
    let manifest = fetch_manifest().await?;
    if let Some((metadata, executable)) = read_installed(dir) {
        if metadata.version == manifest.version {
            emit_progress(app, "ready", &metadata.version, 0, None);
            return Ok(executable);
        }
    }
    download_and_install(app, dir, &manifest).await
}

fn profile_key(account_id: &str) -> String {
    let sanitized: String = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "account".to_string()
    } else {
        sanitized
    }
}

async fn wait_for_devtools_port(
    child: &mut tokio::process::Child,
    user_data_dir: &Path,
) -> Result<u32, String> {
    let port_file = user_data_dir.join(DEVTOOLS_PORT_FILE);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        if let Ok(raw) = tokio::fs::read_to_string(&port_file).await {
            if let Some(port) = raw
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u32>().ok())
            {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Could not inspect the Wayfern process: {e}"))?
        {
            return Err(format!("Wayfern exited before CDP was ready ({status})."));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Wayfern did not expose its CDP port within 45 seconds.".to_string());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

pub async fn open_account_browser(
    app: &AppHandle,
    dir: &Path,
    sessions: Arc<AsyncMutex<HashMap<String, BrowserSession>>>,
    install_lock: Arc<AsyncMutex<()>>,
    account_id: &str,
) -> OpenResult {
    if !cfg!(target_os = "windows") {
        return OpenResult::err("Standalone Wayfern is available on Windows only.");
    }
    let account = match browser_launcher::load_accounts(dir)
        .unwrap_or_default()
        .into_iter()
        .find(|account| account.id == account_id)
    {
        Some(account) => account,
        None => return OpenResult::err("Account not found."),
    };
    if account.cookie.is_empty() {
        return OpenResult::err(format!(
            "No cookie is stored for {}.",
            browser_launcher::account_label(&account)
        ));
    }

    let tracked = {
        let guard = sessions.lock().await;
        matches!(
            guard.get(account_id).map(|session| session.state),
            Some(SessionState::Opening) | Some(SessionState::Open)
        )
    };
    if tracked {
        let focused = browser_launcher::focus_existing_session(&sessions, account_id).await;
        return OpenResult::deduped(focused.focused);
    }

    let profile_id = format!("wayfern-local:{}", profile_key(account_id));
    browser_launcher::mark_session_opening(&sessions, account_id, &profile_id).await;
    let executable = match ensure_installed(app, dir, install_lock, true).await {
        Ok(path) => path,
        Err(error) => {
            browser_launcher::untrack_session(&sessions, account_id).await;
            logging::log_browser(
                app,
                "error",
                &format!("Standalone Wayfern install failed: {error}"),
                json!({ "accountId": account_id }),
                Some(&account),
                Some(&account.cookie),
                None,
            );
            return OpenResult::err(error);
        }
    };

    let user_data_dir = wayfern_root(dir)
        .join("profiles")
        .join(profile_key(account_id));
    if let Err(error) = tokio::fs::create_dir_all(&user_data_dir).await {
        browser_launcher::untrack_session(&sessions, account_id).await;
        return OpenResult::err(format!(
            "Could not create the Wayfern account profile: {error}"
        ));
    }
    let _ = tokio::fs::remove_file(user_data_dir.join(DEVTOOLS_PORT_FILE)).await;

    let mut child = match tokio::process::Command::new(&executable)
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg("--remote-debugging-port=0")
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            browser_launcher::untrack_session(&sessions, account_id).await;
            return OpenResult::err(format!("Could not start Wayfern: {error}"));
        }
    };

    let cdp_port = match wait_for_devtools_port(&mut child, &user_data_dir).await {
        Ok(port) => port,
        Err(error) => {
            let _ = child.kill().await;
            browser_launcher::untrack_session(&sessions, account_id).await;
            return OpenResult::err(error);
        }
    };
    let injected =
        match browser_launcher::inject_cookie_and_navigate(cdp_port, &account.cookie).await {
            Ok(injected) => injected,
            Err(error) => {
                let _ = child.kill().await;
                browser_launcher::untrack_session(&sessions, account_id).await;
                return OpenResult::err(error);
            }
        };

    // Dropping tokio::process::Child only releases our process handle; it does
    // not terminate Wayfern. The live CDP session owns lifecycle/focus from here.
    drop(child);
    browser_launcher::mark_session_open(
        sessions,
        account_id.to_string(),
        profile_id,
        cdp_port,
        injected,
    )
    .await;
    OpenResult::ok()
}

pub async fn open_account_browsers(
    app: &AppHandle,
    dir: &Path,
    sessions: Arc<AsyncMutex<HashMap<String, BrowserSession>>>,
    install_lock: Arc<AsyncMutex<()>>,
    account_ids: Vec<String>,
) -> OpenBatchResult {
    let total = account_ids.len();
    let mut results = Vec::with_capacity(total);
    for account_id in account_ids {
        let result = open_account_browser(
            app,
            dir,
            Arc::clone(&sessions),
            Arc::clone(&install_lock),
            &account_id,
        )
        .await;
        results.push(OpenBatchItemResult {
            account_id,
            ok: result.ok,
            error: result.error,
            focused: result.focused,
        });
    }
    let opened = results.iter().filter(|result| result.ok).count();
    OpenBatchResult {
        ok: opened == total,
        opened,
        total,
        results,
    }
}

pub fn selected(dir: &Path) -> bool {
    crate::settings::load_from_dir(dir)
        .ok()
        .and_then(|settings| settings.extra.get("browserProvider").cloned())
        .and_then(|value| value.as_str().map(str::to_owned))
        .is_some_and(|provider| provider.eq_ignore_ascii_case("wayfern"))
}

#[tauri::command]
pub async fn browser_wayfern_status(app: AppHandle) -> Result<WayfernStatus, String> {
    let dir = accounts::store_dir(&app)?;
    let latest = fetch_manifest().await.ok().map(|manifest| manifest.version);
    Ok(status_from(&dir, latest))
}

#[tauri::command]
pub async fn browser_wayfern_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WayfernStatus, String> {
    let dir = accounts::store_dir(&app)?;
    let _ = ensure_installed(&app, &dir, Arc::clone(&state.wayfern_install_lock), false).await?;
    let latest = fetch_manifest().await.ok().map(|manifest| manifest.version);
    Ok(status_from(&dir, latest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_selects_only_windows_x64() {
        let manifest: WayfernManifest = serde_json::from_str(
            r#"{"version":"149.0.1","downloads":{"windows-x64":"https://download.wayfern.com/wayfern.zip"}}"#,
        )
        .unwrap();
        assert_eq!(
            validated_download_url(&manifest).unwrap(),
            "https://download.wayfern.com/wayfern.zip"
        );
    }

    #[test]
    fn rejects_manifest_download_from_another_host() {
        let manifest: WayfernManifest = serde_json::from_str(
            r#"{"version":"149.0.1","downloads":{"windows-x64":"https://example.com/wayfern.zip"}}"#,
        )
        .unwrap();
        assert!(validated_download_url(&manifest).is_err());
    }

    #[test]
    fn profile_keys_cannot_escape_the_profile_root() {
        assert_eq!(profile_key("../../account:1"), "______account_1");
    }
}
