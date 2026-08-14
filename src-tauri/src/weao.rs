//! WEAO (whatexpsare.online) client — Roblox version tracker and executor status.
//!
//! The renderer cannot call this API itself for two independent reasons: every
//! endpoint rejects requests that do not carry `User-Agent: WEAO-3PService`, and
//! `User-Agent` is a forbidden header that the browser `fetch` silently drops.
//! The webview CSP also does not list the host. So the calls live here, behind
//! two narrow commands rather than a generic `weao_get(path)` — with the URL as
//! a compile-time constant there is no request-forgery surface at all.
//!
//! Responses are cached in `AppState::weao_cache`, which is declared as
//! `Arc<AsyncMutex<HashMap<String, weao::CachedResponse>>>` and initialized to
//! an empty map in `impl Default for AppState`.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::roblox_api::send_retrying;
use crate::AppState;

/// The exact `User-Agent` WEAO requires. Anything else is rejected.
const WEAO_UA: &str = "WEAO-3PService";

/// Primary host. `whatexpsare.online` and `weao.gg` serve the same API, but the
/// commands stay pinned to one so the URL is never assembled from input.
const WEAO_BASE: &str = "https://weao.xyz";
const VERSIONS_CURRENT_PATH: &str = "/api/versions/current";
const VERSIONS_FUTURE_PATH: &str = "/api/versions/future";
const EXPLOITS_PATH: &str = "/api/status/exploits";

/// Cache keys. Versions are cached as a single entry because the two version
/// endpoints are always fetched and served together.
const VERSIONS_KEY: &str = "versions";
const EXPLOITS_KEY: &str = "exploits";

/// Matches the `Cache-Control: max-age=14400` WEAO sends on the version
/// endpoints — refetching sooner only re-reads their own CDN cache.
const VERSIONS_TTL_MS: i64 = 4 * 60 * 60 * 1000;

/// Executor status turns over much faster than versions do: an executor flips to
/// "not updated" within minutes of a Roblox client update.
const EXPLOITS_TTL_MS: i64 = 30 * 60 * 1000;

/// Minimum spacing between two network attempts for the same key, so the UI's
/// Refresh button cannot be held down as a hammer against the API.
const FORCE_REFRESH_FLOOR_MS: i64 = 60_000;

/// Ceiling on the wait a 429 body can ask for. The unit of `remainingTime` is
/// undocumented, so a cap keeps a wrong guess from disabling Refresh for hours.
const MAX_RETRY_AFTER_MS: u64 = 5 * 60 * 1000;

/// One cached WEAO response.
///
/// `fetched_at` is when the value was last successfully retrieved, while
/// `last_attempt_at` also advances on failures — the refresh floor has to count
/// attempts, not successes, or a failing endpoint would be retried in a tight
/// loop for as long as the user keeps pressing Refresh.
#[derive(Debug, Clone)]
pub struct CachedResponse {
    pub value: Value,
    pub fetched_at: i64,
    pub last_attempt_at: i64,
}

/// A WEAO response plus the metadata the UI needs to describe it.
///
/// `data` is the raw `serde_json::Value` on purpose. The live schema already
/// contradicts WEAO's own documentation — the field is `extype`, not `type`, and
/// the `aexecutor`/`iexecutor` values are not documented at all — so a Rust
/// struct would go stale and every drift would cost a recompile. Passing the
/// body through untouched moves that problem into a defensive normalizer in the
/// frontend, which is hot-reloadable. Same reasoning that made `Settings` carry
/// a `#[serde(flatten)] extra` catch-all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaoPayload {
    pub data: Value,
    pub fetched_at: i64,
    pub from_cache: bool,
    /// Stable identifier (`refresh_throttled`, `rate_limited`, `request_failed`)
    /// for why this is cached rather than freshly fetched, `None` when the value
    /// is current. Not prose: the frontend runs it through `t()`.
    pub stale_reason: Option<String>,
    /// How long the UI should wait before offering Refresh again, when known.
    pub retry_after_ms: Option<u64>,
}

