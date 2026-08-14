//! Standalone Wayfern browser provider.
//!
//! Wayfern is installed from the official Donut manifest as a portable Windows
//! build. The archive is streamed to disk (it is currently about 1 GB), then
//! extracted on a blocking worker so neither RAM nor the async runtime gets
//! hammered. Each Roblox account receives its own persistent user-data folder.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{stream, StreamExt};
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
const WAYFERN_FINGERPRINT_FILE: &str = "wayfern-fingerprint.json";
const WAYFERN_OPEN_CONCURRENCY: usize = 4;

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
    let percent = if stage == "ready" {
        Some(100.0)
    } else {
        total_bytes
            .filter(|total| *total > 0)
            .map(|total| (downloaded_bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
    };
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
    let mut chromium_launcher = None;
    let mut named_fallback = None;
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
            // Wayfern is Chromium-based and the official portable Windows ZIP
            // currently exposes its main launcher as `chrome.exe`. Helper
            // binaries such as chrome_proxy.exe and chrome_pwa_launcher.exe are
            // deliberately excluded by requiring the exact file name.
            let has_chromium_payload = path.parent().is_some_and(|parent| {
                parent.join("chrome.dll").is_file()
                    && parent.join("resources.pak").is_file()
                    && parent.join("icudtl.dat").is_file()
            });
            if name == "chrome.exe" && has_chromium_payload && chromium_launcher.is_none() {
                chromium_launcher = Some(path);
                continue;
            }
            if name.ends_with(".exe") && name.contains("wayfern") && named_fallback.is_none() {
                named_fallback = Some(path);
            }
        }
    }
    chromium_launcher.or(named_fallback)
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
        .ok_or_else(|| {
            "The Wayfern archive did not contain a supported browser launcher (wayfern.exe or chrome.exe)."
                .to_string()
        })
}

/// A previous build wrote completed downloads with a `.part` suffix and left
/// them behind whenever launcher detection failed. Opening the central
/// directory is a cheap way to distinguish one of those complete ZIPs from a
/// genuinely interrupted download without reading the whole ~1 GB file.
fn is_complete_zip(archive: &Path) -> bool {
    File::open(archive)
        .ok()
        .and_then(|file| zip::ZipArchive::new(file).ok())
        .is_some_and(|zip| !zip.is_empty())
}

fn staging_path(root: &Path, version: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    root.join(format!("staging-{version}-{}-{nonce}", std::process::id()))
}

async fn extract_to_staging(
    root: &Path,
    archive: &Path,
    version: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let staging = staging_path(root, version);
    let archive_for_worker = archive.to_path_buf();
    let staging_for_worker = staging.clone();
    let result = tokio::task::spawn_blocking(move || {
        extract_portable_zip(&archive_for_worker, &staging_for_worker)
    })
    .await
    .map_err(|e| format!("The Wayfern extraction worker failed: {e}"))?;

    match result {
        Ok(executable) => Ok((staging, executable)),
        Err(error) => {
            // Never accumulate another multi-gigabyte half-install after an
            // extraction or launcher-detection failure.
            let _ = tokio::fs::remove_dir_all(&staging).await;
            Err(error)
        }
    }
}

