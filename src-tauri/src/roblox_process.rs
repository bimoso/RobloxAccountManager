//! Roblox game client process management, ported from the legacy JS backend's
//! `// ── Roblox session control ──` section.
//!
//! This module owns the launch flow (target parsing → CSRF/auth-ticket
//! acquisition → `roblox-player:` URI construction → process spawn), the
//! watch/poll close-detection state machine, and the kill-one/kill-all paths.
//!
//! Task 10.1 implements the **launch-target parser**: the pure, synchronous
//! classification of the user-supplied launch target into the correct
//! launcher-request variant. The asynchronous resolution steps that some
//! variants require (following a `ro.blox.com` short link, resolving a share
//! link, resolving a private-server access code) are deliberately left as
//! distinct variants for the launch flow to resolve — this keeps
//! `parse_launch_target` a pure function with no I/O, so it is exhaustively
//! unit-testable.
//!
//! Task 10.2 implements the **launch-credential pipeline** that the launch flow
//! runs before spawning the client:
//!   * the **launch queue** — a `tokio::sync::Mutex` (`AppState::launch_lock`)
//!     that serializes concurrent launches so they cannot all hammer
//!     `auth.roblox.com` at once (porting the legacy JS backend's promise-chained
//!     `_launchQueue`), plus the 4-second [`LAUNCH_STAGGER_MS`] gap enforced
//!     against `AppState::last_launch_ts`;
//!   * **CSRF-token caching** ([`get_csrf_token`]) with a 5-minute
//!     ([`CSRF_TTL_MS`]) TTL, keyed per cookie;
//!   * **auth-ticket caching** ([`get_auth_ticket`]) with a 25-second
//!     ([`TICKET_TTL_MS`]) TTL and an 8-second ([`TICKET_MIN_GAP_MS`]) minimum
//!     gap between live requests for the same cookie;
//!   * [`acquire_launch_credentials`], which chains stagger → CSRF → auth ticket
//!     and, if either acquisition step fails, returns a [`LaunchResult`] failure
//!     (`{ success: false, error }`) **without** touching any launch/watch state
//!     — the account is never marked launched on a credential failure
//!     (Requirement 2.2).
//!
//! Task 10.3 implements the **watch/poll close-detection state machine**: the
//! shared `HashMap` tracking maps (guarded by `tokio::sync::Mutex`), the
//! [`POLL_INTERVAL_MS`] = 5000 ms poll loop ([`ensure_watch_loop`], driven by a
//! `tokio::time::interval`), the [`LAUNCH_DELAY_MS`] = 15000 ms post-launch grace
//! period ([`arm_watch`]), the [`MISS_THRESHOLD`] = 4-consecutive-miss close
//! rule with reset-on-present ([`evaluate_watch_tick`]), and the Renderer_UI
//! close notification ([`WatchNotifier`] / [`TauriWatchNotifier`], emitting the
//! `roblox://closed` / `roblox://all-closed` / `roblox://count` events). The
//! system-presence check is abstracted behind [`PresenceProbe`] so the state
//! machine is testable without spawning real processes.
//!
//! Task 10.4 implements the **process enumeration / termination + kill paths**:
//! the `tasklist`-backed [`PresenceProbe`] ([`TasklistPresenceProbe`]) and
//! enumeration/count/fully-closed helpers, and the `taskkill`-backed
//! [`kill_one`] / [`kill_all`], all issued with the **same command strings** the
//! legacy JS build uses ([`TASKLIST_ENUM_CMD`], [`TASKKILL_ALL_CMD`], etc.). A
//! kill on an untracked identifier is a no-op that affects only the targeted
//! account (Requirement 2.6), and the tracking-map bookkeeping is factored into
//! pure, process-free helpers so that property is unit-testable.
//!
//! Task 10.10 wires the **command layer**: the `roblox_launch` /
//! `roblox_kill_all` / `roblox_kill_one` / `roblox_running_count`
//! `#[tauri::command]` handlers (registered in [`crate::run`]), the full
//! `do_launch` orchestration (prelude → credentials → target resolution →
//! `roblox-player:` URI construction → detached client spawn → PID tracking →
//! `arm_watch` / `ensure_watch_loop` / `mark_launched`), and the production
//! [`MutexHolderRefresh`] ([`RealMutexRefresh`], driving
//! `native_helper::restart_mutex_holder` / `start_mutex_holder`), emitting the
//! `roblox://closed` / `roblox://all-closed` / `roblox://count` events via
//! [`TauriWatchNotifier`].

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

use crate::{AppState, CachedToken};

/// The classification of a launch target, mirroring the four `request=` variants
/// the legacy JS backend builds into the `placelauncher.ashx` URL, plus the app-only case.
///
/// the legacy JS backend reference (the `roblox:launch` handler): a launch target is trimmed,
/// then classified in this exact order:
/// 1. empty                              → app-only launch (`launchmode:app`)
/// 2. all digits (`/^\d+$/`)             → `RequestGame`
/// 3. otherwise treat as a URL:
///    a. host is `ro.blox.com`           → follow redirect first (async), reparse
///    b. `privateServerLinkCode` + placeId → `RequestPrivateGame`
///    c. `/share` path or `code`+`type`  → share link → `RequestGameJob` (async)
///    d. a placeId anywhere in the path  → `RequestGame`
///    e. none of the above               → error
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LauncherRequest {
    /// Empty target. the legacy JS backend builds a `launchmode:app` URI with no
    /// `placelauncherurl`, launching the Roblox app to its home screen.
    AppOnly,

    /// A bare place id, or a games/place URL from which a place id was
    /// extracted. Maps to `request=RequestGame&placeId=<id>&isPlayTogetherGame=false`.
    RequestGame { place_id: String },

    /// A specific public server: a games/place URL carrying a `gameId`
    /// (job id) query param alongside a place id. Maps directly to
    /// `request=RequestGameJob&placeId=<id>&gameId=<jobId>` with no async
    /// resolution needed (both ids are already known).
    RequestGameJob { place_id: String, game_id: String },

    /// "Follow / join a player": a URL carrying a `followUserId` query param.
    /// Maps to `request=RequestFollowUser&userId=<id>`, which drops the launching
    /// account into whatever joinable game the target user is currently in (when
    /// that user allows public joins).
    RequestFollowUser { user_id: String },

    /// A private-server-link-code URL (`?privateServerLinkCode=<code>` on a
    /// `/games/<id>` URL). Maps to `request=RequestPrivateGame`, but building the
    /// final URL first requires resolving the `accessCode` from the link code —
    /// an async call (`getAccessCode`) the launch flow (Task 10.2) performs.
    RequestPrivateGame {
        place_id: String,
        private_link_code: String,
    },

    /// A share link (a `/share` URL, or any URL carrying both `code` and `type`
    /// query params). the legacy JS backend resolves this with an async call
    /// (`resolveShareLink`) into a `placeId` + `linkCode`, then builds
    /// `request=RequestGameJob`. Task 10.2 performs that resolution.
    ShareLink {
        code: String,
        link_type: Option<String>,
    },

    /// A `ro.blox.com` short link. the legacy JS backend follows the HTTP redirect
    /// (`followRedirect`, async) to obtain the real URL, then re-parses it. The
    /// launch flow (Task 10.2) follows the redirect and calls
    /// [`parse_launch_target`] again on the resolved URL.
    ShortLink { url: String },
}

/// A launch-target classification failure, carrying the same user-facing message
/// text the legacy JS backend returns for the corresponding `{ success: false, error }` case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchTargetError {
    /// URL parsed, share/private branches did not match, and no place id was
    /// found in the path.
    NoPlaceId,
    /// A `/share` URL with no `code` query parameter.
    MissingShareCode,
    /// The target was neither a bare place id nor a parseable URL.
    Unrecognized,
}

impl LaunchTargetError {
    /// The exact user-facing error string the legacy JS backend returns for this case.
    pub fn message(&self) -> &'static str {
        match self {
            LaunchTargetError::NoPlaceId => "Could not find a Place ID in the URL.",
            LaunchTargetError::MissingShareCode => "Invalid share link -- no code found.",
            LaunchTargetError::Unrecognized => {
                "Unrecognised input. Enter a place ID, game URL, or private server link."
            }
        }
    }
}

impl LauncherRequest {
    /// For a fully-resolved [`LauncherRequest::RequestGame`], build the exact
    /// `placelauncher.ashx` URL the legacy JS backend builds (`request=RequestGame`). The
    /// other variants require async resolution before their URL can be built,
    /// so they return `None` here (Task 10.2 builds those).
    pub fn placelauncher_url(&self) -> Option<String> {
        match self {
            LauncherRequest::RequestGame { place_id } => Some(format!(
                "https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId={place_id}&isPlayTogetherGame=false"
            )),
            _ => None,
        }
    }
}

/// Classify a raw launch target into the correct [`LauncherRequest`] variant,
/// exactly reproducing the legacy JS backend's synchronous branching (see [`LauncherRequest`]).
///
/// This is a pure function: it performs no network or process I/O. Variants that
/// the legacy JS backend resolves with an async call ([`LauncherRequest::ShortLink`],
/// [`LauncherRequest::ShareLink`], [`LauncherRequest::RequestPrivateGame`]'s
/// access-code step) are returned as-is for the launch flow to resolve.
pub fn parse_launch_target(target: &str) -> Result<LauncherRequest, LaunchTargetError> {
    // `const t = (target || '').trim();`
    let t = target.trim();

    // Empty target → app-only launch.
    if t.is_empty() {
        return Ok(LauncherRequest::AppOnly);
    }

    // `if (/^\d+$/.test(t))` → bare place id.
    if is_all_ascii_digits(t) {
        return Ok(LauncherRequest::RequestGame {
            place_id: t.to_string(),
        });
    }

    // `let rawUrl = t.startsWith('http') ? t : 'https://' + t;`
    let raw_url = if t.starts_with("http") {
        t.to_string()
    } else {
        format!("https://{t}")
    };

    // ro.blox.com short-link detection happens before the main parse in
    // the legacy JS backend, wrapped in try/catch (a parse failure here is ignored and falls
    // through to the main parse). We mirror that: only classify as a ShortLink
    // when the URL parses AND the host matches.
    if let Ok(parsed0) = Url::parse(&raw_url) {
        if let Some(host) = parsed0.host_str() {
            if host == "ro.blox.com" || host.ends_with(".ro.blox.com") {
                return Ok(LauncherRequest::ShortLink { url: raw_url });
            }
        }
    }

    // `let parsedUrl; try { parsedUrl = new URL(rawUrl); } catch {}`
    // `if (parsedUrl) { ... } else { return Unrecognised }`
    let parsed = match Url::parse(&raw_url) {
        Ok(u) => u,
        Err(_) => return Err(LaunchTargetError::Unrecognized),
    };

    let private_code = query_param(&parsed, "privateServerLinkCode");
    let share_code = query_param(&parsed, "code");
    let share_type = query_param(&parsed, "type");
    // A specific public server carries a `gameId` (job id) query param. Accept the
    // common aliases the website / this app use for it.
    let game_job_id = query_param(&parsed, "gameId")
        .or_else(|| query_param(&parsed, "gameInstanceId"))
        .or_else(|| query_param(&parsed, "jobId"));
    // `pathname.match(/\/games\/(\d+)/)?.[1] || pathname.match(/\/(\d+)/)?.[1]`
    let place_id = extract_place_id(parsed.path());

    // `if (privateCode && placeId)`
    if is_truthy(&private_code) {
        if let Some(pid) = place_id.clone() {
            return Ok(LauncherRequest::RequestPrivateGame {
                place_id: pid,
                // is_truthy guaranteed Some & non-empty.
                private_link_code: private_code.unwrap(),
            });
        }
    }

    // A gameId + placeId means "join this exact public server" (RequestGameJob).
    if is_truthy(&game_job_id) {
        if let Some(pid) = place_id.clone() {
            return Ok(LauncherRequest::RequestGameJob {
                place_id: pid,
                game_id: game_job_id.unwrap(),
            });
        }
    }

    // A `followUserId` query param means "join this player" (RequestFollowUser).
    let follow_user = query_param(&parsed, "followUserId");
    if is_truthy(&follow_user) {
        return Ok(LauncherRequest::RequestFollowUser {
            user_id: follow_user.unwrap(),
        });
    }

    // `else if (parsedUrl.pathname === '/share' || (shareCode && shareType))`
    if parsed.path() == "/share" || (is_truthy(&share_code) && is_truthy(&share_type)) {
        // `const code = shareCode; if (!code) return { ... 'no code found.' };`
        if !is_truthy(&share_code) {
            return Err(LaunchTargetError::MissingShareCode);
        }
        return Ok(LauncherRequest::ShareLink {
            code: share_code.unwrap(),
            // `type` is passed to resolveShareLink; keep it (falsy → None).
            link_type: share_type.filter(|s| !s.is_empty()),
        });
    }

    // `else if (placeId)`
    if let Some(pid) = place_id {
        return Ok(LauncherRequest::RequestGame { place_id: pid });
    }

    // `else return { ... 'Could not find a Place ID in the URL.' }`
    Err(LaunchTargetError::NoPlaceId)
}

/// `/^\d+$/` — true iff `s` is non-empty and every char is an ASCII digit.
fn is_all_ascii_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// JS truthiness for a query-param value: `Some(non-empty)` is truthy; both
/// `None` (param absent) and `Some("")` (param present but empty) are falsy,
/// matching how `searchParams.get(...)` results are used in boolean position.
fn is_truthy(v: &Option<String>) -> bool {
    v.as_deref().map_or(false, |s| !s.is_empty())
}

/// `searchParams.get(key)` — the first (decoded) value for `key`, or `None`.
fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

/// Reproduce `pathname.match(/\/games\/(\d+)/)?.[1] || pathname.match(/\/(\d+)/)?.[1]`:
/// prefer a place id following a `/games/` segment, otherwise the first run of
/// digits immediately after any `/`.
fn extract_place_id(path: &str) -> Option<String> {
    // First: /games/<digits> (scan every "/games/" occurrence for one with digits).
    let marker = "/games/";
    let mut from = 0;
    while let Some(rel) = path[from..].find(marker) {
        let idx = from + rel;
        let start = idx + marker.len();
        let digits: String = path[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return Some(digits);
        }
        from = idx + 1;
    }

    // Fallback: /<digits> anywhere in the path (first occurrence).
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                return Some(path[start..j].to_string());
            }
        }
        i += 1;
    }

    None
}

// ── Launch-credential pipeline (Task 10.2) ──────────────────────────────────

/// 4-second minimum gap between successive launches (`LAUNCH_STAGGER` in
/// the legacy JS backend), enforced against [`AppState::last_launch_ts`] to avoid tripping
/// `auth.roblox.com`'s 429 rate limiter when several accounts launch at once.
pub const LAUNCH_STAGGER_MS: i64 = 4_000;

/// CSRF-token cache TTL (`CSRF_TTL` in the legacy JS backend): 5 minutes. A cached token
/// newer than this is reused; anything older is re-fetched.
pub const CSRF_TTL_MS: i64 = 5 * 60_000;

/// Auth-ticket cache TTL (`TICKET_TTL` in the legacy JS backend): 25 seconds. A cached ticket
/// newer than this is returned without a network round-trip.
pub const TICKET_TTL_MS: i64 = 25_000;

/// Minimum gap between live auth-ticket requests for the same cookie
/// (`TICKET_MIN_GAP` in the legacy JS backend): 8 seconds. If a cached ticket is older than
/// [`TICKET_TTL_MS`] but younger than this, the flow sleeps the remaining gap
/// before issuing a fresh request, so a single cookie never requests tickets
/// faster than once per 8 seconds.
pub const TICKET_MIN_GAP_MS: i64 = 8_000;

/// The renderer-facing result of a launch attempt, mirroring the legacy JS backend's
/// `{ success: true }` / `{ success: false, error }` resolution value so the
/// `roblox:launch` command (Task 10.10) can return it straight to the
/// Renderer_UI. On failure `error` carries the exact user-facing message text
/// the legacy JS backend produced for that failure.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LaunchResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LaunchResult {
    /// A successful launch (`{ success: true }`).
    pub fn ok() -> Self {
        Self { success: true, error: None }
    }

    /// A failed launch (`{ success: false, error }`).
    pub fn fail(error: impl Into<String>) -> Self {
        Self { success: false, error: Some(error.into()) }
    }
}

/// Current wall-clock time in epoch milliseconds, matching `Date.now()`. A clock
/// before the Unix epoch (not reachable on a sane system) is clamped to 0.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `sleep(ms)` — the async equivalent of the legacy JS backend's
/// `new Promise(r => setTimeout(r, ms))`. A non-positive duration is a no-op.
async fn sleep_ms(ms: i64) {
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms as u64)).await;
    }
}

/// Build the HTTP client used for the `auth.roblox.com` calls. Redirects are
/// disabled (`redirect: 'manual'`-equivalent) so a `3xx` surfaces as-is rather
/// than being transparently followed, matching the Node `https` behavior these
/// calls relied on.
fn build_auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Acquire the launch-queue lock, serializing this launch against every other
/// in-flight launch for the lifetime of the returned guard.
///
/// This is the Rust counterpart of the legacy JS backend's `_launchQueue = _launchQueue.then(
/// () => _doLaunch(...))` promise chain: there, each launch is appended to a
/// single promise chain so only one `_doLaunch` body runs at a time; here, the
/// caller holds this guard across the whole launch body to get the same
/// one-at-a-time ordering. The guard is `'static` (via `lock_owned`) so it can be
/// held across the `.await` points of the full launch without borrowing
/// `AppState`.
pub async fn acquire_launch_slot(state: &AppState) -> tokio::sync::OwnedMutexGuard<()> {
    state.launch_lock.clone().lock_owned().await
}

/// Enforce the 4-second stagger between launches.
///
/// Ports the legacy JS backend's pre-launch guard:
/// ```js
/// const sinceLastLaunch = Date.now() - _lastLaunchTs;
/// if (_lastLaunchTs > 0 && sinceLastLaunch < LAUNCH_STAGGER)
///   await sleep(LAUNCH_STAGGER - sinceLastLaunch);
/// ```
/// The `_lastLaunchTs` timestamp is only ever set by [`mark_launched`] (called by
/// the spawn step on a *successful* launch), so a run of failed launches does not
/// keep pushing the stagger window forward.
pub async fn enforce_launch_stagger(state: &AppState) {
    let last = *state
        .last_launch_ts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if last > 0 {
        let since = now_ms() - last;
        if since < LAUNCH_STAGGER_MS {
            sleep_ms(LAUNCH_STAGGER_MS - since).await;
        }
    }
}

/// Record that a launch just completed, so the next launch staggers off it.
/// Ports the legacy JS backend's `_lastLaunchTs = Date.now();` at the end of a successful
/// `_doLaunch`. Kept public so the spawn step (Task 10.3+) can call it at the
/// same point in the flow.
pub fn mark_launched(state: &AppState) {
    let mut guard = state
        .last_launch_ts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = now_ms();
}

