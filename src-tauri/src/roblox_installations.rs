//! Roblox client discovery, protocol presets, release metadata, and managed
//! deployment installation.
//!
//! The Windows registry is only mutated by the explicit
//! `roblox_protocol_activate` / `roblox_protocol_restore` commands.  Discovery,
//! release lookup, and deployment listing are read-only. Managed deployments
//! live below this application's data directory and never modify Roblox's own
//! `%LOCALAPPDATA%\Roblox\Versions` tree.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::models::{RobloxLaunchMode, Settings};
use crate::{accounts, settings, AppState};

const CLIENT_SETTINGS_BASE: &str =
    "https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer";
const SETUP_CDN_BASE: &str = "https://setup-aws.rbxcdn.com";
const DEPLOYMENT_SOURCE: &str = "setup-aws.rbxcdn.com";
const DEPLOYMENT_PROGRESS_EVENT: &str = "roblox://deployment-progress";
const PROTOCOL_SNAPSHOT_FILE: &str = "roblox-protocol-snapshot.json";
const CUSTOM_PRESETS_FILE: &str = "roblox-custom-presets.json";
const DEPLOYMENTS_DIR: &str = "roblox-deployments";
const INSTALL_METADATA_FILE: &str = "installed.json";
const DOWNLOAD_CONCURRENCY: usize = 4;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_DOWNLOAD_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RobloxLauncherKind {
    Official,
    Bloxstrap,
    Fishstrap,
    Froststrap,
    Voidstrap,
    Nyxstrap,
    OtherBootstrapper,
    Custom,
    MicrosoftStore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionSource {
    UninstallRegistry,
    ProtocolRegistry,
    KnownPath,
    ManagedDeployment,
    UserPreset,
    AppxRegistry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxInstallation {
    pub id: String,
    pub kind: RobloxLauncherKind,
    pub display_name: String,
    pub executable: Option<String>,
    pub install_location: Option<String>,
    pub display_version: Option<String>,
    pub version_guid: Option<String>,
    pub channel: Option<String>,
    pub detected_by: DetectionSource,
    pub protocol_capable: bool,
    pub active_schemes: Vec<String>,
    pub handler_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolHandlerState {
    pub scheme: String,
    pub command: Option<String>,
    pub executable: Option<String>,
    pub arguments: Vec<String>,
    pub installation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxProtocolState {
    pub roblox: ProtocolHandlerState,
    pub roblox_player: ProtocolHandlerState,
    pub snapshot_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxRelease {
    pub channel: String,
    pub version_guid: String,
    pub client_version: String,
    pub bootstrapper_version: Option<String>,
    pub checked_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxDeployment {
    pub id: String,
    pub channel: String,
    pub version_guid: String,
    pub client_version: String,
    pub installed_at: u64,
    pub install_location: String,
    pub executable: String,
    pub size_bytes: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxDeploymentProgress {
    pub operation_id: String,
    pub stage: &'static str,
    pub channel: String,
    pub version_guid: Option<String>,
    pub package_name: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RobloxLaunchPlan {
    /// Delegate the already-authenticated URI to Windows' active handler.
    Protocol,
    /// Spawn an executable with explicit arguments. `tracks_player` is false
    /// for bootstrapper processes because their PID is not RobloxPlayerBeta's.
    Command {
        executable: PathBuf,
        arguments: Vec<String>,
        tracks_player: bool,
    },
}

/// A [`RobloxLaunchPlan`] with the authenticated URI not yet substituted.
///
/// Selecting the client is a sweep of the registry and several install trees;
/// the URI, by contrast, must be minted at the moment of spawn because
/// `build_roblox_uri` embeds `launchtime:{now_ms()}`. Splitting the two lets the
/// expensive half be resolved from a cache — and be resolved *purely*, which is
/// what makes the client-selection matrix testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RobloxLaunchTemplate {
    /// Delegate to Windows' active handler; nothing to substitute.
    Protocol,
    /// Spawn `executable`, substituting the URI for every `%1` in `arguments`.
    Command {
        executable: PathBuf,
        arguments: Vec<String>,
        tracks_player: bool,
    },
}

impl RobloxLaunchTemplate {
    /// Substitute `uri` for the `%1` placeholder, yielding the plan to spawn.
    ///
    /// `%1` is the placeholder Windows itself uses in a registered protocol
    /// command, so a bootstrapper's stored command line needs no rewriting to
    /// fit this shape; the direct-client arms adopt it so one substitution rule
    /// covers every arm.
    pub fn with_uri(self, uri: &str) -> RobloxLaunchPlan {
        match self {
            Self::Protocol => RobloxLaunchPlan::Protocol,
            Self::Command {
                executable,
                arguments,
                tracks_player,
            } => RobloxLaunchPlan::Command {
                executable,
                arguments: arguments
                    .into_iter()
                    .map(|argument| argument.replace("%1", uri))
                    .collect(),
                tracks_player,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDeployment {
    channel: String,
    version_guid: String,
    client_version: String,
    installed_at: u64,
    executable: String,
    size_bytes: u64,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCustomPreset {
    id: String,
    display_name: String,
    executable: String,
    added_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientVersionResponse {
    version: String,
    client_version_upload: String,
    #[serde(default)]
    bootstrapper_version: String,
}

#[derive(Debug, Clone)]
struct PackageManifestEntry {
    name: String,
    md5: String,
    compressed_size: u64,
    uncompressed_size: u64,
    extract_root: String,
}

#[derive(Debug, Clone)]
struct DeploymentManifest {
    base_url: String,
    packages: Vec<PackageManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolKeySnapshot {
    existed: bool,
    description: Option<String>,
    url_protocol: Option<String>,
    default_icon: Option<String>,
    command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolSnapshot {
    version: u32,
    captured_at: u64,
    applied_roblox_command: Option<String>,
    applied_roblox_player_command: Option<String>,
    roblox: ProtocolKeySnapshot,
    roblox_player: ProtocolKeySnapshot,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn normalized_path(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path_without_verbatim_prefix(&resolved)
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn stable_path_id(prefix: &str, value: &str) -> String {
    let digest = Sha256::digest(value.to_ascii_lowercase().as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}:{suffix}")
}

fn path_without_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join("AppData").join("Local"))
        })
}

fn non_blank(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().trim_matches('\0').trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

/// Parse the Windows quoting rules needed by protocol-handler command values.
/// It deliberately does not expand environment variables or execute anything.
pub fn parse_windows_command_line(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut args = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        let mut arg = String::new();
        let mut quoted = false;
        while i < chars.len() {
            if !quoted && chars[i].is_whitespace() {
                break;
            }
            if chars[i] == '\\' {
                let start = i;
                while i < chars.len() && chars[i] == '\\' {
                    i += 1;
                }
                let slash_count = i - start;
                if i < chars.len() && chars[i] == '"' {
                    arg.extend(std::iter::repeat('\\').take(slash_count / 2));
                    if slash_count % 2 == 0 {
                        quoted = !quoted;
                    } else {
                        arg.push('"');
                    }
                    i += 1;
                } else {
                    arg.extend(std::iter::repeat('\\').take(slash_count));
                }
                continue;
            }
            if chars[i] == '"' {
                quoted = !quoted;
                i += 1;
                continue;
            }
            arg.push(chars[i]);
            i += 1;
        }
        args.push(arg);
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
    }
    args
}

fn quote_windows_argument(argument: &str) -> String {
    format!("\"{}\"", argument.replace('"', "\\\""))
}

fn executable_from_command(command: &str) -> Option<PathBuf> {
    parse_windows_command_line(command)
        .into_iter()
        .next()
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_preset_path(&value).unwrap_or_else(|_| PathBuf::from(value)))
}

fn executable_from_registry_value(value: &str) -> Option<PathBuf> {
    // DisplayIcon commonly stores `"C:\\...\\Launcher.exe",0`, while the
    // uninstall/modify values append command-line switches. Taking everything
    // through the first .exe handles both forms without executing the value.
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    let exe_end = lower.find(".exe")? + 4;
    let raw = trimmed[..exe_end].trim().trim_matches('"').trim();
    if raw.is_empty() {
        return None;
    }
    let path = expand_preset_path(raw).unwrap_or_else(|_| PathBuf::from(raw));
    path.is_file().then_some(path)
}

fn version_guid_from_executable(executable: &Path) -> Option<String> {
    executable
        .parent()?
        .file_name()?
        .to_str()
        .filter(|name| name.starts_with("version-"))
        .map(ToOwned::to_owned)
}

fn classify_executable(executable: &Path) -> Option<(RobloxLauncherKind, String)> {
    let name = executable
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    match name.as_str() {
        "robloxplayerbeta.exe" | "robloxplayerlauncher.exe" => {
            Some((RobloxLauncherKind::Official, "Roblox Player".to_string()))
        }
        "bloxstrap.exe" => Some((RobloxLauncherKind::Bloxstrap, "Bloxstrap".to_string())),
        "fishstrap.exe" => Some((RobloxLauncherKind::Fishstrap, "Fishstrap".to_string())),
        "froststrap.exe" => Some((RobloxLauncherKind::Froststrap, "Froststrap".to_string())),
        "voidstrap.exe" => Some((RobloxLauncherKind::Voidstrap, "Voidstrap".to_string())),
        "nyxstrap.exe" => Some((RobloxLauncherKind::Nyxstrap, "Nyxstrap".to_string())),
        _ if looks_like_bootstrapper(executable) => {
            let display_name = executable
                .file_stem()
                .map(|stem| stem.to_string_lossy().trim().to_string())
                .filter(|stem| !stem.is_empty())
                .unwrap_or_else(|| "External Roblox bootstrapper".to_string());
            Some((RobloxLauncherKind::OtherBootstrapper, display_name))
        }
        _ => None,
    }
}

fn is_auxiliary_executable(executable: &Path) -> bool {
    let name = executable
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    [
        "crash",
        "installer",
        "setup",
        "studio",
        "unins",
        "uninstall",
        "update",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn looks_like_bootstrapper(executable: &Path) -> bool {
    if !executable
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        || is_auxiliary_executable(executable)
    {
        return false;
    }
    let stem = executable
        .file_stem()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    stem.contains("strap")
        || stem.contains("bootstrap")
        || stem.contains("plexity")
        || stem.contains("robloxlauncher")
}

fn classify_protocol_executable(executable: &Path) -> Option<(RobloxLauncherKind, String)> {
    classify_executable(executable).or_else(|| {
        executable
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            .then(|| {
                let display_name = executable
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().trim().to_string())
                    .filter(|stem| !stem.is_empty())
                    .unwrap_or_else(|| "Registered Roblox handler".to_string());
                (RobloxLauncherKind::OtherBootstrapper, display_name)
            })
    })
}

fn is_bootstrapper_kind(kind: RobloxLauncherKind) -> bool {
    matches!(
        kind,
        RobloxLauncherKind::Bloxstrap
            | RobloxLauncherKind::Fishstrap
            | RobloxLauncherKind::Froststrap
            | RobloxLauncherKind::Voidstrap
            | RobloxLauncherKind::Nyxstrap
            | RobloxLauncherKind::OtherBootstrapper
    )
}

fn handler_command_for(installation: &RobloxInstallation) -> Option<String> {
    let executable = installation.executable.as_deref()?;
    if let Some(command) = installation
        .handler_command
        .as_ref()
        .filter(|command| command.contains("%1"))
    {
        return Some(command.clone());
    }
    let quoted = quote_windows_argument(executable);
    match installation.kind {
        RobloxLauncherKind::Official | RobloxLauncherKind::Custom => {
            Some(format!("{quoted} \"%1\""))
        }
        // Bloxstrap and its Fishstrap fork both expose the same documented
        // player entry point. An existing registry command always wins above,
        // preserving fork-specific flags when available.
        kind if is_bootstrapper_kind(kind) => Some(format!("{quoted} -player \"%1\"")),
        RobloxLauncherKind::MicrosoftStore => None,
        _ => None,
    }
}

fn protocol_snapshot_path(dir: &Path) -> PathBuf {
    dir.join(PROTOCOL_SNAPSHOT_FILE)
}

fn custom_presets_path(dir: &Path) -> PathBuf {
    dir.join(CUSTOM_PRESETS_FILE)
}

fn deployments_root(dir: &Path) -> PathBuf {
    dir.join(DEPLOYMENTS_DIR)
}

fn deployment_versions_root(dir: &Path) -> PathBuf {
    deployments_root(dir).join("versions")
}

fn normalize_channel(channel: Option<&str>) -> Result<String, String> {
    let value = channel.unwrap_or("LIVE").trim();
    let value = if value.is_empty() { "LIVE" } else { value };
    if value.len() > 64
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("The Roblox channel contains unsupported characters.".to_string());
    }
    if value.eq_ignore_ascii_case("LIVE") || value.eq_ignore_ascii_case("production") {
        Ok("LIVE".to_string())
    } else {
        Ok(value.to_ascii_lowercase())
    }
}

fn normalize_version_guid(value: &str) -> Result<String, String> {
    let raw = value.trim().to_ascii_lowercase();
    let suffix = raw.strip_prefix("version-").unwrap_or(&raw);
    if !(16..=64).contains(&suffix.len()) || !suffix.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("The Roblox version GUID is invalid.".to_string());
    }
    Ok(format!("version-{suffix}"))
}

fn validate_operation_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("The deployment operation id is invalid.".to_string());
    }
    Ok(value.to_string())
}

fn protocol_command(scheme: &str) -> Option<String> {
    protocol_key_snapshot(scheme).ok()?.command
}

#[cfg(target_os = "windows")]
fn registry_string(key: &winreg::RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok()
}

#[cfg(target_os = "windows")]
fn protocol_key_snapshot(scheme: &str) -> Result<ProtocolKeySnapshot, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{scheme}");
    let root = match hkcu.open_subkey(&path) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ProtocolKeySnapshot {
                existed: false,
                description: None,
                url_protocol: None,
                default_icon: None,
                command: None,
            })
        }
        Err(error) => {
            return Err(format!(
                "Could not read {scheme} protocol registration: {error}"
            ))
        }
    };
    let default_icon = root
        .open_subkey("DefaultIcon")
        .ok()
        .and_then(|key| registry_string(&key, ""));
    let command = root
        .open_subkey(r"shell\open\command")
        .ok()
        .and_then(|key| registry_string(&key, ""));
    Ok(ProtocolKeySnapshot {
        existed: true,
        description: registry_string(&root, ""),
        url_protocol: registry_string(&root, "URL Protocol"),
        default_icon,
        command,
    })
}

#[cfg(not(target_os = "windows"))]
fn protocol_key_snapshot(_scheme: &str) -> Result<ProtocolKeySnapshot, String> {
    Ok(ProtocolKeySnapshot {
        existed: false,
        description: None,
        url_protocol: None,
        default_icon: None,
        command: None,
    })
}

#[cfg(target_os = "windows")]
fn set_or_delete_value(key: &winreg::RegKey, name: &str, value: Option<&str>) -> io::Result<()> {
    if let Some(value) = value {
        key.set_value(name, &value)
    } else {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_protocol_registration(
    scheme: &str,
    executable: &Path,
    command: &str,
) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{scheme}");
    let (root, _) = hkcu
        .create_subkey(&path)
        .map_err(|error| format!("Could not register {scheme}: {error}"))?;
    root.set_value("", &"URL: Roblox Protocol")
        .map_err(|error| format!("Could not describe {scheme}: {error}"))?;
    root.set_value("URL Protocol", &"")
        .map_err(|error| format!("Could not mark {scheme} as a URL protocol: {error}"))?;
    let (icon, _) = root
        .create_subkey("DefaultIcon")
        .map_err(|error| format!("Could not register the {scheme} icon: {error}"))?;
    let icon_path = executable.to_string_lossy().into_owned();
    icon.set_value("", &icon_path)
        .map_err(|error| format!("Could not register the {scheme} icon: {error}"))?;
    let (handler, _) = root
        .create_subkey(r"shell\open\command")
        .map_err(|error| format!("Could not register the {scheme} handler: {error}"))?;
    handler
        .set_value("", &command)
        .map_err(|error| format!("Could not register the {scheme} handler: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn apply_protocol_registration(
    _scheme: &str,
    _executable: &Path,
    _command: &str,
) -> Result<(), String> {
    Err("Roblox protocol presets are available on Windows only.".to_string())
}

#[cfg(target_os = "windows")]
fn restore_protocol_registration(scheme: &str, saved: &ProtocolKeySnapshot) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{scheme}");
    if !saved.existed {
        match hkcu.delete_subkey_all(&path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Could not remove {scheme} registration: {error}")),
        }
    }

    let (root, _) = hkcu
        .create_subkey(&path)
        .map_err(|error| format!("Could not restore {scheme}: {error}"))?;
    set_or_delete_value(&root, "", saved.description.as_deref())
        .map_err(|error| format!("Could not restore {scheme} description: {error}"))?;
    set_or_delete_value(&root, "URL Protocol", saved.url_protocol.as_deref())
        .map_err(|error| format!("Could not restore {scheme} URL marker: {error}"))?;
    let (icon, _) = root
        .create_subkey("DefaultIcon")
        .map_err(|error| format!("Could not restore {scheme} icon: {error}"))?;
    set_or_delete_value(&icon, "", saved.default_icon.as_deref())
        .map_err(|error| format!("Could not restore {scheme} icon: {error}"))?;
    let (handler, _) = root
        .create_subkey(r"shell\open\command")
        .map_err(|error| format!("Could not restore {scheme} handler: {error}"))?;
    set_or_delete_value(&handler, "", saved.command.as_deref())
        .map_err(|error| format!("Could not restore {scheme} handler: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn restore_protocol_registration(
    _scheme: &str,
    _saved: &ProtocolKeySnapshot,
) -> Result<(), String> {
    Err("Roblox protocol presets are available on Windows only.".to_string())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not prepare {}: {error}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize {}: {error}", path.display()))?;
    let temp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    fs::write(&temp, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temp.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
    }
    fs::rename(&temp, path)
        .map_err(|error| format!("Could not activate {}: {error}", path.display()))
}

fn load_protocol_snapshot(dir: &Path) -> Result<Option<ProtocolSnapshot>, String> {
    let path = protocol_snapshot_path(dir);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("The protocol snapshot is corrupted: {error}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the protocol snapshot: {error}")),
    }
}

fn load_custom_presets(dir: &Path) -> Result<Vec<StoredCustomPreset>, String> {
    let path = custom_presets_path(dir);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|error| format!("The custom Roblox preset list is corrupted: {error}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Could not read custom Roblox presets: {error}")),
    }
}

fn save_custom_presets(dir: &Path, presets: &[StoredCustomPreset]) -> Result<(), String> {
    write_json_atomic(&custom_presets_path(dir), &presets)
}

fn expand_preset_path(raw: &str) -> Result<PathBuf, String> {
    let mut value = raw.trim().trim_matches('"').trim().to_string();
    if value.is_empty() {
        return Err("Enter the folder or executable path for this preset.".to_string());
    }
    for (token, variable) in [
        ("%LOCALAPPDATA%", "LOCALAPPDATA"),
        ("%APPDATA%", "APPDATA"),
        ("%USERPROFILE%", "USERPROFILE"),
    ] {
        while let Some(start) = value.to_ascii_uppercase().find(token) {
            let replacement = std::env::var(variable)
                .map_err(|_| format!("Windows did not expose {variable}."))?;
            value.replace_range(start..start + token.len(), &replacement);
        }
    }
    if let Some(rest) = value
        .strip_prefix("~\\")
        .or_else(|| value.strip_prefix("~/"))
    {
        let home = std::env::var("USERPROFILE")
            .map_err(|_| "Windows did not expose USERPROFILE.".to_string())?;
        value = PathBuf::from(home)
            .join(rest)
            .to_string_lossy()
            .into_owned();
    }
    Ok(PathBuf::from(value))
}

fn executable_candidates_in(directory: &Path) -> Vec<PathBuf> {
    const KNOWN_EXECUTABLES: &[&str] = &[
        "RobloxPlayerBeta.exe",
        "RobloxPlayerLauncher.exe",
        "Bloxstrap.exe",
        "Fishstrap.exe",
        "Froststrap.exe",
        "Voidstrap.exe",
        "Nyxstrap.exe",
        "Plexity.exe",
    ];
    let mut candidates = KNOWN_EXECUTABLES
        .iter()
        .map(|name| directory.join(name))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file()
                || classify_executable(&path).is_none()
                || candidates
                    .iter()
                    .any(|candidate| normalized_path(candidate) == normalized_path(&path))
            {
                continue;
            }
            candidates.push(path);
        }
    }
    let directory_name = directory
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase());
    candidates.sort_by_key(|candidate| {
        let file_name = candidate
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let exact_directory_launcher = directory_name
            .as_ref()
            .is_some_and(|directory| file_name == format!("{directory}.exe"));
        if file_name == "robloxplayerbeta.exe" {
            0
        } else if exact_directory_launcher {
            1
        } else if classify_executable(candidate)
            .is_some_and(|(kind, _)| kind != RobloxLauncherKind::OtherBootstrapper)
        {
            2
        } else {
            3
        }
    });
    candidates
}

fn resolve_preset_executable(raw: &str) -> Result<PathBuf, String> {
    let path = expand_preset_path(raw)?;
    let executable = if path.is_dir() {
        let candidates = executable_candidates_in(&path);
        match candidates.as_slice() {
            [] => {
                return Err(format!(
                    "No Roblox player or bootstrapper executable was found in {}.",
                    path.display()
                ))
            }
            [single] => single.clone(),
            _ => candidates[0].clone(),
        }
    } else {
        path
    };
    if !executable.is_file() {
        return Err(format!(
            "The preset executable does not exist: {}",
            executable.display()
        ));
    }
    if !executable
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err("A Roblox preset must point to a Windows .exe file or its folder.".to_string());
    }
    fs::canonicalize(&executable)
        .map(|resolved| path_without_verbatim_prefix(&resolved))
        .map_err(|error| {
            format!(
                "Could not resolve the preset executable {}: {error}",
                executable.display()
            )
        })
}

fn custom_preset_installation(preset: &StoredCustomPreset) -> Option<RobloxInstallation> {
    let executable = PathBuf::from(&preset.executable);
    if !executable.is_file() {
        return None;
    }
    let (detected_kind, _) = classify_executable(&executable)?;
    let kind = if detected_kind == RobloxLauncherKind::Official {
        RobloxLauncherKind::Custom
    } else {
        detected_kind
    };
    Some(RobloxInstallation {
        id: preset.id.clone(),
        kind,
        display_name: preset.display_name.clone(),
        executable: Some(executable.to_string_lossy().into_owned()),
        install_location: executable
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        display_version: None,
        version_guid: version_guid_from_executable(&executable),
        channel: None,
        detected_by: DetectionSource::UserPreset,
        protocol_capable: true,
        active_schemes: Vec::new(),
        handler_command: None,
    })
}

fn detect_local_bootstrappers(local: &Path) -> Vec<RobloxInstallation> {
    let Ok(entries) = fs::read_dir(local) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.contains("strap") || matches!(name.as_str(), "plexity" | "robloxlauncher")
        })
        .flat_map(|entry| executable_candidates_in(&entry.path()).into_iter())
        .filter_map(|executable| {
            let (kind, display_name) = classify_executable(&executable)?;
            if kind == RobloxLauncherKind::Official {
                return None;
            }
            let key = normalized_path(&executable);
            Some(RobloxInstallation {
                id: stable_path_id("bootstrapper", &key),
                kind,
                display_name,
                executable: Some(executable.to_string_lossy().into_owned()),
                install_location: executable
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned()),
                display_version: None,
                version_guid: None,
                channel: None,
                detected_by: DetectionSource::KnownPath,
                protocol_capable: true,
                active_schemes: Vec::new(),
                handler_command: None,
            })
        })
        .collect()
}