/// Why a fetch failed, kept richer than a plain string so a 429 can carry the
/// server's own wait hint all the way back to the UI.
struct FetchError {
    reason: &'static str,
    message: String,
    retry_after_ms: Option<u64>,
}

impl FetchError {
    fn request_failed(message: impl Into<String>) -> Self {
        Self { reason: "request_failed", message: message.into(), retry_after_ms: None }
    }
}

/// What to do with the cache entry for an incoming request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheAction {
    /// Serve the cached value: it is still inside its TTL.
    ServeFresh,
    /// Serve the cached value even though a refresh was wanted: the previous
    /// network attempt is younger than [`FORCE_REFRESH_FLOOR_MS`].
    ServeThrottled,
    /// Go to the network.
    Refresh,
}

/// Current wall-clock time in epoch milliseconds. A clock before the Unix epoch
/// (not reachable on a sane system) is clamped to 0.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Decide how to answer a request, given what is cached. Kept pure so the TTL
/// boundaries and the refresh floor are testable without touching the network.
fn decide_cache_action(
    entry: Option<&CachedResponse>,
    now: i64,
    ttl_ms: i64,
    force: bool,
) -> CacheAction {
    let Some(entry) = entry else {
        return CacheAction::Refresh;
    };
    if !force && now.saturating_sub(entry.fetched_at) < ttl_ms {
        return CacheAction::ServeFresh;
    }
    if now.saturating_sub(entry.last_attempt_at) < FORCE_REFRESH_FLOOR_MS {
        return CacheAction::ServeThrottled;
    }
    CacheAction::Refresh
}

/// Extract the wait hint WEAO puts in the body of a 429.
///
/// The response headers advertise the quota (`x-ratelimit-limit`), not the wait;
/// only `rateLimitInfo.remainingTime` in the body says when to come back. The
/// field is undocumented, so both the numeric and the string spelling are
/// accepted, and the result is capped by [`MAX_RETRY_AFTER_MS`].
fn parse_rate_limit_ms(body: &str) -> Option<u64> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let remaining = parsed.get("rateLimitInfo")?.get("remainingTime")?;
    let seconds = match remaining {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some(((seconds * 1000.0).round() as u64).min(MAX_RETRY_AFTER_MS))
}

/// The shared WEAO HTTP client.
///
/// Its own client rather than the Roblox one, because these calls need a
/// different `User-Agent` and their own timeouts. `OnceLock` (not `LazyLock`,
/// which needs Rust 1.80 while this crate declares 1.77.2) caches only the `Ok`
/// — caching a `Result` would let one transient builder failure poison the
/// process for its whole lifetime.
fn weao_client() -> Result<reqwest::Client, String> {
    static WEAO_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(existing) = WEAO_CLIENT.get() {
        return Ok(existing.clone());
    }
    let built = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to build the WEAO HTTP client: {error}"))?;
    Ok(WEAO_CLIENT.get_or_init(|| built).clone())
}

/// `GET {WEAO_BASE}{path}`, parsed as raw JSON.
///
/// 429s are retried by [`send_retrying`] first; one that survives every retry
/// reaches here and is reported with the body's own wait hint.
async fn get_json(client: &reqwest::Client, path: &str) -> Result<Value, FetchError> {
    let request = client
        .get(format!("{WEAO_BASE}{path}"))
        .header("User-Agent", WEAO_UA)
        .header("Accept", "application/json");
    let response = send_retrying(request)
        .await
        .map_err(|error| FetchError::request_failed(format!("WEAO {path}: {error}")))?;
    let status = response.status().as_u16();
    // reqwest is built without the `json` feature, so read the body as text and
    // hand it to serde_json — the same shape every other API call here uses.
    let body = response
        .text()
        .await
        .map_err(|error| FetchError::request_failed(format!("WEAO {path}: read failed: {error}")))?;
    if status == 429 {
        return Err(FetchError {
            reason: "rate_limited",
            message: format!("WEAO {path}: rate limited"),
            retry_after_ms: parse_rate_limit_ms(&body),
        });
    }
    if status != 200 {
        return Err(FetchError::request_failed(format!("WEAO {path}: status {status}")));
    }
    serde_json::from_str(&body)
        .map_err(|error| FetchError::request_failed(format!("WEAO {path}: parse failed: {error}")))
}