/// Fetch a fresh CSRF token from `auth.roblox.com`, ignoring any cache.
///
/// Ports the network half of `getCSRFToken`: `POST` to `/v2/logout` then
/// `/v1/logout` (a logout with no body deliberately returns a
/// `x-csrf-token` response header), returning the first token header seen.
/// Returns `None` when neither endpoint yields a token (matching the legacy JS backend's
/// `return null`); transport errors on one endpoint fall through to the next.
async fn fetch_csrf_token(cookie: &str) -> Option<String> {
    let client = build_auth_client().ok()?;
    let cookie_header = format!(".ROBLOSECURITY={cookie}");
    for endpoint in ["/v2/logout", "/v1/logout"] {
        let resp = client
            .post(format!("https://auth.roblox.com{endpoint}"))
            .header("Cookie", &cookie_header)
            .send()
            .await;
        if let Ok(r) = resp {
            if let Some(token) = r
                .headers()
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty())
            {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Return a valid CSRF token for `cookie`, using the 5-minute cache when possible.
///
/// Ports `getCSRFToken`: a cache entry younger than [`CSRF_TTL_MS`] is returned
/// directly; otherwise a fresh token is fetched via [`fetch_csrf_token`] and, on
/// success, written back to the cache with the current timestamp. Returns `None`
/// only when a fresh fetch also fails.
///
/// The cache lock is never held across the network fetch — it is taken to read
/// the cached value, released for the `.await`, then re-taken to store the
/// result — so a slow CSRF fetch for one cookie cannot block a cache hit for
/// another.
pub async fn get_csrf_token(state: &AppState, cookie: &str) -> Option<String> {
    let now = now_ms();
    {
        let cache = state.csrf_cache.lock().await;
        if let Some(entry) = cache.get(cookie) {
            if now - entry.cached_at < CSRF_TTL_MS {
                return Some(entry.value.clone());
            }
        }
    }

    let token = fetch_csrf_token(cookie).await?;
    let mut cache = state.csrf_cache.lock().await;
    cache.insert(
        cookie.to_string(),
        CachedToken { value: token.clone(), cached_at: now_ms() },
    );
    Some(token)
}

/// The parsed outcome of one `authentication-ticket` POST: the ticket header (if
/// present), the HTTP status, and the `retry-after` header (if present).
struct TicketAttempt {
    ticket: Option<String>,
    status: u16,
    retry_after_secs: Option<u64>,
}

/// Issue one `POST https://auth.roblox.com/v1/authentication-ticket` with the
/// given CSRF token and read back the ticket / status / retry-after. A transport
/// failure is reported as status `0` with no ticket (so the caller's status-based
/// branching treats it as a generic non-2xx failure), matching how the legacy JS backend's
/// `httpsPost` rejections are surfaced as a non-success status.
async fn post_auth_ticket(client: &reqwest::Client, cookie: &str, csrf: &str) -> TicketAttempt {
    let resp = client
        .post("https://auth.roblox.com/v1/authentication-ticket")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Referer", "https://www.roblox.com")
        .header("Origin", "https://www.roblox.com")
        .header("X-CSRF-TOKEN", csrf)
        // The endpoint rejects the request with HTTP 415 without a JSON
        // Content-Type; the legacy JS backend's httpsPost always sent these. The body is
        // empty (the ticket is derived from the cookie + CSRF headers).
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .body("")
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let ticket = r
                .headers()
                .get("rbx-authentication-ticket")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let retry_after_secs = r
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(parse_leading_u64);
            TicketAttempt { ticket, status, retry_after_secs }
        }
        Err(_) => TicketAttempt { ticket: None, status: 0, retry_after_secs: None },
    }
}

/// Obtain an auth ticket for `cookie`, using the 25-second cache, the 8-second
/// minimum gap, and the same 3-attempt 429/403 recovery loop as the legacy JS backend's
/// `getAuthTicket`.
///
/// Behavior (a faithful port of `getAuthTicket`):
///   1. A cached ticket younger than [`TICKET_TTL_MS`] is returned immediately.
///   2. Otherwise, if a cached ticket is younger than [`TICKET_MIN_GAP_MS`], sleep
///      the remaining gap before hitting the network.
///   3. Up to 3 attempts with `[0, 2000, 5000]` ms pre-delays:
///      - a ticket header → cache it (with the current timestamp) and return it;
///      - `429` → drop the CSRF cache entry, sleep `retry-after` (default 8s),
///        re-fetch CSRF, and retry (or fail if CSRF can't be refreshed);
///      - `403` → drop the CSRF cache entry, re-fetch CSRF, and retry (or fail);
///      - any other status → fail immediately with the HTTP-status message.
///   4. Exhausting all 3 attempts fails with the "still rate limited" message.
///
/// Returns `Ok(ticket)` or `Err(user_facing_message)`; the error strings match
/// the legacy JS backend verbatim so the Renderer_UI shows the same text.
pub async fn get_auth_ticket(
    state: &AppState,
    cookie: &str,
    csrf_token: &str,
) -> Result<String, String> {
    let now = now_ms();
    {
        let cache = state.ticket_cache.lock().await;
        if let Some(entry) = cache.get(cookie) {
            let age = now - entry.cached_at;
            if age < TICKET_TTL_MS {
                return Ok(entry.value.clone());
            }
        }
    }
    // Minimum-gap back-off: sleep out the remainder of the 8-second window if the
    // (now-stale-for-reuse) cached ticket is still younger than the gap.
    {
        let gap_remaining = {
            let cache = state.ticket_cache.lock().await;
            cache.get(cookie).and_then(|entry| {
                let age = now - entry.cached_at;
                if age < TICKET_MIN_GAP_MS {
                    Some(TICKET_MIN_GAP_MS - age)
                } else {
                    None
                }
            })
        };
        if let Some(remaining) = gap_remaining {
            sleep_ms(remaining).await;
        }
    }

    let client = build_auth_client()?;
    let mut token = csrf_token.to_string();
    let delays = [0i64, 2_000, 5_000];

    for delay in delays {
        sleep_ms(delay).await;

        let attempt = post_auth_ticket(&client, cookie, &token).await;

        if let Some(ticket) = attempt.ticket {
            let mut cache = state.ticket_cache.lock().await;
            cache.insert(
                cookie.to_string(),
                CachedToken { value: ticket.clone(), cached_at: now_ms() },
            );
            return Ok(ticket);
        }

        if attempt.status == 429 {
            state.csrf_cache.lock().await.remove(cookie);
            let retry_after = attempt.retry_after_secs.unwrap_or(8);
            sleep_ms((retry_after as i64) * 1_000).await;
            match get_csrf_token(state, cookie).await {
                Some(fresh) => {
                    token = fresh;
                    continue;
                }
                None => {
                    return Err(
                        "Rate limited and could not refresh token. Wait a moment and try again."
                            .to_string(),
                    );
                }
            }
        }

        if attempt.status == 403 {
            state.csrf_cache.lock().await.remove(cookie);
            match get_csrf_token(state, cookie).await {
                Some(fresh) => {
                    token = fresh;
                    continue;
                }
                None => {
                    return Err("Authentication failed (403). Cookie may be expired.".to_string());
                }
            }
        }

        return Err(format!(
            "Auth ticket request failed (HTTP {}). Try again in a moment.",
            attempt.status
        ));
    }

    Err("Still rate limited after 3 attempts. Please wait 30 seconds and try again.".to_string())
}

/// The credentials needed to build the `roblox-player:` launch URI: the auth
/// ticket and the CSRF token used to obtain it (the CSRF token is threaded on
/// because the private-server / share-link resolution steps the launch flow runs
/// next — Task 10.3 — reuse it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCredentials {
    pub ticket: String,
    pub csrf_token: String,
}

/// Run the credential-acquisition half of a launch: enforce the stagger, obtain a
/// CSRF token, then obtain an auth ticket.
///
/// Ports the leading section of the legacy JS backend's `_doLaunch`:
/// ```js
/// // (stagger)
/// const csrfToken = await getCSRFToken(cookie);
/// if (!csrfToken) return { success: false, error: 'Failed to get CSRF token...' };
/// const ticketResult = await getAuthTicket(cookie, csrfToken);
/// if (!ticketResult.ok) return { success: false, error: `Failed to get auth ticket: ${...}` };
/// ```
///
/// On success returns [`LaunchCredentials`]. On failure at **either** the CSRF or
/// the auth-ticket step it returns `Err(LaunchResult::fail(...))` with the exact
/// message the legacy JS backend produced — and, critically, returns **before** any launch or
/// watch state is mutated, so a credential failure never marks the account as
/// launched (Requirement 2.2). The caller (the spawn step) only records the PID,
/// arms the watcher, and calls [`mark_launched`] on the `Ok` path.
pub async fn acquire_launch_credentials(
    state: &AppState,
    cookie: &str,
) -> Result<LaunchCredentials, LaunchResult> {
    acquire_launch_credentials_via(state, cookie, &RealCredentialSteps).await
}

/// The two credential-acquisition steps a launch runs against `auth.roblox.com`,
/// abstracted behind a trait so the launch flow's failure handling
/// (Requirement 2.2 / Property 6) can be exercised deterministically without a
/// live network — a test double can force a failure at either the CSRF stage or
/// the auth-ticket stage. The production implementation ([`RealCredentialSteps`])
/// wires these straight to [`get_csrf_token`] / [`get_auth_ticket`], so the
/// live behavior is byte-for-byte unchanged by this seam.
pub trait LaunchCredentialSteps: Send + Sync {
    /// Obtain a CSRF token for `cookie` (or `None` on failure), mirroring
    /// [`get_csrf_token`].
    fn csrf<'a>(
        &'a self,
        state: &'a AppState,
        cookie: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

    /// Obtain an auth ticket for `cookie` given a CSRF token (or an error message
    /// on failure), mirroring [`get_auth_ticket`].
    fn ticket<'a>(
        &'a self,
        state: &'a AppState,
        cookie: &'a str,
        csrf: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
}

/// The production [`LaunchCredentialSteps`]: the real, network-backed CSRF and
/// auth-ticket acquisition. This is what [`acquire_launch_credentials`] uses.
struct RealCredentialSteps;

impl LaunchCredentialSteps for RealCredentialSteps {
    fn csrf<'a>(
        &'a self,
        state: &'a AppState,
        cookie: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>> {
        Box::pin(get_csrf_token(state, cookie))
    }

    fn ticket<'a>(
        &'a self,
        state: &'a AppState,
        cookie: &'a str,
        csrf: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(get_auth_ticket(state, cookie, csrf))
    }
}

/// The credential-acquisition half of a launch, parameterized over its
/// [`LaunchCredentialSteps`] so the failure paths can be injected in tests.
///
/// This is the seam behind [`acquire_launch_credentials`] and preserves its exact
/// behavior: enforce the stagger, obtain a CSRF token, then obtain an auth
/// ticket. On failure at **either** the CSRF or the auth-ticket step it returns
/// `Err(LaunchResult::fail(...))` with the exact message the legacy JS backend produced —
/// and, critically, returns **before** any launch or watch state is mutated
/// (`arm_watch`/`mark_launched` are only reached by the caller on the `Ok` path),
/// so a credential failure never marks the account as launched (Requirement 2.2).
pub async fn acquire_launch_credentials_via(
    state: &AppState,
    cookie: &str,
    steps: &dyn LaunchCredentialSteps,
) -> Result<LaunchCredentials, LaunchResult> {
    enforce_launch_stagger(state).await;

    let csrf_token = match steps.csrf(state, cookie).await {
        Some(t) => t,
        None => {
            return Err(LaunchResult::fail(
                "Failed to get CSRF token. Is the account cookie still valid?",
            ));
        }
    };

    match steps.ticket(state, cookie, &csrf_token).await {
        Ok(ticket) => Ok(LaunchCredentials { ticket, csrf_token }),
        Err(e) => Err(LaunchResult::fail(format!("Failed to get auth ticket: {e}"))),
    }
}

/// Parse the leading run of ASCII digits of `s` as a `u64`, mirroring
/// `parseInt(x, 10)`'s "leading integer" behavior for the `retry-after` header
/// (e.g. `"8"` → `8`, `"12, 30"` → `12`, `"abc"` → `None`).
fn parse_leading_u64(s: &str) -> Option<u64> {
    let digits: String = s.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

// ── Watch/poll close-detection state machine (Task 10.3) ────────────────────
//
// This is a faithful port of the legacy JS backend's single shared watch poll (the
// `_watchedAccounts` / `_missCounts` / `_watchTimer` machinery and `_watchTick`).
// The design fixes the timing constants below and requires the map be a Rust
// `HashMap` guarded by a `tokio::sync::Mutex`, ticked by a `tokio::time::interval`
// (Requirement 2.7, 7.2, 7.3).
//
// The presence check — enumerating live `RobloxPlayerBeta.exe` PIDs via
// `tasklist` — is deliberately abstracted behind the [`PresenceProbe`] trait so
// this state machine is testable without spawning real processes (the real
// `tasklist`-backed probe is Task 10.4). Likewise, the Renderer_UI close
// notification is abstracted behind [`WatchNotifier`] (the `roblox://closed` /
// `roblox://all-closed` / `roblox://count` events are formally registered in
// Task 10.10); a [`TauriWatchNotifier`] wires it to real Tauri events here,
// consistent with the legacy JS backend's `win.webContents.send('roblox:closed', ...)` /
// `send('roblox:count', ...)` calls.

/// Poll cadence (`POLL_INTERVAL` in the legacy JS backend): a single `tasklist` sweep every
/// 5000 ms covering every watched account, rather than one timer per account.
pub const POLL_INTERVAL_MS: u64 = 5_000;

/// Post-launch grace period (`LAUNCH_DELAY` in the legacy JS backend): 15000 ms. An account is
/// armed with `readyAt = now + LAUNCH_DELAY_MS` and is not evaluated until that
/// instant passes, covering the launcher→game-client hand-off gap during which
/// the process we spawned legitimately disappears.
pub const LAUNCH_DELAY_MS: i64 = 15_000;

/// Consecutive-miss threshold (`MISS_THRESHOLD` in the legacy JS backend): an account must be
/// observed absent on 4 consecutive post-grace polls (~20 s) before it is
/// declared closed. Any single "present" observation resets the count to zero.
pub const MISS_THRESHOLD: u32 = 4;

/// Tauri event replacing the legacy JS backend's `win.webContents.send('roblox:closed', id)`
/// (design IPC_Surface mapping, registered in Task 10.10).
pub const ROBLOX_CLOSED_EVENT: &str = "roblox://closed";

/// Tauri event replacing the legacy JS backend's `send('roblox:allClosed')` (emitted by the
/// kill-all path, Task 10.4/10.10).
pub const ROBLOX_ALL_CLOSED_EVENT: &str = "roblox://all-closed";

/// Tauri event replacing the legacy JS backend's `send('roblox:count', alivePids.size)`.
pub const ROBLOX_COUNT_EVENT: &str = "roblox://count";

/// One poll observation of the system's live Roblox processes, the input the
/// state machine evaluates each tick.
///
/// On Windows (`is_windows == true`) the legacy JS backend enumerates every live
/// `RobloxPlayerBeta.exe` PID from `tasklist` CSV, so per-account liveness can be
/// checked against that account's *own* tracked PID (`alive_pids`). On any other
/// platform only a coarse "is any Roblox process running" signal is available
/// (`any_running`), matching the legacy JS backend's `pgrep` fallback.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PresenceSnapshot {
    /// Whether this snapshot came from the Windows PID-enumeration path.
    pub is_windows: bool,
    /// Every currently-alive `RobloxPlayerBeta.exe` PID (Windows only; empty on
    /// other platforms).
    pub alive_pids: HashSet<u32>,
    /// Coarse "something is running" signal used for accounts launched without a
    /// tracked PID, and as the sole signal on non-Windows platforms.
    pub any_running: bool,
}

impl PresenceSnapshot {
    /// Build a Windows snapshot from the set of live `RobloxPlayerBeta.exe` PIDs.
    /// `any_running` follows `alivePids.size > 0`, matching the legacy JS backend.
    pub fn windows(alive_pids: HashSet<u32>) -> Self {
        let any_running = !alive_pids.is_empty();
        Self { is_windows: true, alive_pids, any_running }
    }

    /// Build a non-Windows snapshot carrying only the coarse running signal.
    pub fn coarse(any_running: bool) -> Self {
        Self { is_windows: false, alive_pids: HashSet::new(), any_running }
    }
}

/// A closed account produced by a watch tick, carrying the account id and the
/// last PID we had tracked for it (read out *before* the tracking entry is
/// removed, so the close notification/log can still identify the process — the
/// `pid: _accountPids.get(accountId)` metadata the legacy JS backend logs on close).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedAccount {
    pub account_id: String,
    pub last_pid: Option<u32>,
}

/// The result of evaluating one watch tick: the accounts newly declared closed
/// (in the order they were detected) and the running-instance count to report to
/// the Renderer_UI.
///
/// `running_count` is `Some(n)` only on the Windows PID-enumeration path (where
/// the legacy JS backend emits `roblox:count` with `alivePids.size`); on other platforms it
/// is `None` because no exact count is available (the legacy JS backend only emits the count
/// under `isWin`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatchTickOutcome {
    pub closed: Vec<ClosedAccount>,
    pub running_count: Option<usize>,
}

/// The pure, synchronous core of the watch/poll state machine — a direct port of
/// the body of the legacy JS backend's `_watchTick` `close` callback, with all I/O (the
/// `tasklist` spawn and the `webContents.send` notifications) factored out.
///
/// Given the current tracking maps, one [`PresenceSnapshot`], and the current
/// time, it advances every watched account exactly as the legacy JS backend does:
///   * accounts still inside their post-launch grace window (`now < readyAt`) are
///     skipped entirely — no observation before the grace period elapses counts
///     toward the miss threshold;
///   * per-account liveness prefers the tracked PID (`alive_pids.contains(pid)`)
///     and falls back to the coarse `any_running` signal for accounts launched
///     without one;
///   * an **orphan** — a live `RobloxPlayerBeta.exe` PID claimed by no watched
///     account — is adopted by a watched account whose own tracked PID has gone
///     (the launcher→game-client hand-off), flipping it back to "running" instead
///     of counting a miss;
///   * an absent account's consecutive-miss count is incremented and, once it
///     reaches [`MISS_THRESHOLD`], the account is declared closed; any present
///     observation resets that account's miss count to zero;
///   * every closed account is removed from all three tracking maps (its last
///     PID captured first for the notification).
///
/// This function is the single source of truth for Property 8 and is exhaustively
/// unit-testable with no async runtime or process spawning.
pub fn evaluate_watch_tick(
    watched: &mut HashMap<String, i64>,
    misses: &mut HashMap<String, u32>,
    pids: &mut HashMap<String, u32>,
    snapshot: &PresenceSnapshot,
    now: i64,
) -> WatchTickOutcome {
    let is_win = snapshot.is_windows;
    let any_running = snapshot.any_running;

    // PIDs currently claimed by *any* watched account (grace window included),
    // matching the legacy JS backend's `claimed` set built over `_watchedAccounts.keys()`.
    let mut claimed: HashSet<u32> = HashSet::new();
    for id in watched.keys() {
        if let Some(p) = pids.get(id) {
            claimed.insert(*p);
        }
    }

    // Orphans: live Roblox PIDs no watched account is claiming (Windows only).
    let mut orphans: Vec<u32> = if is_win {
        snapshot
            .alive_pids
            .iter()
            .copied()
            .filter(|p| !claimed.contains(p))
            .collect()
    } else {
        Vec::new()
    };

    // Snapshot the watched entries so the maps can be mutated during evaluation.
    let entries: Vec<(String, i64)> = watched.iter().map(|(k, v)| (k.clone(), *v)).collect();

    let mut closed_ids: Vec<String> = Vec::new();

    for (account_id, ready_at) in entries {
        if now < ready_at {
            continue; // still in post-launch grace window
        }

        let pid = pids.get(&account_id).copied();

        // Per-account liveness: tracked PID on Windows, else the coarse signal.
        let mut running = match (is_win, pid) {
            (true, Some(p)) => snapshot.alive_pids.contains(&p),
            _ => any_running,
        };

        // Adopt an orphan when our tracked process exited but Roblox is still up
        // under a new PID (`orphans.shift()`), so a still-running instance is not
        // reported as closed.
        if is_win && pid.is_some() && !running && !orphans.is_empty() {
            let adopted = orphans.remove(0);
            pids.insert(account_id.clone(), adopted);
            running = true;
        }

        if !running {
            let next = misses.get(&account_id).copied().unwrap_or(0) + 1;
            misses.insert(account_id.clone(), next);
            if next >= MISS_THRESHOLD {
                closed_ids.push(account_id);
            }
        } else {
            misses.insert(account_id, 0); // reset on any successful detection
        }
    }

    // Retire every closed account from all three tracking maps, capturing its
    // last-known PID first for the notification/log.
    let mut closed: Vec<ClosedAccount> = Vec::with_capacity(closed_ids.len());
    for account_id in closed_ids {
        watched.remove(&account_id);
        misses.remove(&account_id);
        let last_pid = pids.remove(&account_id);
        closed.push(ClosedAccount { account_id, last_pid });
    }

    let running_count = if is_win { Some(snapshot.alive_pids.len()) } else { None };

    WatchTickOutcome { closed, running_count }
}