fn detect_official_versions(local: &Path) -> Vec<RobloxInstallation> {
    let versions = local.join("Roblox").join("Versions");
    let Ok(entries) = fs::read_dir(versions) else {
        return Vec::new();
    };
    let mut found = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let version_guid = entry.file_name().to_string_lossy().to_string();
            if !version_guid.starts_with("version-") {
                return None;
            }
            let executable = entry.path().join("RobloxPlayerBeta.exe");
            if !executable.is_file() {
                return None;
            }
            let modified = executable
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            let key = normalized_path(&executable);
            Some((
                modified,
                RobloxInstallation {
                    id: stable_path_id("official", &key),
                    kind: RobloxLauncherKind::Official,
                    display_name: format!("Roblox {version_guid}"),
                    executable: Some(executable.to_string_lossy().into_owned()),
                    install_location: executable
                        .parent()
                        .map(|parent| parent.to_string_lossy().into_owned()),
                    display_version: None,
                    version_guid: Some(version_guid),
                    channel: None,
                    detected_by: DetectionSource::KnownPath,
                    protocol_capable: true,
                    active_schemes: Vec::new(),
                    handler_command: None,
                },
            ))
        })
        .collect::<Vec<_>>();
    found.sort_by(|left, right| right.0.cmp(&left.0));
    found
        .into_iter()
        .map(|(_, installation)| installation)
        .collect()
}