/// Serve `key` from the cache when that is allowed, otherwise run `fetch` and
/// store the result.
///
/// LOCK DISCIPLINE: the cache guard is taken, the entry cloned, and the guard
/// dropped *before* any `await` on HTTP; it is reacquired only to write the
/// result back. Holding it across the await would serialize the two version
/// requests that `weao_versions` deliberately runs concurrently.
async fn serve_cached<F, Fut>(
    state: &State<'_, AppState>,
    key: &str,
    ttl_ms: i64,
    force: bool,
    fetch: F,
) -> Result<WeaoPayload, String>
where
    F: FnOnce(reqwest::Client) -> Fut,
    Fut: std::future::Future<Output = Result<Value, FetchError>>,
{
    let now = now_ms();
    let cached = {
        let cache = state.weao_cache.lock().await;
        cache.get(key).cloned()
    };

    match decide_cache_action(cached.as_ref(), now, ttl_ms, force) {
        CacheAction::ServeFresh => {
            let entry = cached.expect("ServeFresh is only reachable with a cache entry");
            return Ok(WeaoPayload {
                data: entry.value,
                fetched_at: entry.fetched_at,
                from_cache: true,
                stale_reason: None,
                retry_after_ms: None,
            });
        }
        CacheAction::ServeThrottled => {
            let entry = cached.expect("ServeThrottled is only reachable with a cache entry");
            let waited = now.saturating_sub(entry.last_attempt_at).max(0) as u64;
            return Ok(WeaoPayload {
                data: entry.value,
                fetched_at: entry.fetched_at,
                from_cache: true,
                stale_reason: Some("refresh_throttled".to_string()),
                retry_after_ms: Some((FORCE_REFRESH_FLOOR_MS as u64).saturating_sub(waited)),
            });
        }
        CacheAction::Refresh => {}
    }

    let outcome = match weao_client() {
        Ok(client) => fetch(client).await,
        Err(error) => Err(FetchError::request_failed(error)),
    };

    let now = now_ms();
    match outcome {
        Ok(value) => {
            let mut cache = state.weao_cache.lock().await;
            cache.insert(
                key.to_string(),
                CachedResponse { value: value.clone(), fetched_at: now, last_attempt_at: now },
            );
            Ok(WeaoPayload {
                data: value,
                fetched_at: now,
                from_cache: false,
                stale_reason: None,
                retry_after_ms: None,
            })
        }
        // A failed fetch is only an error when there is nothing at all to show;
        // with anything cached the UI gets the stale copy plus the reason, which
        // beats blanking a page that was populated a moment ago.
        Err(error) => {
            let mut cache = state.weao_cache.lock().await;
            if let Some(entry) = cache.get_mut(key) {
                entry.last_attempt_at = now;
                return Ok(WeaoPayload {
                    data: entry.value.clone(),
                    fetched_at: entry.fetched_at,
                    from_cache: true,
                    stale_reason: Some(error.reason.to_string()),
                    retry_after_ms: error.retry_after_ms,
                });
            }
            Err(error.message)
        }
    }
}

/// Current and upcoming Roblox client versions per platform.
///
/// Returns `{ "current": ..., "future": ... }`. The two endpoints are fetched
/// concurrently: they are independent, and `/future` is the slower of the pair.
#[tauri::command]
pub async fn weao_versions(
    state: State<'_, AppState>,
    force: bool,
) -> Result<WeaoPayload, String> {
    serve_cached(&state, VERSIONS_KEY, VERSIONS_TTL_MS, force, |client| async move {
        let (current, future) = tokio::try_join!(
            get_json(&client, VERSIONS_CURRENT_PATH),
            get_json(&client, VERSIONS_FUTURE_PATH),
        )?;
        Ok(serde_json::json!({ "current": current, "future": future }))
    })
    .await
}