/// The pluggable presence check the watch loop calls once per tick. The real,
/// Windows `tasklist`-backed implementation is Task 10.4; abstracting it behind a
/// trait keeps the [`evaluate_watch_tick`] state machine and the loop testable
/// with a scripted test double.
///
/// `probe` returns `None` when the enumeration itself failed this tick (the
/// `tasklist` spawn errored) — matching the legacy JS backend's `proc.on('error', () => {})`,
/// which skips the tick and retries on the next one rather than treating a failed
/// enumeration as "nothing running".
pub trait PresenceProbe: Send + Sync {
    fn probe(&self) -> Pin<Box<dyn Future<Output = Option<PresenceSnapshot>> + Send + '_>>;
}

/// The Renderer_UI close-notification sink the watch loop drives. The Tauri
/// event wiring lives in [`TauriWatchNotifier`]; abstracting it keeps the loop
/// testable and lets Task 10.10 formally register the events.
pub trait WatchNotifier: Send + Sync {
    /// A previously-tracked account's process was found gone: `roblox://closed`
    /// (the legacy JS backend: `send('roblox:closed', accountId)`).
    fn notify_closed(&self, account_id: &str);
    /// The current live Roblox-instance count: `roblox://count` (the legacy JS backend:
    /// `send('roblox:count', alivePids.size)`).
    fn notify_count(&self, count: usize);
    /// Every tracked instance went down at once: `roblox://all-closed`
    /// (the legacy JS backend: `send('roblox:allClosed')`, used by the kill-all path).
    fn notify_all_closed(&self);
}

/// [`WatchNotifier`] that emits the real Tauri events, replacing the legacy JS backend's
/// `win.webContents.send(...)`. Emission is best-effort (any emit error is
/// swallowed), matching the legacy JS backend's `if (win && !win.isDestroyed())` guard.
#[derive(Clone)]
pub struct TauriWatchNotifier {
    app: tauri::AppHandle,
}

impl TauriWatchNotifier {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl WatchNotifier for TauriWatchNotifier {
    fn notify_closed(&self, account_id: &str) {
        use tauri::Emitter;
        let _ = self.app.emit(ROBLOX_CLOSED_EVENT, account_id);
    }

    fn notify_count(&self, count: usize) {
        use tauri::Emitter;
        let _ = self.app.emit(ROBLOX_COUNT_EVENT, count);
    }

    fn notify_all_closed(&self) {
        use tauri::Emitter;
        let _ = self.app.emit(ROBLOX_ALL_CLOSED_EVENT, ());
    }
}

/// Arm (or re-arm) watching for `account_id` with a fresh post-launch grace
/// period, a direct port of the legacy JS backend's `_watchRoblox(accountId)`:
/// ```js
/// _watchedAccounts.set(accountId, Date.now() + LAUNCH_DELAY);
/// _missCounts.set(accountId, 0);
/// _startWatchPoll();
/// ```
/// Starting the shared poll loop (`_startWatchPoll`) is the caller's next step
/// via [`ensure_watch_loop`]; keeping the two separate lets the pure arming logic
/// be exercised without spawning a background task.
pub async fn arm_watch(state: &AppState, account_id: &str) {
    let ready_at = now_ms() + LAUNCH_DELAY_MS;
    {
        let mut watched = state.watched_accounts.lock().await;
        watched.insert(account_id.to_string(), ready_at);
    }
    let mut misses = state.miss_counts.lock().await;
    misses.insert(account_id.to_string(), 0);
}

/// Run exactly one watch tick against the given tracking maps: probe presence,
/// evaluate the state machine under lock, then fire the Renderer_UI
/// notifications. Returns `true` when no accounts remain watched afterward (so
/// the caller's loop can stop), mirroring the legacy JS backend's `_stopWatchPollIfIdle`.
///
/// A `None` probe result (failed enumeration this tick) is skipped without
/// touching any state, matching the legacy JS backend's `proc.on('error')` retry-next-tick
/// behavior; the idle check still runs so a loop with nothing left to watch can
/// still wind down.
async fn run_watch_tick(
    watched: &Arc<AsyncMutex<HashMap<String, i64>>>,
    misses: &Arc<AsyncMutex<HashMap<String, u32>>>,
    pids: &Arc<Mutex<HashMap<String, u32>>>,
    probe: &dyn PresenceProbe,
    notifier: &dyn WatchNotifier,
) -> bool {
    let snapshot = match probe.probe().await {
        Some(s) => s,
        None => {
            // Failed enumeration -> skip this tick, retry next; report idleness.
            return watched.lock().await.is_empty();
        }
    };

    let outcome = {
        // Lock the async maps first (across no await), then the std-mutex PID map
        // synchronously; the pure evaluator holds no lock across an await point.
        let mut watched_guard = watched.lock().await;
        let mut misses_guard = misses.lock().await;
        let mut pids_guard = pids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        evaluate_watch_tick(
            &mut watched_guard,
            &mut misses_guard,
            &mut pids_guard,
            &snapshot,
            now_ms(),
        )
    };

    for c in &outcome.closed {
        notifier.notify_closed(&c.account_id);
    }
    if let Some(count) = outcome.running_count {
        notifier.notify_count(count);
    }

    watched.lock().await.is_empty()
}

/// Run one watch tick against `state` (the [`AppState`] tracking maps). Thin
/// wrapper over [`run_watch_tick`] used by the launch/command layer and tests.
pub async fn watch_tick_once(
    state: &AppState,
    probe: &dyn PresenceProbe,
    notifier: &dyn WatchNotifier,
) -> bool {
    run_watch_tick(
        &state.watched_accounts,
        &state.miss_counts,
        &state.account_pids,
        probe,
        notifier,
    )
    .await
}

/// Ensure the single shared watch/poll loop is running, starting it if it is not
/// — the Rust counterpart of the legacy JS backend's `_startWatchPoll()` (`if (_watchTimer)
/// return; _watchTimer = setInterval(_watchTick, POLL_INTERVAL);`).
///
/// At most one loop task ever runs: the [`AppState::watch_loop_running`] flag
/// gates startup. The loop ticks every [`POLL_INTERVAL_MS`] via a
/// `tokio::time::interval`, and stops itself once no accounts remain watched
/// (re-checking emptiness under the running-flag lock so a launch that arms a new
/// account concurrently with an idle tick cannot lose the loop).
pub async fn ensure_watch_loop(
    state: &AppState,
    probe: Arc<dyn PresenceProbe>,
    notifier: Arc<dyn WatchNotifier>,
) {
    {
        let mut running = state.watch_loop_running.lock().await;
        if *running {
            return;
        }
        *running = true;
    }

    let watched = state.watched_accounts.clone();
    let misses = state.miss_counts.clone();
    let pids = state.account_pids.clone();
    let running_flag = state.watch_loop_running.clone();

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        // `setInterval` fires *after* the first interval elapses; consume the
        // immediate initial tick so the first evaluation happens one interval in.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let idle = run_watch_tick(&watched, &misses, &pids, probe.as_ref(), notifier.as_ref()).await;
            if idle {
                // Wind the loop down, but only if nothing was armed in the
                // meantime (checked under the same lock `ensure_watch_loop`
                // acquires before starting a fresh loop).
                let mut running = running_flag.lock().await;
                if watched.lock().await.is_empty() {
                    *running = false;
                    break;
                }
            }
        }
    });
}

// ── Process enumeration / termination + kill paths (Task 10.4) ──────────────
//
// Ports the legacy JS backend's `// ── Roblox session control (volume / kill / count) ──`
// process paths: the `tasklist`-backed enumeration / count / "fully closed"
// checks and the `taskkill`-backed kill-one / kill-all termination, issued with
// the **same command strings** the legacy JS build uses so the observable OS
// effect is identical (Requirement 8.3), plus the tracking-map bookkeeping and
// Renderer_UI notifications of `killAccountRoblox` / `killAllRoblox`
// (Requirement 2.5, 2.6). The `tasklist` enumeration here is also the real,
// Windows-backed [`PresenceProbe`] the watch loop (Task 10.3) is parameterized
// over.
//
// The pure pieces — the `tasklist`-output parsers, the command strings, and the
// tracking-map bookkeeping ([`untrack_account`] / [`untrack_all`]) — are factored
// out so the "kill only affects its targeted account(s)" property
// (Requirement 2.6) is unit-testable without spawning any real process.

/// `tasklist` enumeration command (`_watchTick`, Windows): every live
/// `RobloxPlayerBeta.exe` row in CSV form (`/FO CSV /NH`), so a PID can be pulled
/// from each row. Byte-for-byte the string the legacy JS backend issues.
pub const TASKLIST_ENUM_CMD: &str =
    r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /FO CSV /NH"#;

/// `tasklist` count command (`countRobloxProcesses`): the plain (non-CSV) listing
/// whose `RobloxPlayerBeta.exe` name occurrences the legacy JS backend counts.
pub const TASKLIST_COUNT_CMD: &str = r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH"#;

/// `tasklist` presence command (`waitForRobloxFullyClosed`): lists both the
/// player and the crash-handler so a *fully* closed state can be confirmed before
/// the singleton-mutex holder is refreshed.
pub const TASKLIST_PRESENCE_CMD: &str =
    r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH & tasklist /FI "IMAGENAME eq RobloxCrashHandler.exe" /NH"#;

/// `taskkill` kill-all command (`killAllRoblox`): force-terminate every Roblox
/// player and crash-handler process tree. Byte-for-byte the string the legacy JS backend
/// issues.
pub const TASKKILL_ALL_CMD: &str =
    "taskkill /F /IM RobloxPlayerBeta.exe /T & taskkill /F /IM RobloxCrashHandler.exe /T";

/// Maximum time [`wait_for_roblox_fully_closed`] polls before giving up
/// (`waitForRobloxFullyClosed`'s `maxWaitMs` default): 5000 ms.
pub const WAIT_FULLY_CLOSED_MS: i64 = 5_000;

/// Build the per-PID kill command (`killAccountRoblox`): `taskkill /F /PID <pid> /T`.
/// Byte-for-byte the template the legacy JS backend interpolates.
pub fn taskkill_pid_cmd(pid: u32) -> String {
    format!("taskkill /F /PID {pid} /T")
}

/// The renderer-facing result of a kill request, mirroring the legacy JS backend's
/// `{ ok: true }` / `{ ok: false, error }` resolution value so the
/// `roblox:killOne` / `roblox:killAll` commands (Task 10.10) can return it
/// straight to the Renderer_UI. On failure `error` carries the exact user-facing
/// message text the legacy JS backend produced.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KillResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl KillResult {
    /// A successful kill (`{ ok: true }`).
    pub fn ok() -> Self {
        Self { ok: true, error: None }
    }

    /// A failed / no-op kill (`{ ok: false, error }`).
    pub fn fail(error: impl Into<String>) -> Self {
        Self { ok: false, error: Some(error.into()) }
    }
}

/// Parse the PIDs of every live `RobloxPlayerBeta.exe` out of the CSV output of
/// [`TASKLIST_ENUM_CMD`], reproducing the legacy JS backend's
/// `out.matchAll(/"RobloxPlayerBeta\.exe","(\d+)"/gi)`: each match is a
/// `"RobloxPlayerBeta.exe","<digits>"` cell pair (image name matched
/// case-insensitively), and `<digits>` must be immediately followed by a closing
/// quote (the regex's trailing `"`).
pub fn parse_tasklist_csv_pids(output: &str) -> HashSet<u32> {
    // The image-name cell + the opening quote of the PID cell. Matched
    // case-insensitively (the regex's `i` flag) by lowercasing a copy; since the
    // needle is pure ASCII, byte offsets line up with the original string.
    const NEEDLE: &str = "\"robloxplayerbeta.exe\",\"";
    let lower = output.to_ascii_lowercase();
    let bytes = output.as_bytes();

    let mut pids = HashSet::new();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(NEEDLE) {
        let digits_start = from + rel + NEEDLE.len();
        let mut j = digits_start;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        // `(\d+)"`: require at least one digit followed by a closing quote.
        if j > digits_start && j < bytes.len() && bytes[j] == b'"' {
            if let Ok(pid) = output[digits_start..j].parse::<u32>() {
                pids.insert(pid);
            }
        }
        from = digits_start.max(from + rel + 1);
    }
    pids
}

/// Whether [`TASKLIST_PRESENCE_CMD`] output still reports a Roblox player or
/// crash-handler process, reproducing the legacy JS backend's
/// `/RobloxPlayerBeta\.exe|RobloxCrashHandler\.exe/i.test(out)`.
pub fn tasklist_reports_roblox_running(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("robloxplayerbeta.exe") || lower.contains("robloxcrashhandler.exe")
}

/// Count `RobloxPlayerBeta.exe` occurrences in [`TASKLIST_COUNT_CMD`] output,
/// reproducing the legacy JS backend's `out.match(/RobloxPlayerBeta\.exe/gi)?.length`.
pub fn count_roblox_processes_in_output(output: &str) -> usize {
    output.to_ascii_lowercase().matches("robloxplayerbeta.exe").count()
}

/// Build a `cmd /c <command>` invocation with no visible console window
/// (`CREATE_NO_WINDOW`), matching legacy JS runtime's `spawn('cmd', ['/c', ...], {
/// windowsHide: true })`.
#[cfg(windows)]
fn spawn_cmd(command: &str) -> tokio::process::Command {
    // `tokio::process::Command` re-exposes `creation_flags` as an inherent method
    // on Windows, so the `std::os::windows::process::CommandExt` trait import is
    // not needed here.
    /// `CREATE_NO_WINDOW`: run the console command headless (legacy JS runtime's
    /// `windowsHide: true`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = tokio::process::Command::new("cmd");
    c.args(["/c", command]).creation_flags(CREATE_NO_WINDOW);
    c
}