#[cfg(target_os = "windows")]
fn uninstall_installation(
    key_name: &str,
    id: &str,
    kind: RobloxLauncherKind,
    display_name: &str,
    executable_name: &str,
) -> Option<RobloxInstallation> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{key_name}"
        ))
        .ok()?;
    let stored_install_location = non_blank(registry_string(&key, "InstallLocation"))?;
    let install_location = expand_preset_path(&stored_install_location).ok()?;
    let executable = install_location.join(executable_name);
    if !executable.is_file() {
        return None;
    }
    let version_guid = (kind == RobloxLauncherKind::Official)
        .then(|| version_guid_from_executable(&executable))
        .flatten();
    Some(RobloxInstallation {
        id: id.to_string(),
        kind,
        display_name: non_blank(registry_string(&key, "DisplayName"))
            .unwrap_or_else(|| display_name.to_string()),
        executable: Some(executable.to_string_lossy().into_owned()),
        install_location: Some(install_location.to_string_lossy().into_owned()),
        display_version: non_blank(registry_string(&key, "DisplayVersion")),
        version_guid,
        channel: None,
        detected_by: DetectionSource::UninstallRegistry,
        protocol_capable: true,
        active_schemes: Vec::new(),
        handler_command: None,
    })
}

#[cfg(target_os = "windows")]
fn generic_uninstall_installations() -> Vec<RobloxInstallation> {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    const UNINSTALL_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    let roots = [
        (RegKey::predef(HKEY_CURRENT_USER), KEY_READ, "hkcu"),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            KEY_READ | KEY_WOW64_64KEY,
            "hklm64",
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            KEY_READ | KEY_WOW64_32KEY,
            "hklm32",
        ),
    ];
    let mut found = Vec::new();

    for (root, flags, scope) in roots {
        let Ok(uninstall) = root.open_subkey_with_flags(UNINSTALL_PATH, flags) else {
            continue;
        };
        for key_name in uninstall.enum_keys().filter_map(Result::ok) {
            let Ok(key) = uninstall.open_subkey_with_flags(&key_name, KEY_READ) else {
                continue;
            };
            let display_name =
                non_blank(registry_string(&key, "DisplayName")).unwrap_or_else(|| key_name.clone());
            let display_version = non_blank(registry_string(&key, "DisplayVersion"));
            let mut candidates = Vec::new();

            if let Some(location) = non_blank(registry_string(&key, "InstallLocation"))
                .and_then(|value| expand_preset_path(&value).ok())
                .filter(|path| path.is_dir())
            {
                candidates.extend(executable_candidates_in(&location));
            }
            for value_name in ["DisplayIcon", "ModifyPath", "UninstallString"] {
                if let Some(executable) = non_blank(registry_string(&key, value_name))
                    .and_then(|value| executable_from_registry_value(&value))
                {
                    candidates.push(executable);
                }
            }

            let mut seen = HashMap::<String, ()>::new();
            let selected = candidates.into_iter().find_map(|executable| {
                let path_key = normalized_path(&executable);
                if seen.insert(path_key, ()).is_some() {
                    return None;
                }
                let (kind, detected_name) = classify_executable(&executable)?;
                is_bootstrapper_kind(kind).then_some((executable, kind, detected_name))
            });
            let Some((executable, kind, detected_name)) = selected else {
                continue;
            };
            let path_key = normalized_path(&executable);
            found.push(RobloxInstallation {
                id: stable_path_id(&format!("uninstall-{scope}"), &path_key),
                kind,
                display_name: if display_name.trim().is_empty() {
                    detected_name
                } else {
                    display_name
                },
                executable: Some(executable.to_string_lossy().into_owned()),
                install_location: executable
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned()),
                display_version,
                version_guid: None,
                channel: None,
                detected_by: DetectionSource::UninstallRegistry,
                protocol_capable: true,
                active_schemes: Vec::new(),
                handler_command: None,
            });
        }
    }
    found
}

#[cfg(not(target_os = "windows"))]
fn generic_uninstall_installations() -> Vec<RobloxInstallation> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn uninstall_installation(
    _key_name: &str,
    _id: &str,
    _kind: RobloxLauncherKind,
    _display_name: &str,
    _executable_name: &str,
) -> Option<RobloxInstallation> {
    None
}

fn known_path_installation(
    id: &str,
    kind: RobloxLauncherKind,
    display_name: &str,
    executable: PathBuf,
) -> Option<RobloxInstallation> {
    if !executable.is_file() {
        return None;
    }
    let version_guid = (kind == RobloxLauncherKind::Official)
        .then(|| version_guid_from_executable(&executable))
        .flatten();
    Some(RobloxInstallation {
        id: id.to_string(),
        kind,
        display_name: display_name.to_string(),
        install_location: executable
            .parent()
            .map(|path| path.to_string_lossy().into_owned()),
        executable: Some(executable.to_string_lossy().into_owned()),
        display_version: None,
        version_guid,
        channel: None,
        detected_by: DetectionSource::KnownPath,
        protocol_capable: true,
        active_schemes: Vec::new(),
        handler_command: None,
    })
}