async fn activate_staging(
    dir: &Path,
    root: &Path,
    version: &str,
    staging: &Path,
    extracted_executable: &Path,
) -> Result<PathBuf, String> {
    // Capture the relative launcher path before moving the staging directory.
    // The old implementation did this after rename, relying on purely lexical
    // Path behaviour even though the source path no longer existed.
    let relative_in_staging = extracted_executable
        .strip_prefix(staging)
        .map_err(|_| "The extracted Wayfern executable escaped its staging folder.".to_string())?
        .to_path_buf();

    let final_dir = root.join("versions").join(version);
    tokio::fs::create_dir_all(final_dir.parent().expect("versions has a parent"))
        .await
        .map_err(|e| format!("Could not create the Wayfern versions folder: {e}"))?;
    if final_dir.exists() {
        tokio::fs::remove_dir_all(&final_dir)
            .await
            .map_err(|e| format!("Could not replace the incomplete Wayfern version: {e}"))?;
    }
    tokio::fs::rename(staging, &final_dir)
        .await
        .map_err(|e| format!("Could not activate the Wayfern version: {e}"))?;

    let executable = final_dir.join(relative_in_staging);
    if !executable.is_file() {
        return Err("The activated Wayfern browser launcher is missing.".to_string());
    }
    let relative_to_root = executable
        .strip_prefix(root)
        .map_err(|_| "The Wayfern executable is outside its install folder.".to_string())?;
    let metadata = InstalledWayfern {
        version: version.to_string(),
        executable: relative_to_root.to_string_lossy().into_owned(),
    };
    let metadata_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|e| format!("Could not serialize the Wayfern install metadata: {e}"))?;
    tokio::fs::write(installed_metadata_path(dir), metadata_json)
        .await
        .map_err(|e| format!("Could not save the Wayfern install metadata: {e}"))?;

    Ok(executable)
}