/// Enumerate the PIDs of every live `RobloxPlayerBeta.exe` via
/// [`TASKLIST_ENUM_CMD`]. Returns `None` when the `tasklist` spawn itself failed
/// (matching the legacy JS backend's `proc.on('error', () => {})`, which skips the tick), or
/// `Some(set)` — possibly empty — when enumeration succeeded.
#[cfg(windows)]
pub async fn enumerate_roblox_pids() -> Option<HashSet<u32>> {
    let output = spawn_cmd(TASKLIST_ENUM_CMD).output().await.ok()?;
    Some(parse_tasklist_csv_pids(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(not(windows))]
pub async fn enumerate_roblox_pids() -> Option<HashSet<u32>> {
    None
}

/// Count running Roblox clients (`countRobloxProcesses`) via
/// [`TASKLIST_COUNT_CMD`]. `0` on a spawn failure (and off Windows), matching
/// the legacy JS backend.
#[cfg(windows)]
pub async fn count_roblox_processes() -> usize {
    match spawn_cmd(TASKLIST_COUNT_CMD).output().await {
        Ok(out) => count_roblox_processes_in_output(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => 0,
    }
}

#[cfg(not(windows))]
pub async fn count_roblox_processes() -> usize {
    0
}

/// Issue [`TASKKILL_ALL_CMD`]. `Ok(())` once the command ran to completion —
/// regardless of `taskkill`'s own exit code, which is non-zero when nothing
/// matched and which the legacy JS backend's `close` handler likewise treats as success —
/// and `Err(())` only when the spawn itself failed (the legacy JS backend's `error` handler).
#[cfg(windows)]
async fn run_taskkill_all() -> Result<(), ()> {
    match spawn_cmd(TASKKILL_ALL_CMD).output().await {
        Ok(_) => Ok(()),
        Err(_) => Err(()),
    }
}

#[cfg(not(windows))]
async fn run_taskkill_all() -> Result<(), ()> {
    Ok(())
}

/// Issue `taskkill /F /PID <pid> /T` for one tracked process (`killAccountRoblox`).
/// Same success/failure contract as [`run_taskkill_all`].
#[cfg(windows)]
async fn run_taskkill_pid(pid: u32) -> Result<(), ()> {
    match spawn_cmd(&taskkill_pid_cmd(pid)).output().await {
        Ok(_) => Ok(()),
        Err(_) => Err(()),
    }
}

#[cfg(not(windows))]
async fn run_taskkill_pid(_pid: u32) -> Result<(), ()> {
    Ok(())
}

/// Poll [`TASKLIST_PRESENCE_CMD`] until neither `RobloxPlayerBeta.exe` nor
/// `RobloxCrashHandler.exe` is reported, or `max_wait_ms` elapses — a port of
/// `waitForRobloxFullyClosed`. `taskkill` returning only means the kill was
/// *issued*; actual teardown (and release of the singleton handles/kernel objects
/// those processes held) can lag a beat behind, so the mutex holder must not be
/// refreshed until this confirms a fully-closed state. A spawn failure resolves
/// immediately (as the legacy JS backend does).
#[cfg(windows)]
pub async fn wait_for_roblox_fully_closed(max_wait_ms: i64) {
    let started = now_ms();
    loop {
        let output = match spawn_cmd(TASKLIST_PRESENCE_CMD).output().await {
            Ok(o) => o,
            Err(_) => return,
        };
        let still_running =
            tasklist_reports_roblox_running(&String::from_utf8_lossy(&output.stdout));
        if !still_running || now_ms() - started >= max_wait_ms {
            return;
        }
        sleep_ms(300).await;
    }
}

#[cfg(not(windows))]
pub async fn wait_for_roblox_fully_closed(_max_wait_ms: i64) {}

/// The production [`PresenceProbe`]: enumerates live Roblox processes with the
/// same `tasklist` command string the legacy JS backend's `_watchTick` issues, wrapping the
/// result in a [`PresenceSnapshot`]. This is the real probe the watch loop
/// (Task 10.3) runs; a `None` result (failed enumeration) makes the loop skip the
/// tick and retry next time, exactly as the legacy JS backend does.
pub struct TasklistPresenceProbe;

impl PresenceProbe for TasklistPresenceProbe {
    fn probe(&self) -> Pin<Box<dyn Future<Output = Option<PresenceSnapshot>> + Send + '_>> {
        Box::pin(async {
            enumerate_roblox_pids().await.map(PresenceSnapshot::windows)
        })
    }
}

/// The singleton-mutex-holder refresh `killAllRoblox` performs *after* confirming
/// Roblox is fully closed. Abstracted behind a trait (following this module's
/// `PresenceProbe` / `WatchNotifier` injection pattern) so the kill path stays
/// unit-testable without a real Native_Helper or `AppHandle`; the command layer
/// (Task 10.10) supplies the production implementation that calls
/// `native_helper::restart_mutex_holder` / `start_mutex_holder`.
pub trait MutexHolderRefresh: Send + Sync {
    /// Refresh the holder. `had_running` mirrors `killAllRoblox`'s branch: when
    /// instances were running the holder is fully restarted
    /// (`restartMutexHolder`), otherwise it is merely (re)started
    /// (`startMutexHolder`), clearing any stale singleton state tied to the
    /// session that was just killed.
    fn refresh<'a>(
        &'a self,
        had_running: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

/// A [`MutexHolderRefresh`] that does nothing — used where the mutex holder is
/// not managed (unit tests, and any non-multi-instance context) so the kill path
/// can run unchanged.
pub struct NoopMutexRefresh;

impl MutexHolderRefresh for NoopMutexRefresh {
    fn refresh<'a>(
        &'a self,
        _had_running: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}

/// Remove one account's entries from all three tracking maps, returning the PID
/// tracked for it (captured *before* removal, so the caller can still identify
/// the process to kill / log). Pure map bookkeeping — no process is spawned —
/// touching **only** the targeted account, which is the core of Requirement 2.6.
///
/// Ports `killAccountRoblox`'s map operations:
/// ```js
/// const pid = _accountPids.get(accountId); _accountPids.delete(accountId);
/// _watchedAccounts.delete(accountId); _missCounts.delete(accountId);
/// ```
/// Clearing the watched entry lets the shared watch loop wind itself down once no
/// accounts remain watched (this module's `_stopWatchPollIfIdle` equivalent), so
/// no explicit poll-stop is needed here.
async fn untrack_account(state: &AppState, account_id: &str) -> Option<u32> {
    let pid = state
        .account_pids
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(account_id);
    state.watched_accounts.lock().await.remove(account_id);
    state.miss_counts.lock().await.remove(account_id);
    pid
}

/// Clear every tracking map, returning the ids that had been watched (for the
/// per-account close notifications). Pure map bookkeeping — no process is
/// spawned. Ports `killAllRoblox`'s up-front clears (`_watchedAccounts.clear()`,
/// `_missCounts.clear()`) plus the `_accountPids.clear()` it runs right after
/// issuing `taskkill`.
async fn untrack_all(state: &AppState) -> Vec<String> {
    let watched_ids: Vec<String> = {
        let mut watched = state.watched_accounts.lock().await;
        let ids = watched.keys().cloned().collect();
        watched.clear();
        ids
    };
    state.miss_counts.lock().await.clear();
    state
        .account_pids
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    watched_ids
}

/// Terminate the Roblox instance launched for a single account, a port of
/// `killAccountRoblox`.
///
/// The account's tracking entries are dropped first (touching **only** that
/// account — no other account's tracked instance is affected, Requirement 2.6),
/// then:
///   * off Windows → notify the account closed and report `{ ok: false, error:
///     "Windows only" }`;
///   * **untracked identifier** (no PID tracked) → a **no-op**: no `taskkill` is
///     issued and no other account is touched; the account's own indicator is
///     still reset (`send('roblox:closed', accountId)`) and the legacy JS backend's benign
///     `{ ok: false, error: "No tracked process for this account" }` is returned
///     (Requirement 2.6);
///   * otherwise → issue `taskkill /F /PID <pid> /T`, notify the account closed,
///     and report `{ ok: true }` (or `{ ok: false, error: "taskkill failed" }` if
///     the spawn itself failed).
pub async fn kill_one(
    state: &AppState,
    notifier: &dyn WatchNotifier,
    account_id: &str,
) -> KillResult {
    let pid = untrack_account(state, account_id).await;

    if let Err(e) = crate::platform::ensure_windows() {
        notifier.notify_closed(account_id);
        return KillResult::fail(e);
    }

    match pid {
        None => {
            // Untracked identifier: no-op termination, only this account's dot
            // resets, no other account is affected (Requirement 2.6).
            notifier.notify_closed(account_id);
            KillResult::fail("No tracked process for this account")
        }
        Some(pid) => {
            let killed = run_taskkill_pid(pid).await;
            notifier.notify_closed(account_id);
            match killed {
                Ok(()) => KillResult::ok(),
                Err(()) => KillResult::fail("taskkill failed"),
            }
        }
    }
}

/// Terminate every running Roblox client, a port of `killAllRoblox`.
///
/// Watchers are cleared and the previously-watched ids snapshotted up front, then
/// `taskkill /F /IM RobloxPlayerBeta.exe /T & taskkill /F /IM
/// RobloxCrashHandler.exe /T` is issued and the PID map cleared. `taskkill`'s
/// return is not trusted alone: [`wait_for_roblox_fully_closed`] confirms the
/// processes are actually gone before the singleton-mutex holder is refreshed
/// (`mutex_refresh`) — the one safe moment to clear stale singleton state tied to
/// the killed session. Finally every previously-watched account is notified
/// closed (`roblox://closed`) followed by `roblox://all-closed`, so every account
/// dot resets to "not launched".
///
/// Returns `{ ok: true }`, or `{ ok: false, error: "taskkill failed" }` if the
/// `taskkill` spawn itself failed (off Windows: `{ ok: false, error: "Windows
/// only" }`).
pub async fn kill_all(
    state: &AppState,
    notifier: &dyn WatchNotifier,
    mutex_refresh: &dyn MutexHolderRefresh,
) -> KillResult {
    let watched_ids = untrack_all(state).await;

    if let Err(e) = crate::platform::ensure_windows() {
        for id in &watched_ids {
            notifier.notify_closed(id);
        }
        notifier.notify_all_closed();
        return KillResult::fail(e);
    }

    let had_running = !watched_ids.is_empty();
    let killed = run_taskkill_all().await;

    // Confirm a fully-closed state before touching the mutex holder.
    wait_for_roblox_fully_closed(WAIT_FULLY_CLOSED_MS).await;
    mutex_refresh.refresh(had_running).await;

    for id in &watched_ids {
        notifier.notify_closed(id);
    }
    notifier.notify_all_closed();

    match killed {
        Ok(()) => KillResult::ok(),
        Err(()) => KillResult::fail("taskkill failed"),
    }
}

// ── Multi-instance vs single-instance launch behavior (Task 10.5) ───────────
//
// Ports the head of the legacy JS backend's `_doLaunch`, branched on the Settings_Store
// `multiInstance` flag (Requirements 2.3 / 2.4).
//
// In the legacy JS build the `multiInstance` flag drives the lifetime of the
// persistent mutex holder: toggling it on starts the holder, toggling it off
// stops it (the `settings:save` side effect), and the holder is what lets
// several `RobloxPlayerBeta` processes coexist instead of Roblox folding a
// second launch into the first via its own `ROBLOX_singletonMutex`. This module
// makes that same distinction explicit at launch time:
//
//   * ENABLED (Req 2.3)  → run `closeSingletonAndHoldMutex`: ensure our holder is
//     alive (concurrent mutex hold on behalf of every instance) and close the
//     singleton-event handles on any running client, so the new one is not
//     redirected into an existing session.
//   * DISABLED (Req 2.4) → do NOT hold the mutex or close singleton handles,
//     leaving Roblox's own singleton mutex in force so a second launch collapses
//     into the single running instance (single-instance enforcement).

/// Which singleton-handling path a launch takes, decided by the Settings_Store
/// `multiInstance` flag (Requirements 2.3 / 2.4). Kept as a small pure value so
/// the branch is unit-testable in isolation from the Native_Helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchSingletonMode {
    /// `multiInstance` ENABLED (Req 2.3): close singleton handles + hold the
    /// mutex per launch, allowing multiple concurrent Roblox clients.
    MultiInstance,
    /// `multiInstance` DISABLED (Req 2.4): do not bypass Roblox's singleton
    /// mutex, enforcing a single instance.
    SingleInstance,
}

/// Pure classifier mapping the `multiInstance` flag to a [`LaunchSingletonMode`],
/// mirroring the legacy JS backend's `isMultiInstanceEnabled()` decision at the launch site.
pub fn launch_singleton_mode(multi_instance_enabled: bool) -> LaunchSingletonMode {
    if multi_instance_enabled {
        LaunchSingletonMode::MultiInstance
    } else {
        LaunchSingletonMode::SingleInstance
    }
}

/// Read the Settings_Store `multiInstance` flag, porting the legacy JS backend's
/// `isMultiInstanceEnabled()` (`return !!(loadSettings().multiInstance)`).
///
/// A store read/parse failure resolves to `false` (single-instance) — the same
/// falsy outcome the legacy JS runtime helper produces when `loadSettings()` yields no
/// usable value — following the identical swallow-to-default pattern
/// `native_helper.rs`'s `setting_enabled` uses.
pub fn is_multi_instance_enabled(app: &AppHandle) -> bool {
    crate::accounts::store_dir(app)
        .ok()
        .and_then(|dir| crate::settings::load_from_dir(&dir).ok())
        .map(|s| s.multi_instance)
        .unwrap_or(false)
}

/// The "close singleton handles + hold mutex" side effect a multi-instance launch
/// performs before spawning, abstracted behind a trait (following this module's
/// `PresenceProbe` / `MutexHolderRefresh` injection pattern) so the launch-behavior
/// branch is unit-testable without a live Native_Helper.
pub trait SingletonHold: Send + Sync {
    /// Ensure the persistent mutex holder is alive and close the singleton-event
    /// handles on running Roblox processes (porting `closeSingletonAndHoldMutex`).
    /// Propagates the helper's `Err` so a launch never proceeds believing the
    /// mutex is held when it is not (Requirement 9.5).
    fn hold<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Production [`SingletonHold`]: delegates to
/// [`crate::native_helper::close_singleton_and_hold_mutex`], so the live behavior
/// is byte-for-byte the legacy JS build's per-launch prelude.
pub struct RealSingletonHold<'h> {
    pub app: &'h AppHandle,
    pub state: &'h AppState,
}

impl<'h> SingletonHold for RealSingletonHold<'h> {
    fn hold<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            crate::native_helper::close_singleton_and_hold_mutex(self.app, self.state).await
        })
    }
}

/// Run the per-launch singleton prelude according to `mode` (Requirements 2.3 / 2.4):
///
///   * [`LaunchSingletonMode::MultiInstance`] → run `hold` (start/reuse the
///     persistent mutex holder and close singleton-event handles); a `hold`
///     failure propagates as `Err` so the launch flow reports it rather than
///     spawning a client whose mutex is not actually held.
///   * [`LaunchSingletonMode::SingleInstance`] → a no-op returning `Ok(())`,
///     leaving Roblox's own singleton mutex in force (single-instance enforcement).
pub async fn apply_launch_singleton_prelude(
    mode: LaunchSingletonMode,
    hold: &dyn SingletonHold,
) -> Result<(), String> {
    match mode {
        LaunchSingletonMode::MultiInstance => hold.hold().await,
        LaunchSingletonMode::SingleInstance => Ok(()),
    }
}

/// Launch-flow entry point (called by the `roblox_launch` command, Task 10.10, at
/// the same point the legacy JS backend's `_doLaunch` calls `closeSingletonAndHoldMutex`):
/// read the `multiInstance` flag, classify it, and run the matching prelude.
pub async fn run_launch_singleton_prelude(
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let mode = launch_singleton_mode(is_multi_instance_enabled(app));
    apply_launch_singleton_prelude(mode, &RealSingletonHold { app, state }).await
}

// ── Command layer: launch / kill / count + event wiring (Task 10.10) ────────
//
// This section wires the building blocks above into the four Tauri commands the
// Renderer_UI invokes and formally registers the three Renderer_UI events. Each
// command takes the SAME parameters, in the SAME order, as its legacy IPC
// handler in the legacy JS backend (Requirement 10.1), and every event carries the same
// payload the legacy JS build sent (Requirement 10.2):
//
// | legacy IPC (the legacy JS backend)     | Tauri command          | legacy handler        |
// |------------------------------|------------------------|-------------------------|
// | `roblox:launch(id,ck,tgt)`   | [`roblox_launch`]      | `_doLaunch`             |
// | `roblox:killAll()`           | [`roblox_kill_all`]    | `killAllRoblox`         |
// | `roblox:killOne(id)`         | [`roblox_kill_one`]    | `killAccountRoblox`     |
// | `roblox:runningCount()`      | [`roblox_running_count`] | `countRobloxProcesses` |
//
// | legacy event                | Tauri event                 |
// |------------------------------|-----------------------------|
// | `roblox:closed`              | [`ROBLOX_CLOSED_EVENT`]     |
// | `roblox:allClosed`           | [`ROBLOX_ALL_CLOSED_EVENT`] |
// | `roblox:count`               | [`ROBLOX_COUNT_EVENT`]      |
//
// The events are emitted by [`TauriWatchNotifier`] (the production
// [`WatchNotifier`]), which the kill paths and the watch loop are parameterized
// over; the kill-all mutex-holder refresh is supplied by [`RealMutexRefresh`],
// the production [`MutexHolderRefresh`] that drives
// `native_helper::restart_mutex_holder` / `start_mutex_holder`.

use tauri::State;

/// The production [`MutexHolderRefresh`]: after `roblox_kill_all` confirms a
/// fully-closed state, refresh the singleton-mutex holder via the Native_Helper,
/// exactly as `killAllRoblox`'s `finishUp` does:
///   * `had_running` (instances were tracked) → `restartMutexHolder` (tear the
///     stale holder down and stand a fresh one up, clearing singleton state tied
///     to the killed session);
///   * otherwise → `startMutexHolder` (merely ensure a holder is alive).
///
/// Both underlying calls are best-effort here (their `Err` is swallowed), matching
/// `killAllRoblox`'s `try { ... } catch {}` around each.
struct RealMutexRefresh<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
}

impl MutexHolderRefresh for RealMutexRefresh<'_> {
    fn refresh<'a>(&'a self, had_running: bool) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if had_running {
                let _ = crate::native_helper::restart_mutex_holder(self.app, self.state).await;
            } else {
                let _ = crate::native_helper::start_mutex_holder(self.app, self.state).await;
            }
        })
    }
}

/// `encodeURIComponent(s)` — percent-encode every byte except the JS
/// "unreserved + a few" set (`A-Z a-z 0-9 - _ . ! ~ * ' ( )`), used to embed the
/// `placelauncherurl` inside the `roblox-player:` URI exactly as `_doLaunch` does.
fn encode_uri_component(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// Mint a 13-digit `browsertrackerid`, reproducing `_doLaunch`'s
/// `String(Math.floor(Math.random() * 9e12 + 1e12))` (a value in `[1e12, 1e13)`).
/// Roblox only needs an opaque numeric id here, so a time-seeded mix is
/// sufficient without pulling in an RNG dependency.
fn random_browser_id() -> u64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let mixed = (now.as_millis() as u64)
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(now.subsec_nanos() as u64)
        .wrapping_add(1_442_695_040_888_963_407);
    1_000_000_000_000u64 + (mixed % 9_000_000_000_000u64)
}

/// Resolve the launch target into the `placelauncherurl` value `_doLaunch` builds
/// (an empty string means an app-only launch, `launchmode:app`).
///
/// A faithful port of `_doLaunch`'s target branching: a bare place id / games URL
/// yields `RequestGame`; a `ro.blox.com` short link is followed and re-parsed; a
/// private-server link resolves an `accessCode` (`RequestPrivateGame`); a share
/// link resolves to `placeId` + `linkCode` (`RequestGameJob`). Each failure
/// returns the exact user-facing message `_doLaunch` returns for that case.
async fn build_launcher_url(
    target: &str,
    cookie: &str,
    csrf_token: &str,
) -> Result<String, String> {
    let mut req = parse_launch_target(target).map_err(|e| e.message().to_string())?;

    // Follow a `ro.blox.com` short link and re-parse the resolved URL. `_doLaunch`
    // follows once; we bound the loop so a pathological redirect chain cannot spin
    // forever, resolving the common single-hop case identically.
    let mut hops = 0;
    while let LauncherRequest::ShortLink { url } = &req {
        if hops >= 5 {
            return Err(LaunchTargetError::NoPlaceId.message().to_string());
        }
        let resolved = crate::roblox_api::follow_redirect(url).await?;
        req = parse_launch_target(&resolved).map_err(|e| e.message().to_string())?;
        hops += 1;
    }

    match req {
        LauncherRequest::AppOnly => Ok(String::new()),
        LauncherRequest::RequestGame { place_id } => Ok(format!(
            "https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId={place_id}&isPlayTogetherGame=false"
        )),
        LauncherRequest::RequestGameJob { place_id, game_id } => Ok(format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={place_id}&gameId={game_id}&isPlayTogetherGame=false"
        )),
        LauncherRequest::RequestFollowUser { user_id } => Ok(format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestFollowUser&userId={user_id}"
        )),
        LauncherRequest::RequestPrivateGame { place_id, private_link_code } => {
            match crate::roblox_api::get_access_code(&place_id, &private_link_code, cookie, csrf_token).await? {
                Some(access_code) => Ok(format!(
                    "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={place_id}&accessCode={access_code}&linkCode={private_link_code}"
                )),
                None => Err(
                    "Could not resolve private server access code. The link may be expired or you may not have permission."
                        .to_string(),
                ),
            }
        }
        LauncherRequest::ShareLink { code, .. } => {
            let resolved =
                crate::roblox_api::resolve_share_link(&code, cookie, csrf_token, "Server").await?;
            Ok(format!(
                "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={}&isPlayTogetherGame=false&linkCode={}",
                resolved.place_id, resolved.link_code
            ))
        }
        // Unreachable: the loop above resolves every ShortLink or returns an error.
        LauncherRequest::ShortLink { .. } => {
            Err(LaunchTargetError::NoPlaceId.message().to_string())
        }
    }
}

/// Build the full `roblox-player:` protocol URI `_doLaunch` hands to the client.
/// A non-empty `launcher_url` produces a `launchmode:play` URI carrying the
/// url-encoded `placelauncherurl`; an empty one produces a `launchmode:app` URI.
fn build_roblox_uri(ticket: &str, launcher_url: &str) -> String {
    let launch_time = now_ms();
    let browser_id = random_browser_id();
    if launcher_url.is_empty() {
        format!(
            "roblox-player:1+launchmode:app+gameinfo:{ticket}+launchtime:{launch_time}+browsertrackerid:{browser_id}+robloxLocale:en_us+gameLocale:en_us"
        )
    } else {
        format!(
            "roblox-player:1+launchmode:play+gameinfo:{ticket}+launchtime:{launch_time}+placelauncherurl:{}+browsertrackerid:{browser_id}+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp",
            encode_uri_component(launcher_url)
        )
    }
}

/// Spawn `RobloxPlayerBeta.exe` directly with the launch URI, detached with no
/// inherited stdio (`spawn(exe, [uri], { detached: true, stdio: 'ignore',
/// windowsHide: false })`). Returns the child PID so the account can be tracked.
/// Spawning the exe directly (rather than opening the URI) bypasses the singleton
/// URI handler that would fold the launch into an existing instance.
#[cfg(windows)]
fn spawn_roblox_player(exe: &std::path::Path, uri: &str) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    /// `DETACHED_PROCESS`: the new client runs independently of this backend
    /// (legacy JS runtime's `detached: true` + `child.unref()`).
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    std::process::Command::new(exe)
        .arg(uri)
        .creation_flags(DETACHED_PROCESS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
        .map(|child| child.id())
}