#[cfg(target_os = "windows")]
fn detect_appx_installations() -> Vec<RobloxInstallation> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(packages) = hkcu.open_subkey(
        r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages",
    ) else {
        return Vec::new();
    };

    packages
        .enum_keys()
        .filter_map(Result::ok)
        .filter(|name| name.to_ascii_lowercase().contains("roblox"))
        .map(|name| {
            let root = packages
                .open_subkey(&name)
                .ok()
                .and_then(|key| non_blank(registry_string(&key, "PackageRootFolder")));
            RobloxInstallation {
                id: stable_path_id("microsoft_store", &name),
                kind: RobloxLauncherKind::MicrosoftStore,
                display_name: "Roblox (Microsoft Store)".to_string(),
                executable: None,
                install_location: root,
                display_version: name.split('_').nth(1).map(ToOwned::to_owned),
                version_guid: None,
                channel: None,
                detected_by: DetectionSource::AppxRegistry,
                // Packaged-app activation is not compatible with the auth-ticket
                // direct-spawn path used by this manager.
                protocol_capable: false,
                active_schemes: Vec::new(),
                handler_command: None,
            }
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn detect_appx_installations() -> Vec<RobloxInstallation> {
    Vec::new()
}

fn stored_deployment_at(path: &Path) -> Option<RobloxDeployment> {
    let raw = fs::read_to_string(path.join(INSTALL_METADATA_FILE)).ok()?;
    let stored: StoredDeployment = serde_json::from_str(&raw).ok()?;
    let executable = path.join(&stored.executable);
    if !executable.is_file() {
        return None;
    }
    Some(RobloxDeployment {
        id: format!("custom:{}:{}", stored.channel, stored.version_guid),
        channel: stored.channel,
        version_guid: stored.version_guid,
        client_version: stored.client_version,
        installed_at: stored.installed_at,
        install_location: path.to_string_lossy().into_owned(),
        executable: executable.to_string_lossy().into_owned(),
        size_bytes: stored.size_bytes,
        source: stored.source,
    })
}

pub fn list_deployments_in(dir: &Path) -> Vec<RobloxDeployment> {
    let root = deployment_versions_root(dir);
    let mut deployments = Vec::new();
    let Ok(channels) = fs::read_dir(root) else {
        return deployments;
    };
    for channel in channels.flatten().filter(|entry| entry.path().is_dir()) {
        let Ok(versions) = fs::read_dir(channel.path()) else {
            continue;
        };
        for version in versions.flatten().filter(|entry| entry.path().is_dir()) {
            if let Some(deployment) = stored_deployment_at(&version.path()) {
                deployments.push(deployment);
            }
        }
    }
    deployments.sort_by(|left, right| right.installed_at.cmp(&left.installed_at));
    deployments
}

fn push_deduped(
    installations: &mut Vec<RobloxInstallation>,
    by_executable: &mut HashMap<String, usize>,
    candidate: RobloxInstallation,
) {
    let Some(executable) = candidate.executable.as_deref() else {
        installations.push(candidate);
        return;
    };
    let key = normalized_path(Path::new(executable));
    if let Some(index) = by_executable.get(&key).copied() {
        if candidate.detected_by == DetectionSource::UserPreset {
            let mut preferred = candidate;
            preferred.display_version = preferred
                .display_version
                .or_else(|| installations[index].display_version.clone());
            preferred.channel = preferred
                .channel
                .or_else(|| installations[index].channel.clone());
            installations[index] = preferred;
        } else if installations[index].detected_by != DetectionSource::UserPreset
            && installations[index].detected_by != DetectionSource::UninstallRegistry
            && candidate.detected_by == DetectionSource::UninstallRegistry
        {
            installations[index] = candidate;
        }
        return;
    }
    by_executable.insert(key, installations.len());
    installations.push(candidate);
}

pub fn scan_installations_in(dir: &Path) -> Vec<RobloxInstallation> {
    let mut installations = Vec::new();
    let mut by_executable = HashMap::new();

    for candidate in [
        uninstall_installation(
            "roblox-player",
            "official",
            RobloxLauncherKind::Official,
            "Roblox Player",
            "RobloxPlayerBeta.exe",
        ),
        uninstall_installation(
            "Bloxstrap",
            "bloxstrap",
            RobloxLauncherKind::Bloxstrap,
            "Bloxstrap",
            "Bloxstrap.exe",
        ),
        uninstall_installation(
            "Fishstrap",
            "fishstrap",
            RobloxLauncherKind::Fishstrap,
            "Fishstrap",
            "Fishstrap.exe",
        ),
        uninstall_installation(
            "Froststrap",
            "froststrap",
            RobloxLauncherKind::Froststrap,
            "Froststrap",
            "Froststrap.exe",
        ),
        uninstall_installation(
            "Voidstrap",
            "voidstrap",
            RobloxLauncherKind::Voidstrap,
            "Voidstrap",
            "Voidstrap.exe",
        ),
        uninstall_installation(
            "Nyxstrap",
            "nyxstrap",
            RobloxLauncherKind::Nyxstrap,
            "Nyxstrap",
            "Nyxstrap.exe",
        ),
    ]
    .into_iter()
    .flatten()
    {
        push_deduped(&mut installations, &mut by_executable, candidate);
    }

    // Enumerating every uninstall entry catches custom-location and future
    // *strap/Plexity forks without coupling discovery to a forever-growing
    // hardcoded list. Known clients above keep their stable friendly ids.
    for candidate in generic_uninstall_installations() {
        push_deduped(&mut installations, &mut by_executable, candidate);
    }

    if let Some(local) = local_app_data() {
        for candidate in detect_official_versions(&local) {
            push_deduped(&mut installations, &mut by_executable, candidate);
        }
        for (id, kind, name, executable) in [
            (
                "bloxstrap",
                RobloxLauncherKind::Bloxstrap,
                "Bloxstrap",
                local.join("Bloxstrap").join("Bloxstrap.exe"),
            ),
            (
                "fishstrap",
                RobloxLauncherKind::Fishstrap,
                "Fishstrap",
                local.join("Fishstrap").join("Fishstrap.exe"),
            ),
            (
                "froststrap",
                RobloxLauncherKind::Froststrap,
                "Froststrap",
                local.join("Froststrap").join("Froststrap.exe"),
            ),
            (
                "voidstrap",
                RobloxLauncherKind::Voidstrap,
                "Voidstrap",
                local.join("Voidstrap").join("Voidstrap.exe"),
            ),
            (
                "nyxstrap",
                RobloxLauncherKind::Nyxstrap,
                "Nyxstrap",
                local.join("Nyxstrap").join("Nyxstrap.exe"),
            ),
        ] {
            if let Some(candidate) = known_path_installation(id, kind, name, executable) {
                push_deduped(&mut installations, &mut by_executable, candidate);
            }
        }
        for candidate in detect_local_bootstrappers(&local) {
            push_deduped(&mut installations, &mut by_executable, candidate);
        }
    }

    for candidate in load_custom_presets(dir)
        .unwrap_or_default()
        .iter()
        .filter_map(custom_preset_installation)
    {
        push_deduped(&mut installations, &mut by_executable, candidate);
    }

    for deployment in list_deployments_in(dir) {
        let candidate = RobloxInstallation {
            id: deployment.id,
            kind: RobloxLauncherKind::Custom,
            display_name: format!(
                "Roblox {} ({})",
                deployment.version_guid, deployment.channel
            ),
            executable: Some(deployment.executable),
            install_location: Some(deployment.install_location),
            display_version: Some(deployment.client_version),
            version_guid: Some(deployment.version_guid),
            channel: Some(deployment.channel),
            detected_by: DetectionSource::ManagedDeployment,
            protocol_capable: true,
            active_schemes: Vec::new(),
            handler_command: None,
        };
        push_deduped(&mut installations, &mut by_executable, candidate);
    }

    let raw_protocols = [
        ("roblox", protocol_command("roblox")),
        ("roblox-player", protocol_command("roblox-player")),
    ];
    for (_, command) in &raw_protocols {
        let Some(command) = command else { continue };
        let Some(executable) = executable_from_command(command) else {
            continue;
        };
        let key = normalized_path(&executable);
        if by_executable.contains_key(&key) || !executable.is_file() {
            continue;
        }
        let Some((kind, name)) = classify_protocol_executable(&executable) else {
            continue;
        };
        let candidate = RobloxInstallation {
            id: stable_path_id("protocol", &key),
            kind,
            display_name: name,
            install_location: executable
                .parent()
                .map(|path| path.to_string_lossy().into_owned()),
            executable: Some(executable.to_string_lossy().into_owned()),
            display_version: None,
            version_guid: version_guid_from_executable(&executable),
            channel: None,
            detected_by: DetectionSource::ProtocolRegistry,
            protocol_capable: true,
            active_schemes: Vec::new(),
            handler_command: Some(command.clone()),
        };
        push_deduped(&mut installations, &mut by_executable, candidate);
    }

    installations.extend(detect_appx_installations());

    for installation in &mut installations {
        let Some(executable) = installation.executable.as_deref() else {
            continue;
        };
        let executable_key = normalized_path(Path::new(executable));
        for (scheme, command) in &raw_protocols {
            let Some(command) = command else { continue };
            let Some(active_executable) = executable_from_command(command) else {
                continue;
            };
            if normalized_path(&active_executable) == executable_key {
                installation.active_schemes.push((*scheme).to_string());
                installation.handler_command = Some(command.clone());
            }
        }
        if installation.handler_command.is_none() {
            installation.handler_command = handler_command_for(installation);
        }
    }

    installations.sort_by_key(|installation| match installation.kind {
        RobloxLauncherKind::Official => 0,
        RobloxLauncherKind::Bloxstrap => 1,
        RobloxLauncherKind::Fishstrap => 2,
        RobloxLauncherKind::Froststrap => 3,
        RobloxLauncherKind::Voidstrap => 4,
        RobloxLauncherKind::Nyxstrap => 5,
        RobloxLauncherKind::OtherBootstrapper => 6,
        RobloxLauncherKind::Custom => 7,
        RobloxLauncherKind::MicrosoftStore => 8,
    });
    installations
}

fn protocol_handler_state(
    scheme: &str,
    installations: &[RobloxInstallation],
) -> ProtocolHandlerState {
    let command = protocol_command(scheme);
    let parsed = command
        .as_deref()
        .map(parse_windows_command_line)
        .unwrap_or_default();
    let executable = parsed.first().cloned();
    let installation_id = executable.as_deref().and_then(|executable| {
        let key = normalized_path(Path::new(executable));
        installations.iter().find_map(|installation| {
            installation.executable.as_deref().and_then(|candidate| {
                (normalized_path(Path::new(candidate)) == key).then(|| installation.id.clone())
            })
        })
    });
    ProtocolHandlerState {
        scheme: scheme.to_string(),
        command,
        executable,
        arguments: parsed.into_iter().skip(1).collect(),
        installation_id,
    }
}

/// Protocol state derived from an installation sweep the caller already ran.
///
/// Split out of [`protocol_state_in`] so callers holding a fresh sweep can reuse
/// it. The sweep walks three uninstall registry hives, the AppX package
/// repository and several install trees, so running it twice for one refresh is
/// the single largest cost in the Clients deck.
fn protocol_state_from(dir: &Path, installations: &[RobloxInstallation]) -> RobloxProtocolState {
    RobloxProtocolState {
        roblox: protocol_handler_state("roblox", installations),
        roblox_player: protocol_handler_state("roblox-player", installations),
        snapshot_available: protocol_snapshot_path(dir).is_file(),
    }
}

fn protocol_state_in(dir: &Path) -> RobloxProtocolState {
    protocol_state_from(dir, &scan_installations_in(dir))
}

fn save_launch_selection(
    dir: &Path,
    preset_id: Option<&str>,
    mode: RobloxLaunchMode,
) -> Result<(), String> {
    let mut update = Map::new();
    update.insert(
        "robloxLaunchPresetId".to_string(),
        preset_id.map_or(Value::Null, |id| Value::String(id.to_string())),
    );
    update.insert(
        "robloxLaunchMode".to_string(),
        Value::String(
            match mode {
                RobloxLaunchMode::Direct => "direct",
                RobloxLaunchMode::Protocol => "protocol",
            }
            .to_string(),
        ),
    );
    settings::save_to_dir(dir, &update)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

// ── Cached installation sweep ───────────────────────────────────────────────
//
// Every launch used to run a full `scan_installations_in` just to map the
// selected preset id onto an executable. The sweep is the same one
// `roblox_clients_snapshot` already routes through `spawn_blocking` because it
// is "hundreds of milliseconds of blocking registry and disk I/O", and it was
// being paid once per account in a batch launch, on an async worker, under the
// global launch lock.

/// How long a cached sweep is served before it is re-run regardless of
/// invalidation. Purely a safety net: clients can also appear because the user
/// installed one outside this app, which nothing here can observe.
pub const INSTALL_SCAN_TTL_MS: u64 = 60_000;

/// An installation sweep held in [`AppState`], tagged with the invalidation
/// epoch it was taken under.
#[derive(Debug, Clone)]
pub struct CachedInstallScan {
    installations: Arc<Vec<RobloxInstallation>>,
    captured_at: u64,
    epoch: u64,
}

/// Mark the cached sweep stale. Cheap and synchronous, so the `pub fn` preset
/// commands can call it without an async context.
pub fn invalidate_install_scan(state: &AppState) {
    state.install_scan_epoch.fetch_add(1, Ordering::Release);
}

/// Same as [`invalidate_install_scan`], for callers that only hold an
/// [`AppHandle`] (the state is registered before any command can run, so a
/// missing state simply means there is no cache to invalidate).
pub fn invalidate_install_scan_for(app: &AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<AppState>() {
        invalidate_install_scan(&state);
    }
}

/// Adopt a sweep the caller just ran as the cached one.
///
/// The scan commands already pay for a full sweep on the user's behalf, so
/// warming from their result means the first launch after opening the Clients
/// deck never re-runs it.
pub async fn warm_install_scan(state: &AppState, installations: &[RobloxInstallation]) {
    let epoch = state.install_scan_epoch.load(Ordering::Acquire);
    *state.install_scan.lock().await = Some(CachedInstallScan {
        installations: Arc::new(installations.to_vec()),
        captured_at: now_ms(),
        epoch,
    });
}

/// The cached installation sweep, re-running it on a blocking worker when the
/// cache is empty, stale by epoch, or older than [`INSTALL_SCAN_TTL_MS`].
///
/// The guard is never held across the `spawn_blocking`: doing so would make one
/// slow sweep block every other reader, which is the exact cost this cache
/// exists to remove.
pub async fn cached_installations(
    state: &AppState,
    dir: &Path,
) -> Result<Arc<Vec<RobloxInstallation>>, String> {
    let epoch = state.install_scan_epoch.load(Ordering::Acquire);
    {
        let cache = state.install_scan.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached.epoch == epoch
                && now_ms().saturating_sub(cached.captured_at) < INSTALL_SCAN_TTL_MS
            {
                return Ok(cached.installations.clone());
            }
        }
    }

    let owned = dir.to_path_buf();
    let installations = Arc::new(
        tokio::task::spawn_blocking(move || scan_installations_in(&owned))
            .await
            .map_err(|error| format!("The Roblox client scan could not complete: {error}"))?,
    );
    // An invalidation that landed while the sweep ran wins: storing the result
    // under its now-superseded epoch would leave a cache no reader accepts,
    // which is correct but wasteful, so drop it instead.
    if state.install_scan_epoch.load(Ordering::Acquire) == epoch {
        *state.install_scan.lock().await = Some(CachedInstallScan {
            installations: installations.clone(),
            captured_at: now_ms(),
            epoch,
        });
    }
    Ok(installations)
}

/// Pick the client a launch should use, given an installation sweep and the
/// stored settings.
///
/// Deliberately pure — no registry, no disk, no clock — so the whole selection
/// matrix (protocol mode, official/custom preset, bootstrapper preset, and the
/// fallback) is exercisable in tests. That is also why `fallback_player` is a
/// parameter: the real fallback is "the newest folder under
/// `%LOCALAPPDATA%\Roblox\Versions` that still holds a player", which the caller
/// resolves and hands in.
pub fn resolve_launch_template_from(
    installations: &[RobloxInstallation],
    settings: &Settings,
    fallback_player: Option<&Path>,
) -> RobloxLaunchTemplate {
    if settings.roblox_launch_mode == RobloxLaunchMode::Protocol {
        return RobloxLaunchTemplate::Protocol;
    }
    if let Some(preset_id) = settings.roblox_launch_preset_id.as_deref() {
        if let Some(installation) = installations
            .iter()
            .find(|installation| installation.id == preset_id && installation.protocol_capable)
        {
            if matches!(
                installation.kind,
                RobloxLauncherKind::Official | RobloxLauncherKind::Custom
            ) {
                if let Some(executable) = installation.executable.as_deref() {
                    return RobloxLaunchTemplate::Command {
                        executable: PathBuf::from(executable),
                        arguments: vec!["%1".to_string()],
                        tracks_player: true,
                    };
                }
            } else if is_bootstrapper_kind(installation.kind) {
                if let Some(command) = handler_command_for(installation) {
                    let mut parts = parse_windows_command_line(&command);
                    if !parts.is_empty() {
                        return RobloxLaunchTemplate::Command {
                            executable: PathBuf::from(parts.remove(0)),
                            arguments: parts,
                            tracks_player: false,
                        };
                    }
                }
            }
        }
    }

    match fallback_player {
        Some(executable) => RobloxLaunchTemplate::Command {
            executable: executable.to_path_buf(),
            arguments: vec!["%1".to_string()],
            tracks_player: true,
        },
        None => RobloxLaunchTemplate::Protocol,
    }
}

/// The newest installed official player, used when no preset resolves.
fn fallback_player_executable() -> Option<PathBuf> {
    settings::latest_roblox_version_dir()
        .map(|path| path.join("RobloxPlayerBeta.exe"))
        .filter(|path| path.is_file())
}

/// Resolve the launch template the blocking way: load settings, run a full
/// installation sweep, then select. Callers on an async worker should prefer
/// [`resolve_launch_plan_cached`], which serves the sweep from [`AppState`].
pub fn resolve_launch_template_in(dir: &Path) -> RobloxLaunchTemplate {
    let loaded = settings::load_from_dir(dir).unwrap_or_else(|_| settings::default_settings());
    let installations = if loaded.roblox_launch_mode == RobloxLaunchMode::Protocol {
        // The sweep cannot change a protocol-mode answer, so skip its cost.
        Vec::new()
    } else {
        scan_installations_in(dir)
    };
    resolve_launch_template_from(&installations, &loaded, fallback_player_executable().as_deref())
}

pub fn resolve_launch_plan(dir: &Path, uri: &str) -> RobloxLaunchPlan {
    resolve_launch_template_in(dir).with_uri(uri)
}

/// The launch-path entry point: same selection as [`resolve_launch_plan`], but
/// the installation sweep comes from the shared cache and runs on a blocking
/// worker instead of stalling the async worker that drives the launch.
pub async fn resolve_launch_plan_cached(
    state: &AppState,
    dir: &Path,
    uri: &str,
) -> RobloxLaunchPlan {
    let loaded = settings::load_from_dir(dir).unwrap_or_else(|_| settings::default_settings());
    if loaded.roblox_launch_mode == RobloxLaunchMode::Protocol {
        return RobloxLaunchTemplate::Protocol.with_uri(uri);
    }
    let installations = cached_installations(state, dir).await.unwrap_or_default();
    resolve_launch_template_from(
        &installations,
        &loaded,
        fallback_player_executable().as_deref(),
    )
    .with_uri(uri)
}

async fn latest_release(channel: Option<&str>) -> Result<RobloxRelease, String> {
    let channel = normalize_channel(channel)?;
    let url = if channel == "LIVE" {
        CLIENT_SETTINGS_BASE.to_string()
    } else {
        format!("{CLIENT_SETTINGS_BASE}/channel/{channel}")
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not create the Roblox release client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not query the latest Roblox release: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Roblox release lookup returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read the Roblox release response: {error}"))?;
    let payload: ClientVersionResponse = serde_json::from_str(&body)
        .map_err(|error| format!("The Roblox release response is invalid: {error}"))?;
    Ok(RobloxRelease {
        channel,
        version_guid: normalize_version_guid(&payload.client_version_upload)?,
        client_version: payload.version,
        bootstrapper_version: non_blank(Some(payload.bootstrapper_version)),
        checked_at: now_ms(),
    })
}

fn parse_package_manifest(raw: &str) -> Result<Vec<PackageManifestEntry>, String> {
    let lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.first().copied() != Some("v0") {
        return Err("The Roblox package manifest has an unsupported format.".to_string());
    }
    let body = &lines[1..];
    if body.is_empty() || body.len() % 4 != 0 {
        return Err("The Roblox package manifest is truncated.".to_string());
    }

    let mut packages = Vec::new();
    let mut total_download = 0u64;
    let mut total_extracted = 0u64;
    for chunk in body.chunks_exact(4) {
        let name = chunk[0];
        if name == "RobloxPlayerInstaller.exe" {
            // RDD intentionally assembles a portable client without the updater;
            // including it would immediately replace a selected historical build.
            continue;
        }
        if !name.ends_with(".zip")
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        {
            return Err(format!("Unsupported Roblox package name: {name}"));
        }
        let md5 = chunk[1].to_ascii_lowercase();
        if md5.len() != 32 || !md5.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("Roblox package {name} has an invalid MD5 digest."));
        }
        let compressed_size = chunk[2]
            .parse::<u64>()
            .map_err(|_| format!("Roblox package {name} has an invalid compressed size."))?;
        let uncompressed_size = chunk[3]
            .parse::<u64>()
            .map_err(|_| format!("Roblox package {name} has an invalid expanded size."))?;
        if compressed_size == 0
            || compressed_size > MAX_PACKAGE_BYTES
            || uncompressed_size > MAX_PACKAGE_BYTES
        {
            return Err(format!("Roblox package {name} exceeds the safety limit."));
        }
        let extract_root = package_extract_root(name)
            .ok_or_else(|| format!("Roblox package {name} has no safe extraction mapping."))?;
        total_download = total_download
            .checked_add(compressed_size)
            .ok_or_else(|| "Roblox package sizes overflowed.".to_string())?;
        total_extracted = total_extracted
            .checked_add(uncompressed_size)
            .ok_or_else(|| "Roblox expanded package sizes overflowed.".to_string())?;
        packages.push(PackageManifestEntry {
            name: name.to_string(),
            md5,
            compressed_size,
            uncompressed_size,
            extract_root: extract_root.to_string(),
        });
    }
    if total_download > MAX_TOTAL_DOWNLOAD_BYTES || total_extracted > MAX_TOTAL_EXTRACTED_BYTES {
        return Err("The Roblox deployment exceeds the configured safety limit.".to_string());
    }
    if !packages
        .iter()
        .any(|package| package.name == "RobloxApp.zip")
    {
        return Err("The Roblox manifest does not contain RobloxApp.zip.".to_string());
    }
    Ok(packages)
}

fn package_extract_root(name: &str) -> Option<&'static str> {
    match name {
        "RobloxApp.zip" | "redist.zip" | "shaders.zip" | "ssl.zip" | "WebView2.zip" => Some(""),
        "WebView2RuntimeInstaller.zip" => Some("WebView2RuntimeInstaller"),
        "content-avatar.zip" => Some("content/avatar"),
        "content-configs.zip" => Some("content/configs"),
        "content-fonts.zip" => Some("content/fonts"),
        "content-sky.zip" => Some("content/sky"),
        "content-sounds.zip" => Some("content/sounds"),
        "content-textures2.zip" => Some("content/textures"),
        "content-models.zip" => Some("content/models"),
        "content-platform-fonts.zip" => Some("PlatformContent/pc/fonts"),
        "content-platform-dictionaries.zip" => {
            Some("PlatformContent/pc/shared_compression_dictionaries")
        }
        "content-terrain.zip" => Some("PlatformContent/pc/terrain"),
        "content-textures3.zip" => Some("PlatformContent/pc/textures"),
        "extracontent-luapackages.zip" => Some("ExtraContent/LuaPackages"),
        "extracontent-translations.zip" => Some("ExtraContent/translations"),
        "extracontent-models.zip" => Some("ExtraContent/models"),
        "extracontent-textures.zip" => Some("ExtraContent/textures"),
        "extracontent-places.zip" => Some("ExtraContent/places"),
        _ => None,
    }
}

