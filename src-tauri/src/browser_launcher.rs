//! Account_Browser_Launcher (`browser_launcher.rs`).
//!
//! This module is the Rust port of the Electron_Build's account-browser-launcher
//! subsystem — the part of `src/main.js` that talks to the Donut Browser local
//! HTTP API (the Donut_Browser_API) and drives the per-account isolated browser
//! session. It depends on `encryption.rs` (to decrypt the stored Donut_API_Token)
//! and `settings.rs` (to read the configured Donut API port / stored token),
//! matching the design's `BROWSER --> ENC` / `BROWSER --> SET` module edges.
//!
//! ## What this task (13.1) ports
//!
//! The plain-HTTP transport for the Donut_Browser_API, ported 1:1 from
//! `src/donut-http.js` plus the two `main.js` wrappers that feed it:
//!
//! ```js
//! // src/donut-http.js
//! function buildDonutBaseUrl(port) { return `http://127.0.0.1:${port || DEFAULT_DONUT_PORT}`; }
//! function donutRequest(baseUrl, token, method, urlPath, body, opts = {}) { ... }
//!
//! // src/main.js
//! function getDonutBaseUrl() { const s = loadSettings(); return buildDonutBaseUrl(s.donutApiPort); }
//! function getDonutToken()   { const s = loadSettings(); return decryptField(s.donutApiTokenEnc) || null; }
//! function donutHttp(method, urlPath, body) { return donutRequest(getDonutBaseUrl(), getDonutToken(), method, urlPath, body); }
//! ```
//!
//! Where the Electron_Build used Node's built-in `http` module (no third-party
//! client), this port uses `reqwest` — the same crate `roblox_api.rs` already
//! uses for the HTTPS Roblox calls — so "the plain-HTTP local API path mirrors
//! the HTTPS Roblox path" (the comment `main.js` carries above this section) is
//! preserved. The request shape is reproduced exactly: an
//! `Authorization: Bearer {token}` header attached only when a token is present
//! (Requirement 5.2 / account-browser-launcher Property 25), a JSON body, a hard
//! 5-second request timeout, and a resolve-never-reject contract — every call
//! returns a classified [`DonutResponse`] instead of surfacing an error, so
//! callers branch on the classification rather than catching exceptions.
//!
//! ### Three-way classification (the invariant this task must preserve)
//!
//! [`donut_request`] always resolves to a [`DonutResponse`] whose `error` is one
//! of exactly three outcomes, identical to `donut-http.js`'s truth table:
//!
//!   * [`DonutTransportError::Unreachable`] — no response arrived at all
//!     (connection refused / socket error / request timeout, or a base-URL/path
//!     that cannot even be parsed into a request), reported with `status = 0`.
//!   * [`DonutTransportError::Http`] — a response arrived but its status was not
//!     `2xx`; the numeric status and any parsed JSON body are still captured.
//!   * `None` (success) — a `2xx` response arrived; `ok` is `true`.
//!
//! The availability preflight (`classifyAvailability`) and the profile
//! resolve/create/run/delete calls that sit on top of this transport are ported
//! by Task 13.2; this task provides only the transport plus the base-URL/token
//! resolution helpers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::network::{CookieSameSite, SetCookieParams};
use chromiumoxide::cdp::browser_protocol::page::BringToFrontParams;
use chromiumoxide::cdp::browser_protocol::storage::GetCookiesParams;
use chromiumoxide::Page;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

use crate::accounts;
use crate::crypto_context;
use crate::encryption;
use crate::logging;
use crate::models::Account;
use crate::roblox_api;
use crate::settings;
use crate::AppState;

/// The Donut_Browser_API's documented default local port, from
/// `donut-http.js`'s `DEFAULT_DONUT_PORT = 10108`. Used when the Settings_Store
/// has no `donutApiPort` (or a falsy `0`), matching the JS `port || DEFAULT`.
pub const DEFAULT_DONUT_PORT: u16 = 10108;

/// The hard per-request timeout, from `donut-http.js`'s
/// `DEFAULT_TIMEOUT_MS = 5000`. A request that does not complete within this
/// window is classified [`DonutTransportError::Unreachable`], exactly as the
/// Electron_Build's `req.setTimeout(timeoutMs, () => { req.destroy(); resolve(unreachable) })`.
pub const DEFAULT_TIMEOUT_MS: u64 = 5000;

/// The non-success outcome of a [`donut_request`] call — the Rust form of
/// `donut-http.js`'s `error: 'unreachable' | 'http'` string field.
///
/// Modeled as an enum (rather than a raw string) so the availability classifier
/// in Task 13.2 can match on it exhaustively; `None` on [`DonutResponse::error`]
/// is the success case (`error: null` in the JS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DonutTransportError {
    /// No response arrived: connection refused, socket error, request timeout,
    /// or an unparseable base URL / path. Always paired with `status = 0`.
    Unreachable,
    /// A response arrived but its status was not `2xx`.
    Http,
}

impl DonutTransportError {
    /// The stable string form (`"unreachable"` / `"http"`), matching the JS
    /// `error` field value, for logging and for the Task 13.2 classifier.
    pub fn as_str(self) -> &'static str {
        match self {
            DonutTransportError::Unreachable => "unreachable",
            DonutTransportError::Http => "http",
        }
    }
}

/// The classified result of a single Donut_Browser_API request — the Rust form
/// of `donut-http.js`'s `{ ok, status, json, error }` resolve value.
///
///   * `ok`     — `true` iff a response arrived with a `2xx` status.
///   * `status` — the numeric HTTP status, or `0` when no response was received.
///   * `json`   — the parsed JSON response body, or `None` when absent/unparseable.
///   * `error`  — `Some(Unreachable)` / `Some(Http)` / `None` (success), per the
///                three-way classification documented on the module.
#[derive(Debug, Clone, PartialEq)]
pub struct DonutResponse {
    pub ok: bool,
    pub status: u16,
    pub json: Option<Value>,
    pub error: Option<DonutTransportError>,
}

impl DonutResponse {
    /// The `unreachable` outcome (`{ ok:false, status:0, json:null, error:'unreachable' }`).
    fn unreachable() -> Self {
        DonutResponse {
            ok: false,
            status: 0,
            json: None,
            error: Some(DonutTransportError::Unreachable),
        }
    }
}

/// Port of `donut-http.js`'s `buildDonutBaseUrl(port)`:
/// `http://127.0.0.1:${port || DEFAULT_DONUT_PORT}`.
///
/// A `None` port (field absent) or a falsy `0` falls back to
/// [`DEFAULT_DONUT_PORT`], reproducing the JS `port || DEFAULT` truthiness.
pub fn build_donut_base_url(port: Option<u16>) -> String {
    let port = match port {
        Some(p) if p != 0 => p,
        _ => DEFAULT_DONUT_PORT,
    };
    format!("http://127.0.0.1:{port}")
}

/// Port of `main.js`'s `getDonutBaseUrl()`: read the Settings_Store's
/// `donutApiPort` and build the local API base URL from it.
///
/// A Settings_Store read failure is non-fatal here (it falls back to
/// [`settings::default_settings`], i.e. the default port), matching
/// `getDonutBaseUrl`'s reliance on `loadSettings()` — whose `try/catch` collapses
/// a read failure to `{}` and thus to the default port. Surfacing an unreadable
/// Settings_Store to the user (Requirement 11.7) is the `settings_load` command's
/// job, not this resolver's.
pub fn get_donut_base_url(dir: &Path) -> String {
    let settings = settings::load_from_dir(dir).unwrap_or_else(|_| settings::default_settings());
    build_donut_base_url(settings.donut_api_port)
}

/// Port of `main.js`'s `getDonutToken()`:
/// `decryptField(s.donutApiTokenEnc) || null`.
///
/// Returns the decrypted Donut_API_Token, or `None` when none is stored (or when
/// the stored value decrypts to an empty string, matching the JS `|| null`). The
/// token is decrypted only here, at the point requests are built (Requirement
/// 5.2), and never persisted or returned in its decrypted form elsewhere. The
/// encryption inputs are resolved from the same Settings_Store + platform the
/// account commands use, via [`crypto_context::resolve`].
///
/// A decrypt failure (e.g. a locked passphrase-mode store) is treated as "no
/// usable token" (`None`) rather than surfaced, so a callable token gate never
/// hangs or errors on the launcher's preflight — mirroring `main.js`'s
/// `launcherSecrets`, which wraps `getDonutToken()` in a `try { ... } catch {}`.
pub fn get_donut_token(dir: &Path) -> Option<String> {
    let settings = settings::load_from_dir(dir).unwrap_or_else(|_| settings::default_settings());
    let enc = settings.donut_api_token_enc.as_deref()?;
    if enc.is_empty() {
        return None;
    }

    let ctx = crypto_context::resolve(dir);
    match encryption::decrypt_field(
        enc,
        ctx.passphrase_mode,
        ctx.safe_storage_ready,
        ctx.device_key,
    ) {
        Ok(Some(token)) if !token.is_empty() => Some(token),
        _ => None,
    }
}

/// Send a single request to the Donut_Browser_API and classify the outcome —
/// the direct port of `donut-http.js`'s `donutRequest`, using the module default
/// 5-second timeout ([`DEFAULT_TIMEOUT_MS`]).
///
/// All inputs are injected (`base_url`, `token`, `method`, `url_path`, `body`),
/// so this is pure with respect to app state and testable without a live Donut
/// Browser. Always resolves (never errors) with a classified [`DonutResponse`];
/// see the module docs for the three-way classification.
pub async fn donut_request(
    base_url: &str,
    token: Option<&str>,
    method: &str,
    url_path: &str,
    body: Option<&Value>,
) -> DonutResponse {
    donut_request_with_timeout(base_url, token, method, url_path, body, DEFAULT_TIMEOUT_MS).await
}

/// [`donut_request`] with an explicit timeout, mirroring `donutRequest`'s
/// `opts.timeoutMs` override (used by the integration tests, exactly as the JS
/// tests pass `{ timeoutMs: 100 }`).
pub async fn donut_request_with_timeout(
    base_url: &str,
    token: Option<&str>,
    method: &str,
    url_path: &str,
    body: Option<&Value>,
    timeout_ms: u64,
) -> DonutResponse {
    // `new URL(urlPath, baseUrl)` — a malformed base/path can never reach Donut
    // Browser, so it classifies as 'unreachable' rather than throwing.
    let url = match Url::parse(base_url).and_then(|base| base.join(url_path)) {
        Ok(url) => url,
        Err(_) => return DonutResponse::unreachable(),
    };

    // An unparseable HTTP method likewise can never produce a request.
    let method = match reqwest::Method::from_bytes(method.as_bytes()) {
        Ok(method) => method,
        Err(_) => return DonutResponse::unreachable(),
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(_) => return DonutResponse::unreachable(),
    };

    // Headers mirror `donut-http.js` exactly: Content-Type + Accept always, and
    // the Bearer Authorization header ONLY when a (truthy) token is supplied.
    let mut request = client
        .request(method, url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    // `body != null ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)` —
    // serialized with serde_json (reqwest's `json` feature is intentionally off,
    // matching main.js's raw JSON.stringify); reqwest sets a matching
    // Content-Length for the attached bytes. A body that cannot be serialized to
    // JSON can never form a valid request, so it classifies as 'unreachable'.
    if let Some(body) = body {
        match serde_json::to_vec(body) {
            Ok(bytes) => request = request.body(bytes),
            Err(_) => return DonutResponse::unreachable(),
        }
    }

    // resolve-never-reject: any transport failure (refused/socket/timeout) is
    // 'unreachable'.
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => return DonutResponse::unreachable(),
    };

    let status = response.status().as_u16();
    let ok = (200..300).contains(&status);
    let text = response.text().await.unwrap_or_default();
    // `if (data) { try JSON.parse ... catch => null }` — a non-empty body that
    // fails to parse yields `json: null`, not an error.
    let json = if text.is_empty() {
        None
    } else {
        serde_json::from_str::<Value>(&text).ok()
    };

    DonutResponse {
        ok,
        status,
        json,
        error: if ok {
            None
        } else {
            Some(DonutTransportError::Http)
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 13.2: availability/preflight, Wayfern engine, Donut_Profile
// resolve/create/run/delete, and the pending-deletion retry queue.
//
// These sit on top of the [`donut_request`] transport (Task 13.1) and port the
// corresponding `src/main.js` section 1:1 (see the inline `js` blocks). Every
// function that only talks HTTP is split into a transport-injected `*_at`
// core (taking `base_url` + `token`, so it is testable against an in-process
// server exactly like the transport tests) plus a thin `dir`-based wrapper that
// resolves the base URL / token from the Settings_Store via
// [`get_donut_base_url`] / [`get_donut_token`]. Functions that additionally
// touch the Account_Store / Settings_Store take the application-data `dir`
// directly, matching `main.js`'s `loadAccounts`/`saveAccounts`/`loadSettings`/
// `saveSettings` call sites.
// ─────────────────────────────────────────────────────────────────────────────

/// The Donut_Browser_API path used as the cheapest authenticated reachability
/// probe by the availability preflight — `GET /v1/profiles` in `main.js`.
const PROFILES_PATH: &str = "/v1/profiles";

/// Donut Browser groups endpoint, plus the dedicated group name and tag under
/// which EVERY profile this app creates is filed. This keeps RobloxAccountManager's
/// profiles visually separated from the user's unrelated Donut Browser profiles
/// (they land in their own group and carry an identifying tag).
const GROUPS_PATH: &str = "/v1/groups";
const DONUT_GROUP_NAME: &str = "RobloxAccountManager";
const DONUT_APP_TAG: &str = "RobloxAccountManager";

/// The Wayfern (anti-detect Chromium) browser name plus the REAL Donut Browser
/// API path for listing its versions. The Electron_Build's
/// `/v1/engines/wayfern[/download]` endpoints do NOT exist in Donut Browser's
/// actual REST API (v0.27.x): the browser lifecycle lives under `/v1/browsers/`:
///   * `GET  /v1/browsers/wayfern/versions`                       (newest-first)
///   * `GET  /v1/browsers/wayfern/versions/{version}/downloaded`  (body: `true`)
///   * `POST /v1/browsers/download { browser, version }`          (async fetch)
const WAYFERN_BROWSER: &str = "wayfern";
const WAYFERN_VERSIONS_PATH: &str = "/v1/browsers/wayfern/versions";

/// Resolve the base URL + token once and send a Donut_Browser_API request — the
/// direct port of `main.js`'s `donutHttp(method, urlPath, body)`:
///
/// ```js
/// function donutHttp(method, urlPath, body) {
///   return donutRequest(getDonutBaseUrl(), getDonutToken(), method, urlPath, body);
/// }
/// ```
async fn donut_http(
    dir: &Path,
    method: &str,
    url_path: &str,
    body: Option<&Value>,
) -> DonutResponse {
    let base_url = get_donut_base_url(dir);
    let token = get_donut_token(dir);
    donut_request(&base_url, token.as_deref(), method, url_path, body).await
}

// ── Availability preflight (Req 5.1 / account-browser-launcher Req 3) ─────────

/// The classified outcome of the Donut_Browser_API availability preflight — the
/// Rust form of `donut-http.js`'s `classifyAvailability` result
/// `{ ok, error: null|'no_token'|'unreachable'|'unauthorized'|'payment_required' }`.
///
/// [`Availability::Ok`] is the success case (`ok:true, error:null`); every other
/// variant is a distinct failure the launcher surfaces to the Renderer_UI
/// WITHOUT hiding the "Open in Browser" / "Copy Cookie" actions (Requirement 5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// A `2xx` response arrived: the API is reachable and the token accepted.
    Ok,
    /// No Donut_API_Token is stored — checked FIRST, short-circuiting before any
    /// request is sent (account-browser-launcher Req 9.6 / Property 27).
    NoToken,
    /// The Donut_Browser_API could not be reached (or returned an unclassified
    /// non-2xx status).
    Unreachable,
    /// HTTP 401: the stored token was rejected.
    Unauthorized,
    /// HTTP 402: the operation requires a Donut Browser Pro subscription.
    PaymentRequired,
}

impl Availability {
    /// The stable string form matching `classifyAvailability`'s `error` field
    /// (`Ok` maps to `None`, the JS `error:null`), for the command layer and
    /// logging.
    pub fn as_error_str(self) -> Option<&'static str> {
        match self {
            Availability::Ok => None,
            Availability::NoToken => Some("no_token"),
            Availability::Unreachable => Some("unreachable"),
            Availability::Unauthorized => Some("unauthorized"),
            Availability::PaymentRequired => Some("payment_required"),
        }
    }

    /// Whether the API is available (`ok:true`), matching the JS `ok` field.
    pub fn is_ok(self) -> bool {
        matches!(self, Availability::Ok)
    }
}

/// Pure port of `donut-http.js`'s `classifyAvailability(hasToken, result)` — the
/// availability truth table, kept transport-free so it is directly testable:
///
/// ```js
/// function classifyAvailability(hasToken, result) {
///   if (!hasToken) return { ok: false, error: 'no_token' };
///   if (!result || result.error === 'unreachable') return { ok: false, error: 'unreachable' };
///   if (result.status === 401) return { ok: false, error: 'unauthorized' };
///   if (result.status === 402) return { ok: false, error: 'payment_required' };
///   if (result.ok) return { ok: true, error: null };
///   return { ok: false, error: 'unreachable' };
/// }
/// ```
///
/// `result` is `None` only when no request was made (mirrors the JS `!result`
/// guard); otherwise it is the [`DonutResponse`] from a reachability call. A
/// missing token short-circuits to [`Availability::NoToken`] before `result` is
/// even consulted.
pub fn classify_availability(has_token: bool, result: Option<&DonutResponse>) -> Availability {
    if !has_token {
        return Availability::NoToken;
    }
    let result = match result {
        // `!result || result.error === 'unreachable'`
        Some(r) if r.error != Some(DonutTransportError::Unreachable) => r,
        _ => return Availability::Unreachable,
    };
    if result.status == 401 {
        return Availability::Unauthorized;
    }
    if result.status == 402 {
        return Availability::PaymentRequired;
    }
    if result.ok {
        return Availability::Ok;
    }
    Availability::Unreachable
}

/// Transport-injected core of the availability preflight: classify a reachability
/// probe given a resolved `token` and `base_url`. With no token, NO request is
/// sent (account-browser-launcher Req 9.6 / Property 27); otherwise it hits
/// [`PROFILES_PATH`] and classifies the result.
pub async fn check_donut_availability_at(base_url: &str, token: Option<&str>) -> Availability {
    let has_token = token.map(|t| !t.is_empty()).unwrap_or(false);
    if !has_token {
        // Req 9.6 / Property 27: with no token, do not send any request at all.
        return classify_availability(false, None);
    }
    let res = donut_request(base_url, token, "GET", PROFILES_PATH, None).await;
    classify_availability(true, Some(&res))
}

/// Port of `main.js`'s `checkDonutAvailability()`: verify the Donut_Browser_API
/// is reachable and the stored token accepted before any profile is created or
/// launched. Resolves the base URL / token from the Settings_Store, then
/// delegates to [`check_donut_availability_at`].
///
/// ```js
/// async function checkDonutAvailability() {
///   const token = getDonutToken();
///   if (!token) return classifyAvailability(false, null);
///   const res = await donutHttp('GET', '/v1/profiles');
///   return classifyAvailability(true, res);
/// }
/// ```
pub async fn check_donut_availability(dir: &Path) -> Availability {
    let token = get_donut_token(dir);
    check_donut_availability_at(&get_donut_base_url(dir), token.as_deref()).await
}

// ── Wayfern engine availability (account-browser-launcher Req 3.5-3.7) ────────

/// Pure port of `main.js`'s `isWayfernDownloaded(json)`: interpret an engine-
/// status body into "is the wayfern engine downloaded?". Reads the commonly-used
/// fields defensively (an explicit `downloaded`/`installed`/`is_downloaded`
/// boolean, or a `status` string of `downloaded`/`installed`/`ready`); anything
/// else (absent body, unknown shape) is treated as NOT downloaded so the caller
/// triggers a download rather than assuming presence.
///
/// ```js
/// function isWayfernDownloaded(json) {
///   if (!json || typeof json !== 'object') return false;
///   if (typeof json.downloaded === 'boolean') return json.downloaded;
///   if (typeof json.installed === 'boolean') return json.installed;
///   if (typeof json.is_downloaded === 'boolean') return json.is_downloaded;
///   const status = typeof json.status === 'string' ? json.status.toLowerCase() : null;
///   if (status) return status === 'downloaded' || status === 'installed' || status === 'ready';
///   return false;
/// }
/// ```
pub fn is_wayfern_downloaded(json: Option<&Value>) -> bool {
    // `!json || typeof json !== 'object'` — a JSON object is required.
    let obj = match json {
        Some(Value::Object(map)) => map,
        _ => return false,
    };
    // The three boolean shapes, checked in order, each only when a *boolean*.
    for key in ["downloaded", "installed", "is_downloaded"] {
        if let Some(Value::Bool(b)) = obj.get(key) {
            return *b;
        }
    }
    // Fall back to a status string (case-insensitive).
    if let Some(Value::String(status)) = obj.get("status") {
        let status = status.to_lowercase();
        return status == "downloaded" || status == "installed" || status == "ready";
    }
    false
}

/// The failure outcomes of [`ensure_wayfern_engine`], mirroring
/// `ensureWayfernEngine`'s `error: 'status_failed' | 'download_failed'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WayfernError {
    /// The engine-status check could not be reached / did not return `2xx`
    /// (account-browser-launcher Req 3.7 — the engine cannot be confirmed).
    StatusFailed,
    /// The engine was not downloaded and the download request failed
    /// (account-browser-launcher Req 3.7).
    DownloadFailed,
}