#[cfg(not(windows))]
fn spawn_roblox_player(_exe: &std::path::Path, _uri: &str) -> Option<u32> {
    None
}

/// Fallback when `RobloxPlayerBeta.exe` cannot be located: hand the URI to the
/// shell's protocol handler (`shell.openExternal(robloxUri)`), so the launch
/// still proceeds through the OS-registered `roblox-player:` handler.
#[cfg(windows)]
fn open_external_uri(uri: &str) {
    // `start "" "<uri>"` invokes the registered protocol handler; the empty title
    // arg keeps `start` from treating the quoted URI as a window title.
    let _ = spawn_cmd(&format!("start \"\" \"{uri}\"")).spawn();
}

#[cfg(not(windows))]
fn open_external_uri(_uri: &str) {}

/// Load the Account_Store quietly for name/id lookups (launch/kill logging),
/// resolving the crypto context the SAME way the `accounts_*` commands do. Any
/// failure yields an empty list — these lookups are only for log metadata and
/// must never break a launch/kill.
fn load_accounts_quiet(app: &AppHandle) -> Vec<crate::models::Account> {
    let dir = match crate::accounts::store_dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let ctx = crate::crypto_context::resolve(&dir);
    crate::accounts::load_from_dir(&dir, ctx.passphrase_mode, ctx.safe_storage_ready, ctx.device_key)
        .map(|loaded| loaded.accounts)
        .unwrap_or_default()
}

/// Stamp `account_id`'s `lastUsed` with the current ISO-8601 timestamp and
/// persist, returning the account's `(username, userId)` for launch logging.
/// Ports `_doLaunch`'s `accounts[idx].lastUsed = new Date().toISOString();
/// saveAccounts(accounts);`. A store failure is swallowed (the launch already
/// succeeded); the identity is returned when resolvable.
fn touch_last_used(app: &AppHandle, account_id: &str) -> (Option<String>, Option<String>) {
    let dir = match crate::accounts::store_dir(app) {
        Ok(d) => d,
        Err(_) => return (None, None),
    };
    let ctx = crate::crypto_context::resolve(&dir);
    let mut accounts = match crate::accounts::load_from_dir(
        &dir,
        ctx.passphrase_mode,
        ctx.safe_storage_ready,
        ctx.device_key,
    ) {
        Ok(loaded) => loaded.accounts,
        Err(_) => return (None, None),
    };

    if let Some(idx) = accounts.iter().position(|a| a.id == account_id) {
        let identity = (
            Some(accounts[idx].username.clone()),
            Some(accounts[idx].user_id.clone()),
        );
        accounts[idx].last_used = Some(crate::accounts::iso8601_utc_now());
        let _ = crate::accounts::save_to_dir(
            &dir,
            &accounts,
            ctx.passphrase_mode,
            ctx.safe_storage_ready,
            ctx.device_key,
        );
        identity
    } else {
        (None, None)
    }
}

/// The credential-failure launch-log message text `_doLaunch` writes on a CSRF /
/// auth-ticket failure, used so the session log matches the legacy JS build.
fn log_launch_failure(app: &AppHandle, account_id: &str, error: &str) {
    let username = load_accounts_quiet(app)
        .into_iter()
        .find(|a| a.id == account_id)
        .map(|a| a.username);
    let who = username.clone().unwrap_or_else(|| account_id.to_string());
    crate::logging::send_log(
        app,
        "err",
        "launch",
        &format!("Launch failed for {who}: {error}"),
        serde_json::json!({ "accountId": account_id, "username": username }),
    );
}

/// The full launch orchestration — the Rust port of `_doLaunch(accountId, cookie,
/// target)`. Runs the singleton prelude, acquires credentials (stagger → CSRF →
/// auth ticket), resolves the launch target into a `placelauncherurl`, builds the
/// `roblox-player:` URI, spawns the client, then — only on the success path —
/// records the PID, stamps `lastUsed`, logs, arms the watcher, and schedules the
/// per-instance master-volume apply. Every failure resolves to
/// `LaunchResult::fail(msg)` (never a rejected promise), so the account is never
/// marked launched on a credential/target failure (Requirement 2.2).
async fn do_launch(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    cookie: &str,
    target: &str,
) -> LaunchResult {
    // (0) Windows-only gate (Requirement 8.4). Launching drives the singleton
    //     mutex, RobloxPlayerBeta spawn, and `RobloxNative.exe`, all
    //     Windows-specific; short-circuit BEFORE the prelude, any auth network
    //     call, or marking the account launched, so a non-Windows OS gets a
    //     graceful "Windows only" report rather than falsely reporting success.
    if let Err(e) = crate::platform::ensure_windows() {
        return LaunchResult::fail(e);
    }

    // (1) Close ROBLOX_singletonEvent from any running client + hold the mutex
    //     (multi-instance), matching `await closeSingletonAndHoldMutex()`. A hold
    //     failure means the mutex is NOT actually held, so we must not proceed
    //     (Requirement 9.5).
    if let Err(e) = run_launch_singleton_prelude(app, state).await {
        return LaunchResult::fail(e);
    }

    // (2) Stagger → CSRF → auth ticket. On failure at either step, report it
    //     without touching launch/watch state (Requirement 2.2).
    let creds = match acquire_launch_credentials(state, cookie).await {
        Ok(c) => c,
        Err(result) => {
            if let Some(err) = &result.error {
                log_launch_failure(app, account_id, err);
            }
            return result;
        }
    };

    // (3) Resolve the launch target into the placelauncherurl (empty = app-only).
    let launcher_url = match build_launcher_url(target, cookie, &creds.csrf_token).await {
        Ok(url) => url,
        Err(msg) => return LaunchResult::fail(msg),
    };

    // (4) Build the roblox-player: URI.
    let roblox_uri = build_roblox_uri(&creds.ticket, &launcher_url);

    // (5) Spawn RobloxPlayerBeta.exe directly (bypassing the singleton URI
    //     handler), or fall back to the OS protocol handler if the exe is absent.
    let exe = crate::settings::latest_roblox_version_dir()
        .map(|dir| dir.join("RobloxPlayerBeta.exe"))
        .filter(|exe| exe.exists());

    if let Some(exe) = exe {
        if let Some(pid) = spawn_roblox_player(&exe, &roblox_uri) {
            state
                .account_pids
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(account_id.to_string(), pid);
        }
    } else {
        open_external_uri(&roblox_uri);
    }

    // (6) Success bookkeeping (mirrors the tail of `_doLaunch`).
    mark_launched(state);
    state.ticket_cache.lock().await.remove(cookie);

    let (username, user_id) = touch_last_used(app, account_id);
    let pid = state
        .account_pids
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(account_id)
        .copied();
    let target_label = {
        let t = target.trim();
        if t.is_empty() {
            "Roblox home".to_string()
        } else {
            t.to_string()
        }
    };
    crate::logging::send_log(
        app,
        "ok",
        "launch",
        &format!(
            "Launched Roblox for {}",
            username.clone().unwrap_or_else(|| account_id.to_string())
        ),
        serde_json::json!({
            "accountId": account_id,
            "username": username,
            "userId": user_id,
            "target": target_label,
            "pid": pid,
        }),
    );

    // (7) Arm the watch/poll close-detection for this account and ensure the
    //     shared poll loop is running (`_watchRoblox(accountId)`).
    arm_watch(state, account_id).await;
    ensure_watch_loop(
        state,
        Arc::new(TasklistPresenceProbe),
        Arc::new(TauriWatchNotifier::new(app.clone())),
    )
    .await;

    // If a non-default master volume is configured, apply it to the new instance
    // once its audio session has spun up (~9s after the window appears).
    if let Ok(dir) = crate::accounts::store_dir(app) {
        if let Ok(settings) = crate::settings::load_from_dir(&dir) {
            if let Some(vol) = settings.master_volume {
                if vol != 100.0 {
                    let app2 = app.clone();
                    tokio::spawn(async move {
                        sleep_ms(9_000).await;
                        let _ = crate::native_helper::set_roblox_volume(&app2, vol as i64).await;
                    });
                }
            }
        }
    }

    LaunchResult::ok()
}

/// `roblox:launch` — launch the Roblox client for an account, injecting its
/// session cookie via the auth-ticket flow (Requirement 2.1, 2.2). Parameters
/// match the legacy handler's `(accountId, cookie, target)` order.
///
/// Launches are serialized through the launch queue ([`acquire_launch_slot`],
/// held for the whole launch) exactly as the legacy JS backend's
/// `_launchQueue = _launchQueue.then(() => _doLaunch(...))` chain does, so
/// concurrent launches stagger rather than all hitting `auth.roblox.com` at once.
#[tauri::command]
pub async fn roblox_launch(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    cookie: String,
    target: Option<String>,
) -> Result<LaunchResult, String> {
    // Serialize this launch against every other in-flight launch (the queue).
    let _slot = acquire_launch_slot(state.inner()).await;
    let result = do_launch(
        &app,
        state.inner(),
        &account_id,
        &cookie,
        target.as_deref().unwrap_or(""),
    )
    .await;
    Ok(result)
}

/// `roblox:killAll` — terminate every running Roblox client and reset every
/// account's running indicator (Requirement 2.5). Emits `roblox://closed` for
/// each previously-watched account followed by `roblox://all-closed`, refreshing
/// the singleton-mutex holder once a fully-closed state is confirmed.
///
/// The `warn`/`kill` session-log entry (running count + account names) is written
/// BEFORE the kill clears the watch maps, matching `killAllRoblox`'s handler.
#[tauri::command]
pub async fn roblox_kill_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<KillResult, String> {
    let st = state.inner();

    // Snapshot the running accounts (for the log) before kill_all clears them.
    let watched_ids: Vec<String> = st.watched_accounts.lock().await.keys().cloned().collect();
    let accounts = load_accounts_quiet(&app);
    let running_names: Vec<String> = watched_ids
        .iter()
        .map(|id| {
            accounts
                .iter()
                .find(|a| &a.id == id)
                .map(|a| a.username.clone())
                .unwrap_or_else(|| id.clone())
        })
        .collect();
    let names_label = if running_names.is_empty() {
        "none".to_string()
    } else {
        running_names.join(", ")
    };
    crate::logging::send_log(
        &app,
        "warn",
        "kill",
        &format!(
            "Killed all Roblox instances ({} running: {})",
            watched_ids.len(),
            names_label
        ),
        serde_json::json!({ "count": watched_ids.len(), "accounts": running_names }),
    );

    let notifier = TauriWatchNotifier::new(app.clone());
    let refresh = RealMutexRefresh { app: &app, state: st };
    Ok(kill_all(st, &notifier, &refresh).await)
}

/// `roblox:killOne` — terminate the Roblox instance launched for one account and
/// reset only that account's indicator (Requirement 2.5, 2.6). Emits
/// `roblox://closed` for the account. An untracked identifier is a benign no-op
/// (no other account is affected). Parameter matches the legacy handler's
/// `(accountId)`.
///
/// The `warn`/`kill` session-log entry is written before the kill, matching
/// `killAccountRoblox`'s handler.
#[tauri::command]
pub async fn roblox_kill_one(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
) -> Result<KillResult, String> {
    let st = state.inner();

    // Resolve identity + tracked PID (for the log) before kill_one untracks it.
    let acct = load_accounts_quiet(&app)
        .into_iter()
        .find(|a| a.id == account_id);
    let username = acct.as_ref().map(|a| a.username.clone());
    let user_id = acct.as_ref().map(|a| a.user_id.clone());
    let pid = st
        .account_pids
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&account_id)
        .copied();
    crate::logging::send_log(
        &app,
        "warn",
        "kill",
        &format!(
            "Killed Roblox instance for {}",
            username.clone().unwrap_or_else(|| account_id.clone())
        ),
        serde_json::json!({
            "accountId": account_id,
            "username": username,
            "userId": user_id,
            "pid": pid,
        }),
    );

    let notifier = TauriWatchNotifier::new(app.clone());
    Ok(kill_one(st, &notifier, &account_id).await)
}