async fn fetch_deployment_manifest(
    client: &reqwest::Client,
    channel: &str,
    version_guid: &str,
) -> Result<DeploymentManifest, String> {
    let primary = if channel == "LIVE" {
        SETUP_CDN_BASE.to_string()
    } else {
        format!("{SETUP_CDN_BASE}/channel/{channel}")
    };
    let mut bases = vec![primary];
    if channel != "LIVE" {
        bases.push(format!("{SETUP_CDN_BASE}/channel/common"));
    }
    for base_url in bases {
        let url = format!("{base_url}/{version_guid}-rbxPkgManifest.txt");
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("Could not fetch the Roblox package manifest: {error}"))?;
        if response.status().is_success() {
            let raw = response
                .text()
                .await
                .map_err(|error| format!("Could not read the Roblox package manifest: {error}"))?;
            return Ok(DeploymentManifest {
                base_url,
                packages: parse_package_manifest(&raw)?,
            });
        }
        if response.status().as_u16() != 404 {
            return Err(format!(
                "The Roblox package manifest returned HTTP {}.",
                response.status().as_u16()
            ));
        }
    }
    Err(format!(
        "Roblox deployment {version_guid} was not found in channel {channel}."
    ))
}

fn emit_deployment_progress(
    app: &AppHandle,
    operation_id: &str,
    stage: &'static str,
    channel: &str,
    version_guid: Option<&str>,
    package_name: Option<&str>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: Option<String>,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| (downloaded_bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
    let _ = app.emit(
        DEPLOYMENT_PROGRESS_EVENT,
        RobloxDeploymentProgress {
            operation_id: operation_id.to_string(),
            stage,
            channel: channel.to_string(),
            version_guid: version_guid.map(ToOwned::to_owned),
            package_name: package_name.map(ToOwned::to_owned),
            downloaded_bytes,
            total_bytes,
            percent,
            message,
        },
    );
}

async fn download_package(
    app: AppHandle,
    client: reqwest::Client,
    operation_id: String,
    channel: String,
    version_guid: String,
    base_url: String,
    work_dir: PathBuf,
    package: PackageManifestEntry,
    downloaded: Arc<AtomicU64>,
    total: u64,
    cancel: CancellationToken,
) -> Result<(PackageManifestEntry, PathBuf), String> {
    if cancel.is_cancelled() {
        return Err("Deployment installation cancelled.".to_string());
    }
    let url = format!("{base_url}/{version_guid}-{}", package.name);
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download {}: {error}", package.name))?;
    if !response.status().is_success() {
        return Err(format!(
            "Roblox package {} returned HTTP {}.",
            package.name,
            response.status().as_u16()
        ));
    }
    if let Some(length) = response.content_length() {
        if length != package.compressed_size {
            return Err(format!(
                "Roblox package {} advertised {length} bytes; expected {}.",
                package.name, package.compressed_size
            ));
        }
    }
    let output = work_dir.join(&package.name);
    let mut file = tokio::fs::File::create(&output)
        .await
        .map_err(|error| format!("Could not create {}: {error}", output.display()))?;
    let mut stream = response.bytes_stream();
    let mut size = 0u64;
    let mut digest = md5::Context::new();
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            return Err("Deployment installation cancelled.".to_string());
        }
        let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
        size = size.saturating_add(chunk.len() as u64);
        if size > package.compressed_size {
            return Err(format!(
                "Roblox package {} exceeded its manifest size.",
                package.name
            ));
        }
        digest.consume(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write {}: {error}", output.display()))?;
        let aggregate =
            downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
        emit_deployment_progress(
            &app,
            &operation_id,
            "downloading",
            &channel,
            Some(&version_guid),
            Some(&package.name),
            aggregate,
            Some(total),
            None,
        );
    }
    file.flush()
        .await
        .map_err(|error| format!("Could not finish {}: {error}", output.display()))?;
    if size != package.compressed_size {
        return Err(format!(
            "Roblox package {} is incomplete: received {size} of {} bytes.",
            package.name, package.compressed_size
        ));
    }
    let actual = format!("{:x}", digest.compute());
    if actual != package.md5 {
        return Err(format!(
            "Roblox package {} failed MD5 verification.",
            package.name
        ));
    }
    Ok((package, output))
}