impl WayfernError {
    /// The stable string form (`"status_failed"` / `"download_failed"`).
    pub fn as_str(self) -> &'static str {
        match self {
            WayfernError::StatusFailed => "status_failed",
            WayfernError::DownloadFailed => "download_failed",
        }
    }
}

/// Transport-injected core of [`ensure_wayfern_engine`] — see that function for
/// the full flow. Takes a resolved `base_url` + `token` so it is testable against
/// an in-process server.
pub async fn ensure_wayfern_engine_at(
    base_url: &str,
    token: Option<&str>,
) -> Result<(), WayfernError> {
    // 1. List the Wayfern versions Donut knows about (newest first). This uses
    //    Donut Browser's real browser API instead of the Electron_Build's
    //    nonexistent `/v1/engines/wayfern` status endpoint. A non-2xx here means
    //    the API is unreachable or the token is wrong.
    let versions_res = donut_request(base_url, token, "GET", WAYFERN_VERSIONS_PATH, None).await;
    if !versions_res.ok {
        return Err(WayfernError::StatusFailed);
    }
    let versions: Vec<String> = versions_res
        .json
        .as_ref()
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // 2. Confirm at least one version is actually downloaded on disk. Profile
    //    creation uses `version: "latest"` (the newest already-downloaded build),
    //    so one must be present.
    for version in &versions {
        let path = format!("/v1/browsers/{WAYFERN_BROWSER}/versions/{version}/downloaded");
        let dl = donut_request(base_url, token, "GET", &path, None).await;
        if dl.ok && dl.json.as_ref().and_then(|j| j.as_bool()).unwrap_or(false) {
            return Ok(());
        }
    }

    // 3. Nothing downloaded yet: best-effort kick off a download of the newest
    //    known version (Donut fetches asynchronously) and report the engine is
    //    not confirmed, so the caller surfaces an actionable error.
    if let Some(latest) = versions.first() {
        let body = serde_json::json!({ "browser": WAYFERN_BROWSER, "version": latest });
        let _ = donut_request(base_url, token, "POST", "/v1/browsers/download", Some(&body)).await;
    }
    Err(WayfernError::DownloadFailed)
}

/// Port of `main.js`'s `ensureWayfernEngine()`: ensure the "wayfern" browser
/// engine is downloaded before a Donut_Profile is created
/// (account-browser-launcher Req 3.5-3.7). The status is re-checked on every
/// call (Req 3.5 / Property 10) — no cached "already downloaded" result is kept.
///
/// ```js
/// async function ensureWayfernEngine() {
///   const statusRes = await donutHttp('GET', '/v1/engines/wayfern');
///   if (!statusRes || !statusRes.ok) return { ok: false, error: 'status_failed' };
///   if (isWayfernDownloaded(statusRes.json)) return { ok: true, error: null };
///   const dlRes = await donutHttp('POST', '/v1/engines/wayfern/download');
///   if (!dlRes || !dlRes.ok) return { ok: false, error: 'download_failed' };
///   return { ok: true, error: null };
/// }
/// ```
pub async fn ensure_wayfern_engine(dir: &Path) -> Result<(), WayfernError> {
    let token = get_donut_token(dir);
    ensure_wayfern_engine_at(&get_donut_base_url(dir), token.as_deref()).await
}

// ── Donut_Profile mapping / run / delete (account-browser-launcher Req 1, 2, 8) ─

/// Coerce a JSON value into the string form `main.js` uses for a returned profile
/// id (`String(res.json.id)`), treating JSON `null`/absence as "no id". Strings
/// pass through unchanged; numbers/booleans are stringified like JS `String(x)`;
/// any other shape is stringified via its JSON representation (unrealistic for a
/// real API, but never produces a spurious empty id).
fn value_to_id_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

/// Extract the created profile id from a `POST /v1/profiles` body — the port of
/// `main.js`'s defensive `res.json.id ?? res.json.profile_id` read:
///
/// ```js
/// const profileId = res.json.id != null ? String(res.json.id)
///   : (res.json.profile_id != null ? String(res.json.profile_id) : null);
/// ```
///
/// Reads `id` first, then `profile_id`; a present-but-`null` value is skipped
/// (matching the JS `!= null` guard).
pub fn extract_profile_id(json: &Value) -> Option<String> {
    // Donut Browser's real API wraps the created profile under a `profile`
    // object (`{ "profile": { "id": ... } }`); the Electron_Build read a
    // top-level `id`/`profile_id`. Check the nested object first, then the flat
    // keys, so both response shapes work.
    let candidates = [
        json.get("profile").and_then(|p| p.get("id")),
        json.get("profile").and_then(|p| p.get("profile_id")),
        json.get("id"),
        json.get("profile_id"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(id) = value_to_id_string(candidate) {
            return Some(id);
        }
    }
    None
}

/// Extract the CDP_Port from a `POST /v1/profiles/{id}/run` body — the port of
/// `main.js`'s defensive multi-key read + integer validation:
///
/// ```js
/// const raw = res.json.cdpPort ?? res.json.cdp_port ?? res.json.port
///   ?? res.json.debuggingPort ?? res.json.remoteDebuggingPort ?? res.json.remote_debugging_port;
/// const cdpPort = Number(raw);
/// if (!Number.isInteger(cdpPort) || cdpPort <= 0) return no_cdp_port;
/// ```
///
/// The keys are tried in order and the FIRST present, non-`null` one wins (JS
/// `??` nullish-coalescing — a `0` value is not skipped, and then fails the
/// `> 0` check just as in the Electron_Build). The chosen value is coerced from a
/// JSON number (integral, `> 0`) or a numeric string; anything else yields `None`.
pub fn extract_cdp_port(json: &Value) -> Option<u32> {
    let raw = [
        "cdpPort",
        "cdp_port",
        "port",
        "debuggingPort",
        "remoteDebuggingPort",
        "remote_debugging_port",
    ]
    .into_iter()
    .find_map(|key| match json.get(key) {
        // `??` skips only null / undefined (absent) — any other value stops here.
        Some(v) if !v.is_null() => Some(v),
        _ => None,
    })?;

    // `Number(raw)` then `Number.isInteger && > 0`.
    let port = match raw {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u
            } else if let Some(i) = n.as_i64() {
                if i < 0 {
                    return None;
                }
                i as u64
            } else {
                // A non-integral float (`Number.isInteger` false).
                let f = n.as_f64()?;
                if f.fract() != 0.0 || f <= 0.0 {
                    return None;
                }
                f as u64
            }
        }
        Value::String(s) => s.trim().parse::<u64>().ok()?,
        _ => return None,
    };

    if port == 0 || port > u32::MAX as u64 {
        return None;
    }
    Some(port as u32)
}

/// The failure outcomes of profile creation, mirroring
/// `createDonutProfileForAccount`'s `error: 'create_failed' | 'duplicate_profile'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateProfileError {
    /// The `POST /v1/profiles` request failed, returned no id, or the account
    /// could not be found in the store to persist the mapping onto.
    CreateFailed,
    /// The id Donut Browser returned is already mapped to a DIFFERENT account —
    /// the profile-id uniqueness invariant would be violated, so the mapping is
    /// NOT persisted (account-browser-launcher Req 2.2 / Property 5).
    DuplicateProfile,
}

impl CreateProfileError {
    /// The stable string form (`"create_failed"` / `"duplicate_profile"`).
    pub fn as_str(self) -> &'static str {
        match self {
            CreateProfileError::CreateFailed => "create_failed",
            CreateProfileError::DuplicateProfile => "duplicate_profile",
        }
    }
}

/// The result of [`resolve_or_create_profile`]: the resolved profile id and
/// whether it was newly created (`created:true`) or reused (`created:false`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProfile {
    pub profile_id: String,
    pub created: bool,
}

/// Load the Account_Store for the app-data `dir`, resolving crypto inputs via
/// [`crypto_context`] exactly as the command layer does. Returns the account
/// list (ciphertext-preserving for any entry whose cookie failed to decrypt); a
/// store read failure yields an empty list so a lookup no-ops rather than hangs,
/// matching how `main.js`'s `loadAccounts()` feeds the profile helpers.
fn load_accounts(dir: &Path) -> Result<Vec<Account>, ()> {
    let ctx = crypto_context::resolve(dir);
    accounts::load_from_dir(
        dir,
        ctx.passphrase_mode,
        ctx.safe_storage_ready,
        ctx.device_key,
    )
    .map(|load| load.accounts)
    .map_err(|_| ())
}

/// Persist the Account_Store for the app-data `dir`, resolving crypto inputs via
/// [`crypto_context`] (mirrors `main.js`'s `saveAccounts(accounts)`).
fn save_accounts(dir: &Path, accounts: &[Account]) -> Result<(), ()> {
    let ctx = crypto_context::resolve(dir);
    accounts::save_to_dir(
        dir,
        accounts,
        ctx.passphrase_mode,
        ctx.safe_storage_ready,
        ctx.device_key,
    )
    .map_err(|_| ())
}

/// Port of `main.js`'s `getProfileIdForAccount(accountId)`: read the
/// Donut_Profile id currently mapped to an account id, or `None` when the account
/// is unknown or not yet mapped.
///
/// ```js
/// function getProfileIdForAccount(accountId) {
///   const acct = loadAccounts().find(a => a.id === accountId);
///   return (acct && acct.donutProfileId) || null;
/// }
/// ```
///
/// A stored empty-string id is treated as unmapped (`|| null`), and a store read
/// failure resolves to `None` (unknown), never an error.
pub fn get_profile_id_for_account(dir: &Path, account_id: &str) -> Option<String> {
    let accounts = load_accounts(dir).ok()?;
    accounts
        .into_iter()
        .find(|a| a.id == account_id)
        .and_then(|a| a.donut_profile_id)
        .filter(|id| !id.is_empty())
}