/// `roblox:runningCount` — return the number of live `RobloxPlayerBeta.exe`
/// processes (`countRobloxProcesses`). Never errors (`0` on any failure / off
/// Windows), matching the handler's `catch { return 0; }`.
#[tauri::command]
pub async fn roblox_running_count() -> Result<usize, String> {
    Ok(count_roblox_processes().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ── Task 10.5: multi-instance vs single-instance launch behavior ────────

    /// A [`SingletonHold`] test double recording how many times `hold` ran and
    /// returning a pre-configured outcome, so the launch branch can be exercised
    /// without a live Native_Helper.
    struct FakeSingletonHold {
        calls: AtomicUsize,
        result: Result<(), String>,
    }

    impl FakeSingletonHold {
        fn new(result: Result<(), String>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result,
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl SingletonHold for FakeSingletonHold {
        fn hold<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let r = self.result.clone();
            Box::pin(async move { r })
        }
    }

    #[test]
    fn multi_instance_flag_maps_to_launch_singleton_mode() {
        // Req 2.3: enabled → hold the mutex per launch.
        assert_eq!(
            launch_singleton_mode(true),
            LaunchSingletonMode::MultiInstance
        );
        // Req 2.4: disabled → single-instance enforcement.
        assert_eq!(
            launch_singleton_mode(false),
            LaunchSingletonMode::SingleInstance
        );
    }

    #[tokio::test]
    async fn multi_instance_prelude_holds_the_mutex() {
        // Req 2.3: in MultiInstance mode the prelude runs the hold side effect
        // (close singleton handles + hold mutex) exactly once and returns Ok.
        let hold = FakeSingletonHold::new(Ok(()));
        let r = apply_launch_singleton_prelude(LaunchSingletonMode::MultiInstance, &hold).await;
        assert_eq!(r, Ok(()));
        assert_eq!(hold.calls(), 1);
    }

    #[tokio::test]
    async fn multi_instance_prelude_propagates_hold_failure() {
        // Req 9.5: a hold failure surfaces as Err so the launch does not proceed
        // believing the mutex is held.
        let hold = FakeSingletonHold::new(Err("helper unavailable".to_string()));
        let r = apply_launch_singleton_prelude(LaunchSingletonMode::MultiInstance, &hold).await;
        assert_eq!(r, Err("helper unavailable".to_string()));
        assert_eq!(hold.calls(), 1);
    }

    #[tokio::test]
    async fn single_instance_prelude_never_holds_the_mutex() {
        // Req 2.4: in SingleInstance mode the prelude is a no-op — it must NOT
        // hold the mutex or close singleton handles, leaving Roblox's own
        // singleton mutex in force. Even a hold that WOULD fail is never called.
        let hold = FakeSingletonHold::new(Err("must not be called".to_string()));
        let r = apply_launch_singleton_prelude(LaunchSingletonMode::SingleInstance, &hold).await;
        assert_eq!(r, Ok(()));
        assert_eq!(hold.calls(), 0);
    }

    #[test]
    fn empty_target_is_app_only() {
        assert_eq!(parse_launch_target("").unwrap(), LauncherRequest::AppOnly);
        // Whitespace-only trims to empty.
        assert_eq!(
            parse_launch_target("   \t ").unwrap(),
            LauncherRequest::AppOnly
        );
    }

    #[test]
    fn bare_place_id_is_request_game() {
        assert_eq!(
            parse_launch_target("606849621").unwrap(),
            LauncherRequest::RequestGame {
                place_id: "606849621".to_string()
            }
        );
        // Surrounding whitespace is trimmed before the digit test.
        assert_eq!(
            parse_launch_target("  920587237  ").unwrap(),
            LauncherRequest::RequestGame {
                place_id: "920587237".to_string()
            }
        );
    }

    #[test]
    fn bare_place_id_builds_expected_launcher_url() {
        let req = parse_launch_target("123").unwrap();
        assert_eq!(
            req.placelauncher_url().unwrap(),
            "https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=123&isPlayTogetherGame=false"
        );
    }

    #[test]
    fn games_url_is_request_game() {
        assert_eq!(
            parse_launch_target("https://www.roblox.com/games/606849621/Jailbreak").unwrap(),
            LauncherRequest::RequestGame {
                place_id: "606849621".to_string()
            }
        );
    }

    #[test]
    fn games_url_with_any_job_id_alias_is_request_game_job() {
        for key in ["gameId", "gameInstanceId", "jobId"] {
            let target = format!(
                "https://www.roblox.com/games/606849621/Jailbreak?{key}=job-abc-123"
            );
            assert_eq!(
                parse_launch_target(&target).unwrap(),
                LauncherRequest::RequestGameJob {
                    place_id: "606849621".to_string(),
                    game_id: "job-abc-123".to_string(),
                },
                "alias {key} must target the exact public server"
            );
        }
    }

    #[tokio::test]
    async fn exact_public_server_builds_request_game_job_launcher_url() {
        let launcher = build_launcher_url(
            "https://www.roblox.com/games/606849621?gameId=job-abc-123",
            "",
            "",
        )
        .await
        .unwrap();
        assert_eq!(
            launcher,
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId=606849621&gameId=job-abc-123&isPlayTogetherGame=false"
        );
    }

    #[test]
    fn games_url_without_scheme_gets_https_prefixed() {
        assert_eq!(
            parse_launch_target("www.roblox.com/games/606849621").unwrap(),
            LauncherRequest::RequestGame {
                place_id: "606849621".to_string()
            }
        );
    }

    #[test]
    fn private_server_link_code_url_is_request_private_game() {
        assert_eq!(
            parse_launch_target(
                "https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ"
            )
            .unwrap(),
            LauncherRequest::RequestPrivateGame {
                place_id: "606849621".to_string(),
                private_link_code: "abc123XYZ".to_string()
            }
        );
    }

    #[test]
    fn private_server_link_code_without_place_id_falls_through_to_no_place_id() {
        // privateServerLinkCode present but no place id in the path → not private,
        // not share, no placeId → NoPlaceId (mirrors the legacy JS backend's fall-through).
        assert_eq!(
            parse_launch_target("https://www.roblox.com/home?privateServerLinkCode=abc"),
            Err(LaunchTargetError::NoPlaceId)
        );
    }

    #[test]
    fn share_path_url_is_share_link() {
        assert_eq!(
            parse_launch_target("https://www.roblox.com/share?code=deadbeef&type=Server").unwrap(),
            LauncherRequest::ShareLink {
                code: "deadbeef".to_string(),
                link_type: Some("Server".to_string())
            }
        );
    }

    #[test]
    fn code_and_type_on_any_path_is_share_link() {
        // The `(shareCode && shareType)` branch triggers even off the /share path.
        assert_eq!(
            parse_launch_target("https://www.roblox.com/games/start?code=xyz&type=ExperienceInvite")
                .unwrap(),
            LauncherRequest::ShareLink {
                code: "xyz".to_string(),
                link_type: Some("ExperienceInvite".to_string())
            }
        );
    }

    #[test]
    fn share_path_without_code_is_missing_share_code_error() {
        assert_eq!(
            parse_launch_target("https://www.roblox.com/share"),
            Err(LaunchTargetError::MissingShareCode)
        );
        // Present-but-empty `code` is falsy → same error.
        assert_eq!(
            parse_launch_target("https://www.roblox.com/share?code="),
            Err(LaunchTargetError::MissingShareCode)
        );
    }

    #[test]
    fn ro_blox_com_short_link_is_deferred_short_link() {
        assert_eq!(
            parse_launch_target("https://ro.blox.com/Ebh5").unwrap(),
            LauncherRequest::ShortLink {
                url: "https://ro.blox.com/Ebh5".to_string()
            }
        );
        // Subdomain of ro.blox.com and scheme-less input both classify as ShortLink.
        assert_eq!(
            parse_launch_target("ro.blox.com/Ebh5").unwrap(),
            LauncherRequest::ShortLink {
                url: "https://ro.blox.com/Ebh5".to_string()
            }
        );
    }

    #[test]
    fn url_with_no_place_id_is_no_place_id_error() {
        assert_eq!(
            parse_launch_target("https://www.roblox.com/home"),
            Err(LaunchTargetError::NoPlaceId)
        );
    }

    #[test]
    fn unparseable_non_digit_input_is_unrecognized_error() {
        // Not all digits, and not a parseable URL (space in authority) → Unrecognized.
        assert_eq!(
            parse_launch_target("not a url"),
            Err(LaunchTargetError::Unrecognized)
        );
    }

    #[test]
    fn private_takes_precedence_over_share_params() {
        // privateServerLinkCode + placeId wins even if code/type are also present.
        assert_eq!(
            parse_launch_target(
                "https://www.roblox.com/games/55?privateServerLinkCode=pc&code=sc&type=Server"
            )
            .unwrap(),
            LauncherRequest::RequestPrivateGame {
                place_id: "55".to_string(),
                private_link_code: "pc".to_string()
            }
        );
    }

    #[test]
    fn error_messages_match_main_js() {
        assert_eq!(
            LaunchTargetError::NoPlaceId.message(),
            "Could not find a Place ID in the URL."
        );
        assert_eq!(
            LaunchTargetError::MissingShareCode.message(),
            "Invalid share link -- no code found."
        );
        assert_eq!(
            LaunchTargetError::Unrecognized.message(),
            "Unrecognised input. Enter a place ID, game URL, or private server link."
        );
    }

    // ── Launch-credential pipeline (Task 10.2) ──────────────────────────────

    /// Insert a cache entry `age_ms` milliseconds old.
    fn stale(value: &str, age_ms: i64) -> CachedToken {
        CachedToken { value: value.to_string(), cached_at: now_ms() - age_ms }
    }

    #[test]
    fn ttl_constants_match_main_js() {
        assert_eq!(LAUNCH_STAGGER_MS, 4_000);
        assert_eq!(CSRF_TTL_MS, 300_000);
        assert_eq!(TICKET_TTL_MS, 25_000);
        assert_eq!(TICKET_MIN_GAP_MS, 8_000);
    }

    #[test]
    fn launch_result_serializes_like_main_js() {
        // Success omits `error` entirely (`{ success: true }`).
        let ok = serde_json::to_string(&LaunchResult::ok()).unwrap();
        assert_eq!(ok, r#"{"success":true}"#);
        // Failure carries the exact message (`{ success: false, error }`).
        let err = serde_json::to_string(&LaunchResult::fail("boom")).unwrap();
        assert_eq!(err, r#"{"success":false,"error":"boom"}"#);
    }

    #[test]
    fn parse_leading_u64_matches_parseint() {
        assert_eq!(parse_leading_u64("8"), Some(8));
        assert_eq!(parse_leading_u64("  12"), Some(12));
        assert_eq!(parse_leading_u64("30, 60"), Some(30));
        assert_eq!(parse_leading_u64("abc"), None);
        assert_eq!(parse_leading_u64(""), None);
    }

    #[tokio::test]
    async fn get_csrf_token_returns_fresh_cache_entry_without_network() {
        let state = AppState::default();
        state
            .csrf_cache
            .lock()
            .await
            .insert("cookieA".to_string(), stale("csrf-A", 1_000)); // 1s old < 5min

        // A fresh cache entry is returned without any network call.
        assert_eq!(
            get_csrf_token(&state, "cookieA").await,
            Some("csrf-A".to_string())
        );
    }

    #[tokio::test]
    async fn csrf_cache_is_keyed_per_cookie() {
        // Distinct cookies must not share a CSRF entry (parity with the legacy JS backend's
        // per-cookie `_csrfCache` Map): a hit for cookieA must not answer cookieB.
        let state = AppState::default();
        state
            .csrf_cache
            .lock()
            .await
            .insert("cookieA".to_string(), stale("csrf-A", 1_000));

        assert_eq!(
            get_csrf_token(&state, "cookieA").await,
            Some("csrf-A".to_string())
        );
        // cookieB has no entry; the only way to answer would be a network fetch,
        // which we can't rely on in a unit test — assert the cache itself has no
        // cross-talk instead.
        let cache = state.csrf_cache.lock().await;
        assert!(cache.get("cookieB").is_none());
        assert_eq!(cache.get("cookieA").map(|e| e.value.as_str()), Some("csrf-A"));
    }

    #[tokio::test]
    async fn get_auth_ticket_returns_cached_ticket_within_ttl() {
        let state = AppState::default();
        state
            .ticket_cache
            .lock()
            .await
            .insert("cookieA".to_string(), stale("ticket-A", 5_000)); // 5s old < 25s TTL

        // Within TTL, the cached ticket is returned with no network round-trip,
        // regardless of the CSRF token passed.
        let ticket = get_auth_ticket(&state, "cookieA", "any-csrf").await;
        assert_eq!(ticket, Ok("ticket-A".to_string()));
    }

    // Network-dependent: exercises the real CSRF fetch against auth.roblox.com,
    // which (deliberately) returns a token even for an invalid cookie, so this
    // only reliably asserts the failure path when run in a network-isolated
    // environment. Ignored by default so `cargo test` stays deterministic and
    // offline; the failure-without-marking-launched behavior is also covered
    // deterministically by the CSRF/auth-ticket property test (Task 10.7).
    #[tokio::test]
    #[ignore = "requires network isolation; run with --ignored offline"]
    async fn acquire_launch_credentials_fails_without_marking_launched_when_csrf_unavailable() {
        // With no reachable network and no cached CSRF token, credential
        // acquisition fails at the CSRF step and returns the exact legacy JS backend
        // message — and must NOT record a launch timestamp (Requirement 2.2).
        let state = AppState::default();
        assert_eq!(
            *state.last_launch_ts.lock().unwrap(),
            0,
            "precondition: no launch recorded yet"
        );

        let result = acquire_launch_credentials(&state, "unreachable-cookie").await;

        assert_eq!(
            result,
            Err(LaunchResult::fail(
                "Failed to get CSRF token. Is the account cookie still valid?"
            ))
        );
        // The account was never marked launched: the stagger timestamp is untouched
        // and no ticket was cached for the cookie.
        assert_eq!(*state.last_launch_ts.lock().unwrap(), 0);
        assert!(state.ticket_cache.lock().await.get("unreachable-cookie").is_none());
    }

    #[tokio::test]
    async fn enforce_launch_stagger_is_noop_when_no_prior_launch() {
        // With last_launch_ts == 0, the stagger must not sleep at all; this
        // completes effectively instantly.
        let state = AppState::default();
        let start = std::time::Instant::now();
        enforce_launch_stagger(&state).await;
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn mark_launched_sets_last_launch_ts() {
        let state = AppState::default();
        mark_launched(&state);
        assert!(*state.last_launch_ts.lock().unwrap() > 0);
    }
}

#[cfg(test)]
mod launch_target_prop_tests {
    //! Property-based test for the launch-target parser (Task 10.6).
    //!
    //! Property 5 (design doc): "Launch target parsing produces the correct
    //! launcher request shape." For any launch target — a bare numeric place id,
    //! a `roblox.com/games/{id}` URL, a URL carrying a `privateServerLinkCode`, a
    //! `code`+`type` share-link URL, a `ro.blox.com` short link, or an empty
    //! string — [`parse_launch_target`] must select the launcher-request variant
    //! that corresponds to that target's shape (or the app-only variant for an
    //! empty target) and embed the extracted place id / access / link code
    //! *unmodified* into the resulting request.
    //!
    //! Strategy: rather than re-deriving the expected classification from the
    //! generated string (which would just duplicate the parser), each generator
    //! constructs an input from known parts *and* the [`LauncherRequest`] /
    //! [`LaunchTargetError`] it must yield, then the property asserts the parser
    //! reproduces exactly that shape — including the verbatim place id / code.

    use super::*;
    use proptest::prelude::*;

    /// One generated launch-target case: the raw input string and the exact
    /// result [`parse_launch_target`] must return for it.
    #[derive(Debug, Clone)]
    struct Case {
        input: String,
        expected: Result<LauncherRequest, LaunchTargetError>,
    }

    /// 0–4 characters drawn from the ASCII whitespace `str::trim` (and JS
    /// `String.prototype.trim`) both strip, used to pad inputs that must survive
    /// trimming unchanged.
    fn whitespace() -> impl Strategy<Value = String> {
        proptest::collection::vec(
            prop_oneof![Just(' '), Just('\t'), Just('\n'), Just('\r')],
            0..4usize,
        )
        .prop_map(|chars| chars.into_iter().collect())
    }

    /// Whitespace-only (or empty) input → app-only launch.
    fn app_only_case() -> impl Strategy<Value = Case> {
        whitespace().prop_map(|ws| Case {
            input: ws,
            expected: Ok(LauncherRequest::AppOnly),
        })
    }

    /// A bare place id, optionally padded with trimmable whitespace →
    /// `RequestGame` carrying the digits verbatim.
    fn bare_place_id_case() -> impl Strategy<Value = Case> {
        (whitespace(), "[0-9]{1,18}", whitespace()).prop_map(|(lead, digits, trail)| Case {
            input: format!("{lead}{digits}{trail}"),
            expected: Ok(LauncherRequest::RequestGame { place_id: digits }),
        })
    }

    /// A `roblox.com/games/{id}/{name}` URL (with or without an explicit scheme)
    /// → `RequestGame` carrying the id verbatim.
    fn games_url_case() -> impl Strategy<Value = Case> {
        ("[0-9]{1,18}", "[A-Za-z]{1,12}", any::<bool>()).prop_map(|(id, name, with_scheme)| {
            let scheme = if with_scheme { "https://" } else { "" };
            Case {
                input: format!("{scheme}www.roblox.com/games/{id}/{name}"),
                expected: Ok(LauncherRequest::RequestGame { place_id: id }),
            }
        })
    }

    /// A `privateServerLinkCode` on a `/games/{id}` URL → `RequestPrivateGame`
    /// carrying both the place id and the link code verbatim.
    fn private_game_case() -> impl Strategy<Value = Case> {
        ("[0-9]{1,18}", "[A-Za-z0-9]{1,24}").prop_map(|(id, code)| Case {
            input: format!("https://www.roblox.com/games/{id}?privateServerLinkCode={code}"),
            expected: Ok(LauncherRequest::RequestPrivateGame {
                place_id: id,
                private_link_code: code,
            }),
        })
    }

    /// A `/share?code=..&type=..` URL → `ShareLink` carrying the code verbatim and
    /// the (non-empty) type.
    fn share_link_case() -> impl Strategy<Value = Case> {
        ("[A-Za-z0-9]{1,24}", "[A-Za-z]{1,12}").prop_map(|(code, link_type)| Case {
            input: format!("https://www.roblox.com/share?code={code}&type={link_type}"),
            expected: Ok(LauncherRequest::ShareLink {
                code,
                link_type: Some(link_type),
            }),
        })
    }

    /// A `/share` URL with no `code` → the missing-share-code error.
    fn missing_share_code_case() -> impl Strategy<Value = Case> {
        Just(Case {
            input: "https://www.roblox.com/share".to_string(),
            expected: Err(LaunchTargetError::MissingShareCode),
        })
    }

    /// A `ro.blox.com` short link (with or without a scheme) → the deferred
    /// `ShortLink` carrying the https-normalized URL.
    fn short_link_case() -> impl Strategy<Value = Case> {
        ("[A-Za-z0-9]{1,12}", any::<bool>()).prop_map(|(path, with_scheme)| {
            let normalized = format!("https://ro.blox.com/{path}");
            let input = if with_scheme {
                normalized.clone()
            } else {
                format!("ro.blox.com/{path}")
            };
            Case {
                input,
                expected: Ok(LauncherRequest::ShortLink { url: normalized }),
            }
        })
    }

    /// A well-formed `roblox.com` URL whose path has no place id, no share
    /// code/type, and no private link code → the no-place-id error.
    fn no_place_id_case() -> impl Strategy<Value = Case> {
        "[a-z]{1,10}"
            .prop_filter("`/share` is its own (missing-code) branch", |w| w != "share")
            .prop_map(|word| Case {
                input: format!("https://www.roblox.com/{word}"),
                expected: Err(LaunchTargetError::NoPlaceId),
            })
    }

    /// A non-numeric, unparseable-as-URL input (two words separated by a space)
    /// → the unrecognized-input error.
    fn unrecognized_case() -> impl Strategy<Value = Case> {
        ("[a-z]{1,8}", "[a-z]{1,8}").prop_map(|(a, b)| Case {
            input: format!("{a} {b}"),
            expected: Err(LaunchTargetError::Unrecognized),
        })
    }

    /// The full input space: one arm per launch-target shape.
    fn launch_target_case() -> impl Strategy<Value = Case> {
        prop_oneof![
            app_only_case(),
            bare_place_id_case(),
            games_url_case(),
            private_game_case(),
            share_link_case(),
            missing_share_code_case(),
            short_link_case(),
            no_place_id_case(),
            unrecognized_case(),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // Feature: native-tauri-backend, Property 5: Launch target parsing produces the correct launcher request shape
        //
        // **Validates: Requirements 2.1**
        //
        // Across every launch-target shape (empty/whitespace, bare place id,
        // games URL, private-server-link-code URL, share link, `ro.blox.com`
        // short link, unrecognized, and no-place-id/missing-share-code errors),
        // `parse_launch_target` returns exactly the request variant that
        // corresponds to the target's shape and embeds the extracted place id /
        // link code / share code verbatim.
        #[test]
        fn parse_launch_target_produces_correct_request_shape(case in launch_target_case()) {
            let actual = parse_launch_target(&case.input);
            prop_assert_eq!(
                actual,
                case.expected,
                "wrong launcher-request shape for input {:?}",
                case.input
            );
        }
    }
}

#[cfg(test)]
mod watch_state_tests {
    //! Unit tests for the watch/poll close-detection state machine (Task 10.3).
    //!
    //! These exercise the same behavior Property 8 (Task 10.9) covers, on
    //! concrete sequences: the grace period gates evaluation, close is declared
    //! iff `MISS_THRESHOLD` consecutive post-grace misses accrue, any "present"
    //! observation resets the miss count, orphan adoption keeps a still-running
    //! instance from being reported closed, and the running count is reported on
    //! the Windows path only.

    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    const ID: &str = "acct-1";

    /// Build the three tracking maps pre-seeded with one watched account that is
    /// already past its grace window (`ready_at = 0`) and has the given tracked
    /// PID and starting miss count.
    fn maps_with_account(
        pid: Option<u32>,
        misses_start: u32,
    ) -> (
        HashMap<String, i64>,
        HashMap<String, u32>,
        HashMap<String, u32>,
    ) {
        let mut watched = HashMap::new();
        watched.insert(ID.to_string(), 0i64); // ready_at in the past -> evaluated
        let mut misses = HashMap::new();
        misses.insert(ID.to_string(), misses_start);
        let mut pids = HashMap::new();
        if let Some(p) = pid {
            pids.insert(ID.to_string(), p);
        }
        (watched, misses, pids)
    }

    #[test]
    fn account_in_grace_window_is_not_evaluated() {
        // ready_at far in the future: an absent observation must NOT count a miss.
        let mut watched = HashMap::new();
        watched.insert(ID.to_string(), 1_000_000i64);
        let mut misses = HashMap::new();
        misses.insert(ID.to_string(), 0);
        let mut pids = HashMap::new();
        pids.insert(ID.to_string(), 42u32);

        // Absent (empty alive set) but still before ready_at.
        let snapshot = PresenceSnapshot::windows(HashSet::new());
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &snapshot, 0);

        assert!(outcome.closed.is_empty());
        assert_eq!(misses.get(ID).copied(), Some(0), "no miss during grace window");
        assert!(watched.contains_key(ID));
    }

    #[test]
    fn declares_closed_only_after_four_consecutive_misses() {
        let (mut watched, mut misses, mut pids) = maps_with_account(Some(42), 0);
        let absent = PresenceSnapshot::windows(HashSet::new()); // pid 42 not alive

        // Misses 1..=3 must NOT close.
        for expected in 1..=3u32 {
            let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &absent, 100);
            assert!(outcome.closed.is_empty(), "closed too early at miss {expected}");
            assert_eq!(misses.get(ID).copied(), Some(expected));
        }

        // The 4th consecutive miss closes.
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &absent, 100);
        assert_eq!(outcome.closed.len(), 1);
        assert_eq!(outcome.closed[0].account_id, ID);
        assert_eq!(outcome.closed[0].last_pid, Some(42));
        // Closed account is retired from all three maps.
        assert!(!watched.contains_key(ID));
        assert!(!misses.contains_key(ID));
        assert!(!pids.contains_key(ID));
    }

    #[test]
    fn present_observation_resets_the_miss_count() {
        let (mut watched, mut misses, mut pids) = maps_with_account(Some(42), 0);
        let absent = PresenceSnapshot::windows(HashSet::new());
        let present = PresenceSnapshot::windows(HashSet::from([42]));

        // 3 misses, then a present observation resets to zero.
        for _ in 0..3 {
            evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &absent, 100);
        }
        assert_eq!(misses.get(ID).copied(), Some(3));

        evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &present, 100);
        assert_eq!(misses.get(ID).copied(), Some(0), "present must reset misses");

        // Now it takes a fresh run of 4 misses to close (never 1 more).
        for expected in 1..=3u32 {
            let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &absent, 100);
            assert!(outcome.closed.is_empty());
            assert_eq!(misses.get(ID).copied(), Some(expected));
        }
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &absent, 100);
        assert_eq!(outcome.closed.len(), 1);
    }

    #[test]
    fn orphan_adoption_keeps_a_still_running_instance_alive() {
        // Our tracked pid (42) is gone, but an unclaimed live Roblox pid (99)
        // exists: the account adopts it and is treated as running (no miss).
        let (mut watched, mut misses, mut pids) = maps_with_account(Some(42), 0);
        let snapshot = PresenceSnapshot::windows(HashSet::from([99]));

        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &snapshot, 100);

        assert!(outcome.closed.is_empty());
        assert_eq!(misses.get(ID).copied(), Some(0));
        assert_eq!(pids.get(ID).copied(), Some(99), "orphan pid adopted");
    }

    #[test]
    fn running_count_reported_on_windows_and_absent_off_windows() {
        let (mut watched, mut misses, mut pids) = maps_with_account(Some(42), 0);
        let win = PresenceSnapshot::windows(HashSet::from([42, 77]));
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &win, 100);
        assert_eq!(outcome.running_count, Some(2));

        let (mut watched, mut misses, mut pids) = maps_with_account(None, 0);
        let coarse = PresenceSnapshot::coarse(true);
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &coarse, 100);
        assert_eq!(outcome.running_count, None, "no exact count off Windows");
        // With only the coarse "something running" signal, a PID-less account
        // counts as running and accrues no miss.
        assert_eq!(misses.get(ID).copied(), Some(0));
    }

    #[test]
    fn closing_one_account_leaves_a_second_still_running_untouched() {
        // Two accounts: one absent (will close), one present (must survive).
        let mut watched = HashMap::new();
        watched.insert("gone".to_string(), 0i64);
        watched.insert("alive".to_string(), 0i64);
        let mut misses = HashMap::new();
        misses.insert("gone".to_string(), 3); // one more miss closes it
        misses.insert("alive".to_string(), 0);
        let mut pids = HashMap::new();
        pids.insert("gone".to_string(), 10u32);
        pids.insert("alive".to_string(), 20u32);

        // 20 alive, 10 not. No orphans (both live pids are claimed... only 20 is).
        let snapshot = PresenceSnapshot::windows(HashSet::from([20]));
        let outcome = evaluate_watch_tick(&mut watched, &mut misses, &mut pids, &snapshot, 100);

        assert_eq!(outcome.closed.len(), 1);
        assert_eq!(outcome.closed[0].account_id, "gone");
        assert!(!watched.contains_key("gone"));
        assert!(watched.contains_key("alive"));
        assert_eq!(misses.get("alive").copied(), Some(0));
        assert_eq!(pids.get("alive").copied(), Some(20));
    }

    // ── Async orchestration: arm_watch + watch_tick_once with test doubles ──

    /// A scripted [`PresenceProbe`]: returns each queued snapshot in order.
    struct ScriptedProbe {
        queue: StdMutex<VecDeque<Option<PresenceSnapshot>>>,
    }
    impl ScriptedProbe {
        fn new(items: Vec<Option<PresenceSnapshot>>) -> Self {
            Self { queue: StdMutex::new(items.into_iter().collect()) }
        }
    }
    impl PresenceProbe for ScriptedProbe {
        fn probe(&self) -> Pin<Box<dyn Future<Output = Option<PresenceSnapshot>> + Send + '_>> {
            let next = self
                .queue
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .pop_front()
                .flatten();
            Box::pin(async move { next })
        }
    }

    /// A recording [`WatchNotifier`] capturing the emitted close ids and counts.
    #[derive(Default)]
    struct RecordingNotifier {
        closed: StdMutex<Vec<String>>,
        counts: StdMutex<Vec<usize>>,
    }
    impl WatchNotifier for RecordingNotifier {
        fn notify_closed(&self, account_id: &str) {
            self.closed.lock().unwrap().push(account_id.to_string());
        }
        fn notify_count(&self, count: usize) {
            self.counts.lock().unwrap().push(count);
        }
        fn notify_all_closed(&self) {}
    }

    #[tokio::test]
    async fn arm_watch_seeds_watched_and_miss_maps() {
        let state = AppState::default();
        arm_watch(&state, ID).await;

        let watched = state.watched_accounts.lock().await;
        let ready_at = *watched.get(ID).expect("armed account is watched");
        // ready_at is roughly now + LAUNCH_DELAY_MS (in the future).
        assert!(ready_at > now_ms());
        assert_eq!(state.miss_counts.lock().await.get(ID).copied(), Some(0));
    }

    #[tokio::test]
    async fn watch_tick_once_emits_close_and_count_and_reports_idle() {
        let state = AppState::default();
        // Seed one already-past-grace account whose pid is absent and one miss
        // short of the threshold, so a single absent tick closes it.
        state.watched_accounts.lock().await.insert(ID.to_string(), 0);
        state.miss_counts.lock().await.insert(ID.to_string(), MISS_THRESHOLD - 1);
        state
            .account_pids
            .lock()
            .unwrap()
            .insert(ID.to_string(), 42);

        let probe = ScriptedProbe::new(vec![Some(PresenceSnapshot::windows(HashSet::new()))]);
        let notifier = RecordingNotifier::default();

        let idle = watch_tick_once(&state, &probe, &notifier).await;

        assert!(idle, "no accounts remain watched -> idle");
        assert_eq!(notifier.closed.lock().unwrap().as_slice(), &[ID.to_string()]);
        assert_eq!(notifier.counts.lock().unwrap().as_slice(), &[0usize]);
        assert!(state.watched_accounts.lock().await.is_empty());
    }

    #[tokio::test]
    async fn watch_tick_once_skips_on_failed_enumeration() {
        let state = AppState::default();
        state.watched_accounts.lock().await.insert(ID.to_string(), 0);
        state.miss_counts.lock().await.insert(ID.to_string(), 3);
        state.account_pids.lock().unwrap().insert(ID.to_string(), 42);

        // `None` snapshot = enumeration failed this tick: skip, do not close.
        let probe = ScriptedProbe::new(vec![None]);
        let notifier = RecordingNotifier::default();

        let idle = watch_tick_once(&state, &probe, &notifier).await;

        assert!(!idle, "account still watched");
        assert!(notifier.closed.lock().unwrap().is_empty());
        assert!(notifier.counts.lock().unwrap().is_empty());
        assert_eq!(state.miss_counts.lock().await.get(ID).copied(), Some(3), "miss unchanged");
    }
}