fn extract_package(
    archive: &Path,
    destination: &Path,
    package: &PackageManifestEntry,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let file = File::open(archive)
        .map_err(|error| format!("Could not open {}: {error}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| {
        format!(
            "Roblox package {} is not a valid ZIP: {error}",
            package.name
        )
    })?;
    let root = destination.join(&package.extract_root);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        if cancel.is_cancelled() {
            return Err("Deployment installation cancelled.".to_string());
        }
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("Could not read {} entry {index}: {error}", package.name))?;
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| format!("Roblox package {} expanded size overflowed.", package.name))?;
        if expanded > package.uncompressed_size {
            return Err(format!(
                "Roblox package {} exceeded its declared expanded size.",
                package.name
            ));
        }
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!(
                "Roblox package {} contains an unsafe path.",
                package.name
            ));
        };
        let output = root.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Could not create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        let mut out = File::create(&output)
            .map_err(|error| format!("Could not extract {}: {error}", output.display()))?;
        io::copy(&mut entry, &mut out)
            .map_err(|error| format!("Could not extract {}: {error}", output.display()))?;
    }
    Ok(())
}

fn directory_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.metadata() {
                Ok(metadata) if metadata.is_dir() => stack.push(path),
                Ok(metadata) if metadata.is_file() => {
                    total = total.saturating_add(metadata.len());
                }
                _ => {}
            }
        }
    }
    total
}

/// Reclaim assembled-but-never-activated deployment trees.
///
/// Same convention and same failure mode as the Wayfern staging store: the name
/// carries the PID that created it, and anything left by an earlier run of the
/// app has a PID that will never match the current one again, so a per-PID
/// filter alone never reclaimed it. A directory belonging to a live process is
/// another instance's in-flight install and is left alone.
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

async fn install_deployment_inner(
    app: &AppHandle,
    dir: &Path,
    operation_id: &str,
    channel: &str,
    requested_version: Option<&str>,
    cancel: CancellationToken,
) -> Result<RobloxDeployment, String> {
    emit_deployment_progress(
        app,
        operation_id,
        "resolving_manifest",
        channel,
        requested_version,
        None,
        0,
        None,
        None,
    );
    let release = if let Some(version) = requested_version {
        let latest = latest_release(Some(channel)).await?;
        RobloxRelease {
            channel: channel.to_string(),
            version_guid: normalize_version_guid(version)?,
            client_version: if normalize_version_guid(version)? == latest.version_guid {
                latest.client_version
            } else {
                "unknown".to_string()
            },
            bootstrapper_version: None,
            checked_at: now_ms(),
        }
    } else {
        latest_release(Some(channel)).await?
    };
    if cancel.is_cancelled() {
        return Err("Deployment installation cancelled.".to_string());
    }

    let final_dir = deployment_versions_root(dir)
        .join(&release.channel)
        .join(&release.version_guid);
    if let Some(existing) = stored_deployment_at(&final_dir) {
        return Ok(existing);
    }

    let root = deployments_root(dir);
    // A multi-gigabyte download should not start on top of the wreckage of the
    // previous attempt.
    cleanup_stale_staging(&root).await;
    let work_dir = root.join("work").join(operation_id);
    let staging_dir = root.join(format!(
        "staging-{}-{}-{}-{}",
        release.channel,
        release.version_guid,
        std::process::id(),
        now_ms()
    ));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|error| format!("Could not prepare deployment downloads: {error}"))?;
    tokio::fs::create_dir_all(&staging_dir)
        .await
        .map_err(|error| format!("Could not prepare deployment staging: {error}"))?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(4 * 60 * 60))
        .build()
        .map_err(|error| format!("Could not create the deployment client: {error}"))?;
    let manifest =
        fetch_deployment_manifest(&client, &release.channel, &release.version_guid).await?;
    let total = manifest
        .packages
        .iter()
        .map(|package| package.compressed_size)
        .sum::<u64>();
    let downloaded = Arc::new(AtomicU64::new(0));
    let tasks = futures_util::stream::iter(manifest.packages.clone().into_iter().map(|package| {
        download_package(
            app.clone(),
            client.clone(),
            operation_id.to_string(),
            release.channel.clone(),
            release.version_guid.clone(),
            manifest.base_url.clone(),
            work_dir.clone(),
            package,
            downloaded.clone(),
            total,
            cancel.clone(),
        )
    }))
    .buffer_unordered(DOWNLOAD_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut archives = Vec::new();
    for task in tasks {
        archives.push(task?);
    }
    for (package, archive) in &archives {
        if cancel.is_cancelled() {
            return Err("Deployment installation cancelled.".to_string());
        }
        emit_deployment_progress(
            app,
            operation_id,
            "extracting",
            &release.channel,
            Some(&release.version_guid),
            Some(&package.name),
            total,
            Some(total),
            None,
        );
        let archive = archive.clone();
        let staging = staging_dir.clone();
        let package = package.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || extract_package(&archive, &staging, &package, &token))
            .await
            .map_err(|error| format!("The package extraction worker failed: {error}"))??;
    }

    let app_settings = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Settings>\n\t<ContentFolder>content</ContentFolder>\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n";
    tokio::fs::write(staging_dir.join("AppSettings.xml"), app_settings)
        .await
        .map_err(|error| format!("Could not write AppSettings.xml: {error}"))?;
    let executable = staging_dir.join("RobloxPlayerBeta.exe");
    if !executable.is_file() {
        return Err("The assembled deployment does not contain RobloxPlayerBeta.exe.".to_string());
    }
    if cancel.is_cancelled() {
        return Err("Deployment installation cancelled.".to_string());
    }
    let staging_for_size = staging_dir.clone();
    let size_bytes = tokio::task::spawn_blocking(move || directory_size(&staging_for_size))
        .await
        .map_err(|error| format!("The deployment size worker failed: {error}"))?;
    let stored = StoredDeployment {
        channel: release.channel.clone(),
        version_guid: release.version_guid.clone(),
        client_version: release.client_version.clone(),
        installed_at: now_ms(),
        executable: "RobloxPlayerBeta.exe".to_string(),
        size_bytes,
        source: DEPLOYMENT_SOURCE.to_string(),
    };
    let metadata = serde_json::to_vec_pretty(&stored)
        .map_err(|error| format!("Could not serialize deployment metadata: {error}"))?;
    tokio::fs::write(staging_dir.join(INSTALL_METADATA_FILE), metadata)
        .await
        .map_err(|error| format!("Could not save deployment metadata: {error}"))?;

    emit_deployment_progress(
        app,
        operation_id,
        "activating",
        &release.channel,
        Some(&release.version_guid),
        None,
        total,
        Some(total),
        None,
    );
    if final_dir.exists() {
        tokio::fs::remove_dir_all(&final_dir)
            .await
            .map_err(|error| format!("Could not replace the incomplete deployment: {error}"))?;
    }
    if let Some(parent) = final_dir.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not prepare the versions folder: {error}"))?;
    }
    tokio::fs::rename(&staging_dir, &final_dir)
        .await
        .map_err(|error| format!("Could not activate the Roblox deployment: {error}"))?;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    stored_deployment_at(&final_dir)
        .ok_or_else(|| "The activated deployment metadata could not be read.".to_string())
}

#[tauri::command]
pub fn roblox_custom_preset_add(
    app: AppHandle,
    path: String,
    display_name: Option<String>,
) -> Result<RobloxInstallation, String> {
    crate::platform::ensure_windows()?;
    let dir = accounts::store_dir(&app)?;
    let executable = resolve_preset_executable(&path)?;
    let executable_key = normalized_path(&executable);
    let (detected_kind, detected_name) = classify_executable(&executable)
        .ok_or_else(|| "The selected file is not a Windows executable.".to_string())?;
    let version_guid = version_guid_from_executable(&executable);
    let fallback_name = if detected_kind == RobloxLauncherKind::Official {
        version_guid
            .as_ref()
            .map(|version| format!("Roblox {version}"))
            .unwrap_or_else(|| "Custom Roblox Player".to_string())
    } else {
        detected_name
    };
    let display_name = display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&fallback_name)
        .to_string();
    if display_name.len() > 80 || display_name.chars().any(char::is_control) {
        return Err("The preset label must be 80 characters or fewer.".to_string());
    }
    let preset = StoredCustomPreset {
        id: stable_path_id("user", &executable_key),
        display_name,
        executable: executable.to_string_lossy().into_owned(),
        added_at: now_ms(),
    };
    let mut presets = load_custom_presets(&dir)?;
    presets.retain(|existing| {
        existing.id != preset.id
            && normalized_path(Path::new(&existing.executable)) != executable_key
    });
    presets.push(preset.clone());
    presets.sort_by(|left, right| right.added_at.cmp(&left.added_at));
    save_custom_presets(&dir, &presets)?;
    invalidate_install_scan_for(&app);
    custom_preset_installation(&preset)
        .ok_or_else(|| "The saved Roblox preset could not be resolved.".to_string())
}

#[tauri::command]
pub fn roblox_custom_preset_remove(
    app: AppHandle,
    installation_id: String,
) -> Result<bool, String> {
    let dir = accounts::store_dir(&app)?;
    let mut presets = load_custom_presets(&dir)?;
    let before = presets.len();
    presets.retain(|preset| preset.id != installation_id);
    if presets.len() == before {
        return Ok(false);
    }
    save_custom_presets(&dir, &presets)?;
    invalidate_install_scan_for(&app);
    if settings::load_from_dir(&dir)
        .ok()
        .and_then(|loaded| loaded.roblox_launch_preset_id)
        .as_deref()
        == Some(installation_id.as_str())
    {
        save_launch_selection(&dir, None, RobloxLaunchMode::Direct)?;
    }
    Ok(true)
}

/// Event emitted when the Windows `roblox://` / `roblox-player:` handlers are
/// rewritten by something other than this application.
pub const PROTOCOL_CHANGED_EVENT: &str = "roblox://protocol-changed";

/// How often the handler registration is re-read. This is two small registry
/// value reads — deliberately NOT the full installation sweep — so it is cheap
/// enough to run for the lifetime of the app.
const PROTOCOL_WATCH_INTERVAL_SECS: u64 = 5;

/// Watch the Windows protocol registration and emit [`PROTOCOL_CHANGED_EVENT`]
/// whenever it stops matching what was last observed.
///
/// Roblox's own bootstrapper — and every *strap fork — reclaims these keys on
/// launch and on update, so the Clients deck's picture of "who handles
/// roblox://" goes stale with no action from this app and no way to notice.
/// Emitting on change lets the UI re-read instead of showing a binding that is
/// no longer real.
///
/// The first observation only establishes the baseline; it never emits.
pub fn spawn_protocol_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<(Option<String>, Option<String>)> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(PROTOCOL_WATCH_INTERVAL_SECS)).await;
            // Registry reads are blocking, so they stay off the async worker.
            let observed = tokio::task::spawn_blocking(|| {
                (
                    protocol_key_snapshot("roblox")
                        .ok()
                        .and_then(|snapshot| snapshot.command),
                    protocol_key_snapshot("roblox-player")
                        .ok()
                        .and_then(|snapshot| snapshot.command),
                )
            })
            .await;
            let Ok(current) = observed else { continue };
            if last.as_ref().is_some_and(|previous| previous != &current) {
                let _ = app.emit(PROTOCOL_CHANGED_EVENT, ());
            }
            last = Some(current);
        }
    });
}