/// Port of `main.js`'s `createDonutProfileForAccount(account)`: create a new
/// Donut_Profile and persist the id -> account mapping IMMEDIATELY (before
/// returning), so a later `/run` failure can never leave a created-but-unrecorded
/// profile (account-browser-launcher Req 2.1 / basis for Req 2.6). Enforces the
/// profile-id uniqueness invariant against the CURRENT store (Req 2.2 /
/// Property 5): if Donut Browser returns an id already mapped to a different
/// account, the mapping is NOT persisted and the call fails.
///
/// ```js
/// async function createDonutProfileForAccount(account) {
///   const res = await donutHttp('POST', '/v1/profiles', { name: account.id });
///   if (!res || !res.ok || !res.json) return { ok:false, ..., error:'create_failed' };
///   const profileId = res.json.id != null ? String(res.json.id) : (res.json.profile_id != null ? String(res.json.profile_id) : null);
///   if (!profileId) return { ok:false, ..., error:'create_failed' };
///   const accounts = loadAccounts();
///   if (accounts.some(a => a.id !== account.id && a.donutProfileId === profileId)) return { ok:false, ..., error:'duplicate_profile' };
///   const idx = accounts.findIndex(a => a.id === account.id);
///   if (idx === -1) return { ok:false, ..., error:'create_failed' };
///   accounts[idx].donutProfileId = profileId;
///   saveAccounts(accounts);
///   return { ok:true, profileId, error:null };
/// }
/// ```
/// Read the cached Donut group id from the Settings_Store (`donutGroupId`, kept
/// in the settings catch-all). `None` when unset or blank.
fn get_cached_donut_group_id(dir: &Path) -> Option<String> {
    let settings = settings::load_from_dir(dir).ok()?;
    settings
        .extra
        .get("donutGroupId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Persist the resolved Donut group id into the Settings_Store via an overlay
/// merge (leaving every other setting untouched). Best-effort.
fn set_cached_donut_group_id(dir: &Path, group_id: &str) {
    let mut update = Map::new();
    update.insert("donutGroupId".to_string(), json!(group_id));
    let _ = settings::save_to_dir(dir, &update);
}

/// Resolve (creating if needed) the dedicated [`DONUT_GROUP_NAME`] Donut group so
/// every profile this app creates is filed under one group, never mixed with the
/// user's unrelated Donut profiles. Returns the group id, or `None` if it could
/// not be resolved/created (the profile is then simply left ungrouped).
///
/// Order: cached id (verified to still exist) → find an existing group by name →
/// create it. The resolved id is cached in the Settings_Store to avoid repeat
/// lookups.
async fn ensure_donut_group(dir: &Path) -> Option<String> {
    // 1. Cached id, verified.
    if let Some(id) = get_cached_donut_group_id(dir) {
        let res = donut_http(dir, "GET", &format!("/v1/groups/{id}"), None).await;
        if res.ok {
            return Some(id);
        }
    }
    // 2. Find an existing group by name (GET /v1/groups -> array).
    let list = donut_http(dir, "GET", GROUPS_PATH, None).await;
    if list.ok {
        if let Some(arr) = list.json.as_ref().and_then(|j| j.as_array()) {
            for group in arr {
                if group.get("name").and_then(|n| n.as_str()) == Some(DONUT_GROUP_NAME) {
                    if let Some(id) = group.get("id").and_then(|i| i.as_str()) {
                        set_cached_donut_group_id(dir, id);
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    // 3. Create it (POST /v1/groups { name } -> { id, name, profile_count }).
    let body = json!({ "name": DONUT_GROUP_NAME });
    let created = donut_http(dir, "POST", GROUPS_PATH, Some(&body)).await;
    if created.ok {
        if let Some(id) = created
            .json
            .as_ref()
            .and_then(|j| j.get("id"))
            .and_then(|i| i.as_str())
        {
            set_cached_donut_group_id(dir, id);
            return Some(id.to_string());
        }
    }
    None
}

pub async fn create_donut_profile_for_account(
    dir: &Path,
    account: &Account,
) -> Result<String, CreateProfileError> {
    // Resolve (creating if needed) our dedicated group so this profile is filed
    // apart from the user's unrelated Donut profiles. Best-effort: a failure to
    // resolve the group leaves the profile ungrouped rather than blocking it.
    let group_id = ensure_donut_group(dir).await;
    let account_tag = if account.username.is_empty() {
        account.id.clone()
    } else {
        account.username.clone()
    };

    // Donut Browser's real POST /v1/profiles REQUIRES `browser` (must be
    // "wayfern") and `version`; `version: "latest"` picks the newest already-
    // downloaded build, and `wayfern_config: {}` requests sensible defaults.
    //
    // NOTE: Donut Browser's create endpoint returns HTTP 500 ("Profile created
    // but failed to apply tags.") when `tags` is included in the initial POST —
    // the profile row itself IS created despite the error, but treating that as
    // a failure would leave an orphaned, unrecorded profile behind. So `tags`
    // is omitted here and applied afterwards via a follow-up PUT (which the API
    // accepts fine), same as the group assignment below.
    let body = json!({
        "name": account.id,
        "browser": WAYFERN_BROWSER,
        "version": "latest",
        "wayfern_config": {},
    });
    let res = donut_http(dir, "POST", PROFILES_PATH, Some(&body)).await;
    // `!res || !res.ok || !res.json`
    if !res.ok {
        return Err(CreateProfileError::CreateFailed);
    }
    let profile_id = match res.json.as_ref().and_then(extract_profile_id) {
        Some(id) => id,
        None => return Err(CreateProfileError::CreateFailed),
    };

    // Apply tags and assign the new profile to our group in a single follow-up
    // PUT (best-effort — a failure here leaves the profile created but untagged/
    // ungrouped rather than failing account setup). `wayfern_config` is required
    // by the PUT contract, so it is always included.
    let mut put_body = json!({
        "tags": [DONUT_APP_TAG, account_tag],
        "wayfern_config": {}
    });
    if let Some(gid) = &group_id {
        put_body["group_id"] = json!(gid);
    }
    let _ = donut_http(dir, "PUT", &format!("/v1/profiles/{profile_id}"), Some(&put_body)).await;

    // Reload here (not trusting the passed-in copy) so a concurrent save can't be
    // clobbered, and enforce uniqueness against the current store.
    let mut accounts = load_accounts(dir).map_err(|_| CreateProfileError::CreateFailed)?;
    if accounts
        .iter()
        .any(|a| a.id != account.id && a.donut_profile_id.as_deref() == Some(profile_id.as_str()))
    {
        return Err(CreateProfileError::DuplicateProfile);
    }
    let idx = match accounts.iter().position(|a| a.id == account.id) {
        Some(idx) => idx,
        None => return Err(CreateProfileError::CreateFailed),
    };
    accounts[idx].donut_profile_id = Some(profile_id.clone());
    save_accounts(dir, &accounts).map_err(|_| CreateProfileError::CreateFailed)?;

    Ok(profile_id)
}

/// Port of `main.js`'s `resolveOrCreateProfile(account)`: resolve the
/// Donut_Profile to open a browser for, creating and mapping one ONLY when the
/// account is not already mapped (account-browser-launcher Req 1.1/1.2/2.4/2.5).
/// Reusing an existing mapping never calls profile creation.
///
/// ```js
/// async function resolveOrCreateProfile(account) {
///   const existing = getProfileIdForAccount(account.id);
///   if (existing) return { ok:true, profileId:existing, created:false, error:null };
///   const created = await createDonutProfileForAccount(account);
///   if (!created.ok) return { ok:false, ..., error:created.error };
///   return { ok:true, profileId:created.profileId, created:true, error:null };
/// }
/// ```
pub async fn resolve_or_create_profile(
    dir: &Path,
    account: &Account,
) -> Result<ResolvedProfile, CreateProfileError> {
    if let Some(existing) = get_profile_id_for_account(dir, &account.id) {
        return Ok(ResolvedProfile {
            profile_id: existing,
            created: false,
        });
    }
    let profile_id = create_donut_profile_for_account(dir, account).await?;
    Ok(ResolvedProfile {
        profile_id,
        created: true,
    })
}

/// The failure outcomes of [`run_donut_profile`], mirroring `runDonutProfile`'s
/// `error: 'run_failed' | 'no_cdp_port'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunProfileError {
    /// The `POST /v1/profiles/{id}/run` request failed or returned no body.
    RunFailed,
    /// The profile ran but no usable CDP_Port could be read from the response.
    NoCdpPort,
    /// HTTP 402: `POST /v1/profiles/{id}/run` is a Donut Browser Pro-only
    /// endpoint; without an active Pro subscription it returns Payment Required.
    RequiresPro,
}

impl RunProfileError {
    /// The stable string form (`"run_failed"` / `"no_cdp_port"` / `"requires_pro"`).
    pub fn as_str(self) -> &'static str {
        match self {
            RunProfileError::RunFailed => "run_failed",
            RunProfileError::NoCdpPort => "no_cdp_port",
            RunProfileError::RequiresPro => "requires_pro",
        }
    }
}

/// Transport-injected core of [`run_donut_profile`] — see that function. Takes a
/// resolved `base_url` + `token` so it is testable against an in-process server.
pub async fn run_donut_profile_at(
    base_url: &str,
    token: Option<&str>,
    profile_id: &str,
) -> Result<u32, RunProfileError> {
    let path = format!("/v1/profiles/{profile_id}/run");
    let body = json!({ "headless": false });
    let res = donut_request(base_url, token, "POST", &path, Some(&body)).await;
    // 402 Payment Required: /run is a Donut Browser Pro-only endpoint.
    if res.status == 402 {
        return Err(RunProfileError::RequiresPro);
    }
    // `!res || !res.ok || !res.json`
    if !res.ok {
        return Err(RunProfileError::RunFailed);
    }
    let json = match res.json.as_ref() {
        Some(json) => json,
        None => return Err(RunProfileError::RunFailed),
    };
    extract_cdp_port(json).ok_or(RunProfileError::NoCdpPort)
}

/// Port of `main.js`'s `runDonutProfile(profileId)`: launch the Browser_Instance
/// for a Donut_Profile via `POST /v1/profiles/{id}/run` (Req 1.1) and extract the
/// CDP_Port the launcher connects to for cookie injection.
///
/// ```js
/// async function runDonutProfile(profileId) {
///   const res = await donutHttp('POST', `/v1/profiles/${profileId}/run`, { headless: false });
///   if (!res || !res.ok || !res.json) return { ok:false, cdpPort:null, error:'run_failed' };
///   const raw = res.json.cdpPort ?? res.json.cdp_port ?? res.json.port ?? res.json.debuggingPort ?? res.json.remoteDebuggingPort ?? res.json.remote_debugging_port;
///   const cdpPort = Number(raw);
///   if (!Number.isInteger(cdpPort) || cdpPort <= 0) return { ok:false, cdpPort:null, error:'no_cdp_port' };
///   return { ok:true, cdpPort, error:null };
/// }
/// ```
pub async fn run_donut_profile(dir: &Path, profile_id: &str) -> Result<u32, RunProfileError> {
    let token = get_donut_token(dir);
    run_donut_profile_at(&get_donut_base_url(dir), token.as_deref(), profile_id).await
}

/// The failure outcomes of [`delete_donut_profile`], mirroring
/// `deleteDonutProfile`'s `error: 'unreachable' | 'delete_failed'`. Success (a
/// `2xx` OR a `404` already-gone) is `Ok(())`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteProfileError {
    /// Donut Browser could not be reached — the id stays queued for retry
    /// (account-browser-launcher Req 8, pending-deletion queue).
    Unreachable,
    /// A response arrived but the delete was rejected (a non-404 HTTP error).
    DeleteFailed,
}

impl DeleteProfileError {
    /// The stable string form (`"unreachable"` / `"delete_failed"`).
    pub fn as_str(self) -> &'static str {
        match self {
            DeleteProfileError::Unreachable => "unreachable",
            DeleteProfileError::DeleteFailed => "delete_failed",
        }
    }
}

/// Transport-injected core of [`delete_donut_profile`] — see that function. Takes
/// a resolved `base_url` + `token` so it is testable against an in-process server.
pub async fn delete_donut_profile_at(
    base_url: &str,
    token: Option<&str>,
    profile_id: &str,
) -> Result<(), DeleteProfileError> {
    let path = format!("/v1/profiles/{profile_id}");
    let res = donut_request(base_url, token, "DELETE", &path, None).await;
    // `if (res && res.ok) ok`
    if res.ok {
        return Ok(());
    }
    // `if (res && res.status === 404) ok` — already gone == desired end state.
    if res.status == 404 {
        return Ok(());
    }
    // `if (!res || res.error === 'unreachable') unreachable`
    if res.error == Some(DonutTransportError::Unreachable) {
        return Err(DeleteProfileError::Unreachable);
    }
    Err(DeleteProfileError::DeleteFailed)
}

/// Port of `main.js`'s `deleteDonutProfile(profileId)`: delete a Donut_Profile
/// via `DELETE /v1/profiles/{id}` (Req 8.1). A `404` "not found" is folded into
/// success — if the profile is already gone the desired end state is achieved, so
/// callers clear the mapping / drop it from the pending-deletion queue just as on
/// a normal delete.
///
/// ```js
/// async function deleteDonutProfile(profileId) {
///   const res = await donutHttp('DELETE', `/v1/profiles/${profileId}`);
///   if (res && res.ok) return { ok:true, error:null };
///   if (res && res.status === 404) return { ok:true, error:null };
///   if (!res || res.error === 'unreachable') return { ok:false, error:'unreachable' };
///   return { ok:false, error:'delete_failed' };
/// }
/// ```
pub async fn delete_donut_profile(
    dir: &Path,
    profile_id: &str,
) -> Result<(), DeleteProfileError> {
    let token = get_donut_token(dir);
    delete_donut_profile_at(&get_donut_base_url(dir), token.as_deref(), profile_id).await
}

// ── Pending-deletion retry queue (account-browser-launcher Req 8.4-8.6) ───────
//
// The durable source of truth for "which Donut_Profiles still need deleting" is
// `settings.pendingDonutDeletions` (an array of profile ids), stored in
// `settings.json` (NOT on the account record, which is gone by the time a retry
// runs). Ported from `main.js`'s `addPendingDeletion` / `retryPendingDeletions`.

/// Port of `main.js`'s `addPendingDeletion(profileId)`: append a Donut_Profile id
/// to the pending-deletion queue and persist it (Req 8.4), de-duplicating so the
/// same id is never queued twice.
///
/// ```js
/// function addPendingDeletion(profileId) {
///   if (!profileId) return;
///   const s = loadSettings();
///   if (!Array.isArray(s.pendingDonutDeletions)) s.pendingDonutDeletions = [];
///   if (!s.pendingDonutDeletions.includes(profileId)) {
///     s.pendingDonutDeletions.push(profileId);
///     saveSettings(s);
///   }
/// }
/// ```
///
/// A blank id is a no-op (matching `if (!profileId) return`). Persisting only
/// happens when the id was actually newly added (the JS dedupe guard). A
/// Settings_Store read/write failure surfaces as `Err` rather than being
/// swallowed, so a caller that cares can observe it (Requirement 11.7); the
/// account-removal caller treats it best-effort exactly as `main.js` does.
pub fn add_pending_deletion(dir: &Path, profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty() {
        return Ok(());
    }
    let settings = settings::load_from_dir(dir).map_err(|e| e.to_string())?;
    let mut queue = settings.pending_donut_deletions.clone();
    if queue.iter().any(|id| id == profile_id) {
        // Already queued — no write, matching the JS `includes` dedupe guard.
        return Ok(());
    }
    queue.push(profile_id.to_string());
    persist_pending_deletions(dir, &queue)
}

/// Port of `main.js`'s `retryPendingDeletions()`: retry [`delete_donut_profile`]
/// for every queued id (Req 8.5). On success the id is removed from the queue; on
/// failure it is left queued for a later retry (Req 8.6). The queue is persisted
/// after EACH successful attempt (reloading settings first so a concurrent
/// [`add_pending_deletion`] isn't clobbered), so an interrupted run never
/// re-deletes an already-deleted profile nor drops a still-pending one.
///
/// ```js
/// async function retryPendingDeletions() {
///   const initial = loadSettings();
///   const queue = Array.isArray(initial.pendingDonutDeletions) ? initial.pendingDonutDeletions.slice() : [];
///   if (queue.length === 0) return;
///   for (const profileId of queue) {
///     const res = await deleteDonutProfile(profileId);
///     if (res && res.ok) {
///       const cur = loadSettings();
///       cur.pendingDonutDeletions = (Array.isArray(cur.pendingDonutDeletions) ? cur.pendingDonutDeletions : []).filter(id => id !== profileId);
///       saveSettings(cur);
///     }
///   }
/// }
/// ```
///
/// Resolve-never-reject in spirit (the queue is best-effort): a per-id delete
/// failure just leaves that id queued. A Settings_Store read/write failure
/// surfaces as `Err` (Requirement 11.7) rather than silently corrupting the queue.
pub async fn retry_pending_deletions(dir: &Path) -> Result<(), String> {
    let initial = settings::load_from_dir(dir).map_err(|e| e.to_string())?;
    let queue = initial.pending_donut_deletions.clone();
    if queue.is_empty() {
        return Ok(());
    }
    for profile_id in queue {
        let res = delete_donut_profile(dir, &profile_id).await;
        if res.is_ok() {
            // Persist the removal immediately. Reload first so a concurrent
            // add_pending_deletion (from an in-flight removal) isn't clobbered.
            let cur = settings::load_from_dir(dir).map_err(|e| e.to_string())?;
            let remaining: Vec<String> = cur
                .pending_donut_deletions
                .into_iter()
                .filter(|id| id != &profile_id)
                .collect();
            persist_pending_deletions(dir, &remaining)?;
        }
        // On failure: leave the id queued (Req 8.6). No persistence needed.
    }
    Ok(())
}

/// Overwrite `settings.pendingDonutDeletions` with `queue` via the Settings_Store
/// overlay-merge write (`pendingDonutDeletions` is not a stripped key, so this
/// path is permitted to persist it). Leaves every other setting untouched.
fn persist_pending_deletions(dir: &Path, queue: &[String]) -> Result<(), String> {
    let mut update = Map::new();
    update.insert("pendingDonutDeletions".to_string(), json!(queue));
    settings::save_to_dir(dir, &update)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 13.3: CDP login flow (Requirement 5.1)
//
// Port of `main.js`'s `puppeteerLogin(chromePath)` — the cookie-capture login
// window. Where the Electron_Build launched a non-headless Chromium via
// `playwright-core` (`chromium.launch({ headless:false, args:[...] })`) and polled
// `Network.getAllCookies` for the `.ROBLOSECURITY` cookie, this uses
// `chromiumoxide`'s `Browser::launch(... .with_head() ...)` and the same
// `Network.getAllCookies` CDP call, at the identical 1500 ms poll interval and
// 5-minute hard timeout. The Electron `ipcMain.once('login:cancel', ...)` cancel
// path is replaced by a `tokio::sync::oneshot` channel: the command layer
// (Task 13.7) holds the `Sender` and fires it when the Renderer_UI requests a
// cancel, which this flow observes on its `Receiver`.
// ─────────────────────────────────────────────────────────────────────────────

/// The URL the login window opens, from `main.js`'s
/// `page.goto('https://www.roblox.com/login', ...)`.
const LOGIN_URL: &str = "https://www.roblox.com/login";

/// The cookie poll cadence, from `main.js`'s `setInterval(..., 1500)`.
const LOGIN_POLL_INTERVAL_MS: u64 = 1500;

/// The hard login timeout, from `main.js`'s `LOGIN_TIMEOUT_MS = 5 * 60 * 1000`
/// ("hard cap -- never hang forever").
const LOGIN_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// The stealth init script registered before navigation, byte-for-byte from
/// `main.js`'s `context.addInitScript(...)` (Playwright's equivalent of
/// Puppeteer's `evaluateOnNewDocument`). Added via
/// [`Page::evaluate_on_new_document`] so it runs on every document before the
/// page's own scripts, exactly as the Electron_Build did.
const STEALTH_INIT_SCRIPT: &str = "\
Object.defineProperty(navigator,'webdriver',{get:()=>false});\
Object.defineProperty(navigator,'plugins',{get:()=>[{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'}]});";

/// The Chromium launch flags, byte-for-byte from `main.js`'s
/// `args: ['--no-sandbox', '--disable-setuid-sandbox',
/// '--disable-blink-features=AutomationControlled', '--window-size=530,700']`.
const LOGIN_CHROME_ARGS: [&str; 4] = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=530,700",
];

/// Port of `main.js`'s `ensureChrome()` (Requirement 5.1): locate a system
/// Chromium-family browser to drive the cookie-capture login window over CDP.
///
/// Scans the same candidate paths in the same order as the Electron_Build,
/// resolving the `ProgramFiles`, `ProgramFiles(x86)`, and `LOCALAPPDATA`
/// environment variables (with the same fallbacks — the two Program Files roots
/// fall back to their `C:\` defaults, and `LOCALAPPDATA` falls back to
/// `%USERPROFILE%\AppData\Local`, mirroring `main.js`'s
/// `path.join(os.homedir(), 'AppData', 'Local')`), and returns the FIRST path
/// that exists on disk. Google Chrome is preferred first (most "vanilla"
/// fingerprint), then Microsoft Edge (ships on every Win10/11 box and is
/// non-removable), then Brave.
///
/// The Electron_Build additionally fell back to Playwright's own bundled
/// Chromium (`chromium.executablePath()`). The Tauri_Build ships no Playwright —
/// it drives CDP via `chromiumoxide` against a system browser — so there is no
/// equivalent bundled-Chromium fallback to scan. Returns `None` when no system
/// Chromium browser is found, so the caller falls back to "Paste Cookie".
pub fn ensure_chrome() -> Option<std::path::PathBuf> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let pf86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    // `LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')`.
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
        format!("{home}\\AppData\\Local")
    });

    let candidates = [
        format!("{pf}\\Google\\Chrome\\Application\\chrome.exe"),
        format!("{pf86}\\Google\\Chrome\\Application\\chrome.exe"),
        format!("{local}\\Google\\Chrome\\Application\\chrome.exe"),
        format!("{pf86}\\Microsoft\\Edge\\Application\\msedge.exe"),
        format!("{pf}\\Microsoft\\Edge\\Application\\msedge.exe"),
        format!("{pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        format!("{local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    ];

    candidates
        .into_iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
}

/// The result of [`run_login_flow`] — the Rust form of `puppeteerLogin`'s resolve
/// value. Serializes to the exact shape the Renderer_UI already branches on:
/// `{ success:true, cookie, username, userId }` on success, or
/// `{ success:false, error }` on any failure.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginResult {
    /// `true` only when a `.ROBLOSECURITY` cookie was captured AND verified via
    /// [`roblox_api::fetch_user_info`].
    pub success: bool,
    /// The captured session cookie value (present only on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
    /// The verified account's username (present only on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// The verified account's user id (present only on success).
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// A user-facing failure message (present only on failure), matching the
    /// exact strings `puppeteerLogin` resolved with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LoginResult {
    fn success(cookie: String, username: Option<String>, user_id: Option<String>) -> Self {
        LoginResult {
            success: true,
            cookie: Some(cookie),
            username,
            user_id,
            error: None,
        }
    }

    fn fail(error: impl Into<String>) -> Self {
        LoginResult {
            success: false,
            cookie: None,
            username: None,
            user_id: None,
            error: Some(error.into()),
        }
    }
}

/// The internal outcome of the poll loop, before it is mapped onto a
/// [`LoginResult`] (success additionally requires the cookie to be verified).
enum LoginOutcome {
    /// A `.ROBLOSECURITY` cookie matching [`matches_login_cookie`] was captured.
    Cookie(String),
    /// The user requested cancel (the `oneshot` fired) — `main.js`'s
    /// `ipcMain.once('login:cancel', ...)` path.
    Cancelled,
    /// The 5-minute hard timeout elapsed.
    Timeout,
    /// The browser disconnected / the login window was closed — `main.js`'s
    /// `browser.on('disconnected', ...)` path.
    Disconnected,
    /// Page setup (navigation / CDP) failed before any cookie could be captured.
    Error(String),
}

/// Pure predicate for the target cookie, from `main.js`'s
/// `cookies.find(ck => ck.name === '.ROBLOSECURITY' &&
/// ck.domain.includes('roblox.com') && ck.value && ck.value.length > 100)`.
/// Kept transport-free so it is unit-testable without a live browser.
fn matches_login_cookie(name: &str, domain: &str, value: &str) -> bool {
    name == ".ROBLOSECURITY" && domain.contains("roblox.com") && value.len() > 100
}

/// Re-resolve the page to poll, mirroring `main.js`'s `resolveActivePage()`:
/// prefer whichever open tab is currently on `roblox.com` (the login flow
/// navigates the tab and spawns popups), else fall back to the last page. Returns
/// `None` when there are no open pages (treated as "retry next tick").
async fn resolve_active_page(browser: &Browser) -> Option<Page> {
    let pages = browser.pages().await.ok()?;
    if pages.is_empty() {
        return None;
    }
    for page in &pages {
        if let Ok(Some(url)) = page.url().await {
            if url.contains("roblox.com") {
                return Some(page.clone());
            }
        }
    }
    pages.into_iter().last()
}

/// One cookie-capture attempt, mirroring `main.js`'s `tryGetCookie()`: resolve the
/// active page, read all browser cookies (`Storage.getCookies`, the CDP
/// equivalent of `main.js`'s `Network.getAllCookies`), and return the matching
/// `.ROBLOSECURITY` value if present. Any error resolves to `None`
/// ("recreated next tick on a freshly resolved page"), never propagates.
async fn try_get_login_cookie(browser: &Browser) -> Option<String> {
    let page = resolve_active_page(browser).await?;
    // `Storage.getCookies` returns ALL cookies in the browser (the CDP equivalent
    // of Playwright's `Network.getAllCookies` used by `main.js`), so a cookie set
    // on `.roblox.com` is found regardless of which tab/popup is currently active.
    let response = page.execute(GetCookiesParams::default()).await.ok()?;
    response
        .result
        .cookies
        .iter()
        .find(|c| matches_login_cookie(&c.name, &c.domain, &c.value))
        .map(|c| c.value.clone())
}

/// The launch + poll portion of the flow, split out so [`run_login_flow`] can run
/// cleanup (close browser, abort the handler task) regardless of how it ends.
/// `browser` is already launched; this sets up the stealth page, navigates to the
/// login URL, and polls until one of the [`LoginOutcome`] conditions is met.
async fn login_poll_loop(
    browser: &Browser,
    handler_task: &mut tokio::task::JoinHandle<()>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> LoginOutcome {
    // Create a blank page, register the stealth init script BEFORE navigation so
    // it applies to the login document (main.js registered it on the context
    // before newPage/goto), then navigate to the login URL.
    let page = match browser.new_page("about:blank").await {
        Ok(page) => page,
        Err(e) => return LoginOutcome::Error(e.to_string()),
    };
    if let Err(e) = page.evaluate_on_new_document(STEALTH_INIT_SCRIPT).await {
        return LoginOutcome::Error(e.to_string());
    }
    if let Err(e) = page.goto(LOGIN_URL).await {
        return LoginOutcome::Error(e.to_string());
    }

    let deadline = tokio::time::Instant::now() + Duration::from_millis(LOGIN_TIMEOUT_MS);
    let mut interval = tokio::time::interval(Duration::from_millis(LOGIN_POLL_INTERVAL_MS));
    // tokio's first `tick()` fires immediately; consume it so the actual polling
    // cadence is a true 1500 ms interval, matching `setInterval(..., 1500)`.
    interval.tick().await;

    loop {
        tokio::select! {
            // User pressed cancel (login:cancel). A dropped Sender also fires here
            // (Err), which we likewise treat as a cancel/closed outcome.
            _ = &mut *cancel_rx => return LoginOutcome::Cancelled,
            // The CDP handler stream ended => the browser process exited / the
            // login window was closed (main.js's `disconnected` event).
            _ = &mut *handler_task => return LoginOutcome::Disconnected,
            // Hard 5-minute cap.
            _ = tokio::time::sleep_until(deadline) => return LoginOutcome::Timeout,
            // Every 1500 ms: poll for the .ROBLOSECURITY cookie.
            _ = interval.tick() => {
                if let Some(value) = try_get_login_cookie(browser).await {
                    return LoginOutcome::Cookie(value);
                }
            }
        }
    }
}

/// Port of `main.js`'s `puppeteerLogin(chromePath)` (Requirement 5.1): launch a
/// non-headless Chromium at `chrome_path`, open the Roblox login page, and poll
/// for the `.ROBLOSECURITY` cookie every 1500 ms until it is captured, the user
/// cancels (via `cancel_rx`, replacing `ipcMain.once('login:cancel')`), the login
/// window is closed, or the 5-minute hard timeout elapses.
///
/// On a captured cookie the account is verified with
/// [`roblox_api::fetch_user_info`] (mirroring `main.js`'s `finishOk` →
/// `fetchUserInfo`) before success is reported; a verification failure resolves to
/// `success:false` with the failure reason. The browser is always closed and the
/// CDP handler task always aborted before returning, matching `puppeteerLogin`'s
/// `cleanup()` in every branch.
///
/// The `roblox_open_login` / `login_cancel` command wrappers (and the `oneshot`
/// sender stored in [`AppState`]) live below in this module and drive this flow:
/// `roblox_open_login` resolves a system browser via [`ensure_chrome`], stores
/// the cancel `Sender`, and awaits this function; `login_cancel` fires that
/// sender to trip `cancel_rx`.
pub async fn run_login_flow(
    chrome_path: &Path,
    mut cancel_rx: oneshot::Receiver<()>,
) -> LoginResult {
    let config = match BrowserConfig::builder()
        .chrome_executable(chrome_path)
        .with_head()
        .args(LOGIN_CHROME_ARGS.iter().map(|s| s.to_string()))
        .build()
    {
        Ok(config) => config,
        Err(e) => return LoginResult::fail(format!("Failed to launch Chrome: {e}")),
    };

    let (browser, mut handler) = match Browser::launch(config).await {
        Ok(pair) => pair,
        Err(e) => return LoginResult::fail(format!("Failed to launch Chrome: {e}")),
    };

    // Drive the CDP message handler concurrently; without this, no page command
    // (goto, getAllCookies) ever resolves. When the browser disconnects the
    // stream ends and this task completes, which `login_poll_loop` observes.
    let mut handler_task = tokio::spawn(async move { while handler.next().await.is_some() {} });

    let outcome = login_poll_loop(&browser, &mut handler_task, &mut cancel_rx).await;

    // cleanup(): close the browser and stop the handler task in every branch.
    let mut browser = browser;
    let _ = browser.close().await;
    handler_task.abort();

    match outcome {
        LoginOutcome::Cookie(value) => match roblox_api::fetch_user_info(&value).await {
            Ok(info) if info.ok => LoginResult::success(value, info.username, info.user_id),
            // fetchUserInfo returned ok:false -> surface its reason.
            Ok(info) => {
                LoginResult::fail(info.reason.unwrap_or_else(|| "Could not verify account.".into()))
            }
            // A transport error verifying the cookie.
            Err(_) => LoginResult::fail("Could not verify account."),
        },
        // Both the cancel path and the window-closed path resolve with the exact
        // string main.js used: 'Login window closed'.
        LoginOutcome::Cancelled | LoginOutcome::Disconnected => {
            LoginResult::fail("Login window closed")
        }
        LoginOutcome::Timeout => LoginResult::fail(
            "Timed out waiting for login. Please try again, or use \"Paste Cookie\".",
        ),
        LoginOutcome::Error(e) => LoginResult::fail(format!("Failed to launch Chrome: {e}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 13.4: CDP cookie injection (Requirements 5.1, 5.2)
//
// Port of `main.js`'s `injectCookieAndNavigate(cdpPort, cookie)` — the mirror
// image of the login flow. Instead of launching Chrome and *reading* the
// `.ROBLOSECURITY` cookie, this connects to an already-running Browser_Instance
// that Donut Browser launched (via the CDP_Port returned by [`run_donut_profile`])
// and *writes* the account's `.ROBLOSECURITY` cookie onto the Roblox website
// domain, then navigates that instance to the Roblox home page.
//
// Where the Electron_Build used `playwright-core`
// (`chromium.connectOverCDP({ endpointURL })` → `Network.setCookie` → `page.goto`),
// this uses `chromiumoxide`'s `Browser::connect` → the same `Network.setCookie`
// CDP command → `page.goto`, preserving the identical sequence (Requirement 5.1).
//
// The cookie MUST be injected strictly BEFORE navigating so the very first
// request to www.roblox.com is already authenticated — so `Network.setCookie` is
// awaited before `page.goto` (Requirement 5.2 / account-browser-launcher Req 1.4,
// design Property 2). On success the connected [`Browser`] and its tracked
// [`Page`] are handed back (inside [`InjectedSession`]) so the session tracker
// (Task 13.5) can hold them and focus/disconnect later; the browser is NEVER
// closed here — over a CDP connection `browser.close()` would tear down the
// user's Browser_Instance. On failure the handler task is aborted and the
// connection dropped, which — for a *connected* (not launched) browser whose
// `child` handle is `None` — never kills the user's Chromium process. The cookie
// value is never logged: any error text is scrubbed of the cookie before it is
// returned (Requirement 5.1 / account-browser-launcher Req 6.1).
// ─────────────────────────────────────────────────────────────────────────────

/// The Roblox home page the injected Browser_Instance navigates to AFTER the
/// cookie is set, from `main.js`'s `page.goto('https://www.roblox.com', ...)`.
const ROBLOX_HOME_URL: &str = "https://www.roblox.com";

/// The navigation timeout, from `main.js`'s `page.goto(..., { timeout: 30000 })`.
/// `chromiumoxide`'s `goto` has no per-call timeout, so the navigation is wrapped
/// in a `tokio::time::timeout` to reproduce the same hard cap and guarantee the
/// injection flow can never hang indefinitely.
const INJECT_NAV_TIMEOUT_MS: u64 = 30_000;

/// A successfully injected, connected Browser_Instance — the Rust form of
/// `injectCookieAndNavigate`'s `{ ok: true, browser, page }` resolve value.
///
/// Holds the connected [`Browser`], its tracked [`Page`] (already navigated to
/// the authenticated Roblox home page), and the [`tokio::task::JoinHandle`]
/// driving the CDP handler stream. All three MUST be kept alive by the caller
/// (the Task 13.5 session tracker): dropping `browser` tears down this process's
/// CDP connection (but NOT the user's Chromium, whose process handle this
/// connection never owned), and dropping/aborting `handler_task` stops CDP
/// message pumping. This type is intentionally not `Serialize` — it never crosses
/// the IPC boundary; only the derived `{ ok, error }` shape does (Task 13.7).
pub struct InjectedSession {
    /// The connected browser (over CDP). Never closed by this module.
    pub browser: Browser,
    /// The tab the cookie was injected into and that was navigated to Roblox.
    pub page: Page,
    /// The task pumping CDP messages; abort it to release the connection.
    pub handler_task: tokio::task::JoinHandle<()>,
}

/// Build the redacted, user-facing error string for a cookie-injection failure —
/// the port of `main.js`'s
/// `'Could not inject cookie into the browser: ' + redactSecrets(e.message, launcherSecrets(cookie))`.
///
/// The cookie value is added to the redaction set so it can never leak into the
/// returned message even though it is never intentionally placed there
/// (Requirement 5.1 / account-browser-launcher Req 6.1). This mirrors the JS
/// `catch` block, which prefixes and scrubs; the two early-return guards
/// (`No CDP port` / `No cookie to inject`) sit OUTSIDE this block and are returned
/// verbatim, exactly as in the Electron_Build.
fn inject_error(cookie: &str, message: &str) -> String {
    let safe = logging::redaction::redact_string(message, &[cookie.to_string()]);
    format!("Could not inject cookie into the browser: {safe}")
}

/// Inject the `.ROBLOSECURITY` cookie into the already-connected `browser` and
/// navigate its active tab to the Roblox home page — the body of the JS `try`
/// block. Reuses the tab Donut Browser already opened (`pages[0]`), falling back
/// to a new page only when none exist, then sets the cookie BEFORE navigating.
///
/// Returns the navigated [`Page`] on success, or a raw (un-prefixed, un-redacted)
/// error string on failure; [`inject_cookie_and_navigate`] applies the prefix and
/// cookie-redaction.
async fn inject_on_connection(browser: &Browser, cookie: &str) -> Result<Page, String> {
    // Reuse the context/tab Donut Browser already opened rather than spawning a
    // second one — `main.js`'s `pages.length > 0 ? pages[0] : context.newPage()`.
    let pages = browser.pages().await.map_err(|e| e.to_string())?;
    let page = match pages.into_iter().next() {
        Some(page) => page,
        None => browser
            .new_page("about:blank")
            .await
            .map_err(|e| e.to_string())?,
    };

    // Inject the `.ROBLOSECURITY` cookie onto the Roblox website domain FIRST.
    // Scoped to `.roblox.com` so it applies across roblox.com subdomains, and
    // marked Secure/HttpOnly/SameSite=Lax to match how Roblox itself sets the real
    // cookie — byte-for-byte the same fields `main.js` passed to
    // `Network.setCookie`.
    let params = SetCookieParams::builder()
        .name(".ROBLOSECURITY")
        .value(cookie.to_string())
        .domain(".roblox.com")
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(CookieSameSite::Lax)
        .build()?;
    page.execute(params).await.map_err(|e| e.to_string())?;

    // Only AFTER the cookie is set do we navigate, so the home-page request is
    // authenticated from the first byte (Requirement 5.2). The 30-second cap
    // mirrors `main.js`'s goto `{ timeout: 30000 }`.
    match tokio::time::timeout(
        Duration::from_millis(INJECT_NAV_TIMEOUT_MS),
        page.goto(ROBLOX_HOME_URL),
    )
    .await
    {
        Ok(Ok(_)) => Ok(page),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("navigation to the Roblox home page timed out".to_string()),
    }
}

/// Port of `main.js`'s `injectCookieAndNavigate(cdpPort, cookie)` (Requirements
/// 5.1, 5.2): connect over CDP to the Browser_Instance at
/// `http://127.0.0.1:{cdp_port}`, inject the account's `.ROBLOSECURITY` cookie via
/// `Network.setCookie`, then navigate to the Roblox home page — in that order.
///
/// Resolve-never-reject, like the JS: the two input guards return the exact
/// verbatim strings the Electron_Build used, and every other failure resolves to
/// `Err` with a `"Could not inject cookie into the browser: …"` message whose text
/// has been scrubbed of the cookie value (Requirement 5.1). On success the
/// connected browser is handed back in an [`InjectedSession`] and is NEVER closed
/// (closing over CDP would destroy the user's Browser_Instance).
///
/// This function intentionally does NOT register a Tauri command or the
/// per-account session tracking — the session tracker (Task 13.5) and the
/// `browser_open` command wiring (Task 13.7) consume this.
pub async fn inject_cookie_and_navigate(
    cdp_port: u32,
    cookie: &str,
) -> Result<InjectedSession, String> {
    // The two guard clauses mirror `main.js`'s `if (!cdpPort)` / `if (!cookie)`
    // early returns — returned verbatim, WITHOUT the catch-block prefix/redaction.
    if cdp_port == 0 {
        return Err("No CDP port for the Browser_Instance.".to_string());
    }
    if cookie.is_empty() {
        return Err("No cookie to inject.".to_string());
    }

    // `chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:${cdpPort}' })`.
    // `Browser::connect` accepts the HTTP endpoint and resolves the WebSocket URL
    // from the instance's `/json/version` itself.
    let endpoint = format!("http://127.0.0.1:{cdp_port}");
    let (browser, mut handler) = match Browser::connect(endpoint).await {
        Ok(pair) => pair,
        // A connect failure is inside the JS `try`, so it is prefixed + redacted.
        Err(e) => return Err(inject_error(cookie, &e.to_string())),
    };

    // Drive the CDP message handler concurrently; without this, no page command
    // (setCookie, goto) ever resolves. Mirrors the login flow's handler task.
    let handler_task = tokio::spawn(async move { while handler.next().await.is_some() {} });

    match inject_on_connection(&browser, cookie).await {
        Ok(page) => Ok(InjectedSession {
            browser,
            page,
            handler_task,
        }),
        Err(e) => {
            // On failure we deliberately do NOT close the browser: over a CDP
            // connection that would tear down the user's Browser_Instance. We only
            // abort our handler task and drop the connection — a *connected*
            // browser's `Drop` never kills the process (its `child` handle is
            // `None`), so the user's Chromium is left untouched (Req 4).
            handler_task.abort();
            drop(browser);
            Err(inject_error(cookie, &e))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 13.5: per-account session tracking + Copy Cookie (Requirement 5.1)
//
// Port of `main.js`'s `_browserSessions` map and the helpers that drive it —
// `focusExistingSession` (dedupe by focusing an already-open instance instead of
// launching a second one, account-browser-launcher Req 4.2/4.4), the
// `disconnected`-handler `clearSessionOnDisconnect` (clear-on-disconnect, Req
// 4.3), `closeTrackedBrowserInstance` (account-removal teardown, Req 8.3), and
// `copyAccountCookie` (the Copy Cookie flow with clipboard write + read-back
// verification, Req 5.2-5.5).
//
// The live map lives in [`crate::AppState::browser_sessions`] as
// `HashMap<String, BrowserSession>`; like `main.js`'s `_browserSessions` it is
// intentionally NOT persisted (it describes only this process's live CDP
// connections). An account with no entry is treated as never-opened, so a
// selection after the instance closed starts a fresh `/run`
// (account-browser-launcher Req 4.3, design Property 11).
//
// This task provides the tracking primitives and the Copy Cookie logic (the
// latter over a [`Clipboard`] abstraction so the read-back verification is
// testable without a real clipboard). It intentionally does NOT register any
// Tauri command: the `browser_open` / `browser_copy_cookie` command wiring — and
// the concrete `tauri-plugin-clipboard-manager`-backed [`Clipboard`] impl the
// command threads in — is Task 13.7, mirroring how the login/inject flows above
// deferred their command registration.
// ─────────────────────────────────────────────────────────────────────────────

/// The lifecycle state of a tracked Browser_Instance, mirroring the `state`
/// field of `main.js`'s `_browserSessions` entry (`'opening' | 'open'`). The map
/// only ever holds these two states — an entry's removal IS the transition to
/// the closed/absent state — so a "closed" variant is deliberately unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Set the instant `openAccountBrowser` commits to a `/run`, BEFORE a
    /// connected browser exists, so a rapid second selection is deduped
    /// (account-browser-launcher Req 4.4). No [`LiveSession`] is attached yet.
    Opening,
    /// Set once the cookie is injected and the page is up, carrying the connected
    /// [`LiveSession`] (account-browser-launcher Req 4.2).
    Open,
}

/// The live CDP connection backing an `open` session — the Rust form of the
/// `browser` + `page` fields on `main.js`'s `_browserSessions` entry.
///
/// Holds the connected [`Browser`] and the tracked [`Page`] (already navigated to
/// the authenticated Roblox home page). The CDP message-pump task is NOT stored
/// here: it is moved into the disconnect monitor spawned by [`mark_session_open`],
/// whose completion (the browser disconnecting) is what triggers
/// clear-on-disconnect. Dropping this struct drops the [`Browser`], which closes
/// THIS process's CDP connection but never kills the user's Chromium (a
/// *connected* browser owns no child process handle).
pub struct LiveSession {
    /// The connected browser (over CDP). Never `close()`d except by the explicit
    /// account-removal teardown [`close_tracked_browser_instance`].
    pub browser: Browser,
    /// The tab the cookie was injected into and that was navigated to Roblox;
    /// the target [`focus_existing_session`] brings to the foreground.
    pub page: Page,
}

/// A tracked per-account browser session — the Rust form of a `main.js`
/// `_browserSessions` entry `{ state, profileId, cdpPort, browser, page }`.
///
/// Stored in [`crate::AppState::browser_sessions`]. `live` is `None` while
/// `state == Opening` (no connected browser yet) and `Some` once `Open`.
pub struct BrowserSession {
    /// `opening` or `open`; see [`SessionState`].
    pub state: SessionState,
    /// The Donut_Profile id backing this session (`profileId` in the JS entry).
    pub profile_id: String,
    /// The CDP_Port the session connected over, once known (`None` while opening).
    pub cdp_port: Option<u32>,
    /// The live connection, present iff `state == Open`.
    pub live: Option<LiveSession>,
}

/// The result of [`focus_existing_session`] — the Rust form of the JS
/// `{ ok, focused, error: null|'no_session'|'not_active'|string }`.
///
/// `ok` is `true` whenever the dedupe contract is satisfied (no second `/run`
/// should be sent), regardless of whether a window was actually raised; `focused`
/// reports whether a window was brought to the foreground.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusResult {
    pub ok: bool,
    pub focused: bool,
    pub error: Option<String>,
}

impl FocusResult {
    /// `{ ok:false, focused:false, error:'no_session' }` — no entry tracked.
    fn no_session() -> Self {
        FocusResult {
            ok: false,
            focused: false,
            error: Some("no_session".to_string()),
        }
    }

    /// `{ ok:true, focused:false, error:null }` — deduped but nothing to raise
    /// (still `opening`, or an open instance with no raisable page).
    fn deduped() -> Self {
        FocusResult {
            ok: true,
            focused: false,
            error: None,
        }
    }

    /// `{ ok:true, focused:true, error:null }` — a window was raised.
    fn focused() -> Self {
        FocusResult {
            ok: true,
            focused: true,
            error: None,
        }
    }

    /// `{ ok:false, focused:false, error:<msg> }` — a focus attempt threw.
    fn error(message: impl Into<String>) -> Self {
        FocusResult {
            ok: false,
            focused: false,
            error: Some(message.into()),
        }
    }
}

/// Bring a page to the foreground via the CDP `Page.bringToFront` command — the
/// port of `main.js`'s `page.bringToFront()`, which "activates the tab and
/// raises/un-minimizes the browser window". Uses the raw CDP command (like the
/// cookie-injection flow uses `Network.setCookie`) so it depends only on the
/// generated protocol, not a convenience wrapper.
async fn bring_page_to_front(page: &Page) -> Result<(), String> {
    page.execute(BringToFrontParams::default())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Mark an account's session `opening` BEFORE issuing `/run`, so a second
/// selection arriving mid-open is deduped rather than launching a duplicate
/// instance — the port of `main.js`'s
/// `_browserSessions.set(accountId, { state:'opening', profileId, ... })`.
///
/// Overwrites any prior entry for the account (the open flow only reaches this
/// after the dedupe check found no active session).
pub async fn mark_session_opening(
    sessions: &AsyncMutex<HashMap<String, BrowserSession>>,
    account_id: &str,
    profile_id: &str,
) {
    let mut guard = sessions.lock().await;
    guard.insert(
        account_id.to_string(),
        BrowserSession {
            state: SessionState::Opening,
            profile_id: profile_id.to_string(),
            cdp_port: None,
            live: None,
        },
    );
}

/// Remove an account's tracked session, returning the removed entry if any — the
/// port of the `_browserSessions.delete(accountId)` calls the open flow makes on
/// a `/run` or cookie-injection failure (account-browser-launcher Req 1.6: leave
/// NO session recorded as open so a later selection starts cleanly).
///
/// Any live connection carried by the removed entry is dropped (closing THIS
/// process's CDP connection, never the user's Chromium). Returns the prior entry
/// so a caller can inspect it if needed.
pub async fn untrack_session(
    sessions: &AsyncMutex<HashMap<String, BrowserSession>>,
    account_id: &str,
) -> Option<BrowserSession> {
    let mut guard = sessions.lock().await;
    guard.remove(account_id)
}

/// Transition an account's session to `open` after a fully successful open,
/// storing the live connection and wiring clear-on-disconnect — the port of
/// `main.js`'s success tail:
///
/// ```js
/// browser.once('disconnected', () => clearSessionOnDisconnect(accountId));
/// _browserSessions.set(accountId, { state:'open', profileId, cdpPort, browser, page });
/// ```
///
/// The [`InjectedSession`]'s CDP message-pump task is moved into a spawned
/// disconnect monitor: when the Browser_Instance goes away (the user closes the
/// window or the process dies) the CDP stream ends, the pump task completes, and
/// the monitor clears the tracked entry (account-browser-launcher Req 4.3 /
/// design Property 11) so the next selection is treated as a first-time open.
/// `sessions` is taken by `Arc` (not `&`) precisely so the monitor can hold its
/// own handle to the map.
pub async fn mark_session_open(
    sessions: Arc<AsyncMutex<HashMap<String, BrowserSession>>>,
    account_id: String,
    profile_id: String,
    cdp_port: u32,
    injected: InjectedSession,
) {
    let InjectedSession {
        browser,
        page,
        handler_task,
    } = injected;

    {
        let mut guard = sessions.lock().await;
        guard.insert(
            account_id.clone(),
            BrowserSession {
                state: SessionState::Open,
                profile_id,
                cdp_port: Some(cdp_port),
                live: Some(LiveSession { browser, page }),
            },
        );
    }

    // Clear-on-disconnect: the CDP pump task completes when the browser
    // disconnects (stream ends) — `main.js`'s `browser.on('disconnected', ...)`.
    // Awaiting it here (rather than storing it in the map) lets us drop the entry
    // exactly when the instance goes away.
    let monitor_sessions = Arc::clone(&sessions);
    tokio::spawn(async move {
        let _ = handler_task.await;
        clear_session_on_disconnect(&monitor_sessions, &account_id).await;
    });
}

/// Restore/activate the Browser_Instance already tracked for an account instead
/// of launching a second one — the port of `main.js`'s
/// `focusExistingSession(accountId)` (account-browser-launcher Req 4.2).
///
/// Contract, matching the JS resolve-never-reject helper:
///   * no tracked entry → `{ ok:false, focused:false, error:'no_session' }`.
///   * `opening` (no live browser yet) → `{ ok:true, focused:false }` (dedupe
///     only; there is nothing to raise, but no second `/run` must be sent).
///   * `open` → bring the tracked page to the foreground via
///     [`bring_page_to_front`], falling back to the first open tab if the tracked
///     page cannot be raised; `{ ok:true, focused:true }` on success, or
///     `{ ok:true, focused:false }` when the instance has no raisable page. A
///     thrown focus error resolves to `{ ok:false, focused:false, error:<msg> }`,
///     never a panic and never a duplicate launch.
pub async fn focus_existing_session(
    sessions: &AsyncMutex<HashMap<String, BrowserSession>>,
    account_id: &str,
) -> FocusResult {
    let guard = sessions.lock().await;
    let session = match guard.get(account_id) {
        Some(session) => session,
        None => return FocusResult::no_session(),
    };

    // 'opening' (no connected browser yet): dedupe only, nothing to raise.
    let live = match session.live.as_ref() {
        Some(live) => live,
        None => return FocusResult::deduped(),
    };

    // 'open': try the exact tracked page first; on failure fall back to the first
    // open tab (mirrors `main.js`'s `session.page` → `collectBrowserPages(...)[0]`).
    match bring_page_to_front(&live.page).await {
        Ok(()) => FocusResult::focused(),
        Err(tracked_err) => match live.browser.pages().await {
            Ok(pages) => match pages.first() {
                Some(page) => match bring_page_to_front(page).await {
                    Ok(()) => FocusResult::focused(),
                    Err(e) => FocusResult::error(e),
                },
                // No open tabs at all: deduped, nothing raised (JS returns
                // ok:true/focused:false when `pages.length === 0`).
                None => FocusResult::deduped(),
            },
            // Could not even enumerate tabs: surface the original focus error.
            Err(_) => FocusResult::error(tracked_err),
        },
    }
}

/// Drop an account's tracked session when its Browser_Instance goes away — the
/// port of `main.js`'s `clearSessionOnDisconnect(accountId)` (the `disconnected`
/// handler, account-browser-launcher Req 4.3). Removing the entry IS the
/// transition to the closed/absent state, since the map only holds
/// `opening`/`open` sessions.
///
/// Returns `true` if a session was cleared, `false` if none was tracked (matching
/// the JS `Map.delete` boolean).
pub async fn clear_session_on_disconnect(
    sessions: &AsyncMutex<HashMap<String, BrowserSession>>,
    account_id: &str,
) -> bool {
    let mut guard = sessions.lock().await;
    guard.remove(account_id).is_some()
}

/// Close a tracked Browser_Instance for an account and confirm it has gone away —
/// the port of `main.js`'s `closeTrackedBrowserInstance(accountId)`, used by the
/// account-removal cleanup (account-browser-launcher Req 8.3) to tear down a live
/// instance BEFORE deleting its Donut_Profile.
///
/// ```js
/// async function closeTrackedBrowserInstance(accountId) {
///   const session = _browserSessions.get(accountId);
///   if (!session) return { closed: false };
///   const browser = session.browser;
///   if (!browser) { _browserSessions.delete(accountId); return { closed: true }; }
///   try { await browser.close(); } catch (_) {}
///   _browserSessions.delete(accountId);
///   return { closed: true };
/// }
/// ```
///
/// Best-effort and infallible-in-spirit: it resolves whether the browser closed
/// cleanly, had to be force-closed, or was already gone, but always awaits the
/// close so the caller may treat resolution as "confirmed closed". The entry is
/// removed regardless of event ordering (the disconnect monitor may also fire and
/// clear it). Unlike the injection-flow teardown, this DELIBERATELY calls
/// `browser.close()`: the whole point of account removal is to tear the
/// Browser_Instance down. Returns `true` if an instance was tracked (and thus
/// closed), `false` if none was tracked.
pub async fn close_tracked_browser_instance(
    sessions: &AsyncMutex<HashMap<String, BrowserSession>>,
    account_id: &str,
) -> bool {
    // Remove first so the concurrently-running disconnect monitor can't race us to
    // a second teardown; take ownership of any live connection to close it.
    let removed = {
        let mut guard = sessions.lock().await;
        guard.remove(account_id)
    };
    let session = match removed {
        Some(session) => session,
        None => return false,
    };
    // 'opening': no connected browser exists yet, so there is nothing to close.
    if let Some(mut live) = session.live {
        // `await`ing close resolves once the connection is gone — our confirmation
        // the instance is closed. A close failure still means we stop tracking.
        let _ = live.browser.close().await;
    }
    true
}

// ── Copy Cookie (account-browser-launcher Req 5.2-5.5) ────────────────────────

/// Abstraction over the system clipboard for the Copy Cookie flow, so the
/// write-then-read-back verification logic is testable without a real clipboard
/// and decoupled from the Tauri command layer.
///
/// The Electron_Build used Electron's main-process `clipboard` module directly;
/// the Tauri_Build's `browser_copy_cookie` command (Task 13.7) supplies a
/// concrete implementation backed by `tauri-plugin-clipboard-manager`
/// (`app.clipboard().write_text(...)` / `.read_text()`), while unit tests supply
/// a fake. Both methods return `Err` on an OS clipboard failure so the flow can
/// surface the distinct error messages Requirement 5.5 requires.
pub trait Clipboard {
    /// Write plain text to the system clipboard (`clipboard.writeText`).
    fn write_text(&self, text: &str) -> Result<(), String>;
    /// Read the current plain-text clipboard contents (`clipboard.readText`).
    fn read_text(&self) -> Result<String, String>;
}

/// The result of [`copy_account_cookie_with`] — the Rust form of
/// `copyAccountCookie`'s `{ ok, error? }` resolve value, serialized to the exact
/// shape the Renderer_UI already branches on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopyCookieResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CopyCookieResult {
    fn ok() -> Self {
        CopyCookieResult {
            ok: true,
            error: None,
        }
    }

    fn err(message: impl Into<String>) -> Self {
        CopyCookieResult {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// A human-facing label for an account, used only in user-facing error text — the
/// port of `main.js`'s `accountLabel(account)`. Prefers the nickname, then the
/// username, then the user id, then the internal id, so the message always names
/// *some* account even for a barely-populated record. (The Rust `Account` fields
/// are non-`Option` strings, so "present" means non-empty, matching the JS `||`.)
pub fn account_label(account: &Account) -> String {
    for candidate in [
        &account.nickname,
        &account.username,
        &account.user_id,
        &account.id,
    ] {
        if !candidate.is_empty() {
            return candidate.clone();
        }
    }
    "this account".to_string()
}

/// Copy an account's `.ROBLOSECURITY` cookie to the system clipboard with
/// post-write read-back verification — the port of `main.js`'s
/// `copyAccountCookie(accountId)` (account-browser-launcher Req 5.2-5.5).
///
/// ```js
/// async function copyAccountCookie(accountId) {
///   const account = loadAccounts().find(a => a.id === accountId) || null;
///   if (!account) return { ok:false, error:'Account not found.' };
///   const cookie = account.cookie;
///   if (!cookie) return { ok:false, error:`No cookie is stored for ${accountLabel(account)}.` };
///   try { clipboard.writeText(cookie); } catch { return { ok:false, error:'Could not write the cookie to the clipboard.' }; }
///   let readBack; try { readBack = clipboard.readText(); } catch { return { ok:false, error:'Could not verify the cookie on the clipboard.' }; }
///   if (readBack !== cookie) return { ok:false, error:'The cookie could not be verified on the clipboard.' };
///   return { ok:true };
/// }
/// ```
///
/// The flow, matching the Electron_Build step for step:
///   1. Unknown account (or an unreadable store) → `Account not found.`, clipboard
///      untouched.
///   2. No stored cookie → an account-identifying error, clipboard untouched
///      (Req 5.4 / Property 15).
///   3. Write the decrypted cookie; a write failure → error, cookie stored value
///      unchanged (Req 5.5).
///   4. Read the clipboard back; a read failure → error (Req 5.5).
///   5. Require the read-back to EXACTLY equal the written cookie; a mismatch →
///      error (Req 5.3/5.5). Only an exact match yields success.
///
/// The account's stored cookie is never modified by this flow. `account.cookie`
/// is already decrypted by [`load_accounts`]. Logging (with the cookie supplied
/// purely as a redaction secret, Req 6) is applied by the Task 13.7 command
/// wrapper, mirroring how the login/inject flows defer logging to their commands.
pub fn copy_account_cookie_with(
    dir: &Path,
    account_id: &str,
    clipboard: &dyn Clipboard,
) -> CopyCookieResult {
    // A store read failure resolves to "not found" (empty list), matching how the
    // JS `loadAccounts().find(...)` yields no account when the store can't load.
    let accounts = load_accounts(dir).unwrap_or_default();
    let account = match accounts.into_iter().find(|a| a.id == account_id) {
        Some(account) => account,
        None => return CopyCookieResult::err("Account not found."),
    };

    // No cookie stored: error naming the account, DO NOT touch the clipboard
    // (Req 5.4 / Property 15).
    let cookie = account.cookie.clone();
    if cookie.is_empty() {
        return CopyCookieResult::err(format!(
            "No cookie is stored for {}.",
            account_label(&account)
        ));
    }

    // Write, then read back and require an exact match (Req 5.2/5.3/5.5).
    if clipboard.write_text(&cookie).is_err() {
        return CopyCookieResult::err("Could not write the cookie to the clipboard.");
    }
    let read_back = match clipboard.read_text() {
        Ok(text) => text,
        Err(_) => return CopyCookieResult::err("Could not verify the cookie on the clipboard."),
    };
    if read_back != cookie {
        return CopyCookieResult::err("The cookie could not be verified on the clipboard.");
    }

    CopyCookieResult::ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 13.7: command layer + events (Requirements 10.1, 10.2)
//
// Wires the Account_Browser_Launcher's two Tauri commands and its push-event
// surface onto the pieces the earlier 13.x tasks built:
//
//   * `browser_open`        <- ipcMain.handle('browser:open',      (_, id) => openAccountBrowser(id))
//   * `browser_copy_cookie` <- ipcMain.handle('browser:copyCookie',(_, id) => copyAccountCookie(id))
//
// Events (design IPC_Surface mapping):
//   * `browser://notify`           <- webContents.send('browser:notify', ...)         (accounts.rs)
//   * `browser://session-state`    <- ipcRenderer.on('browser:sessionState', ...)     (see note)
//   * `chrome://download-progress` <- ipcRenderer.on('chrome:download-progress', ...)  (see note)
//
// NOTE on session-state / download-progress: in the Electron_Build these two are
// declared as `window.api` subscription points (`onBrowserSessionState`,
// `onChromeProgress`) but the main process NEVER emits them in the browser-open /
// copy-cookie flows (grep of `src/main.js` finds no `webContents.send` for either;
// only `browser:notify` is ever sent, from the `accounts:remove` handler). This
// is a faithful behavioral port (Requirement 13.1 — no new user-facing behavior),
// so this module defines the canonical event names as the Tauri channels the
// adapted `preload.js` (Task 17) listens on, satisfying Requirement 10.2/10.4's
// "an equivalent event exists for every subscription" bar, WITHOUT introducing
// emissions the Electron_Build did not make. `browser://notify`'s single emission
// point remains the `accounts_remove` command in `accounts.rs`.
// ─────────────────────────────────────────────────────────────────────────────

/// Tauri event replacing the Electron `browser:sessionState` `webContents`
/// subscription (`window.api.onBrowserSessionState`). See the section note: the
/// Electron_Build declares this channel but does not emit on it during the
/// open/copy flows, so this constant defines the canonical channel name for the
/// adapted `preload.js` without adding a new emission.
pub const BROWSER_SESSION_STATE_EVENT: &str = "browser://session-state";

/// Tauri event replacing the Electron `chrome:download-progress` `webContents`
/// subscription (`window.api.onChromeProgress`, used by the login UI). See the
/// section note: the Electron_Build declares this channel but its Playwright
/// login flow never emits progress on it, so this constant defines the canonical
/// channel name for the adapted `preload.js` without adding a new emission.
pub const CHROME_DOWNLOAD_PROGRESS_EVENT: &str = "chrome://download-progress";

/// Re-export of the `browser://notify` event name (defined by `accounts.rs`,
/// whose `accounts_remove` command owns its single emission point) so the whole
/// Account_Browser_Launcher event surface is discoverable from one module.
pub use crate::accounts::BROWSER_NOTIFY_EVENT;

/// The concrete [`Clipboard`] backed by `tauri-plugin-clipboard-manager`, the
/// Tauri_Build's replacement for Electron's main-process `clipboard` module
/// (design "Overview" rationale). Wraps an [`AppHandle`] and delegates to the
/// plugin's `ClipboardExt::clipboard().write_text()` / `.read_text()`; any OS
/// clipboard failure surfaces as `Err(String)` so [`copy_account_cookie_with`]
/// can report the distinct write/verify error messages Requirement 5.5 requires.
pub struct TauriClipboard<'a> {
    app: &'a AppHandle,
}

impl<'a> TauriClipboard<'a> {
    /// Wrap an [`AppHandle`] for the duration of one Copy Cookie invocation.
    pub fn new(app: &'a AppHandle) -> Self {
        TauriClipboard { app }
    }
}

impl Clipboard for TauriClipboard<'_> {
    fn write_text(&self, text: &str) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app
            .clipboard()
            .write_text(text.to_string())
            .map_err(|e| e.to_string())
    }

    fn read_text(&self) -> Result<String, String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app.clipboard().read_text().map_err(|e| e.to_string())
    }
}

/// The result of [`open_account_browser`] — the Rust form of
/// `openAccountBrowser`'s `{ ok, error?, focused? }` resolve value, serialized to
/// the exact shape the Renderer_UI already branches on:
///   * fresh success → `{ ok: true }` (no `error`, no `focused`),
///   * dedupe/focus  → `{ ok: true, focused: <bool> }`,
///   * failure       → `{ ok: false, error: <message> }`.
///
/// `error`/`focused` are omitted when absent (matching the JS object literals),
/// so a Renderer_UI reading `r.ok` / `r.focused` / `r.error` sees identical
/// payloads to the Electron_Build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
}

impl OpenResult {
    /// `{ ok: true }` — a fully successful fresh open.
    fn ok() -> Self {
        OpenResult {
            ok: true,
            error: None,
            focused: None,
        }
    }

    /// `{ ok: false, error }` — any stage failure.
    fn err(message: impl Into<String>) -> Self {
        OpenResult {
            ok: false,
            error: Some(message.into()),
            focused: None,
        }
    }

    /// `{ ok: true, focused }` — an already-opening/open account was deduped and
    /// (best-effort) focused, from the JS `return { ok: true, focused: !!focus.focused }`.
    fn deduped(focused: bool) -> Self {
        OpenResult {
            ok: true,
            error: None,
            focused: Some(focused),
        }
    }
}

/// Map a [`Availability`] failure to the distinct user-facing message each mode
/// requires — the port of `main.js`'s `availabilityError(code)` (design
/// Property 8). [`Availability::Ok`] maps to the JS `default` branch, matching the
/// Electron switch's fall-through wording.
fn availability_error(availability: Availability) -> &'static str {
    match availability {
        Availability::NoToken => {
            "No Donut Browser API token is configured. Add one in Settings to open account browsers."
        }
        Availability::Unreachable => {
            "Donut Browser is not running or not reachable. Start Donut Browser and enable its Local API."
        }
        Availability::Unauthorized => {
            "The configured Donut Browser API token is invalid. Update it in Settings."
        }
        Availability::PaymentRequired => {
            "An active Donut Browser Pro subscription is required for this action."
        }
        Availability::Ok => "Donut Browser is not available.",
    }
}

/// The full "Open in Browser" orchestration — the direct port of `main.js`'s
/// `openAccountBrowser(accountId)` (Requirement 5.1). Every check is re-evaluated
/// per invocation (nothing cached across calls) and runs in the same fixed order
/// so a failure short-circuits before any later, more expensive step:
///
///   1. Windows-only platform gate.
///   2. Account lookup + has-cookie gate (no Donut call without a stored cookie).
///   3. Session dedupe: an `opening`/`open` account is focused (via
///      [`focus_existing_session`]) instead of launching a second instance.
///   4. Preflight: reachability + auth ([`check_donut_availability`]), then the
///      wayfern engine ([`ensure_wayfern_engine`]) — both re-checked every call.
///   5. Resolve/create the Donut_Profile ([`resolve_or_create_profile`]).
///   6. Mark the session `opening`, `/run` it, inject the cookie then navigate,
///      and only on full success mark the session `open` (wiring disconnect
///      cleanup via [`mark_session_open`]).
///
/// On any stage failure it logs via [`logging::log_browser`] (which redacts the
/// cookie / Donut_API_Token, Requirement 4.3) and leaves NO session recorded as
/// open (Requirement 5.1 / account-browser-launcher Req 1.6), so a later
/// selection starts cleanly. Resolve-never-reject: always returns an
/// [`OpenResult`], never an `Err`.
pub async fn open_account_browser(
    app: &AppHandle,
    dir: &Path,
    sessions: Arc<AsyncMutex<HashMap<String, BrowserSession>>>,
    account_id: &str,
) -> OpenResult {
    // Resolved once and threaded into every log call so the token can never leak
    // into a log entry, mirroring `main.js`'s `launcherSecrets` (which always
    // includes `getDonutToken()`).
    let donut_token = get_donut_token(dir);

    // 1. Windows-only, matching the rest of the app. Short-circuits before any
    //    reachability check, profile call, or injection.
    if !cfg!(target_os = "windows") {
        let error = "Open in Browser is available on Windows only.";
        logging::log_browser(
            app,
            "warn",
            error,
            json!({ "accountId": account_id }),
            None,
            None,
            donut_token.as_deref(),
        );
        return OpenResult::err(error);
    }

    // A store read failure resolves to "not found" (empty list), matching the JS
    // `loadAccounts().find(...)` yielding no account when the store can't load.
    let accounts = load_accounts(dir).unwrap_or_default();
    let account = match accounts.into_iter().find(|a| a.id == account_id) {
        Some(account) => account,
        None => {
            logging::log_browser(
                app,
                "error",
                "Open in Browser: account not found.",
                json!({ "accountId": account_id }),
                None,
                None,
                donut_token.as_deref(),
            );
            return OpenResult::err("Account not found.");
        }
    };

    // 2. Missing cookie -> error identifying the account, no Donut calls at all.
    //    `account.cookie` is already decrypted by `load_accounts`.
    if account.cookie.is_empty() {
        logging::log_browser(
            app,
            "error",
            "Open in Browser: no ROBLOSECURITY cookie stored for this account.",
            Value::Null,
            Some(&account),
            None,
            donut_token.as_deref(),
        );
        return OpenResult::err(format!(
            "No cookie is stored for {}.",
            account_label(&account)
        ));
    }

    // 3. Dedupe: if a Browser_Instance for this account is already opening or open,
    //    focus it instead of sending a second `/run`.
    let already_tracked = {
        let guard = sessions.lock().await;
        matches!(
            guard.get(account_id).map(|s| s.state),
            Some(SessionState::Opening) | Some(SessionState::Open)
        )
    };
    if already_tracked {
        let focus = focus_existing_session(&sessions, account_id).await;
        return OpenResult::deduped(focus.focused);
    }

    // 4a. Reachability + token/auth preflight, re-run every invocation. No
    //     profile/run/inject call happens unless this passes.
    let avail = check_donut_availability(dir).await;
    if !avail.is_ok() {
        logging::log_browser(
            app,
            "error",
            &format!(
                "Open in Browser preflight failed: {}.",
                avail.as_error_str().unwrap_or("unavailable")
            ),
            Value::Null,
            Some(&account),
            None,
            donut_token.as_deref(),
        );
        return OpenResult::err(availability_error(avail));
    }

    // Donut Browser is confirmed reachable, so retry any Donut_Profile deletions
    // queued while it was unreachable (account-browser-launcher Req 8.5).
    // Fire-and-forget, exactly as `main.js`'s
    // `Promise.resolve(retryPendingDeletions()).catch(() => {})` — it never blocks
    // or fails the open flow.
    {
        let dir_owned = dir.to_path_buf();
        tokio::spawn(async move {
            let _ = retry_pending_deletions(&dir_owned).await;
        });
    }

    // 4b. Ensure the wayfern engine is present, re-checked every invocation.
    //     Abort (open nothing) if it can't be prepared.
    if let Err(engine_err) = ensure_wayfern_engine(dir).await {
        logging::log_browser(
            app,
            "error",
            &format!(
                "Open in Browser: wayfern engine unavailable ({}).",
                engine_err.as_str()
            ),
            Value::Null,
            Some(&account),
            None,
            donut_token.as_deref(),
        );
        return OpenResult::err(
            "The Donut Browser \"wayfern\" engine could not be downloaded or confirmed.",
        );
    }

    // 5. Resolve the account's Donut_Profile, creating and persisting a mapping
    //    only when it is unmapped.
    let resolved = match resolve_or_create_profile(dir, &account).await {
        Ok(resolved) => resolved,
        Err(create_err) => {
            logging::log_browser(
                app,
                "error",
                &format!(
                    "Open in Browser: could not resolve or create a Donut profile ({}).",
                    create_err.as_str()
                ),
                Value::Null,
                Some(&account),
                None,
                donut_token.as_deref(),
            );
            return OpenResult::err("Could not create a Donut Browser profile for this account.");
        }
    };
    let profile_id = resolved.profile_id;

    // 6. Mark 'opening' BEFORE issuing `/run` so a second selection arriving
    //    mid-open is deduped rather than launching a duplicate instance. Any
    //    failure below removes this entry so nothing is left recorded as open.
    mark_session_opening(&sessions, account_id, &profile_id).await;

    let cdp_port = match run_donut_profile(dir, &profile_id).await {
        Ok(cdp_port) => cdp_port,
        Err(run_err) => {
            untrack_session(&sessions, account_id).await;
            logging::log_browser(
                app,
                "error",
                &format!("Open in Browser: /run failed ({}).", run_err.as_str()),
                json!({ "profileId": profile_id }),
                Some(&account),
                None,
                donut_token.as_deref(),
            );
            let message = match run_err {
                RunProfileError::RequiresPro => {
                    "Opening an account browser session requires a Donut Browser Pro subscription."
                }
                _ => "Could not launch the browser instance through Donut Browser.",
            };
            return OpenResult::err(message);
        }
    };

    // Inject the cookie via CDP, then navigate. The cookie value is passed to
    // `log_browser` ONLY as a redaction secret, never as message/metadata.
    let injected = match inject_cookie_and_navigate(cdp_port, &account.cookie).await {
        Ok(injected) => injected,
        Err(inject_err) => {
            untrack_session(&sessions, account_id).await;
            logging::log_browser(
                app,
                "error",
                "Open in Browser: cookie injection failed.",
                json!({ "profileId": profile_id }),
                Some(&account),
                Some(&account.cookie),
                donut_token.as_deref(),
            );
            // JS: `injected.error || 'Could not inject the cookie into the browser.'`
            let message = if inject_err.is_empty() {
                "Could not inject the cookie into the browser.".to_string()
            } else {
                inject_err
            };
            return OpenResult::err(message);
        }
    };

    // Success. `mark_session_open` transitions the entry to 'open', stores the
    // live connection, and wires the disconnect monitor (clear-on-disconnect) so
    // closing the window opens a fresh instance next time.
    mark_session_open(
        Arc::clone(&sessions),
        account_id.to_string(),
        profile_id.clone(),
        cdp_port,
        injected,
    )
    .await;

    logging::log_browser(
        app,
        "info",
        "Opened the Roblox website in an isolated Donut Browser session.",
        json!({ "profileId": profile_id }),
        Some(&account),
        None,
        donut_token.as_deref(),
    );
    OpenResult::ok()
}

/// `browser:open` — open the Roblox website in an isolated per-account Donut
/// Browser session. Ports `ipcMain.handle('browser:open', (_, accountId) =>
/// openAccountBrowser(accountId))` (Requirement 10.1); the parameter order
/// matches the Electron handler (a single `accountId`).
///
/// Resolve-never-reject in spirit: it returns `Ok(OpenResult)` for every open
/// outcome the Renderer_UI branches on, and only `Err` if the app-data directory
/// itself cannot be resolved (a precondition failure that predates any open work).
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
) -> Result<OpenResult, String> {
    let result = async {
        let dir = accounts::store_dir(&app)?;
        let sessions = Arc::clone(&state.browser_sessions);
        Ok(open_account_browser(&app, &dir, sessions, &account_id).await)
    }
    .await;
    crate::logging::log_command_result("browser_open", result)
}

/// `browser:copyCookie` — copy an account's `.ROBLOSECURITY` cookie to the system
/// clipboard with read-back verification. Ports
/// `ipcMain.handle('browser:copyCookie', (_, accountId) =>
/// copyAccountCookie(accountId))` (Requirement 10.1); the parameter order matches
/// the Electron handler (a single `accountId`).
///
/// Uses the real [`TauriClipboard`] (`tauri-plugin-clipboard-manager`) and the
/// pure [`copy_account_cookie_with`] flow. Logs the outcome via
/// [`logging::log_browser`] with the cookie supplied purely as a redaction secret
/// (Requirement 4.3), mirroring `main.js`'s `copyAccountCookie` log points, then
/// returns the `{ ok, error? }` result the Renderer_UI already branches on.
#[tauri::command]
pub async fn browser_copy_cookie(
    app: AppHandle,
    account_id: String,
) -> Result<CopyCookieResult, String> {
    // The only internal-error path this command has is failing to resolve the
    // app-data directory; route it through the centralized logger (Requirement
    // 7.1). Every other outcome resolves to `Ok(CopyCookieResult { .. })`.
    let dir = match accounts::store_dir(&app) {
        Ok(dir) => dir,
        Err(e) => return crate::logging::log_command_result("browser_copy_cookie", Err(e)),
    };
    let donut_token = get_donut_token(&dir);

    // The cookie is looked up again here only to feed `log_browser`'s redaction
    // set and to name the account in the success/failure log lines, mirroring how
    // `main.js`'s `copyAccountCookie` logs with the account + cookie in scope. The
    // authoritative copy decision is made entirely by `copy_account_cookie_with`.
    let account = load_accounts(&dir)
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.id == account_id);
    let cookie_secret = account.as_ref().map(|a| a.cookie.clone());

    let clipboard = TauriClipboard::new(&app);
    let result = copy_account_cookie_with(&dir, &account_id, &clipboard);

    // Log points ported 1:1 from `copyAccountCookie` (success + each failure),
    // always redaction-safe (the cookie is passed only as a secret).
    if result.ok {
        logging::log_browser(
            &app,
            "info",
            "Copied the account cookie to the clipboard.",
            Value::Null,
            account.as_ref(),
            cookie_secret.as_deref(),
            donut_token.as_deref(),
        );
    } else {
        let (message, meta): (&str, Value) = match result.error.as_deref() {
            Some("Account not found.") => (
                "Copy Cookie: account not found.",
                json!({ "accountId": account_id }),
            ),
            Some("Could not write the cookie to the clipboard.") => (
                "Copy Cookie: failed to write the cookie to the clipboard.",
                Value::Null,
            ),
            Some("Could not verify the cookie on the clipboard.") => (
                "Copy Cookie: failed to read the clipboard back.",
                Value::Null,
            ),
            Some("The cookie could not be verified on the clipboard.") => (
                "Copy Cookie: clipboard read-back did not match the copied cookie.",
                Value::Null,
            ),
            // No-cookie-stored case (and any other): account-scoped error line.
            _ => (
                "Copy Cookie: no ROBLOSECURITY cookie stored for this account.",
                Value::Null,
            ),
        };
        // The "account not found" line carries no account (there is none); every
        // other line stamps the account, matching `main.js`'s log calls.
        let account_for_log = if meta.is_null() { account.as_ref() } else { None };
        logging::log_browser(
            &app,
            "error",
            message,
            meta,
            account_for_log,
            cookie_secret.as_deref(),
            donut_token.as_deref(),
        );
    }

    Ok(result)
}

/// `roblox:openLogin` — open the cookie-capture login window and return the
/// captured/verified account, or a failure the Renderer_UI branches on. Ports
/// `ipcMain.handle('roblox:openLogin', ...)` (Requirement 10.1); the Electron
/// handler takes no positional arguments, and neither does this command (preload
/// calls `invoke('roblox_open_login')`).
///
/// Mirrors `main.js`'s handler faithfully:
///   1. Windows-gated first via [`crate::platform::ensure_windows`]; on a
///      non-Windows OS it resolves to `LoginResult::fail("Windows only")` rather
///      than proceeding (Requirement 8.4), matching how `browser_open` gates.
///   2. Resolves a system Chromium browser via [`ensure_chrome`]. Since this
///      distributable ships no bundled browser download (no Playwright), a
///      missing browser reports the accurate build-state message and keeps
///      "Paste Cookie" available — the Tauri_Build's form of `main.js`'s
///      no-browser fallback.
///   3. Stores a cancel `Sender` in [`AppState`], awaits [`run_login_flow`],
///      then clears the slot regardless of how the flow ended. The cancel path
///      is driven by [`login_cancel`], replacing `ipcMain.once('login:cancel')`.
///
/// The `{ success, cookie, username, userId }` / `{ success, error }` shape
/// [`LoginResult`] serializes to is exactly what the Renderer_UI branches on, so
/// `invoke('roblox_open_login')` resolves to the same payload the Electron_Build
/// produced.
#[tauri::command]
pub async fn roblox_open_login(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoginResult, String> {
    // 1. Windows-only, matching the rest of the app (and main.js's win32 browser
    //    login). Reports gracefully rather than proceeding on a non-Windows OS.
    if let Err(e) = crate::platform::ensure_windows() {
        return Ok(LoginResult::fail(e));
    }

    // 2. Resolve a system Chromium browser. No bundled-browser fallback exists in
    //    this build, so a missing browser keeps "Paste Cookie" as the path
    //    forward (main.js's no-browser fallback wording).
    let chrome_path = match ensure_chrome() {
        Some(path) => path,
        None => {
            return Ok(LoginResult::fail(
                "Browser login is not available in this build. Use \"Paste Cookie\" instead.",
            ));
        }
    };

    // 3. Store the cancel Sender (replacing `ipcMain.once('login:cancel', ...)`),
    //    run the flow, then clear the slot no matter how it resolved.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut guard = state.login_cancel_tx.lock().await;
        *guard = Some(cancel_tx);
    }

    let result = run_login_flow(&chrome_path, cancel_rx).await;

    {
        let mut guard = state.login_cancel_tx.lock().await;
        *guard = None;
    }

    Ok(result)
}

/// `login:cancel` — cancel an in-progress login window. Ports the Electron_Build's
/// `ipcMain.once('login:cancel', ...)` (Requirement 10.1); mapped to a command
/// since preload calls `invoke('login_cancel')`. Takes the stored cancel `Sender`
/// out of [`AppState`] and fires it, tripping [`run_login_flow`]'s `cancel_rx`
/// (which reports "Login window closed"). A no-op when no login is in progress
/// (no stored sender), matching the Electron `once` listener that simply never
/// fires when there is nothing to cancel.
#[tauri::command]
pub async fn login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let sender = {
        let mut guard = state.login_cancel_tx.lock().await;
        guard.take()
    };
    if let Some(tx) = sender {
        // The receiver may already be gone (flow finished on its own); a failed
        // send is a harmless no-op, exactly like a late `login:cancel`.
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Transport + resolver tests for the Donut_Browser_API client, mirroring
    //! `test/donut-http.test.js` and `test/donut-http-auth.property.test.js`
    //! (Requirements 5.1, 5.2). The success/`http` paths run against a tiny
    //! in-process HTTP server (a std-thread `TcpListener`, so no extra tokio
    //! feature is needed); the `unreachable` paths use a dead port, a never-
    //! responding server (timeout), and a malformed URL.

    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    /// Start a one-shot HTTP/1.1 server on a free loopback port that captures the
    /// first request line + headers, then answers with the given status/body.
    /// Returns `(base_url, captured_receiver)`; the receiver yields the raw
    /// request bytes the server saw (for header assertions).
    fn spawn_capture_server(
        status: u16,
        content_type: &str,
        body: &str,
    ) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        let content_type = content_type.to_string();
        let body = body.to_string();
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let response = format!(
                    "HTTP/1.1 {status} STATUS\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(response.as_bytes());
                let _ = sock.flush();
            }
        });

        (base, rx)
    }

    /// Start a server that accepts the connection but never responds, so the
    /// client-side timeout must fire. Returns the base URL; the accepted socket
    /// is held open by the spawned thread.
    fn spawn_silent_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        thread::spawn(move || {
            if let Ok((sock, _)) = listener.accept() {
                // Hold the connection open without replying, then let it drop
                // after the client's timeout has comfortably elapsed.
                thread::sleep(Duration::from_millis(500));
                drop(sock);
            }
        });
        base
    }

    // ── build_donut_base_url ────────────────────────────────────────────────

    #[test]
    fn base_url_defaults_to_10108_when_absent_or_zero() {
        assert_eq!(build_donut_base_url(None), "http://127.0.0.1:10108");
        assert_eq!(build_donut_base_url(Some(0)), "http://127.0.0.1:10108");
    }

    #[test]
    fn base_url_uses_configured_port() {
        assert_eq!(build_donut_base_url(Some(20000)), "http://127.0.0.1:20000");
    }

    // ── Request construction: method, path, Bearer header ────────────────────

    #[tokio::test]
    async fn sends_method_path_and_bearer_authorization_header() {
        let (base, rx) = spawn_capture_server(200, "application/json", r#"{"ok":true}"#);

        let result =
            donut_request(&base, Some("my-secret-token"), "GET", "/v1/profiles", None).await;

        let captured = rx.recv_timeout(Duration::from_secs(5)).expect("captured request");
        assert!(captured.starts_with("GET /v1/profiles "), "request line: {captured}");
        assert!(
            captured.contains("authorization: Bearer my-secret-token")
                || captured.contains("Authorization: Bearer my-secret-token"),
            "missing Bearer header in: {captured}"
        );

        assert!(result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(result.json, Some(json!({ "ok": true })));
        assert_eq!(result.error, None);
    }

    #[tokio::test]
    async fn omits_authorization_header_when_no_token() {
        let (base, rx) = spawn_capture_server(200, "application/json", "{}");

        let _ = donut_request(&base, None, "GET", "/v1/profiles", None).await;

        let captured = rx.recv_timeout(Duration::from_secs(5)).expect("captured request");
        assert!(
            !captured.to_lowercase().contains("authorization:"),
            "Authorization header must be absent, got: {captured}"
        );
    }

    #[tokio::test]
    async fn empty_token_attaches_no_authorization_header() {
        let (base, rx) = spawn_capture_server(200, "application/json", "{}");

        let _ = donut_request(&base, Some(""), "POST", "/open", Some(&json!({ "a": 1 }))).await;

        let captured = rx.recv_timeout(Duration::from_secs(5)).expect("captured request");
        assert!(
            !captured.to_lowercase().contains("authorization:"),
            "empty token must attach no Authorization header, got: {captured}"
        );
    }

    #[tokio::test]
    async fn encodes_json_body_for_post() {
        let (base, rx) = spawn_capture_server(201, "application/json", r#"{"id":"profile-1"}"#);

        let payload = json!({ "name": "account-a" });
        let result = donut_request(&base, Some("tok"), "POST", "/v1/profiles", Some(&payload)).await;

        let captured = rx.recv_timeout(Duration::from_secs(5)).expect("captured request");
        assert!(captured.starts_with("POST /v1/profiles "), "request line: {captured}");
        assert!(captured.contains(r#"{"name":"account-a"}"#), "body not sent: {captured}");

        assert!(result.ok);
        assert_eq!(result.status, 201);
        assert_eq!(result.json, Some(json!({ "id": "profile-1" })));
        assert_eq!(result.error, None);
    }

    // ── Classification: http / non-JSON / unreachable ────────────────────────

    #[tokio::test]
    async fn classifies_non_2xx_as_http_error_with_status_and_json() {
        let (base, _rx) =
            spawn_capture_server(401, "application/json", r#"{"message":"invalid token"}"#);

        let result = donut_request(&base, Some("bad"), "GET", "/v1/profiles", None).await;

        assert!(!result.ok);
        assert_eq!(result.status, 401);
        assert_eq!(result.json, Some(json!({ "message": "invalid token" })));
        assert_eq!(result.error, Some(DonutTransportError::Http));
    }

    #[tokio::test]
    async fn returns_json_none_for_2xx_non_json_body() {
        let (base, _rx) = spawn_capture_server(200, "text/plain", "not json");

        let result = donut_request(&base, Some("tok"), "GET", "/v1/ping", None).await;

        assert!(result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(result.json, None);
        assert_eq!(result.error, None);
    }

    #[tokio::test]
    async fn refused_connection_is_unreachable() {
        // Bind then drop the listener so nothing is listening on that port.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead_base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        drop(listener);

        let result = donut_request(&dead_base, Some("tok"), "GET", "/v1/profiles", None).await;

        assert!(!result.ok);
        assert_eq!(result.status, 0);
        assert_eq!(result.json, None);
        assert_eq!(result.error, Some(DonutTransportError::Unreachable));
    }

    #[tokio::test]
    async fn request_exceeding_timeout_is_unreachable() {
        let base = spawn_silent_server();

        let result =
            donut_request_with_timeout(&base, Some("tok"), "GET", "/v1/profiles", None, 100).await;

        assert!(!result.ok);
        assert_eq!(result.status, 0);
        assert_eq!(result.error, Some(DonutTransportError::Unreachable));
    }

    #[tokio::test]
    async fn malformed_base_url_is_unreachable_without_panicking() {
        let result = donut_request("not a url", Some("tok"), "GET", "/v1/profiles", None).await;

        assert!(!result.ok);
        assert_eq!(result.status, 0);
        assert_eq!(result.error, Some(DonutTransportError::Unreachable));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Task 13.2 tests: availability, Wayfern, profile run/delete/create,
    // profile-id / CDP-port extraction, and the pending-deletion retry queue.
    // ═════════════════════════════════════════════════════════════════════════

    /// A server that answers N sequential HTTP/1.1 requests with the given
    /// `(status, content_type, body)` responses, in order. Used for the flows
    /// that make more than one request (e.g. Wayfern status + download).
    fn spawn_sequence_server(responses: Vec<(u16, &'static str, &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        thread::spawn(move || {
            for (status, content_type, body) in responses {
                match listener.accept() {
                    Ok((mut sock, _)) => {
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf).unwrap_or(0);
                        let response = format!(
                            "HTTP/1.1 {status} STATUS\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(response.as_bytes());
                        let _ = sock.flush();
                    }
                    Err(_) => break,
                }
            }
        });
        base
    }

    /// A base URL pointing at a closed loopback port (nothing listening), so any
    /// request classifies as `unreachable`.
    fn dead_base_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        drop(listener);
        base
    }

    /// A unique, freshly-created temp directory for a store-backed test case.
    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "mr_browser_test_{tag}_{}_{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    // ── classify_availability (pure truth table) ─────────────────────────────

    fn http_response(status: u16) -> DonutResponse {
        DonutResponse {
            ok: (200..300).contains(&status),
            status,
            json: None,
            error: if (200..300).contains(&status) {
                None
            } else {
                Some(DonutTransportError::Http)
            },
        }
    }

    #[test]
    fn availability_no_token_short_circuits_without_result() {
        assert_eq!(classify_availability(false, None), Availability::NoToken);
        // Even a successful result is ignored when there is no token.
        assert_eq!(
            classify_availability(false, Some(&http_response(200))),
            Availability::NoToken
        );
    }

    #[test]
    fn availability_maps_statuses_to_variants() {
        assert_eq!(
            classify_availability(true, Some(&http_response(200))),
            Availability::Ok
        );
        assert_eq!(
            classify_availability(true, Some(&http_response(401))),
            Availability::Unauthorized
        );
        assert_eq!(
            classify_availability(true, Some(&http_response(402))),
            Availability::PaymentRequired
        );
        // Any other non-2xx status folds to unreachable.
        assert_eq!(
            classify_availability(true, Some(&http_response(500))),
            Availability::Unreachable
        );
        // A transport-unreachable result, and a missing result, are unreachable.
        assert_eq!(
            classify_availability(true, Some(&DonutResponse::unreachable())),
            Availability::Unreachable
        );
        assert_eq!(classify_availability(true, None), Availability::Unreachable);
    }

    #[tokio::test]
    async fn check_availability_at_no_token_sends_no_request() {
        // Dead base: if a request were sent it would be unreachable, but with no
        // token we must short-circuit to NoToken without touching the network.
        let base = dead_base_url();
        assert_eq!(
            check_donut_availability_at(&base, None).await,
            Availability::NoToken
        );
        assert_eq!(
            check_donut_availability_at(&base, Some("")).await,
            Availability::NoToken
        );
    }

    #[tokio::test]
    async fn check_availability_at_classifies_live_responses() {
        let (ok_base, _rx) = spawn_capture_server(200, "application/json", "[]");
        assert_eq!(
            check_donut_availability_at(&ok_base, Some("tok")).await,
            Availability::Ok
        );

        let (unauth_base, _rx) = spawn_capture_server(401, "application/json", "{}");
        assert_eq!(
            check_donut_availability_at(&unauth_base, Some("tok")).await,
            Availability::Unauthorized
        );

        let (pay_base, _rx) = spawn_capture_server(402, "application/json", "{}");
        assert_eq!(
            check_donut_availability_at(&pay_base, Some("tok")).await,
            Availability::PaymentRequired
        );

        assert_eq!(
            check_donut_availability_at(&dead_base_url(), Some("tok")).await,
            Availability::Unreachable
        );
    }

    // ── is_wayfern_downloaded (pure) ─────────────────────────────────────────

    #[test]
    fn wayfern_downloaded_boolean_fields() {
        assert!(is_wayfern_downloaded(Some(&json!({ "downloaded": true }))));
        assert!(!is_wayfern_downloaded(Some(&json!({ "downloaded": false }))));
        assert!(is_wayfern_downloaded(Some(&json!({ "installed": true }))));
        assert!(is_wayfern_downloaded(Some(&json!({ "is_downloaded": true }))));
    }

    #[test]
    fn wayfern_downloaded_status_string() {
        assert!(is_wayfern_downloaded(Some(&json!({ "status": "Downloaded" }))));
        assert!(is_wayfern_downloaded(Some(&json!({ "status": "installed" }))));
        assert!(is_wayfern_downloaded(Some(&json!({ "status": "READY" }))));
        assert!(!is_wayfern_downloaded(Some(&json!({ "status": "pending" }))));
    }

    #[test]
    fn wayfern_downloaded_unknown_or_absent_is_false() {
        assert!(!is_wayfern_downloaded(None));
        assert!(!is_wayfern_downloaded(Some(&json!({}))));
        assert!(!is_wayfern_downloaded(Some(&json!("not an object"))));
        // A non-boolean `downloaded` falls through to the status check, then false.
        assert!(!is_wayfern_downloaded(Some(&json!({ "downloaded": "yes" }))));
    }

    // ── ensure_wayfern_engine_at ─────────────────────────────────────────────

    #[tokio::test]
    async fn wayfern_status_failure_aborts() {
        let (base, _rx) = spawn_capture_server(500, "application/json", "{}");
        assert_eq!(
            ensure_wayfern_engine_at(&base, Some("tok")).await,
            Err(WayfernError::StatusFailed)
        );
        assert_eq!(
            ensure_wayfern_engine_at(&dead_base_url(), Some("tok")).await,
            Err(WayfernError::StatusFailed)
        );
    }

    #[tokio::test]
    async fn wayfern_already_downloaded_makes_no_download_request() {
        // One response only: if a download were requested the server would need a
        // second, so a single-response server proves no download call was made.
        let (base, _rx) = spawn_capture_server(200, "application/json", r#"{"downloaded":true}"#);
        assert_eq!(ensure_wayfern_engine_at(&base, Some("tok")).await, Ok(()));
    }

    #[tokio::test]
    async fn wayfern_not_downloaded_then_download_succeeds() {
        let base = spawn_sequence_server(vec![
            (200, "application/json", r#"{"downloaded":false}"#),
            (200, "application/json", r#"{"ok":true}"#),
        ]);
        assert_eq!(ensure_wayfern_engine_at(&base, Some("tok")).await, Ok(()));
    }

    #[tokio::test]
    async fn wayfern_download_failure_aborts() {
        let base = spawn_sequence_server(vec![
            (200, "application/json", r#"{"downloaded":false}"#),
            (500, "application/json", "{}"),
        ]);
        assert_eq!(
            ensure_wayfern_engine_at(&base, Some("tok")).await,
            Err(WayfernError::DownloadFailed)
        );
    }

    // ── extract_profile_id / extract_cdp_port (pure) ─────────────────────────

    #[test]
    fn profile_id_prefers_id_then_profile_id() {
        assert_eq!(
            extract_profile_id(&json!({ "id": "p1" })),
            Some("p1".to_string())
        );
        assert_eq!(
            extract_profile_id(&json!({ "profile_id": "p2" })),
            Some("p2".to_string())
        );
        // Numeric id is stringified (JS String(123)).
        assert_eq!(
            extract_profile_id(&json!({ "id": 123 })),
            Some("123".to_string())
        );
        // Present-but-null id falls through to profile_id.
        assert_eq!(
            extract_profile_id(&json!({ "id": null, "profile_id": "p3" })),
            Some("p3".to_string())
        );
        assert_eq!(extract_profile_id(&json!({})), None);
    }

    #[test]
    fn cdp_port_reads_keys_in_priority_order() {
        assert_eq!(extract_cdp_port(&json!({ "cdpPort": 9222 })), Some(9222));
        assert_eq!(extract_cdp_port(&json!({ "cdp_port": 9223 })), Some(9223));
        assert_eq!(extract_cdp_port(&json!({ "port": 9224 })), Some(9224));
        assert_eq!(
            extract_cdp_port(&json!({ "debuggingPort": 9225 })),
            Some(9225)
        );
        assert_eq!(
            extract_cdp_port(&json!({ "remoteDebuggingPort": 9226 })),
            Some(9226)
        );
        assert_eq!(
            extract_cdp_port(&json!({ "remote_debugging_port": 9228 })),
            Some(9228)
        );
        // Numeric string is coerced (JS Number("9227")).
        assert_eq!(extract_cdp_port(&json!({ "port": "9227" })), Some(9227));
        // cdpPort wins over the lower-priority keys.
        assert_eq!(
            extract_cdp_port(&json!({ "cdpPort": 1, "port": 2 })),
            Some(1)
        );
    }

    #[test]
    fn cdp_port_rejects_zero_negative_and_missing() {
        assert_eq!(extract_cdp_port(&json!({ "port": 0 })), None);
        assert_eq!(extract_cdp_port(&json!({ "port": -5 })), None);
        assert_eq!(extract_cdp_port(&json!({ "port": "abc" })), None);
        assert_eq!(extract_cdp_port(&json!({})), None);
        // A present 0 (nullish-coalescing does NOT skip it) still fails > 0.
        assert_eq!(
            extract_cdp_port(&json!({ "cdpPort": 0, "port": 9222 })),
            None
        );
    }

    // ── run_donut_profile_at ─────────────────────────────────────────────────

    #[tokio::test]
    async fn run_profile_returns_cdp_port() {
        let (base, rx) = spawn_capture_server(200, "application/json", r#"{"cdpPort":9333}"#);
        assert_eq!(
            run_donut_profile_at(&base, Some("tok"), "profile-1").await,
            Ok(9333)
        );
        let captured = rx.recv().expect("captured run request");
        assert!(
            captured.starts_with("POST /v1/profiles/profile-1/run "),
            "request line: {captured}"
        );
        assert!(
            captured.contains(r#"{"headless":false}"#),
            "run body not sent: {captured}"
        );
    }

    #[tokio::test]
    async fn run_profile_run_failed_on_non_2xx() {
        let (base, _rx) = spawn_capture_server(500, "application/json", "{}");
        assert_eq!(
            run_donut_profile_at(&base, Some("tok"), "p").await,
            Err(RunProfileError::RunFailed)
        );
        assert_eq!(
            run_donut_profile_at(&dead_base_url(), Some("tok"), "p").await,
            Err(RunProfileError::RunFailed)
        );
    }

    #[tokio::test]
    async fn run_profile_no_cdp_port_when_absent() {
        let (base, _rx) = spawn_capture_server(200, "application/json", r#"{"other":1}"#);
        assert_eq!(
            run_donut_profile_at(&base, Some("tok"), "p").await,
            Err(RunProfileError::NoCdpPort)
        );
    }

    // ── delete_donut_profile_at ──────────────────────────────────────────────

    #[tokio::test]
    async fn delete_profile_success_on_2xx() {
        let (base, _rx) = spawn_capture_server(200, "application/json", "{}");
        assert_eq!(
            delete_donut_profile_at(&base, Some("tok"), "p").await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn delete_profile_folds_404_into_success() {
        let (base, _rx) = spawn_capture_server(404, "application/json", "{}");
        assert_eq!(
            delete_donut_profile_at(&base, Some("tok"), "p").await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn delete_profile_unreachable_vs_delete_failed() {
        assert_eq!(
            delete_donut_profile_at(&dead_base_url(), Some("tok"), "p").await,
            Err(DeleteProfileError::Unreachable)
        );
        let (base, _rx) = spawn_capture_server(500, "application/json", "{}");
        assert_eq!(
            delete_donut_profile_at(&base, Some("tok"), "p").await,
            Err(DeleteProfileError::DeleteFailed)
        );
    }

    // ── Pending-deletion retry queue (store-backed) ──────────────────────────

    #[test]
    fn add_pending_deletion_appends_and_dedupes() {
        let dir = unique_temp_dir("pending_add");

        add_pending_deletion(&dir, "prof-a").expect("add a");
        add_pending_deletion(&dir, "prof-b").expect("add b");
        // Duplicate: no-op, queue unchanged.
        add_pending_deletion(&dir, "prof-a").expect("add a again");
        // Blank id: no-op.
        add_pending_deletion(&dir, "").expect("blank");

        let settings = settings::load_from_dir(&dir).expect("load settings");
        assert_eq!(
            settings.pending_donut_deletions,
            vec!["prof-a".to_string(), "prof-b".to_string()]
        );
    }

    #[tokio::test]
    async fn retry_pending_deletions_leaves_ids_queued_when_unreachable() {
        let dir = unique_temp_dir("pending_retry_unreachable");

        // Point the Donut API at a dead port so every delete is unreachable.
        let dead = dead_base_url();
        let port: u16 = dead.rsplit(':').next().unwrap().parse().unwrap();
        let mut update = Map::new();
        update.insert("donutApiPort".to_string(), json!(port));
        update.insert(
            "pendingDonutDeletions".to_string(),
            json!(["prof-a", "prof-b"]),
        );
        settings::save_to_dir(&dir, &update).expect("seed settings");

        retry_pending_deletions(&dir).await.expect("retry");

        // Unreachable -> both ids remain queued for a later retry (Req 8.6).
        let settings = settings::load_from_dir(&dir).expect("load settings");
        assert_eq!(
            settings.pending_donut_deletions,
            vec!["prof-a".to_string(), "prof-b".to_string()]
        );
    }

    #[tokio::test]
    async fn retry_pending_deletions_empty_queue_is_noop() {
        let dir = unique_temp_dir("pending_retry_empty");
        // No settings written -> empty queue -> Ok with nothing to do.
        retry_pending_deletions(&dir).await.expect("retry empty");
        let settings = settings::load_from_dir(&dir).expect("load settings");
        assert!(settings.pending_donut_deletions.is_empty());
    }

    // ── Task 13.3: login cookie predicate ────────────────────────────────────
    //
    // The CDP launch/poll flow itself needs a live Chromium (covered by Task
    // 13.6's fake-CDP integration tests), but the cookie-matching predicate that
    // decides when the login succeeds is pure and ported directly from
    // `puppeteerLogin`'s `cookies.find(...)` guard, so it is unit-tested here.

    /// A base64-ish value comfortably over the 100-char minimum.
    fn long_cookie_value() -> String {
        "A".repeat(150)
    }

    #[test]
    fn login_cookie_matches_roblosecurity_on_roblox_domain_when_long() {
        assert!(matches_login_cookie(
            ".ROBLOSECURITY",
            ".roblox.com",
            &long_cookie_value()
        ));
        // Subdomains still contain "roblox.com".
        assert!(matches_login_cookie(
            ".ROBLOSECURITY",
            "www.roblox.com",
            &long_cookie_value()
        ));
    }

    #[test]
    fn login_cookie_rejects_wrong_name_domain_or_short_value() {
        // Wrong cookie name.
        assert!(!matches_login_cookie(
            "RBXEventTrackerV2",
            ".roblox.com",
            &long_cookie_value()
        ));
        // Wrong domain.
        assert!(!matches_login_cookie(
            ".ROBLOSECURITY",
            "example.com",
            &long_cookie_value()
        ));
        // Value at or below the 100-char threshold (main.js: `value.length > 100`).
        assert!(!matches_login_cookie(
            ".ROBLOSECURITY",
            ".roblox.com",
            &"A".repeat(100)
        ));
        // Empty value.
        assert!(!matches_login_cookie(".ROBLOSECURITY", ".roblox.com", ""));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Task 13.5 tests: per-account session tracking (focus dedupe, clear-on-
    // disconnect, mark/untrack) and the Copy Cookie read-back verification.
    //
    // The `open`/focus path that raises a real window needs a live Chromium
    // (covered by Task 13.6's fake-CDP integration tests); the pure map/dedupe
    // logic and the clipboard read-back flow are unit-tested here against
    // in-memory state and a fake clipboard.
    // ═════════════════════════════════════════════════════════════════════════

    use std::sync::Mutex as StdMutex;

    /// A fresh, empty session map behind the same `tokio::sync::Mutex` the live
    /// [`crate::AppState::browser_sessions`] uses.
    fn empty_sessions() -> AsyncMutex<HashMap<String, BrowserSession>> {
        AsyncMutex::new(HashMap::new())
    }

    /// Build an `opening` session entry (no live connection yet).
    fn opening_session(profile_id: &str) -> BrowserSession {
        BrowserSession {
            state: SessionState::Opening,
            profile_id: profile_id.to_string(),
            cdp_port: None,
            live: None,
        }
    }

    /// Write a minimal Account_Store with a single plaintext (no-tag) cookie that
    /// `decrypt_field` passes through unchanged, so `load_accounts` returns it
    /// decrypted to itself.
    fn write_account(dir: &Path, id: &str, cookie: &str) {
        let store = json!([{
            "id": id,
            "username": "user",
            "userId": "42",
            "nickname": "Nick",
            "cookie": cookie,
            "createdAt": "2024-01-01T00:00:00.000Z"
        }]);
        std::fs::write(
            accounts::accounts_path_in(dir),
            serde_json::to_vec(&store).unwrap(),
        )
        .expect("seed accounts.json");
    }

    /// A fake clipboard with injectable write/read failures and an optional
    /// read-back override, for the Copy Cookie verification tests.
    struct FakeClipboard {
        content: StdMutex<Option<String>>,
        fail_write: bool,
        fail_read: bool,
        read_override: Option<String>,
    }

    impl FakeClipboard {
        /// A working clipboard, initially empty (never written).
        fn working() -> Self {
            FakeClipboard {
                content: StdMutex::new(None),
                fail_write: false,
                fail_read: false,
                read_override: None,
            }
        }

        /// Whether `write_text` was ever called (to assert the clipboard was left
        /// untouched on the no-cookie / not-found paths).
        fn was_written(&self) -> bool {
            self.content.lock().unwrap().is_some()
        }
    }

    impl Clipboard for FakeClipboard {
        fn write_text(&self, text: &str) -> Result<(), String> {
            if self.fail_write {
                return Err("write failed".to_string());
            }
            *self.content.lock().unwrap() = Some(text.to_string());
            Ok(())
        }

        fn read_text(&self) -> Result<String, String> {
            if self.fail_read {
                return Err("read failed".to_string());
            }
            if let Some(o) = &self.read_override {
                return Ok(o.clone());
            }
            Ok(self.content.lock().unwrap().clone().unwrap_or_default())
        }
    }

    // ── account_label ────────────────────────────────────────────────────────

    #[test]
    fn account_label_prefers_nickname_then_username_then_ids() {
        let mut acc = Account {
            id: "id-1".to_string(),
            username: "user-1".to_string(),
            user_id: "42".to_string(),
            nickname: "Nick".to_string(),
            cookie: String::new(),
            created_at: String::new(),
            last_used: None,
            donut_profile_id: None,
            donut_profile_pending_delete: false,
            extra: Map::new(),
        };
        assert_eq!(account_label(&acc), "Nick");
        acc.nickname = String::new();
        assert_eq!(account_label(&acc), "user-1");
        acc.username = String::new();
        assert_eq!(account_label(&acc), "42");
        acc.user_id = String::new();
        assert_eq!(account_label(&acc), "id-1");
        acc.id = String::new();
        assert_eq!(account_label(&acc), "this account");
    }

    // ── focus_existing_session ───────────────────────────────────────────────

    #[tokio::test]
    async fn focus_untracked_account_reports_no_session() {
        let sessions = empty_sessions();
        let result = focus_existing_session(&sessions, "missing").await;
        assert_eq!(
            result,
            FocusResult {
                ok: false,
                focused: false,
                error: Some("no_session".to_string())
            }
        );
    }

    #[tokio::test]
    async fn focus_opening_session_dedupes_without_raising() {
        // An 'opening' entry (no live browser yet) must dedupe (ok:true) but raise
        // nothing (focused:false) — no second /run may be issued.
        let sessions = empty_sessions();
        sessions
            .lock()
            .await
            .insert("acc-1".to_string(), opening_session("prof-1"));

        let result = focus_existing_session(&sessions, "acc-1").await;
        assert_eq!(
            result,
            FocusResult {
                ok: true,
                focused: false,
                error: None
            }
        );
        // The entry is left intact (dedupe never tears down the opening session).
        assert!(sessions.lock().await.contains_key("acc-1"));
    }

    // ── mark_session_opening / untrack_session ───────────────────────────────

    #[tokio::test]
    async fn mark_opening_then_untrack_round_trips() {
        let sessions = empty_sessions();

        mark_session_opening(&sessions, "acc-1", "prof-1").await;
        {
            let guard = sessions.lock().await;
            let entry = guard.get("acc-1").expect("entry present after mark");
            assert_eq!(entry.state, SessionState::Opening);
            assert_eq!(entry.profile_id, "prof-1");
            assert_eq!(entry.cdp_port, None);
            assert!(entry.live.is_none());
        }

        let removed = untrack_session(&sessions, "acc-1").await;
        assert!(removed.is_some());
        assert!(sessions.lock().await.is_empty());

        // Untracking an absent account is a no-op returning None.
        assert!(untrack_session(&sessions, "acc-1").await.is_none());
    }

    // ── clear_session_on_disconnect ──────────────────────────────────────────

    #[tokio::test]
    async fn clear_on_disconnect_removes_entry_then_reports_absent() {
        let sessions = empty_sessions();
        sessions
            .lock()
            .await
            .insert("acc-1".to_string(), opening_session("prof-1"));

        // First clear removes the tracked entry and reports it was present.
        assert!(clear_session_on_disconnect(&sessions, "acc-1").await);
        assert!(sessions.lock().await.is_empty());
        // A second clear finds nothing to remove.
        assert!(!clear_session_on_disconnect(&sessions, "acc-1").await);
    }

    #[tokio::test]
    async fn close_tracked_instance_untracked_is_false() {
        // With no live connection there is nothing to `browser.close()`; an
        // untracked account simply reports false without touching the network.
        let sessions = empty_sessions();
        assert!(!close_tracked_browser_instance(&sessions, "missing").await);

        // An 'opening' entry (no live browser) is dropped and reports true.
        sessions
            .lock()
            .await
            .insert("acc-1".to_string(), opening_session("prof-1"));
        assert!(close_tracked_browser_instance(&sessions, "acc-1").await);
        assert!(sessions.lock().await.is_empty());
    }

    // ── copy_account_cookie_with (read-back verification) ────────────────────

    #[test]
    fn copy_cookie_succeeds_when_readback_matches() {
        let dir = unique_temp_dir("copy_ok");
        write_account(&dir, "acc-1", "plain-cookie-value-123");

        let clip = FakeClipboard::working();
        let result = copy_account_cookie_with(&dir, "acc-1", &clip);

        assert_eq!(result, CopyCookieResult { ok: true, error: None });
        // The exact cookie was placed on the clipboard.
        assert_eq!(
            clip.content.lock().unwrap().as_deref(),
            Some("plain-cookie-value-123")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_cookie_account_not_found_leaves_clipboard_untouched() {
        // No accounts.json at all -> load yields an empty store -> not found.
        let dir = unique_temp_dir("copy_notfound");
        let clip = FakeClipboard::working();

        let result = copy_account_cookie_with(&dir, "acc-1", &clip);
        assert_eq!(result.ok, false);
        assert_eq!(result.error.as_deref(), Some("Account not found."));
        assert!(!clip.was_written(), "clipboard must not be touched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_cookie_no_stored_cookie_leaves_clipboard_untouched() {
        let dir = unique_temp_dir("copy_nocookie");
        write_account(&dir, "acc-1", "");
        let clip = FakeClipboard::working();

        let result = copy_account_cookie_with(&dir, "acc-1", &clip);
        assert_eq!(result.ok, false);
        // The message names the account (nickname "Nick" from write_account).
        assert_eq!(
            result.error.as_deref(),
            Some("No cookie is stored for Nick.")
        );
        assert!(!clip.was_written(), "clipboard must not be touched (Req 5.4)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_cookie_write_failure_is_reported() {
        let dir = unique_temp_dir("copy_writefail");
        write_account(&dir, "acc-1", "plain-cookie-value-123");

        let mut clip = FakeClipboard::working();
        clip.fail_write = true;

        let result = copy_account_cookie_with(&dir, "acc-1", &clip);
        assert_eq!(result.ok, false);
        assert_eq!(
            result.error.as_deref(),
            Some("Could not write the cookie to the clipboard.")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_cookie_read_failure_is_reported() {
        let dir = unique_temp_dir("copy_readfail");
        write_account(&dir, "acc-1", "plain-cookie-value-123");

        let mut clip = FakeClipboard::working();
        clip.fail_read = true;

        let result = copy_account_cookie_with(&dir, "acc-1", &clip);
        assert_eq!(result.ok, false);
        assert_eq!(
            result.error.as_deref(),
            Some("Could not verify the cookie on the clipboard.")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_cookie_readback_mismatch_is_reported() {
        let dir = unique_temp_dir("copy_mismatch");
        write_account(&dir, "acc-1", "plain-cookie-value-123");

        let mut clip = FakeClipboard::working();
        // Read-back returns a different value than what was written (e.g. another
        // app clobbered the clipboard) -> verification must fail (Req 5.3/5.5).
        clip.read_override = Some("something-else".to_string());

        let result = copy_account_cookie_with(&dir, "acc-1", &clip);
        assert_eq!(result.ok, false);
        assert_eq!(
            result.error.as_deref(),
            Some("The cookie could not be verified on the clipboard.")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Task 13.6 tests: the availability-failure cases and the login/cookie-
    // injection sequencing, driven against a FAKE Donut_Browser_API client (the
    // in-process `TcpListener` servers above stand in for the real local API)
    // and a FAKE CDP client (there is no live Chromium in tests, so the CDP path
    // is exercised through its pure predicates and its guard-clause / error-
    // redaction behavior). Requirement 5.4 / account-browser-launcher Req 3, 6.
    //
    // Req 5.4 says each availability failure must be reported "through the same
    // error-message behavior" the account-browser-launcher feature defines — so
    // these tests assert not just the classified variant but the stable error
    // *identifier* the command/UI layer surfaces (`Availability::as_error_str` /
    // `WayfernError::as_str`), which is the shape the Renderer_UI branches on.
    // ═════════════════════════════════════════════════════════════════════════

    // ── Availability failures, end-to-end through check_donut_availability_at ──

    #[tokio::test]
    async fn availability_failure_unreachable_api_reports_unreachable() {
        // The fake Donut_Browser_API is not listening at all: an unreachable API
        // must classify as Unreachable and surface the "unreachable" identifier
        // WITHOUT hiding the account actions (Req 5.4).
        let availability = check_donut_availability_at(&dead_base_url(), Some("tok")).await;
        assert_eq!(availability, Availability::Unreachable);
        assert!(!availability.is_ok());
        assert_eq!(availability.as_error_str(), Some("unreachable"));
    }

    #[tokio::test]
    async fn availability_failure_invalid_token_reports_unauthorized() {
        // The fake API answers the /v1/profiles reachability probe with 401 for a
        // rejected (invalid) token -> Unauthorized / "unauthorized".
        let (base, _rx) =
            spawn_capture_server(401, "application/json", r#"{"message":"invalid token"}"#);
        let availability = check_donut_availability_at(&base, Some("bad-token")).await;
        assert_eq!(availability, Availability::Unauthorized);
        assert!(!availability.is_ok());
        assert_eq!(availability.as_error_str(), Some("unauthorized"));
    }

    #[tokio::test]
    async fn availability_failure_pro_required_reports_payment_required() {
        // The fake API answers 402 when the operation needs a Donut Browser Pro
        // subscription -> PaymentRequired / "payment_required".
        let (base, _rx) = spawn_capture_server(402, "application/json", r#"{"error":"pro"}"#);
        let availability = check_donut_availability_at(&base, Some("tok")).await;
        assert_eq!(availability, Availability::PaymentRequired);
        assert!(!availability.is_ok());
        assert_eq!(availability.as_error_str(), Some("payment_required"));
    }

    #[tokio::test]
    async fn availability_failure_from_dead_server_never_sends_when_tokenless() {
        // Guard for the NoToken short-circuit alongside the failure cases: with no
        // token the preflight must not even reach the (failing) API, and reports
        // "no_token" rather than any transport-derived failure (Req 9.6 / 5.4).
        let (base, _rx) = spawn_capture_server(402, "application/json", "{}");
        assert_eq!(
            check_donut_availability_at(&base, None).await.as_error_str(),
            Some("no_token")
        );
    }

    // ── Wayfern engine download failure, end-to-end through the fake API ───────

    #[tokio::test]
    async fn availability_failure_wayfern_download_failed_reports_download_failed() {
        // The fake API reports the engine is present-but-not-downloaded (status
        // 200, `downloaded:false`) so a download is requested, then FAILS that
        // download (500). ensure_wayfern_engine_at must abort with DownloadFailed
        // and surface the "download_failed" identifier (Req 3.7 / 5.4).
        let base = spawn_sequence_server(vec![
            (200, "application/json", r#"{"downloaded":false}"#),
            (500, "application/json", r#"{"error":"boom"}"#),
        ]);
        let result = ensure_wayfern_engine_at(&base, Some("tok")).await;
        assert_eq!(result, Err(WayfernError::DownloadFailed));
        assert_eq!(result.unwrap_err().as_str(), "download_failed");
    }

    #[tokio::test]
    async fn availability_failure_wayfern_download_unreachable_reports_download_failed() {
        // A download request that cannot even reach the fake API (the second call
        // hits a dead port because the one-shot status server has already closed)
        // is still a download failure — the engine cannot be confirmed (Req 3.7).
        // Status says not-downloaded, then the download endpoint is unreachable.
        let base = spawn_sequence_server(vec![(
            200,
            "application/json",
            r#"{"status":"pending"}"#,
        )]);
        // After the single status response the server thread exits, so the POST
        // download request finds nothing listening -> DownloadFailed.
        let result = ensure_wayfern_engine_at(&base, Some("tok")).await;
        assert_eq!(result, Err(WayfernError::DownloadFailed));
    }

    // ── login / cookie-injection sequencing (fake CDP client surface) ──────────

    #[tokio::test]
    async fn inject_guard_rejects_zero_cdp_port_verbatim() {
        // The `if (!cdpPort)` guard returns the exact verbatim string, WITHOUT the
        // catch-block prefix or cookie redaction, and never touches the network.
        // (InjectedSession holds a live CDP handle and is not Debug, so match on
        // the result rather than unwrapping it.)
        let err = match inject_cookie_and_navigate(0, &long_cookie_value()).await {
            Ok(_) => panic!("cdp_port == 0 must be an error"),
            Err(e) => e,
        };
        assert_eq!(err, "No CDP port for the Browser_Instance.");
        // It is a raw guard message, not the prefixed catch-block message.
        assert!(!err.starts_with("Could not inject cookie into the browser:"));
    }

    #[tokio::test]
    async fn inject_guard_rejects_empty_cookie_verbatim() {
        // The `if (!cookie)` guard returns its verbatim string. A non-zero port is
        // supplied so we prove the cookie guard (not the port guard) fired, and no
        // CDP connection is attempted for an empty cookie.
        let err = match inject_cookie_and_navigate(9222, "").await {
            Ok(_) => panic!("empty cookie must be an error"),
            Err(e) => e,
        };
        assert_eq!(err, "No cookie to inject.");
        assert!(!err.starts_with("Could not inject cookie into the browser:"));
    }

    // ── inject_error: prefix + cookie redaction (Req 5.1 / 6.1) ────────────────

    #[test]
    fn inject_error_prefixes_message_and_redacts_the_cookie() {
        // A failure message that (hypothetically) embedded the cookie value must
        // come back prefixed AND with the cookie scrubbed, so the secret can never
        // leak into a user-facing error even if a lower layer echoed it.
        let cookie = long_cookie_value();
        let raw = format!("connect failed near {cookie} while dialing");
        let out = inject_error(&cookie, &raw);

        assert!(
            out.starts_with("Could not inject cookie into the browser: "),
            "missing prefix: {out}"
        );
        assert!(
            !out.contains(&cookie),
            "cookie value must not survive redaction: {out}"
        );
        // No >= MIN_SECRET_FRAGMENT_LEN (8-char) window of the cookie may remain.
        assert!(
            !out.contains(&cookie[..8]),
            "an 8-char cookie fragment leaked: {out}"
        );
        // The masked marker is present where the cookie was.
        assert!(out.contains("[redacted]"), "expected mask marker: {out}");
    }

    #[test]
    fn inject_error_leaves_cookie_free_message_intact_but_prefixed() {
        // When the raw message contains no cookie fragment, redaction is a no-op
        // and only the fixed prefix is added.
        let cookie = long_cookie_value();
        let out = inject_error(&cookie, "navigation to the Roblox home page timed out");
        assert_eq!(
            out,
            "Could not inject cookie into the browser: navigation to the Roblox home page timed out"
        );
    }

    // ── matches_login_cookie: the login-success predicate (sequencing) ─────────

    #[test]
    fn login_predicate_gates_success_only_on_a_long_roblosecurity_cookie() {
        // The login poll loop declares success when this predicate first returns
        // true; assert the boundary the sequencing depends on. A value of exactly
        // 101 chars is the smallest accepted (`value.length > 100`).
        assert!(matches_login_cookie(
            ".ROBLOSECURITY",
            ".roblox.com",
            &"z".repeat(101)
        ));
        assert!(!matches_login_cookie(
            ".ROBLOSECURITY",
            ".roblox.com",
            &"z".repeat(100)
        ));
    }
}