#[cfg(test)]
mod csrf_auth_ticket_failure_prop_tests {
    //! Property-based test for CSRF/auth-ticket launch-failure handling (Task 10.7).
    //!
    //! Property 6 (design doc): "A launch failure at the CSRF or auth-ticket
    //! stage reports failure and does not mark the account as launched." For any
    //! account and any injected failure at CSRF-token acquisition or at
    //! auth-ticket acquisition, the launch operation must return a failure result
    //! carrying a non-empty error message, and must NOT begin watching that
    //! account as running (the account's tracked running-state must be unchanged
    //! from before the launch attempt).
    //!
    //! Strategy: the network-backed CSRF/auth-ticket steps are injected via a
    //! scripted [`LaunchCredentialSteps`] double (the same seam the production
    //! [`acquire_launch_credentials`] uses), forcing a failure at exactly one of
    //! the two stages. The tracking maps are pre-seeded with arbitrary unrelated
    //! accounts and a fixed prior launch timestamp; after the forced failure the
    //! property asserts (a) the returned [`LaunchResult`] is a failure with a
    //! non-empty, verbatim error message, and (b) every tracking map plus the
    //! launch timestamp is byte-for-byte unchanged and the target account was
    //! never added to the watched set.

    use super::*;
    use proptest::prelude::*;

    /// Which stage of credential acquisition is forced to fail.
    #[derive(Debug, Clone)]
    enum FailStage {
        /// CSRF-token acquisition returns `None`.
        Csrf,
        /// CSRF succeeds; auth-ticket acquisition returns `Err(msg)`.
        Ticket(String),
    }

    /// A scripted [`LaunchCredentialSteps`] that forces a failure at the
    /// configured stage. A CSRF-stage failure short-circuits before `ticket` is
    /// ever consulted; a ticket-stage failure first hands back a CSRF token.
    struct ScriptedCredentialSteps {
        stage: FailStage,
    }

    impl LaunchCredentialSteps for ScriptedCredentialSteps {
        fn csrf<'a>(
            &'a self,
            _state: &'a AppState,
            _cookie: &'a str,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>> {
            let out = match &self.stage {
                FailStage::Csrf => None,
                FailStage::Ticket(_) => Some("scripted-csrf-token".to_string()),
            };
            Box::pin(async move { out })
        }