/// Everything the Clients deck reads, produced by a single installation sweep.
///
/// The deck needs the installation list, the protocol handlers derived from it,
/// and the managed deployment library. Serving all three from one command keeps
/// the sweep to a single run per refresh; requesting them as separate commands
/// ran it twice, because protocol state derives from a sweep of its own.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RobloxClientsSnapshot {
    pub installations: Vec<RobloxInstallation>,
    pub protocol: RobloxProtocolState,
    pub deployments: Vec<RobloxDeployment>,
}

/// `roblox_clients_snapshot` — one sweep serving the whole Clients deck.
#[tauri::command]
pub async fn roblox_clients_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RobloxClientsSnapshot, String> {
    let dir = accounts::store_dir(&app)?;
    // Off the main thread: the sweep is hundreds of milliseconds of blocking
    // registry and disk I/O, and a plain `fn` command runs on Tauri's main
    // thread, freezing the window for its whole duration.
    let snapshot = tokio::task::spawn_blocking(move || {
        let installations = scan_installations_in(&dir);
        let protocol = protocol_state_from(&dir, &installations);
        let deployments = list_deployments_in(&dir);
        RobloxClientsSnapshot {
            installations,
            protocol,
            deployments,
        }
    })
    .await
    .map_err(|error| format!("The Roblox client scan could not complete: {error}"))?;
    // Warmed rather than invalidated: this sweep is as fresh as one taken now.
    warm_install_scan(&state, &snapshot.installations).await;
    Ok(snapshot)
}