/// The executor catalog with each entry's update status.
#[tauri::command]
pub async fn weao_exploits(
    state: State<'_, AppState>,
    force: bool,
) -> Result<WeaoPayload, String> {
    serve_cached(&state, EXPLOITS_KEY, EXPLOITS_TTL_MS, force, |client| async move {
        get_json(&client, EXPLOITS_PATH).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(fetched_at: i64, last_attempt_at: i64) -> CachedResponse {
        CachedResponse { value: Value::Null, fetched_at, last_attempt_at }
    }

    #[test]
    fn cache_stays_fresh_up_to_but_not_including_the_ttl() {
        let now = 9_000_000i64;
        let ttl = EXPLOITS_TTL_MS;

        let almost_expired = entry(now - ttl + 1, now - ttl + 1);
        assert_eq!(
            decide_cache_action(Some(&almost_expired), now, ttl, false),
            CacheAction::ServeFresh
        );

        // Exactly at the TTL the entry is expired. Both TTLs are far larger than
        // the refresh floor, so `last_attempt_at` here is already past the floor
        // and cannot mask the TTL result.
        let expired = entry(now - ttl, now - ttl);
        assert_eq!(decide_cache_action(Some(&expired), now, ttl, false), CacheAction::Refresh);
    }

    #[test]
    fn a_forced_refresh_ignores_a_still_fresh_ttl() {
        let now = 9_000_000i64;
        let fresh = entry(now - 1, now - FORCE_REFRESH_FLOOR_MS);
        assert_eq!(
            decide_cache_action(Some(&fresh), now, VERSIONS_TTL_MS, true),
            CacheAction::Refresh
        );
    }

    #[test]
    fn the_refresh_floor_holds_until_it_elapses() {
        let now = 9_000_000i64;
        // Long past its TTL, so only the floor can be what holds the refresh back.
        let stale_at = now - VERSIONS_TTL_MS * 2;

        let just_attempted = entry(stale_at, now - FORCE_REFRESH_FLOOR_MS + 1);
        assert_eq!(
            decide_cache_action(Some(&just_attempted), now, VERSIONS_TTL_MS, true),
            CacheAction::ServeThrottled
        );

        let floor_elapsed = entry(stale_at, now - FORCE_REFRESH_FLOOR_MS);
        assert_eq!(
            decide_cache_action(Some(&floor_elapsed), now, VERSIONS_TTL_MS, true),
            CacheAction::Refresh
        );
    }

    #[test]
    fn a_cold_cache_always_goes_to_the_network() {
        assert_eq!(decide_cache_action(None, 0, VERSIONS_TTL_MS, false), CacheAction::Refresh);
        assert_eq!(decide_cache_action(None, 0, VERSIONS_TTL_MS, true), CacheAction::Refresh);
    }

    #[test]
    fn reads_the_wait_hint_out_of_a_429_body() {
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":42}}"#), Some(42_000));
        // The field is undocumented, so neither the fractional nor the string
        // spelling can be ruled out.
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":1.5}}"#), Some(1_500));
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":"30"}}"#), Some(30_000));
    }

    #[test]
    fn a_429_wait_hint_is_capped_and_nonsense_is_rejected() {
        assert_eq!(
            parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":99999}}"#),
            Some(MAX_RETRY_AFTER_MS)
        );
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":0}}"#), None);
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":-5}}"#), None);
        assert_eq!(parse_rate_limit_ms(r#"{"rateLimitInfo":{"remainingTime":null}}"#), None);
        assert_eq!(parse_rate_limit_ms(r#"{"message":"Too many requests"}"#), None);
        assert_eq!(parse_rate_limit_ms("not json at all"), None);
    }
}