/// Reclaim staging directories left behind by installs that never finished.
///
/// A staging tree is the fully extracted browser — about 1.9 GB — so every
/// cancelled download, crashed extraction or app close mid-install stranded one
/// permanently: the previous implementation only matched the *current* PID and
/// the *current* version, and a leftover directory by definition carries neither.
///
/// The in-memory install mutex cannot coordinate two separate application
/// processes, so a directory whose PID is still live is left alone — that is
/// another instance's active extraction. When the process sweep cannot run at
/// all, only this process's own leftovers are removed.
async fn cleanup_stale_staging(root: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    let live_pids = crate::roblox_process::enumerate_live_pids().await;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if crate::roblox_process::staging_dir_is_abandoned(
            &name.to_string_lossy(),
            live_pids.as_ref(),
        ) {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
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
    // Before, not only after: an install needs roughly 2 GB of headroom, and any
    // orphan sitting here is holding exactly that much.
    cleanup_stale_staging(&root).await;

    let archive = downloads.join(format!("wayfern-{version}.zip.part"));
    let existing_size = tokio::fs::metadata(&archive)
        .await
        .ok()
        .filter(|metadata| metadata.is_file() && metadata.len() > 0)
        .map(|metadata| metadata.len());
    let reusable_archive = if existing_size.is_some() {
        let archive_for_worker = archive.clone();
        tokio::task::spawn_blocking(move || is_complete_zip(&archive_for_worker))
            .await
            .map_err(|e| format!("The Wayfern archive validation worker failed: {e}"))?
    } else {
        false
    };

    let (downloaded, total) = if reusable_archive {
        // A complete archive from the broken detector is already on disk. Reuse
        // it instead of truncating it and making the user download ~1 GB again.
        let size = existing_size.expect("a reusable archive has metadata");
        (size, Some(size))
    } else {
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

        if let Some(expected) = total {
            if downloaded != expected {
                return Err(format!(
                    "The Wayfern download was incomplete: received {downloaded} of {expected} bytes."
                ));
            }
        }
        (downloaded, total)
    };

    emit_progress(app, "extracting", &version, downloaded, total);
    let (staging, extracted_executable) = match extract_to_staging(&root, &archive, &version).await
    {
        Ok(extracted) => extracted,
        Err(error) => {
            // Do not retry the same bad cache forever. A later explicit retry
            // starts from a fresh download; extraction already removed its own
            // partial staging directory.
            let _ = tokio::fs::remove_file(&archive).await;
            return Err(error);
        }
    };
    let executable =
        activate_staging(dir, &root, &version, &staging, &extracted_executable).await?;
    let _ = tokio::fs::remove_file(&archive).await;
    cleanup_stale_staging(&root).await;
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

/// Resolve the app-managed standalone Wayfern executable, installing/updating
/// it from the official Donut manifest when necessary. Browser-backed features
/// outside this module (notably credential login) use this entrypoint so they
/// never fall back to Donut Browser's local API or to an unrelated Chromium.
pub async fn ensure_executable(
    app: &AppHandle,
    dir: &Path,
    install_lock: Arc<AsyncMutex<()>>,
) -> Result<PathBuf, String> {
    ensure_installed(app, dir, install_lock, true).await
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

fn standalone_args(
    user_data_dir: &Path,
    initial_url: &str,
    extra_args: &[&str],
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from(format!("--user-data-dir={}", user_data_dir.display())),
        OsString::from("--remote-debugging-port=0"),
        OsString::from("--remote-allow-origins=*"),
        OsString::from("--force-device-scale-factor=1"),
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
    ];
    args.extend(extra_args.iter().map(OsString::from));
    args.push(OsString::from(initial_url));
    args
}

/// Start the app-managed Wayfern binary as a normal standalone browser and
/// discover its local CDP port. Deliberately avoids chromiumoxide's
/// `Browser::launch`, whose default arguments include `--enable-automation` and
/// make Wayfern route the launch through Donut Browser's paid automation gate.
pub(crate) async fn spawn_standalone(
    executable: &Path,
    user_data_dir: &Path,
    initial_url: &str,
    extra_args: &[&str],
) -> Result<(tokio::process::Child, u32), String> {
    tokio::fs::create_dir_all(user_data_dir)
        .await
        .map_err(|error| format!("Could not create the Wayfern profile: {error}"))?;
    let _ = tokio::fs::remove_file(user_data_dir.join(DEVTOOLS_PORT_FILE)).await;

    let mut command = tokio::process::Command::new(executable);
    command.args(standalone_args(user_data_dir, initial_url, extra_args));
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start standalone Wayfern: {error}"))?;

    match wait_for_devtools_port(&mut child, user_data_dir).await {
        Ok(port) => Ok((child, port)),
        Err(error) => {
            let _ = child.kill().await;
            Err(error)
        }
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
        if focused.ok {
            return OpenResult::deduped(focused.focused);
        }
        // The window is gone but an old CDP entry survived. Remove that corpse
        // and continue with a clean process launch for the same profile.
        browser_launcher::untrack_session(&sessions, account_id).await;
    }

    let profile_id = format!("wayfern-local:{}", profile_key(account_id));
    browser_launcher::mark_session_opening(&sessions, account_id, &profile_id).await;
    let executable = match ensure_installed(app, dir, Arc::clone(&install_lock), true).await {
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
    let fingerprint_path = user_data_dir.join(WAYFERN_FINGERPRINT_FILE);

    // Wayfern/Chromium performs process-singleton setup during startup. Starting
    // four executables on the same tick made bulk-open races collapse into one
    // surviving browser on Windows. Serialize only spawn -> DevTools port; as
    // soon as this profile is independently reachable, release the lane so its
    // cookie injection can overlap with the next profile's startup.
    let startup_guard = install_lock.lock().await;
    let (mut child, cdp_port) = match spawn_standalone(
        &executable,
        &user_data_dir,
        "about:blank",
        &[],
    )
    .await
    {
        Ok(started) => started,
        Err(error) => {
            browser_launcher::untrack_session(&sessions, account_id).await;
            return OpenResult::err(error);
        }
    };
    drop(startup_guard);
    let injected = match browser_launcher::inject_wayfern_cookie_and_navigate(
        cdp_port,
        &account.cookie,
        &fingerprint_path,
    )
    .await
    {
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
    // Waiting for CDP and cookie injection serially made a 10-account batch feel
    // like traffic on Periferico: every browser waited behind the previous one.
    // Start a bounded group together so windows appear promptly without dumping
    // all profiles on disk/CPU at once. Results are restored to request order.
    let mut indexed_results = stream::iter(account_ids.into_iter().enumerate().map(
        |(index, account_id)| {
            let sessions = Arc::clone(&sessions);
            let install_lock = Arc::clone(&install_lock);
            async move {
                let result =
                    open_account_browser(app, dir, sessions, install_lock, &account_id).await;
                (
                    index,
                    OpenBatchItemResult {
                        account_id,
                        ok: result.ok,
                        error: result.error,
                        focused: result.focused,
                    },
                )
            }
        },
    ))
    .buffer_unordered(WAYFERN_OPEN_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    indexed_results.sort_by_key(|(index, _)| *index);
    let results = indexed_results
        .into_iter()
        .map(|(_, result)| result)
        .collect::<Vec<_>>();
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
    // Sweep abandoned staging trees here too, not only inside an install. Each
    // one is ~1.9 GB, and an install that died mid-extraction leaves a tree that
    // the install path alone would never revisit — a user who already has
    // Wayfern would keep paying for it until they happened to reinstall. This
    // command is the Settings panel's mount-time read, so the space comes back
    // simply by opening the page.
    cleanup_stale_staging(&wayfern_root(&dir)).await;
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
    use std::io::Write as _;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "robloxaccountmanager-wayfern-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn standalone_launch_never_enables_paid_browser_automation() {
        let args = standalone_args(
            Path::new(r"C:\temp\wayfern-profile"),
            "about:blank",
            &["--window-size=530,700"],
        );
        let rendered: Vec<String> = args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();

        assert!(rendered.iter().any(|argument| argument == "--remote-debugging-port=0"));
        assert!(rendered.iter().any(|argument| argument == "--window-size=530,700"));
        assert!(!rendered.iter().any(|argument| argument == "--enable-automation"));
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"test").unwrap();
    }

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
    fn finds_official_chrome_launcher_without_selecting_helpers() {
        let root = test_dir("chrome-layout");
        let browser = root.join("wayfern-149_windows_x64");
        touch(&browser.join("chrome_proxy.exe"));
        touch(&browser.join("chrome_pwa_launcher.exe"));
        touch(&browser.join("notification_helper.exe"));
        touch(&browser.join("chrome.dll"));
        touch(&browser.join("resources.pak"));
        touch(&browser.join("icudtl.dat"));
        let expected = browser.join("chrome.exe");
        touch(&expected);

        assert_eq!(find_wayfern_executable(&root), Some(expected));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_bare_unrelated_chrome_executable() {
        let root = test_dir("bare-chrome");
        touch(&root.join("chrome.exe"));
        touch(&root.join("chrome_proxy.exe"));

        assert_eq!(find_wayfern_executable(&root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn complete_cached_zip_extracts_the_official_chromium_layout() {
        let root = test_dir("cached-zip");
        let archive = root.join("wayfern.zip.part");
        let file = File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for name in [
            "wayfern_windows_x64/chrome.exe",
            "wayfern_windows_x64/chrome.dll",
            "wayfern_windows_x64/resources.pak",
            "wayfern_windows_x64/icudtl.dat",
            "wayfern_windows_x64/chrome_proxy.exe",
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"test payload").unwrap();
        }
        zip.finish().unwrap();

        assert!(is_complete_zip(&archive));
        let destination = root.join("extracted");
        let executable = extract_portable_zip(&archive, &destination).unwrap();
        assert_eq!(
            executable,
            destination.join("wayfern_windows_x64").join("chrome.exe")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prefers_a_named_wayfern_launcher_over_chrome_fallback() {
        let root = test_dir("launcher-priority");
        let chrome = root.join("chrome.exe");
        let expected = root.join("nested").join("wayfern.exe");
        touch(&chrome);
        touch(&expected);

        assert_eq!(find_wayfern_executable(&root), Some(expected));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_metadata_recognizes_the_official_chrome_launcher() {
        let dir = test_dir("installed-metadata");
        let root = wayfern_root(&dir);
        let relative = PathBuf::from("versions")
            .join("149.0.7827.116")
            .join("wayfern_windows_x64")
            .join("chrome.exe");
        touch(&root.join(&relative));
        fs::write(
            installed_metadata_path(&dir),
            serde_json::to_vec(&InstalledWayfern {
                version: "149.0.7827.116".to_string(),
                executable: relative.to_string_lossy().into_owned(),
            })
            .unwrap(),
        )
        .unwrap();

        let (metadata, executable) = read_installed(&dir).expect("installation must be detected");
        assert_eq!(metadata.version, "149.0.7827.116");
        assert_eq!(executable, root.join(relative));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profile_keys_cannot_escape_the_profile_root() {
        assert_eq!(profile_key("../../account:1"), "______account_1");
    }
}