#[tauri::command]
pub async fn roblox_installations_scan(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<RobloxInstallation>, String> {
    let dir = accounts::store_dir(&app)?;
    let installations = tokio::task::spawn_blocking(move || scan_installations_in(&dir))
        .await
        .map_err(|error| format!("The Roblox client scan could not complete: {error}"))?;
    warm_install_scan(&state, &installations).await;
    Ok(installations)
}

#[tauri::command]
pub async fn roblox_protocol_state(app: AppHandle) -> Result<RobloxProtocolState, String> {
    let dir = accounts::store_dir(&app)?;
    tokio::task::spawn_blocking(move || protocol_state_in(&dir))
        .await
        .map_err(|error| format!("The Roblox protocol state could not be read: {error}"))
}

#[tauri::command]
pub async fn roblox_protocol_activate(
    app: AppHandle,
    state: State<'_, AppState>,
    installation_id: String,
) -> Result<RobloxProtocolState, String> {
    crate::platform::ensure_windows()?;
    let dir = accounts::store_dir(&app)?;
    let activated = tokio::task::spawn_blocking(move || activate_protocol_in(&dir, &installation_id))
        .await
        .map_err(|error| format!("The Roblox protocol change could not complete: {error}"))?;
    // A sweep records each installation's `active_schemes`, so rewriting the
    // handlers changes what a sweep would return even though no client moved.
    invalidate_install_scan(&state);
    activated
}

/// The blocking body of [`roblox_protocol_activate`]: registry snapshot, handler
/// rewrite, and rollback on any failure.
fn activate_protocol_in(
    dir: &Path,
    installation_id: &str,
) -> Result<RobloxProtocolState, String> {
    // Kept as a list so the closing protocol read can reuse this sweep.
    let installations = scan_installations_in(dir);
    let installation = installations
        .iter()
        .find(|installation| installation.id == installation_id)
        .cloned()
        .ok_or_else(|| "The selected Roblox installation was not found.".to_string())?;
    if !installation.protocol_capable {
        return Err("The selected Roblox client cannot handle roblox:// links.".to_string());
    }
    let executable = installation
        .executable
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or_else(|| "The selected Roblox launcher executable is missing.".to_string())?;
    let command = handler_command_for(&installation)
        .ok_or_else(|| "The selected installation has no protocol command.".to_string())?;

    let current_roblox = protocol_key_snapshot("roblox")?;
    let current_player = protocol_key_snapshot("roblox-player")?;
    let existing_snapshot = load_protocol_snapshot(&dir)?;
    let mut snapshot = existing_snapshot
        .clone()
        .unwrap_or_else(|| ProtocolSnapshot {
            version: 1,
            captured_at: now_ms(),
            applied_roblox_command: None,
            applied_roblox_player_command: None,
            roblox: current_roblox.clone(),
            roblox_player: current_player.clone(),
        });
    write_json_atomic(&protocol_snapshot_path(&dir), &snapshot)?;

    let apply_result = (|| {
        apply_protocol_registration("roblox", &executable, &command)?;
        apply_protocol_registration("roblox-player", &executable, &command)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = apply_result {
        let _ = restore_protocol_registration("roblox", &current_roblox);
        let _ = restore_protocol_registration("roblox-player", &current_player);
        return Err(error);
    }

    snapshot.applied_roblox_command = Some(command.clone());
    snapshot.applied_roblox_player_command = Some(command);
    if let Err(error) = write_json_atomic(&protocol_snapshot_path(&dir), &snapshot) {
        let _ = restore_protocol_registration("roblox", &current_roblox);
        let _ = restore_protocol_registration("roblox-player", &current_player);
        return Err(error);
    }
    if let Err(error) =
        save_launch_selection(&dir, Some(&installation.id), RobloxLaunchMode::Protocol)
    {
        let _ = restore_protocol_registration("roblox", &current_roblox);
        let _ = restore_protocol_registration("roblox-player", &current_player);
        if let Some(previous) = existing_snapshot {
            let _ = write_json_atomic(&protocol_snapshot_path(&dir), &previous);
        }
        return Err(format!(
            "Protocol changed but settings could not be saved: {error}"
        ));
    }
    // The registry changed but the installed clients did not, so the sweep taken
    // at the top of this function still describes them.
    Ok(protocol_state_from(dir, &installations))
}

#[tauri::command]
pub async fn roblox_protocol_restore(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RobloxProtocolState, String> {
    crate::platform::ensure_windows()?;
    let dir = accounts::store_dir(&app)?;
    let restored = tokio::task::spawn_blocking(move || restore_protocol_in(&dir))
        .await
        .map_err(|error| format!("The Roblox protocol restore could not complete: {error}"))?;
    invalidate_install_scan(&state);
    restored
}

/// The blocking body of [`roblox_protocol_restore`].
fn restore_protocol_in(dir: &Path) -> Result<RobloxProtocolState, String> {
    let snapshot = load_protocol_snapshot(&dir)?
        .ok_or_else(|| "No Roblox protocol snapshot is available.".to_string())?;
    let current_roblox = protocol_key_snapshot("roblox")?;
    let current_player = protocol_key_snapshot("roblox-player")?;
    if let Some(expected) = snapshot.applied_roblox_command.as_deref() {
        if current_roblox.command.as_deref() != Some(expected) {
            return Err("The roblox:// handler changed after this preset was applied; refusing to overwrite it.".to_string());
        }
    }
    if let Some(expected) = snapshot.applied_roblox_player_command.as_deref() {
        if current_player.command.as_deref() != Some(expected) {
            return Err("The roblox-player: handler changed after this preset was applied; refusing to overwrite it.".to_string());
        }
    }
    let restored = (|| {
        restore_protocol_registration("roblox", &snapshot.roblox)?;
        restore_protocol_registration("roblox-player", &snapshot.roblox_player)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = restored {
        let _ = restore_protocol_registration("roblox", &current_roblox);
        let _ = restore_protocol_registration("roblox-player", &current_player);
        return Err(error);
    }
    if let Err(error) = save_launch_selection(&dir, None, RobloxLaunchMode::Direct) {
        let _ = restore_protocol_registration("roblox", &current_roblox);
        let _ = restore_protocol_registration("roblox-player", &current_player);
        return Err(format!(
            "Protocols restored but settings could not be saved: {error}"
        ));
    }
    let _ = fs::remove_file(protocol_snapshot_path(&dir));
    Ok(protocol_state_in(&dir))
}

#[tauri::command]
pub async fn roblox_release_latest(channel: Option<String>) -> Result<RobloxRelease, String> {
    latest_release(channel.as_deref()).await
}

#[tauri::command]
pub async fn roblox_deployments_list(app: AppHandle) -> Result<Vec<RobloxDeployment>, String> {
    let dir = accounts::store_dir(&app)?;
    tokio::task::spawn_blocking(move || list_deployments_in(&dir))
        .await
        .map_err(|error| format!("The deployment library could not be read: {error}"))
}

#[tauri::command]
pub async fn roblox_deployment_cancel(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<bool, String> {
    let token = state
        .roblox_deployment_cancellations
        .lock()
        .await
        .get(&operation_id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn roblox_deployment_install(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: String,
    channel: Option<String>,
    version_guid: Option<String>,
) -> Result<RobloxDeployment, String> {
    crate::platform::ensure_windows()?;
    let operation_id = validate_operation_id(&operation_id)?;
    let channel = normalize_channel(channel.as_deref())?;
    let version_guid = version_guid
        .as_deref()
        .map(normalize_version_guid)
        .transpose()?;
    let dir = accounts::store_dir(&app)?;
    let cancel = CancellationToken::new();
    {
        let mut operations = state.roblox_deployment_cancellations.lock().await;
        if operations.contains_key(&operation_id) {
            return Err("A deployment operation with this id is already running.".to_string());
        }
        operations.insert(operation_id.clone(), cancel.clone());
    }

    let _install_guard = state.roblox_deployment_install_lock.lock().await;
    let result = install_deployment_inner(
        &app,
        &dir,
        &operation_id,
        &channel,
        version_guid.as_deref(),
        cancel.clone(),
    )
    .await;
    state
        .roblox_deployment_cancellations
        .lock()
        .await
        .remove(&operation_id);

    match result {
        Ok(deployment) => {
            emit_deployment_progress(
                &app,
                &operation_id,
                "ready",
                &channel,
                Some(&deployment.version_guid),
                None,
                deployment.size_bytes,
                Some(deployment.size_bytes),
                None,
            );
            // `scan_installations_in` publishes every managed deployment as a
            // launchable `custom:{channel}:{guid}` installation, so the new build
            // must be visible to the next launch without a Clients-deck visit.
            invalidate_install_scan(&state);
            Ok(deployment)
        }
        Err(error) => {
            let cancelled =
                cancel.is_cancelled() || error.to_ascii_lowercase().contains("cancelled");
            emit_deployment_progress(
                &app,
                &operation_id,
                if cancelled { "cancelled" } else { "error" },
                &channel,
                version_guid.as_deref(),
                None,
                0,
                None,
                Some(error.clone()),
            );
            // Only application-owned paths are cleaned, never Roblox's install.
            let root = deployments_root(&dir);
            let _ = tokio::fs::remove_dir_all(root.join("work").join(&operation_id)).await;
            cleanup_stale_staging(&root).await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_protocol_command_and_arguments() {
        let parsed = parse_windows_command_line(
            r#""C:\Program Files\Fishstrap\Fishstrap.exe" -player "%1""#,
        );
        assert_eq!(
            parsed,
            vec![r"C:\Program Files\Fishstrap\Fishstrap.exe", "-player", "%1"]
        );
    }

    #[test]
    fn normalizes_live_and_rejects_path_like_channels() {
        assert_eq!(normalize_channel(None).unwrap(), "LIVE");
        assert_eq!(normalize_channel(Some("production")).unwrap(), "LIVE");
        assert_eq!(
            normalize_channel(Some("ZFeature_01")).unwrap(),
            "zfeature_01"
        );
        assert!(normalize_channel(Some("../LIVE")).is_err());
    }

    #[test]
    fn normalizes_version_guid_without_accepting_paths() {
        assert_eq!(
            normalize_version_guid("36a2600cebf1487d").unwrap(),
            "version-36a2600cebf1487d"
        );
        assert!(normalize_version_guid("version-../../bad").is_err());
    }

    #[test]
    fn parses_v0_manifest_and_skips_the_self_updater() {
        let raw = "v0\nRobloxApp.zip\n2398218c17293f8f4729c542b4a11d51\n10\n20\nRobloxPlayerInstaller.exe\ndb08dc7b734bfeec9653ac1d0942f73c\n30\n30\n";
        let parsed = parse_package_manifest(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "RobloxApp.zip");
        assert_eq!(parsed[0].compressed_size, 10);
    }

    #[test]
    fn rejects_unknown_or_oversized_manifest_packages() {
        let unknown = "v0\nnew-dangerous.zip\n2398218c17293f8f4729c542b4a11d51\n10\n20\n";
        assert!(parse_package_manifest(unknown).is_err());
        let huge = format!(
            "v0\nRobloxApp.zip\n2398218c17293f8f4729c542b4a11d51\n{}\n20\n",
            MAX_PACKAGE_BYTES + 1
        );
        assert!(parse_package_manifest(&huge).is_err());
    }

    #[test]
    fn maps_current_windows_player_packages() {
        assert_eq!(package_extract_root("RobloxApp.zip"), Some(""));
        assert_eq!(
            package_extract_root("content-platform-dictionaries.zip"),
            Some("PlatformContent/pc/shared_compression_dictionaries")
        );
        assert_eq!(package_extract_root("evil.zip"), None);
    }

    #[test]
    fn bootstrapper_handler_preserves_existing_registered_command() {
        let installation = RobloxInstallation {
            id: "fishstrap".to_string(),
            kind: RobloxLauncherKind::Fishstrap,
            display_name: "Fishstrap".to_string(),
            executable: Some(r"C:\Fishstrap\Fishstrap.exe".to_string()),
            install_location: None,
            display_version: None,
            version_guid: None,
            channel: None,
            detected_by: DetectionSource::ProtocolRegistry,
            protocol_capable: true,
            active_schemes: vec!["roblox".to_string()],
            handler_command: Some(r#""C:\Fishstrap\Fishstrap.exe" --fork-player "%1""#.to_string()),
        };
        assert_eq!(
            handler_command_for(&installation).unwrap(),
            r#""C:\Fishstrap\Fishstrap.exe" --fork-player "%1""#
        );
    }

    #[test]
    fn classifies_voidstrap_and_builds_compatible_player_command() {
        let executable = Path::new(r"C:\Users\dev\AppData\Local\Voidstrap\Voidstrap.exe");
        let (kind, name) = classify_executable(executable).unwrap();
        assert_eq!(kind, RobloxLauncherKind::Voidstrap);
        assert_eq!(name, "Voidstrap");
        let installation = RobloxInstallation {
            id: "voidstrap".to_string(),
            kind,
            display_name: name,
            executable: Some(executable.to_string_lossy().into_owned()),
            install_location: executable
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned()),
            display_version: None,
            version_guid: None,
            channel: None,
            detected_by: DetectionSource::KnownPath,
            protocol_capable: true,
            active_schemes: Vec::new(),
            handler_command: None,
        };
        assert_eq!(
            handler_command_for(&installation).unwrap(),
            r#""C:\Users\dev\AppData\Local\Voidstrap\Voidstrap.exe" -player "%1""#
        );
    }

    #[test]
    fn ignores_bootstrapper_auxiliary_executables() {
        assert!(classify_executable(Path::new(r"C:\Voidstrap\VoidstrapUpdater.exe")).is_none());
        assert!(classify_executable(Path::new(r"C:\Fishstrap\FishstrapInstaller.exe")).is_none());
        assert!(classify_executable(Path::new(r"C:\Froststrap\Froststrap.exe")).is_some());
    }

    #[test]
    fn classifies_generic_strap_and_plexity_forks() {
        assert!(matches!(
            classify_executable(Path::new(r"C:\Launchers\Lunastrap.exe")),
            Some((RobloxLauncherKind::OtherBootstrapper, _))
        ));
        assert!(matches!(
            classify_executable(Path::new(r"C:\Plexity\Plexity.exe")),
            Some((RobloxLauncherKind::OtherBootstrapper, _))
        ));
        assert!(classify_executable(Path::new(r"C:\Launchers\LunastrapUpdater.exe")).is_none());
    }

    #[test]
    fn user_preset_wins_path_deduplication_without_duplicating_the_client() {
        let executable = r"C:\Voidstrap\Voidstrap.exe".to_string();
        let mut installations = Vec::new();
        let mut by_executable = HashMap::new();
        let detected = RobloxInstallation {
            id: "voidstrap".to_string(),
            kind: RobloxLauncherKind::Voidstrap,
            display_name: "Voidstrap".to_string(),
            executable: Some(executable.clone()),
            install_location: Some(r"C:\Voidstrap".to_string()),
            display_version: Some("1.0.6.9".to_string()),
            version_guid: None,
            channel: None,
            detected_by: DetectionSource::KnownPath,
            protocol_capable: true,
            active_schemes: Vec::new(),
            handler_command: None,
        };
        let saved = RobloxInstallation {
            id: "user:voidstrap".to_string(),
            display_name: "My stable Voidstrap".to_string(),
            detected_by: DetectionSource::UserPreset,
            display_version: None,
            ..detected.clone()
        };

        push_deduped(&mut installations, &mut by_executable, detected);
        push_deduped(&mut installations, &mut by_executable, saved);

        assert_eq!(installations.len(), 1);
        assert_eq!(installations[0].id, "user:voidstrap");
        assert_eq!(installations[0].display_name, "My stable Voidstrap");
        assert_eq!(installations[0].detected_by, DetectionSource::UserPreset);
        assert_eq!(installations[0].display_version.as_deref(), Some("1.0.6.9"));
    }

    // ── Launch-client selection matrix ──────────────────────────────────────
    //
    // `resolve_launch_template_from` is pure, so every branch that used to be
    // reachable only through a real registry sweep and a real settings file is
    // exercised directly here.

    /// A protocol-capable installation of `kind` with a stable id.
    fn installation(id: &str, kind: RobloxLauncherKind, executable: &str) -> RobloxInstallation {
        RobloxInstallation {
            id: id.to_string(),
            kind,
            display_name: id.to_string(),
            executable: Some(executable.to_string()),
            install_location: None,
            display_version: None,
            version_guid: None,
            channel: None,
            detected_by: DetectionSource::KnownPath,
            protocol_capable: true,
            active_schemes: Vec::new(),
            handler_command: None,
        }
    }

    fn settings_for(preset_id: Option<&str>, mode: RobloxLaunchMode) -> Settings {
        Settings {
            roblox_launch_preset_id: preset_id.map(str::to_string),
            roblox_launch_mode: mode,
            ..Settings::default()
        }
    }

    const URI: &str = "roblox-player:1+launchmode:play+gameinfo:TICKET";

    #[test]
    fn protocol_mode_delegates_regardless_of_the_selected_preset() {
        let installations = vec![installation(
            "official",
            RobloxLauncherKind::Official,
            r"C:\Roblox\Versions\version-a\RobloxPlayerBeta.exe",
        )];
        let settings = settings_for(Some("official"), RobloxLaunchMode::Protocol);
        let fallback = PathBuf::from(r"C:\Roblox\Versions\version-b\RobloxPlayerBeta.exe");
        assert_eq!(
            resolve_launch_template_from(&installations, &settings, Some(&fallback)),
            RobloxLaunchTemplate::Protocol
        );
    }

    #[test]
    fn official_and_custom_presets_spawn_the_player_directly_and_are_tracked() {
        let exe = r"C:\Roblox\Versions\version-a\RobloxPlayerBeta.exe";
        for kind in [RobloxLauncherKind::Official, RobloxLauncherKind::Custom] {
            let installations = vec![installation("chosen", kind, exe)];
            let settings = settings_for(Some("chosen"), RobloxLaunchMode::Direct);
            let plan = resolve_launch_template_from(&installations, &settings, None).with_uri(URI);
            assert_eq!(
                plan,
                RobloxLaunchPlan::Command {
                    executable: PathBuf::from(exe),
                    arguments: vec![URI.to_string()],
                    tracks_player: true,
                }
            );
        }
    }

    #[test]
    fn bootstrapper_presets_keep_their_command_line_and_are_not_tracked() {
        // A bootstrapper's PID is not RobloxPlayerBeta's, so `tracks_player` is
        // false and the `%1` placeholder in its registered command carries the URI.
        let mut fishstrap = installation(
            "fishstrap",
            RobloxLauncherKind::Fishstrap,
            r"C:\Fishstrap\Fishstrap.exe",
        );
        fishstrap.handler_command =
            Some(r#""C:\Fishstrap\Fishstrap.exe" --fork-player "%1""#.to_string());
        let settings = settings_for(Some("fishstrap"), RobloxLaunchMode::Direct);
        let plan = resolve_launch_template_from(&[fishstrap], &settings, None).with_uri(URI);
        assert_eq!(
            plan,
            RobloxLaunchPlan::Command {
                executable: PathBuf::from(r"C:\Fishstrap\Fishstrap.exe"),
                arguments: vec!["--fork-player".to_string(), URI.to_string()],
                tracks_player: false,
            }
        );
    }

    #[test]
    fn a_preset_that_no_longer_exists_falls_back_to_the_newest_player() {
        let fallback = PathBuf::from(r"C:\Roblox\Versions\version-b\RobloxPlayerBeta.exe");
        let settings = settings_for(Some("removed-preset"), RobloxLaunchMode::Direct);
        let plan =
            resolve_launch_template_from(&[], &settings, Some(&fallback)).with_uri(URI);
        assert_eq!(
            plan,
            RobloxLaunchPlan::Command {
                executable: fallback,
                arguments: vec![URI.to_string()],
                tracks_player: true,
            }
        );
    }

    #[test]
    fn nothing_selected_and_nothing_installed_falls_all_the_way_back_to_protocol() {
        let settings = settings_for(None, RobloxLaunchMode::Direct);
        assert_eq!(
            resolve_launch_template_from(&[], &settings, None),
            RobloxLaunchTemplate::Protocol
        );
    }

    #[test]
    fn a_preset_that_cannot_handle_the_protocol_is_skipped() {
        let mut installation = installation(
            "store",
            RobloxLauncherKind::MicrosoftStore,
            r"C:\Store\Roblox.exe",
        );
        installation.protocol_capable = false;
        let settings = settings_for(Some("store"), RobloxLaunchMode::Direct);
        assert_eq!(
            resolve_launch_template_from(&[installation], &settings, None),
            RobloxLaunchTemplate::Protocol
        );
    }

    #[test]
    fn the_blocking_wrapper_still_matches_the_template_pipeline() {
        // `resolve_launch_plan` is now a wrapper; this pins that it keeps
        // wiring settings, the sweep and the fallback together the same way.
        let dir = std::env::temp_dir().join(format!(
            "multiroblox-launchplan-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("settings.json"),
            br#"{"robloxLaunchMode":"protocol"}"#,
        )
        .unwrap();

        assert_eq!(resolve_launch_plan(&dir, URI), RobloxLaunchPlan::Protocol);
        assert_eq!(
            resolve_launch_plan(&dir, URI),
            resolve_launch_template_in(&dir).with_uri(URI)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preset_folder_resolves_a_version_player_executable() {
        let root = std::env::temp_dir().join(format!(
            "multiroblox-preset-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("RobloxPlayerBeta.exe");
        File::create(&executable).unwrap();
        let resolved = resolve_preset_executable(&root.to_string_lossy()).unwrap();
        assert_eq!(normalized_path(&resolved), normalized_path(&executable));
        fs::remove_dir_all(root).unwrap();
    }
}