        fn ticket<'a>(
            &'a self,
            _state: &'a AppState,
            _cookie: &'a str,
            _csrf: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
            let out = match &self.stage {
                // Reaching `ticket` after a CSRF-stage failure would be a bug in
                // the flow; surface it as an error so the property would catch it.
                FailStage::Csrf => {
                    Err("BUG: ticket reached after CSRF failure".to_string())
                }
                FailStage::Ticket(msg) => Err(msg.clone()),
            };
            Box::pin(async move { out })
        }
    }

    /// An arbitrary pre-existing tracking state for a handful of *other* accounts,
    /// used to prove the failing launch leaves everything untouched.
    #[derive(Debug, Clone)]
    struct PriorState {
        /// (account id, ready_at, miss count, optional tracked pid) for accounts
        /// unrelated to the launch under test.
        others: Vec<(String, i64, u32, Option<u32>)>,
        /// The account id being launched (guaranteed absent from `others`).
        target_id: String,
    }

    fn fail_stage() -> impl Strategy<Value = FailStage> {
        prop_oneof![
            Just(FailStage::Csrf),
            // Arbitrary ticket-stage error message, including the empty string, to
            // prove the reported error is non-empty even when the underlying cause
            // string is empty (the "Failed to get auth ticket: " prefix remains).
            "[a-zA-Z0-9 .:()-]{0,40}".prop_map(FailStage::Ticket),
        ]
    }

    fn prior_state() -> impl Strategy<Value = PriorState> {
        (
            proptest::collection::vec(
                (
                    "acct-[a-z0-9]{1,8}",
                    0i64..1_000_000i64,
                    0u32..MISS_THRESHOLD,
                    proptest::option::of(1u32..50_000u32),
                ),
                0..5,
            ),
            "target-[a-z0-9]{1,8}",
        )
            .prop_map(|(others, target_id)| {
                // Guarantee the target id is not among the pre-seeded accounts, so
                // "target was never tracked before" is a real precondition.
                let others = others
                    .into_iter()
                    .filter(|(id, _, _, _)| *id != target_id)
                    .collect();
                PriorState { others, target_id }
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // Feature: native-tauri-backend, Property 6: A launch failure at the CSRF or auth-ticket stage reports failure and does not mark the account as launched
        //
        // **Validates: Requirements 2.2**
        //
        // For any injected failure at the CSRF-token stage or the auth-ticket
        // stage, `acquire_launch_credentials_via` returns a failure `LaunchResult`
        // with a non-empty, verbatim error message, and never mutates any launch
        // or watch tracking state: the target account is never added to the
        // watched set and every tracking map plus the launch timestamp is left
        // exactly as it was before the attempt.
        #[test]
        fn csrf_or_ticket_failure_reports_failure_without_marking_launched(
            stage in fail_stage(),
            prior in prior_state(),
        ) {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build current-thread runtime");

            rt.block_on(async move {
                let state = AppState::default();

                // Seed the arbitrary prior tracking state for unrelated accounts.
                {
                    let mut watched = state.watched_accounts.lock().await;
                    let mut misses = state.miss_counts.lock().await;
                    let mut pids = state
                        .account_pids
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    for (id, ready_at, miss, pid) in &prior.others {
                        watched.insert(id.clone(), *ready_at);
                        misses.insert(id.clone(), *miss);
                        if let Some(p) = pid {
                            pids.insert(id.clone(), *p);
                        }
                    }
                }

                // A fixed prior launch timestamp, old enough (>> the 4s stagger)
                // that `enforce_launch_stagger` never sleeps, so we can assert it
                // is left unchanged by a failed launch.
                let prior_ts = now_ms() - 100_000;
                *state.last_launch_ts.lock().unwrap_or_else(|p| p.into_inner()) = prior_ts;

                // Snapshot the tracking state before the failing launch attempt.
                let watched_before = state.watched_accounts.lock().await.clone();
                let misses_before = state.miss_counts.lock().await.clone();
                let pids_before = state
                    .account_pids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();

                // Precondition: the target account is not tracked yet.
                prop_assert!(!watched_before.contains_key(&prior.target_id));

                let steps = ScriptedCredentialSteps { stage: stage.clone() };
                let result =
                    acquire_launch_credentials_via(&state, "cookie-value", &steps).await;

                // (a) The launch reports failure with a non-empty error message.
                let failure = match result {
                    Err(lr) => lr,
                    Ok(creds) => {
                        return Err(TestCaseError::fail(format!(
                            "expected a failure result, got success: {creds:?}"
                        )));
                    }
                };
                prop_assert!(!failure.success);
                let error = failure
                    .error
                    .as_deref()
                    .expect("a failure LaunchResult carries an error message");
                prop_assert!(!error.is_empty(), "the reported error must be non-empty");

                // The reported message is the exact text the legacy JS backend produces for
                // the stage that failed.
                let expected = match &stage {
                    FailStage::Csrf => {
                        "Failed to get CSRF token. Is the account cookie still valid?"
                            .to_string()
                    }
                    FailStage::Ticket(msg) => format!("Failed to get auth ticket: {msg}"),
                };
                prop_assert_eq!(error, expected);

                // (b) The account was never marked launched / watched: the target
                // is still absent and every tracking map + the timestamp is
                // byte-for-byte unchanged.
                let watched_after = state.watched_accounts.lock().await.clone();
                let misses_after = state.miss_counts.lock().await.clone();
                let pids_after = state
                    .account_pids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();

                prop_assert!(
                    !watched_after.contains_key(&prior.target_id),
                    "failed launch must not begin watching the target account"
                );
                prop_assert_eq!(watched_after, watched_before, "watched map mutated");
                prop_assert_eq!(misses_after, misses_before, "miss map mutated");
                prop_assert_eq!(pids_after, pids_before, "pid map mutated");
                prop_assert_eq!(
                    *state.last_launch_ts.lock().unwrap_or_else(|p| p.into_inner()),
                    prior_ts,
                    "failed launch must not update the launch timestamp"
                );

                Ok(())
            })?;
        }
    }
}

#[cfg(test)]
mod watch_grace_miss_prop_tests {
    //! Property-based test for the watch/poll close-detection state machine
    //! (Task 10.9, Property 8).
    //!
    //! Property 8 (design doc): "For any launched account and any generated
    //! sequence of poll observations (each either 'process present' or 'process
    //! absent') occurring after that account's post-launch grace period has
    //! elapsed, the watch state machine SHALL declare the account closed if and
    //! only if the sequence contains at least `MISS_THRESHOLD` (4) consecutive
    //! 'absent' observations, and any 'present' observation SHALL reset the
    //! consecutive-miss count to zero; no observation occurring before the grace
    //! period elapses SHALL count toward the miss threshold."
    //!
    //! Strategy: drive the pure [`evaluate_watch_tick`] core directly (no async
    //! runtime, no real process enumeration) over one watched account with a
    //! tracked PID. Each generated observation is turned into a Windows
    //! [`PresenceSnapshot`]: "present" → the account's tracked PID is alive (and
    //! it is the *only* alive PID, so no orphan is available to muddy the
    //! signal); "absent" → the alive set is empty (so there is no orphan to adopt
    //! and an absent observation is a genuine miss). A run of `grace_ticks`
    //! absent observations is first fed while `now < ready_at` to prove the grace
    //! window suppresses misses entirely. A reference simulation mirrors the
    //! exact reset-on-present / close-on-4th-consecutive-miss rule, and the test
    //! asserts the real state machine's per-tick close decisions, miss-reset
    //! behavior, and final closed/watched state all agree with it.

    use super::*;
    use proptest::prelude::*;

    const ID: &str = "acct-prop";
    const PID: u32 = 42;
    /// A `ready_at` far enough in the future that a chosen "pre-grace" `now`
    /// (0) is strictly before it, so grace-window ticks are skipped.
    const READY_AT: i64 = 1_000_000;
    /// A `now` strictly before `READY_AT` — used for the grace-window ticks.
    const PRE_GRACE_NOW: i64 = 0;
    /// A `now` at/after `READY_AT` — used for the evaluated (post-grace) ticks.
    const POST_GRACE_NOW: i64 = READY_AT;

    /// Snapshot for a "present" observation: the account's PID is the sole live
    /// Roblox PID (so it is detected running and there is no orphan to adopt).
    fn present_snapshot() -> PresenceSnapshot {
        PresenceSnapshot::windows(HashSet::from([PID]))
    }

    /// Snapshot for an "absent" observation: no live Roblox PID at all, so the
    /// account's tracked PID is gone and no orphan exists to adopt — a real miss.
    fn absent_snapshot() -> PresenceSnapshot {
        PresenceSnapshot::windows(HashSet::new())
    }

    /// One tracked account, already seeded past its grace window's miss state
    /// (miss count 0), with `ready_at = READY_AT` so the caller controls whether
    /// a given `now` falls inside or outside the grace window.
    fn seed_maps() -> (
        HashMap<String, i64>,
        HashMap<String, u32>,
        HashMap<String, u32>,
    ) {
        let mut watched = HashMap::new();
        watched.insert(ID.to_string(), READY_AT);
        let mut misses = HashMap::new();
        misses.insert(ID.to_string(), 0u32);
        let mut pids = HashMap::new();
        pids.insert(ID.to_string(), PID);
        (watched, misses, pids)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // Feature: native-tauri-backend, Property 8: Watch/poll close-detection respects the grace period and miss threshold
        //
        // **Validates: Requirements 2.7, 7.2, 7.3**
        //
        // For an account launched and armed with a post-launch grace window, and
        // any sequence of post-grace poll observations (`true` = present,
        // `false` = absent), `evaluate_watch_tick`:
        //   * counts no miss for any observation taken before the grace window
        //     elapses (`now < ready_at`);
        //   * resets the consecutive-miss count to zero on every present
        //     observation;
        //   * declares the account closed exactly on the 4th (`MISS_THRESHOLD`)
        //     consecutive post-grace absent observation, i.e. closed overall iff
        //     the post-grace sequence contains a run of >= MISS_THRESHOLD
        //     consecutive absent observations.
        #[test]
        fn watch_state_machine_respects_grace_and_miss_threshold(
            grace_ticks in 0usize..6,
            observations in proptest::collection::vec(any::<bool>(), 0..40),
        ) {
            let (mut watched, mut misses, mut pids) = seed_maps();

            // ── Grace window: absent observations here must NOT accrue misses. ──
            for _ in 0..grace_ticks {
                let outcome = evaluate_watch_tick(
                    &mut watched,
                    &mut misses,
                    &mut pids,
                    &absent_snapshot(),
                    PRE_GRACE_NOW,
                );
                prop_assert!(
                    outcome.closed.is_empty(),
                    "no account may close during the grace window"
                );
                prop_assert_eq!(
                    misses.get(ID).copied(),
                    Some(0),
                    "no miss may accrue during the grace window"
                );
                prop_assert!(
                    watched.contains_key(ID),
                    "the account must remain watched during the grace window"
                );
            }

            // ── Post-grace: evaluate the generated observation sequence. ──
            // Reference model mirroring evaluate_watch_tick's reset-on-present /
            // close-on-4th-consecutive-miss rule.
            let mut ref_miss = 0u32;
            let mut ref_closed = false;

            for &present in &observations {
                let snapshot = if present {
                    present_snapshot()
                } else {
                    absent_snapshot()
                };

                // Expected close decision for THIS tick, per the reference model.
                // Once closed, the account is retired from the maps, so no
                // further tick can (re)close it.
                let expect_close_this_tick = if ref_closed {
                    false
                } else if present {
                    ref_miss = 0;
                    false
                } else {
                    ref_miss += 1;
                    if ref_miss >= MISS_THRESHOLD {
                        ref_closed = true;
                        true
                    } else {
                        false
                    }
                };

                let outcome = evaluate_watch_tick(
                    &mut watched,
                    &mut misses,
                    &mut pids,
                    &snapshot,
                    POST_GRACE_NOW,
                );

                let closed_this_tick: Vec<&str> =
                    outcome.closed.iter().map(|c| c.account_id.as_str()).collect();

                if expect_close_this_tick {
                    prop_assert_eq!(
                        closed_this_tick.as_slice(),
                        &[ID],
                        "account must be declared closed exactly on the 4th consecutive miss"
                    );
                    // A closed account is retired from all three tracking maps.
                    prop_assert!(!watched.contains_key(ID));
                    prop_assert!(!misses.contains_key(ID));
                    prop_assert!(!pids.contains_key(ID));
                } else {
                    prop_assert!(
                        closed_this_tick.is_empty(),
                        "no account may be declared closed on this tick"
                    );
                }

                // While still watched, a present observation must have reset the
                // miss count to zero, and an absent one must reflect the running
                // consecutive-miss tally.
                if !ref_closed {
                    prop_assert_eq!(
                        misses.get(ID).copied(),
                        Some(ref_miss),
                        "the tracked miss count must match the reference tally"
                    );
                }
            }

            // ── Final state: closed IFF a run of >= MISS_THRESHOLD absents. ──
            let expected_closed = {
                let mut run = 0u32;
                let mut hit = false;
                for &present in &observations {
                    if present {
                        run = 0;
                    } else {
                        run += 1;
                        if run >= MISS_THRESHOLD {
                            hit = true;
                            break;
                        }
                    }
                }
                hit
            };

            prop_assert_eq!(
                ref_closed,
                expected_closed,
                "reference model and run-length characterization must agree"
            );
            prop_assert_eq!(
                !watched.contains_key(ID),
                expected_closed,
                "account is retired from the watched set iff it was declared closed"
            );
        }
    }
}

#[cfg(test)]
mod kill_tests {
    //! Unit tests for the Task 10.4 process-enumeration / termination + kill
    //! paths. The kill functions ([`kill_one`] / [`kill_all`]) themselves spawn
    //! real `taskkill` processes on Windows (which would target any live Roblox
    //! on the developer's machine), so these tests exercise the *pure* pieces:
    //! the `tasklist`-output parsers, the exact command strings, and the
    //! tracking-map bookkeeping ([`untrack_account`] / [`untrack_all`]) that
    //! encodes the "only the targeted account(s) are affected" behavior
    //! (Requirement 2.5, 2.6).

    use super::*;
    use std::sync::Mutex as StdMutex;

    // ── Command-string parity with the legacy JS build (Requirement 8.3) ─────

    #[test]
    fn command_strings_match_main_js() {
        assert_eq!(
            TASKLIST_ENUM_CMD,
            r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /FO CSV /NH"#
        );
        assert_eq!(
            TASKLIST_COUNT_CMD,
            r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH"#
        );
        assert_eq!(
            TASKLIST_PRESENCE_CMD,
            r#"tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH & tasklist /FI "IMAGENAME eq RobloxCrashHandler.exe" /NH"#
        );
        assert_eq!(
            TASKKILL_ALL_CMD,
            "taskkill /F /IM RobloxPlayerBeta.exe /T & taskkill /F /IM RobloxCrashHandler.exe /T"
        );
        assert_eq!(taskkill_pid_cmd(1234), "taskkill /F /PID 1234 /T");
    }

    // ── tasklist CSV PID enumeration (mirrors _watchTick's regex) ───────────

    #[test]
    fn parse_tasklist_csv_pids_extracts_every_pid() {
        // Real-shape `tasklist ... /FO CSV /NH` rows.
        let out = "\"RobloxPlayerBeta.exe\",\"1234\",\"Console\",\"1\",\"512,000 K\"\r\n\
                   \"RobloxPlayerBeta.exe\",\"5678\",\"Console\",\"1\",\"498,000 K\"\r\n";
        let pids = parse_tasklist_csv_pids(out);
        assert_eq!(pids, HashSet::from([1234, 5678]));
    }

    #[test]
    fn parse_tasklist_csv_pids_is_case_insensitive_on_image_name() {
        // The regex carries the `i` flag, so a differently-cased image name still
        // matches.
        let out = "\"ROBLOXPLAYERBETA.EXE\",\"42\",\"Console\",\"1\",\"1,000 K\"";
        assert_eq!(parse_tasklist_csv_pids(out), HashSet::from([42]));
    }

    #[test]
    fn parse_tasklist_csv_pids_ignores_non_matching_and_empty_output() {
        // The "no tasks" banner tasklist prints when nothing matches.
        let banner = "INFO: No tasks are running which match the specified criteria.";
        assert!(parse_tasklist_csv_pids(banner).is_empty());
        assert!(parse_tasklist_csv_pids("").is_empty());
        // A crash-handler row must not be mistaken for a player row.
        let other = "\"RobloxCrashHandler.exe\",\"99\",\"Console\",\"1\",\"3,000 K\"";
        assert!(parse_tasklist_csv_pids(other).is_empty());
    }

    #[test]
    fn parse_tasklist_csv_pids_requires_trailing_quote() {
        // `(\d+)"` requires the digit run to be closed by a quote; a malformed
        // cell without it does not match.
        let malformed = "\"RobloxPlayerBeta.exe\",\"12ab\"";
        assert!(parse_tasklist_csv_pids(malformed).is_empty());
    }

    // ── presence / count parsing (mirrors the legacy JS backend's regexes) ────────────────

    #[test]
    fn tasklist_reports_roblox_running_detects_either_process() {
        let player = "\"RobloxPlayerBeta.exe\",\"1\",\"Console\",\"1\",\"1 K\"";
        let crash = "\"RobloxCrashHandler.exe\",\"2\",\"Console\",\"1\",\"1 K\"";
        assert!(tasklist_reports_roblox_running(player));
        assert!(tasklist_reports_roblox_running(crash));
        assert!(!tasklist_reports_roblox_running(
            "INFO: No tasks are running which match the specified criteria."
        ));
    }

    #[test]
    fn count_roblox_processes_in_output_counts_player_rows() {
        let out = "\"RobloxPlayerBeta.exe\",\"1\"\r\n\"RobloxPlayerBeta.exe\",\"2\"\r\n";
        assert_eq!(count_roblox_processes_in_output(out), 2);
        assert_eq!(count_roblox_processes_in_output(""), 0);
    }

    // ── tracking-map bookkeeping: only the targeted account is touched ──────

    #[tokio::test]
    async fn untrack_account_removes_only_the_target_and_returns_its_pid() {
        let state = AppState::default();
        {
            let mut watched = state.watched_accounts.lock().await;
            watched.insert("target".into(), 111);
            watched.insert("other".into(), 222);
        }
        {
            let mut misses = state.miss_counts.lock().await;
            misses.insert("target".into(), 2);
            misses.insert("other".into(), 3);
        }
        {
            let mut pids = state.account_pids.lock().unwrap();
            pids.insert("target".into(), 4242);
            pids.insert("other".into(), 9999);
        }

        let pid = untrack_account(&state, "target").await;
        assert_eq!(pid, Some(4242), "returns the target's tracked pid");

        // Target gone from every map; the other account is completely untouched.
        assert!(!state.watched_accounts.lock().await.contains_key("target"));
        assert!(!state.miss_counts.lock().await.contains_key("target"));
        assert!(!state.account_pids.lock().unwrap().contains_key("target"));

        assert_eq!(state.watched_accounts.lock().await.get("other").copied(), Some(222));
        assert_eq!(state.miss_counts.lock().await.get("other").copied(), Some(3));
        assert_eq!(state.account_pids.lock().unwrap().get("other").copied(), Some(9999));
    }

    #[tokio::test]
    async fn untrack_account_on_untracked_id_is_a_noop_returning_none() {
        let state = AppState::default();
        state.watched_accounts.lock().await.insert("other".into(), 222);
        state.miss_counts.lock().await.insert("other".into(), 3);
        state.account_pids.lock().unwrap().insert("other".into(), 9999);

        let pid = untrack_account(&state, "ghost").await;
        assert_eq!(pid, None, "no pid for an untracked identifier");

        // Nothing else changed: the unrelated account survives intact.
        assert_eq!(state.watched_accounts.lock().await.get("other").copied(), Some(222));
        assert_eq!(state.miss_counts.lock().await.get("other").copied(), Some(3));
        assert_eq!(state.account_pids.lock().unwrap().get("other").copied(), Some(9999));
    }

    #[tokio::test]
    async fn untrack_all_clears_every_map_and_returns_watched_ids() {
        let state = AppState::default();
        {
            let mut watched = state.watched_accounts.lock().await;
            watched.insert("a".into(), 1);
            watched.insert("b".into(), 2);
        }
        state.miss_counts.lock().await.insert("a".into(), 1);
        state.account_pids.lock().unwrap().insert("a".into(), 10);
        state.account_pids.lock().unwrap().insert("b".into(), 20);

        let mut ids = untrack_all(&state).await;
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        assert!(state.watched_accounts.lock().await.is_empty());
        assert!(state.miss_counts.lock().await.is_empty());
        assert!(state.account_pids.lock().unwrap().is_empty());
    }

    // ── KillResult serialization parity with the legacy JS backend's { ok, error? } ───────

    #[test]
    fn kill_result_serializes_like_main_js() {
        let ok = serde_json::to_string(&KillResult::ok()).unwrap();
        assert_eq!(ok, r#"{"ok":true}"#);
        let err = serde_json::to_string(&KillResult::fail("boom")).unwrap();
        assert_eq!(err, r#"{"ok":false,"error":"boom"}"#);
    }

    // ── kill_one / kill_all notification + result behavior (no real taskkill) ─
    //
    // These drive the real `kill_one` / `kill_all` but only for cases that never
    // reach `taskkill`: an untracked `kill_one` (no PID → no-op) and an empty
    // `kill_all` on non-Windows targets. On Windows a tracked kill would spawn a
    // real `taskkill`, so that path is left to the integration/command layer.

    /// A recording [`WatchNotifier`] capturing closed ids and whether
    /// `all-closed` fired.
    #[derive(Default)]
    struct RecordingNotifier {
        closed: StdMutex<Vec<String>>,
        all_closed: StdMutex<bool>,
    }
    impl WatchNotifier for RecordingNotifier {
        fn notify_closed(&self, account_id: &str) {
            self.closed.lock().unwrap().push(account_id.to_string());
        }
        fn notify_count(&self, _count: usize) {}
        fn notify_all_closed(&self) {
            *self.all_closed.lock().unwrap() = true;
        }
    }

    #[tokio::test]
    async fn kill_one_untracked_is_noop_and_leaves_other_accounts_running() {
        let state = AppState::default();
        // A different account is tracked and must survive untouched.
        state.watched_accounts.lock().await.insert("other".into(), 222);
        state.account_pids.lock().unwrap().insert("other".into(), 9999);
        let notifier = RecordingNotifier::default();

        let result = kill_one(&state, &notifier, "ghost").await;

        // No tracked process → no-op result; only the target's own dot was reset.
        if cfg!(windows) {
            assert_eq!(result, KillResult::fail("No tracked process for this account"));
        } else {
            assert_eq!(result, KillResult::fail("Windows only"));
        }
        assert_eq!(notifier.closed.lock().unwrap().as_slice(), &["ghost".to_string()]);

        // The unrelated running account is entirely unaffected (Requirement 2.6).
        assert_eq!(state.watched_accounts.lock().await.get("other").copied(), Some(222));
        assert_eq!(state.account_pids.lock().unwrap().get("other").copied(), Some(9999));
    }

    #[tokio::test]
    async fn kill_all_clears_tracking_and_notifies_every_watched_account() {
        let state = AppState::default();
        {
            let mut watched = state.watched_accounts.lock().await;
            watched.insert("a".into(), 1);
            watched.insert("b".into(), 2);
        }
        state.account_pids.lock().unwrap().insert("a".into(), 10);
        state.account_pids.lock().unwrap().insert("b".into(), 20);
        let notifier = RecordingNotifier::default();

        // On non-Windows this returns before any taskkill and exercises the full
        // notification path; on Windows it would spawn a real taskkill, so only
        // run the assertions off Windows to keep the test side-effect-free.
        if !cfg!(windows) {
            let result = kill_all(&state, &notifier, &NoopMutexRefresh).await;
            assert_eq!(result, KillResult::fail("Windows only"));

            // Every tracking map is cleared and every watched account + all-closed
            // was notified.
            assert!(state.watched_accounts.lock().await.is_empty());
            assert!(state.miss_counts.lock().await.is_empty());
            assert!(state.account_pids.lock().unwrap().is_empty());
            let mut closed = notifier.closed.lock().unwrap().clone();
            closed.sort();
            assert_eq!(closed, vec!["a".to_string(), "b".to_string()]);
            assert!(*notifier.all_closed.lock().unwrap());
        } else {
            // On Windows just verify the bookkeeping helper the kill path uses
            // clears state without spawning taskkill.
            let ids = untrack_all(&state).await;
            assert_eq!(ids.len(), 2);
            assert!(state.watched_accounts.lock().await.is_empty());
        }
    }
}

#[cfg(test)]
mod kill_targeting_prop_tests {
    //! Property-based test for the kill paths' targeting guarantee (Task 10.8,
    //! Property 7).
    //!
    //! Property 7 (design doc): "For any set of accounts currently tracked as
    //! running, requesting to kill one specific tracked account SHALL remove
    //! exactly that account from the tracked set and SHALL leave every other
    //! tracked account's entry unchanged; requesting to kill all SHALL clear the
    //! entire tracked set; and requesting to kill an account identifier that is
    //! not in the tracked set SHALL leave the tracked set completely unchanged."
    //!
    //! Strategy: drive the *pure* map-bookkeeping helpers the kill paths run —
    //! [`untrack_account`] (the body of `kill_one`) and [`untrack_all`] (the body
    //! of `kill_all`) — directly, so no real `taskkill` process is ever spawned.
    //! For an arbitrary set of tracked accounts (each with a `ready_at`, a miss
    //! count, and a tracked PID across the three tracking maps) we exercise a
    //! `kill_one` against either a tracked account or an untracked ("ghost")
    //! identifier, and a `kill_all` over the whole set, asserting the exact
    //! removal / no-op / clear behavior Requirements 2.5 and 2.6 require.

    use super::*;
    use proptest::prelude::*;
    use proptest::sample::Index;

    /// One tracked account: `(id, ready_at, miss_count, pid)`. Ids use an
    /// `acct-` prefix so they can never collide with the `ghost-` untracked
    /// identifier used to exercise the no-op branch.
    type TrackedAccount = (String, i64, u32, u32);

    /// A ghost identifier guaranteed absent from any generated account set (the
    /// account generator only ever produces `acct-`-prefixed ids).
    const GHOST_ID: &str = "ghost-not-tracked";

    /// Generate an arbitrary set of tracked accounts with unique ids. Duplicate
    /// ids from the raw vector are dropped (first occurrence wins) so each id
    /// maps to a single tracked entry, mirroring the real tracking maps.
    fn tracked_accounts() -> impl Strategy<Value = Vec<TrackedAccount>> {
        proptest::collection::vec(
            (
                "acct-[a-z0-9]{1,8}",
                0i64..1_000_000i64,
                0u32..10u32,
                1u32..60_000u32,
            ),
            0..8,
        )
        .prop_map(|raw| {
            let mut seen = HashSet::new();
            raw.into_iter()
                .filter(|(id, _, _, _)| seen.insert(id.clone()))
                .collect()
        })
    }

    /// Seed all three tracking maps with the given accounts.
    async fn seed(state: &AppState, accounts: &[TrackedAccount]) {
        let mut watched = state.watched_accounts.lock().await;
        let mut misses = state.miss_counts.lock().await;
        let mut pids = state
            .account_pids
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        for (id, ready_at, miss, pid) in accounts {
            watched.insert(id.clone(), *ready_at);
            misses.insert(id.clone(), *miss);
            pids.insert(id.clone(), *pid);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // Feature: native-tauri-backend, Property 7: Kill operations only affect their targeted tracked account(s)
        //
        // **Validates: Requirements 2.5, 2.6**
        //
        // For any set of tracked accounts: killing one tracked account removes
        // exactly that account from every tracking map (returning its tracked
        // PID) and leaves every other account's entry byte-for-byte unchanged;
        // killing an untracked identifier is a no-op that affects no account;
        // and killing all clears exactly the tracked set (returning exactly the
        // watched ids).
        #[test]
        fn kill_only_affects_targeted_tracked_accounts(
            accounts in tracked_accounts(),
            target_is_ghost in any::<bool>(),
            idx in any::<Index>(),
        ) {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build current-thread runtime");

            rt.block_on(async move {
                let len = accounts.len();

                // Choose the kill_one target: an untracked ghost id (also forced
                // when there are no accounts to pick from), or one of the tracked
                // accounts selected by the arbitrary index.
                let target = if target_is_ghost || len == 0 {
                    GHOST_ID.to_string()
                } else {
                    accounts[idx.index(len)].0.clone()
                };
                let target_was_tracked =
                    accounts.iter().any(|(id, _, _, _)| id == &target);

                // ── kill_one path (drives untrack_account, no taskkill) ──
                let state = AppState::default();
                seed(&state, &accounts).await;

                let watched_before = state.watched_accounts.lock().await.clone();
                let misses_before = state.miss_counts.lock().await.clone();
                let pids_before = state
                    .account_pids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();

                let returned = untrack_account(&state, &target).await;

                let watched_after = state.watched_accounts.lock().await.clone();
                let misses_after = state.miss_counts.lock().await.clone();
                let pids_after = state
                    .account_pids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();

                if target_was_tracked {
                    // Returns exactly the target's tracked PID.
                    let expected_pid = accounts
                        .iter()
                        .find(|(id, _, _, _)| id == &target)
                        .map(|(_, _, _, pid)| *pid)
                        .expect("target is tracked");
                    prop_assert_eq!(returned, Some(expected_pid));

                    // The target is gone from every tracking map.
                    prop_assert!(!watched_after.contains_key(&target));
                    prop_assert!(!misses_after.contains_key(&target));
                    prop_assert!(!pids_after.contains_key(&target));

                    // Exactly one entry removed from each map.
                    prop_assert_eq!(watched_after.len(), watched_before.len() - 1);
                    prop_assert_eq!(misses_after.len(), misses_before.len() - 1);
                    prop_assert_eq!(pids_after.len(), pids_before.len() - 1);

                    // Every other account is left completely unchanged.
                    for (id, ready_at, miss, pid) in &accounts {
                        if id == &target {
                            continue;
                        }
                        prop_assert_eq!(watched_after.get(id).copied(), Some(*ready_at));
                        prop_assert_eq!(misses_after.get(id).copied(), Some(*miss));
                        prop_assert_eq!(pids_after.get(id).copied(), Some(*pid));
                    }
                } else {
                    // Untracked identifier → no-op affecting no account.
                    prop_assert_eq!(returned, None);
                    prop_assert_eq!(&watched_after, &watched_before);
                    prop_assert_eq!(&misses_after, &misses_before);
                    prop_assert_eq!(&pids_after, &pids_before);
                }

                // ── kill_all path (drives untrack_all, no taskkill) ──
                let state_all = AppState::default();
                seed(&state_all, &accounts).await;

                let expected_ids: HashSet<String> =
                    accounts.iter().map(|(id, _, _, _)| id.clone()).collect();
                let returned_ids: HashSet<String> =
                    untrack_all(&state_all).await.into_iter().collect();

                // kill_all clears exactly the tracked set: the returned watched
                // ids equal the seeded set, and every map is now empty.
                prop_assert_eq!(returned_ids, expected_ids);
                prop_assert!(state_all.watched_accounts.lock().await.is_empty());
                prop_assert!(state_all.miss_counts.lock().await.is_empty());
                prop_assert!(state_all
                    .account_pids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_empty());

                Ok(())
            })?;
        }
    }
}
