//! Roblox HTTPS API calls, ported from the legacy JS backend's Roblox networking section.
//!
//! This module is a behavioral port of the Node.js functions that talk to
//! Roblox's public HTTPS endpoints. The legacy JS build used a mix of legacy JS runtime's
//! `net.request` and Node's `https` module; here every call goes through
//! `reqwest`, but the endpoints, headers, request bodies, response parsing, and
//! error handling are reproduced 1:1 so behavior is unchanged (Requirement 2.1).
//!
//! Ported functions (legacy JS runtime -> Rust):
//!
//! | the legacy JS backend            | Rust                          | Endpoint                                                            |
//! |----------------------|-------------------------------|--------------------------------------------------------------------|
//! | `getRobloxVersion`   | [`get_roblox_version`]        | `GET clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer` |
//! | `fetchUserInfo`      | [`fetch_user_info`]           | `GET users.roblox.com/v1/users/authenticated`                      |
//! | `getGameName`        | [`get_game_name`]             | `GET games.roblox.com/v1/games/multiget-place-details` (+ universe fallback) |
//! | `resolveShareLink`   | [`resolve_share_link`]        | `POST apis.roblox.com/sharelinks/v1/resolve-link`                  |
//! | `getAccessCode`      | [`get_access_code`]           | `POST apis.roblox.com/sharelinks/v1/resolve` (+ redirect-scrape fallback) |
//! | `followRedirect`     | [`follow_redirect`]           | `GET <url>` with manual redirect                                   |
//!
//! Header parity notes (these are deliberate, matching the legacy JS backend exactly):
//!   * [`fetch_user_info`] sends ONLY `Cookie` + `Accept` — it does NOT send a
//!     `User-Agent` (the legacy JS runtime `net.request` call did not), unlike every other
//!     call here which sends the desktop `User-Agent` string.
//!   * The shared desktop UA is
//!     `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`.
//!
//! Every function returns a `Result`; no `unwrap`/`expect` is used on any
//! fallible operation. Functions that in the legacy JS backend "resolve to null / a status
//! object on error" return `Ok(None)` / an `ok:false` payload for the *expected*
//! not-found / invalid-cookie cases, and reserve `Err(String)` for genuine
//! transport/build failures, so the command layer (Task 11.3) and
//! `roblox_process` (Task 10.2) can map them onto the same renderer-visible
//! outcomes the legacy JS build produced.

use serde::Serialize;
use serde_json::Value;

/// Desktop `User-Agent` string sent by every ported call except
/// [`fetch_user_info`] (which, matching the legacy JS backend, sends none).
const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/// Result of validating a `.ROBLOSECURITY` cookie via [`fetch_user_info`].
///
/// Field names are chosen to serialize to the exact shape the legacy JS backend's
/// `fetchUserInfo` resolved with (`{ ok, username, userId }` on success,
/// `{ ok:false, reason }` on failure), so the `roblox_validate_cookie` command
/// can return this struct straight to the Renderer_UI without reshaping.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UserInfo {
    /// `true` when the cookie authenticated and an account id was returned.
    pub ok: bool,
    /// The authenticated account's username (`d.name`), present only on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// The authenticated account's user id as a string (`String(d.id)`), present
    /// only on success.
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// A short failure reason (parse error message or truncated response body),
    /// present only on failure — mirrors the legacy JS backend's `reason` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl UserInfo {
    fn ok(username: String, user_id: String) -> Self {
        Self { ok: true, username: Some(username), user_id: Some(user_id), reason: None }
    }
    fn fail(reason: impl Into<String>) -> Self {
        Self { ok: false, username: None, user_id: None, reason: Some(reason.into()) }
    }
}

/// A resolved share link: the place id and link code extracted from Roblox's
/// `sharelinks/v1/resolve-link` response. Mirrors the legacy JS backend's
/// `{ placeId, linkCode }` success payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedShareLink {
    pub place_id: String,
    pub link_code: String,
}

/// Build a `reqwest` client. `follow_redirects=false` reproduces the legacy JS runtime
/// `redirect: 'manual'` behavior needed by [`follow_redirect`] and
/// [`get_access_code`]'s redirect-scrape fallback; the other calls hit endpoints
/// that answer `200` directly, matching Node's non-following `https.get`.
fn build_client(follow_redirects: bool) -> Result<reqwest::Client, String> {
    let policy = if follow_redirects {
        reqwest::redirect::Policy::default()
    } else {
        reqwest::redirect::Policy::none()
    };
    reqwest::Client::builder()
        .redirect(policy)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Port of `getRobloxVersion`.
///
/// `GET https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer`
/// with a 5-second timeout (matching `httpsGet`). On `200`, returns
/// `clientVersionUpload` if present, else `version`. Returns `Ok(None)` when the
/// call succeeds but neither field is present (mirroring the legacy JS backend's `return
/// null`), and `Err` only on transport failure or a non-200 status.
pub async fn get_roblox_version() -> Result<Option<String>, String> {
    let client = build_client(false)?;
    let resp = client
        .get("https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer")
        .header("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("client-version request failed: {e}"))?;

    if resp.status().as_u16() != 200 {
        return Err(format!("client-version returned status {}", resp.status().as_u16()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read client-version body: {e}"))?;
    let d: Value = serde_json::from_str(&body)
        .map_err(|e| format!("failed to parse client-version JSON: {e}"))?;

    if let Some(v) = d.get("clientVersionUpload").and_then(Value::as_str) {
        return Ok(Some(v.to_string()));
    }
    if let Some(v) = d.get("version").and_then(Value::as_str) {
        return Ok(Some(v.to_string()));
    }
    Ok(None)
}

/// Port of `fetchUserInfo` (the `roblox:validateCookie` backing call).
///
/// `GET https://users.roblox.com/v1/users/authenticated` with
/// `Cookie: .ROBLOSECURITY=<cookie>` and `Accept: application/json` (and NO
/// `User-Agent`, matching the legacy JS runtime `net.request` call). Never returns `Err`:
/// like the Node promise, every outcome resolves to a [`UserInfo`] — `ok:true`
/// with `username`/`userId` when `d.id` is present, otherwise `ok:false` with a
/// `reason` (truncated body, `"parse error"`, or the transport error message).
pub async fn fetch_user_info(cookie: &str) -> Result<UserInfo, String> {
    let client = match build_client(false) {
        Ok(c) => c,
        Err(e) => return Ok(UserInfo::fail(e)),
    };
    let resp = client
        .get("https://users.roblox.com/v1/users/authenticated")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Accept", "application/json")
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Ok(UserInfo::fail(e.to_string())),
    };
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => return Ok(UserInfo::fail(e.to_string())),
    };

    match serde_json::from_str::<Value>(&body) {
        Ok(d) => {
            // `d && d.id` — an id present (number or string) means success.
            let id = d.get("id");
            let id_str = id.and_then(value_to_id_string);
            match id_str {
                Some(uid) => {
                    let name = d.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    Ok(UserInfo::ok(name, uid))
                }
                // Parsed JSON but no usable id: mirror `resolve({ ok:false,
                // reason: body.slice(0,200) })`.
                None => Ok(UserInfo::fail(truncate(&body, 200))),
            }
        }
        Err(_) => Ok(UserInfo::fail("parse error")),
    }
}

/// Port of the `roblox:getGameName` handler.
///
/// Accepts a bare place id OR a games/URL target; extracts the place id via
/// [`extract_place_id`] first (returning `Ok(None)` if none can be found, exactly
/// as the handler does). Then:
///   1. `GET games.roblox.com/v1/games/multiget-place-details?placeIds=<id>` and
///      returns `data[0].name` if present.
///   2. Fallback: `GET apis.roblox.com/universes/v1/places/<id>/universe` ->
///      `universeId`, then `GET games.roblox.com/v1/games?universeIds=<uid>` ->
///      `data[0].name`.
/// Each call carries the `.ROBLOSECURITY` cookie, `Accept: application/json`, the
/// desktop `User-Agent`, and a 5-second timeout. Returns `Ok(None)` when no name
/// resolves (mirroring the handler's `return null`).
pub async fn get_game_name(
    place_id_or_target: &str,
    cookie: &str,
) -> Result<Option<String>, String> {
    let place_id = match extract_place_id(place_id_or_target) {
        Some(id) => id,
        None => return Ok(None),
    };

    let client = build_client(false)?;

    // Primary: multiget-place-details -> [0].name
    let url = format!(
        "https://games.roblox.com/v1/games/multiget-place-details?placeIds={place_id}"
    );
    if let Some(json) = get_json(&client, &url, cookie).await {
        let name = json.as_array().and_then(|a| a.first())
            .and_then(|first| first.get("name"))
            .and_then(Value::as_str);
        if let Some(name) = name {
            if !name.is_empty() {
                return Ok(Some(name.to_string()));
            }
        }
    }

    // Fallback: placeId -> universeId -> universe name
    let uni_url = format!(
        "https://apis.roblox.com/universes/v1/places/{place_id}/universe"
    );
    if let Some(uni) = get_json(&client, &uni_url, cookie).await {
        let universe_id = uni.get("universeId").and_then(value_to_id_string);
        if let Some(uid) = universe_id {
            let games_url = format!(
                "https://games.roblox.com/v1/games?universeIds={uid}"
            );
            if let Some(games) = get_json(&client, &games_url, cookie).await {
                let name = games.get("data").and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(|first| first.get("name"))
                    .and_then(Value::as_str);
                if let Some(name) = name {
                    if !name.is_empty() {
                        return Ok(Some(name.to_string()));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Shared authenticated GET-and-parse-JSON helper for [`get_game_name`], mirroring
/// the handler's inline `getJson` closure: 5-second timeout, cookie + accept +
/// UA headers, and `null` (here `None`) on any transport/parse failure.
async fn get_json(client: &reqwest::Client, url: &str, cookie: &str) -> Option<Value> {
    let resp = client
        .get(url)
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Accept", "application/json")
        .header("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let body = resp.text().await.ok()?;
    serde_json::from_str::<Value>(&body).ok()
}

/// Port of `resolveShareLink`.
///
/// `POST https://apis.roblox.com/sharelinks/v1/resolve-link` with
/// `Cookie: .ROBLOSECURITY=<cookie>`, `X-CSRF-TOKEN`, JSON body, and the desktop
/// UA, with an 8-second timeout. Tries two payload shapes in order
/// (`{linkId,linkType}` then `{code,type}`); on a `403` carrying a fresh
/// `x-csrf-token` response header it retries the SAME payload once with that
/// token before moving on. On a `200`, extracts `placeId` and one of
/// `linkCode`/`privateServerLinkCode`/`accessCode`/`linkcode` from the response
/// body. Returns `Err` with the legacy JS backend's user-facing message when nothing
/// resolves.
///
/// `link_type` parameterizes the payload's type field (the legacy JS build
/// hardcoded `"Server"`); pass `"Server"` for the private-server/share flow.
pub async fn resolve_share_link(
    share_code: &str,
    cookie: &str,
    csrf_token: &str,
    link_type: &str,
) -> Result<ResolvedShareLink, String> {
    let client = build_client(false)?;

    let payloads = [
        serde_json::json!({ "linkId": share_code, "linkType": link_type }),
        serde_json::json!({ "code": share_code, "type": link_type }),
    ];

    for payload in &payloads {
        // First attempt with the caller-supplied CSRF token.
        let (status, csrf_hdr, body) =
            post_resolve_link(&client, cookie, csrf_token, payload).await;
        if status == 200 {
            if let Some(resolved) = parse_share_link_body(&body) {
                return Ok(resolved);
            }
        } else if status == 403 {
            if let Some(fresh) = csrf_hdr {
                // Retry the SAME payload once with the fresh CSRF token.
                let (status2, _csrf2, body2) =
                    post_resolve_link(&client, cookie, &fresh, payload).await;
                if status2 == 200 {
                    if let Some(resolved) = parse_share_link_body(&body2) {
                        return Ok(resolved);
                    }
                }
            }
        }
        // Otherwise fall through to the next payload shape.
    }

    Err("Could not resolve share link. It may be expired or invalid.".to_string())
}

/// One POST to `sharelinks/v1/resolve-link`, returning `(status, x-csrf-token
/// header, body)`. A transport failure or timeout is reported as status `0` with
/// an empty body, matching the legacy JS backend's `cb(0, {}, '')`.
async fn post_resolve_link(
    client: &reqwest::Client,
    cookie: &str,
    csrf: &str,
    payload: &Value,
) -> (u16, Option<String>, String) {
    let body_str = payload.to_string();
    let resp = client
        .post("https://apis.roblox.com/sharelinks/v1/resolve-link")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("X-CSRF-TOKEN", csrf)
        .header("Content-Type", "application/json")
        .header("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(8))
        .body(body_str)
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let csrf_hdr = r
                .headers()
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let body = r.text().await.unwrap_or_default();
            (status, csrf_hdr, body)
        }
        Err(_) => (0, None, String::new()),
    }
}

/// Port of `getAccessCode`.
///
/// Primary: `POST https://apis.roblox.com/sharelinks/v1/resolve` with
/// `{ shareCode: <linkCode>, shareType: "Server" }`, cookie, CSRF, `Origin` and
/// `Referer` of `https://www.roblox.com`, and the desktop UA; extracts
/// `accessCode` from `privateServerInviteData` (checking the top-level,
/// `resolvedShareData`, and `experienceInviteData` nestings, matching the legacy JS backend).
///
/// Fallback: `GET https://www.roblox.com/games/<placeId>?privateServerLinkCode=<linkCode>`
/// with manual redirect (5-second timeout) and scrapes `accessCode=` out of the
/// `Location` header. Returns `Ok(None)` when neither path yields an access code.
pub async fn get_access_code(
    place_id: &str,
    link_code: &str,
    cookie: &str,
    csrf_token: &str,
) -> Result<Option<String>, String> {
    // Primary: sharelinks resolve API.
    let primary_client = build_client(false)?;
    let body = serde_json::json!({ "shareCode": link_code, "shareType": "Server" }).to_string();
    let resp = primary_client
        .post("https://apis.roblox.com/sharelinks/v1/resolve")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("X-CSRF-TOKEN", csrf_token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Origin", "https://www.roblox.com")
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", DESKTOP_UA)
        .body(body)
        .send()
        .await;

    if let Ok(r) = resp {
        if let Ok(text) = r.text().await {
            if let Ok(d) = serde_json::from_str::<Value>(&text) {
                if let Some(code) = extract_access_code(&d) {
                    return Ok(Some(code));
                }
            }
        }
    }

    // Fallback: redirect scrape.
    let redirect_client = build_client(false)?;
    let url = format!(
        "https://www.roblox.com/games/{place_id}?privateServerLinkCode={link_code}"
    );
    let resp = redirect_client
        .get(&url)
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;

    if let Ok(r) = resp {
        let loc = r
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if let Some(code) = scrape_access_code(&loc) {
            return Ok(Some(code));
        }
    }

    Ok(None)
}

/// Port of `followRedirect`.
///
/// `GET <url>` with manual redirect; resolves to the `Location` header value if
/// present, otherwise to the original `url`. Any transport error also resolves to
/// the original `url` (never an `Err`), matching the Node promise.
pub async fn follow_redirect(url: &str) -> Result<String, String> {
    let client = build_client(false)?;
    let resp = client.get(url).send().await;
    match resp {
        Ok(r) => {
            let loc = r
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            Ok(loc.unwrap_or_else(|| url.to_string()))
        }
        Err(_) => Ok(url.to_string()),
    }
}

// ── Tauri command wrappers (Task 11.3) ──────────────────────────────────────
//
// These three `#[tauri::command]` functions are the direct counterparts of the
// legacy JS runtime `roblox:getVersion` / `roblox:validateCookie` / `roblox:getGameName`
// IPC handlers (design IPC_Surface mapping table). Each takes the same
// parameters, in the same order, as its legacy handler, and yields the same
// user-observable result in the Renderer_UI (Requirement 10.1):
//
// | legacy IPC             | command                  | core called          |
// |--------------------------|--------------------------|----------------------|
// | `roblox:getVersion`      | [`roblox_get_version`]   | [`get_roblox_version`] |
// | `roblox:validateCookie`  | [`roblox_validate_cookie`] | [`fetch_user_info`] |
// | `roblox:getGameName`     | [`roblox_get_game_name`] | [`get_game_name`]    |

/// `roblox:getVersion` — return the current Roblox client version string, or
/// `null` on any failure.
///
/// Ports `legacy command handler('roblox:getVersion', async () => { try { return await
/// getRobloxVersion(); } catch { return null; } })`. The legacy handler
/// swallows every error to `null`; here both a transport/parse `Err` and the
/// "succeeded but no version field" `Ok(None)` collapse to `None`, so the
/// Renderer_UI receives `null` in exactly the cases the legacy JS build returned
/// `null`. Returns `Ok` unconditionally (never a rejected promise).
#[tauri::command]
pub async fn roblox_get_version() -> Result<Option<String>, String> {
    Ok(get_roblox_version().await.unwrap_or(None))
}

/// `roblox:validateCookie` — validate a `.ROBLOSECURITY` cookie, returning the
/// `{ ok, username, userId }` / `{ ok:false, reason }` payload.
///
/// Ports `legacy command handler('roblox:validateCookie', async (_, cookie) => await
/// fetchUserInfo(cookie))`. [`fetch_user_info`] never returns `Err` (every
/// outcome, including transport failure, resolves to a [`UserInfo`]), matching
/// the Node promise that always resolves, so the Renderer_UI branches on the
/// returned `ok` flag exactly as before. A missing/`null` `cookie` argument is
/// treated as the empty string.
#[tauri::command]
pub async fn roblox_validate_cookie(cookie: Option<String>) -> Result<UserInfo, String> {
    fetch_user_info(&cookie.unwrap_or_default()).await
}

/// `roblox:getGameName` — resolve a bare place id or a games/URL target to a
/// game name, or `null` on any failure.
///
/// Ports `legacy command handler('roblox:getGameName', async (_, placeIdOrTarget,
/// cookie) => { try { ... } catch { return null; } })`, preserving the
/// `(placeIdOrTarget, cookie)` parameter order. The legacy handler returns
/// `null` when no place id can be extracted, when neither the primary nor the
/// universe-fallback lookup yields a name, and on any thrown error; here the
/// `Ok(None)` cases and a transport/build `Err` all collapse to `None` so the
/// Renderer_UI receives `null` in the same cases. A missing/`null` `cookie`
/// argument is treated as the empty string.
#[tauri::command]
pub async fn roblox_get_game_name(
    place_id_or_target: String,
    cookie: Option<String>,
) -> Result<Option<String>, String> {
    Ok(get_game_name(&place_id_or_target, &cookie.unwrap_or_default())
        .await
        .unwrap_or(None))
}

/// Fetch avatar-headshot thumbnails for a batch of user ids via Roblox's
/// `POST https://thumbnails.roblox.com/v1/batch` endpoint.
///
/// This runs in the Rust backend rather than the Renderer_UI on purpose: the
/// WebView2 webview enforces CORS, and `thumbnails.roblox.com` sends no
/// `Access-Control-Allow-Origin`, so a direct `fetch` from the page (origin
/// `http://tauri.localhost`) is blocked. A server-side request is not subject to
/// CORS. Returns a normalized `{ "data": [{ "targetId", "state", "imageUrl" }] }`
/// object matching the shape `renderer.js` already consumes from the thumbnails
/// endpoint, so the renderer only swaps its transport (Requirement 10.1/8.3).
#[tauri::command]
pub async fn roblox_get_avatar_thumbnails(user_ids: Vec<String>) -> Result<Value, String> {
    // Build the batch request array (one AvatarHeadShot item per numeric id),
    // mirroring the documented POST /v1/batch body shape.
    let mut items: Vec<Value> = Vec::new();
    for (i, id) in user_ids.iter().enumerate() {
        let target_id: u64 = match id.trim().parse() {
            Ok(n) => n,
            Err(_) => continue, // skip blank / non-numeric ids
        };
        items.push(serde_json::json!({
            "requestId": format!("{i}:AvatarHeadShot:48x48:Png:regular"),
            "type": "AvatarHeadShot",
            "targetId": target_id,
            "format": "Png",
            "size": "48x48",
            "isCircular": false
        }));
    }
    if items.is_empty() {
        return Ok(serde_json::json!({ "data": [] }));
    }

    let payload = serde_json::to_string(&items).map_err(|e| e.to_string())?;
    let client = build_client(false)?;
    let resp = client
        .post("https://thumbnails.roblox.com/v1/batch")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("thumbnails request failed: {e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("thumbnails read failed: {e}"))?;
    let body: Value =
        serde_json::from_str(&text).map_err(|e| format!("thumbnails parse failed: {e}"))?;

    // Normalize to { data: [{ targetId, state, imageUrl }] } — the exact fields
    // the renderer reads (`item.targetId`, `item.imageUrl`, `item.state`).
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let normalized: Vec<Value> = data
        .into_iter()
        .filter_map(|item| {
            let target_id = item.get("targetId")?.clone();
            Some(serde_json::json!({
                "targetId": target_id,
                "state": item.get("state").cloned().unwrap_or(Value::Null),
                "imageUrl": item.get("imageUrl").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();

    Ok(serde_json::json!({ "data": normalized }))
}

/// Refresh an account's `.ROBLOSECURITY` cookie by asking Roblox to rotate the
/// session, returning the (possibly new) cookie value.
///
/// Ported from the reference `POST https://auth.roblox.com/v1/session/refresh`
/// flow: the current cookie is sent, and if Roblox responds with a rotated
/// `.ROBLOSECURITY` in a `Set-Cookie` header, that new value is returned;
/// otherwise the cookie is still alive and is returned unchanged. Runs in the
/// Rust backend (not the webview) so it is not subject to CORS. Any transport
/// failure or missing rotation yields the input cookie unchanged, so the caller
/// can always persist the result safely.
#[tauri::command]
pub async fn roblox_refresh_cookie(cookie: String) -> Result<Value, String> {
    // Result shape consumed by the renderer: `{ cookie, rateLimited }`. `cookie`
    // is the (possibly rotated) value; `rateLimited` is true only on HTTP 429 so
    // the caller can back off and retry rather than treating it as a rotation.
    let unchanged = |c: String| serde_json::json!({ "cookie": c, "rateLimited": false });

    if cookie.trim().is_empty() {
        return Ok(unchanged(cookie));
    }
    let client = build_client(false)?;
    let resp = client
        .post("https://auth.roblox.com/v1/session/refresh")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(_) => return Ok(unchanged(cookie)), // unreachable -> keep the current cookie
    };
    // 429 Too Many Requests: signal the caller to wait and retry.
    if resp.status().as_u16() == 429 {
        return Ok(serde_json::json!({ "cookie": cookie, "rateLimited": true }));
    }
    // Scan every Set-Cookie header for a rotated `.ROBLOSECURITY` value,
    // mirroring the reference regex `/\.ROBLOSECURITY=([^;]+)/`.
    for value in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
        if let Ok(s) = value.to_str() {
            if let Some(new_cookie) = parse_roblosecurity(s) {
                if !new_cookie.is_empty() && new_cookie != cookie {
                    return Ok(serde_json::json!({ "cookie": new_cookie, "rateLimited": false }));
                }
            }
        }
    }
    Ok(unchanged(cookie))
}

/// Server-side GET for public Roblox JSON APIs, to bypass the WebView2 CORS wall
/// (thumbnails/apis/users/games/... send no `Access-Control-Allow-Origin`, so the
/// Renderer_UI cannot call them directly from `http://tauri.localhost`).
///
/// RESTRICTED to `https://*.roblox.com` hosts so it can never be used as an open
/// proxy. Returns the parsed JSON body (or `Null` for an empty body). Errors only
/// on a disallowed URL or a transport/parse failure, so the renderer can branch
/// the same way it did on a failed `fetch`.
#[tauri::command]
pub async fn roblox_api_get(url: String) -> Result<Value, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "invalid url".to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https URLs are allowed".to_string());
    }
    let host = parsed.host_str().unwrap_or("");
    if host != "roblox.com" && !host.ends_with(".roblox.com") {
        return Err("only *.roblox.com hosts are allowed".to_string());
    }
    let client = build_client(true)?;
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let text = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("parse failed: {e}"))
}

// ── Authenticated account actions (presence, friend request, password, display name) ──
//
// These commands operate on a specific account's `.ROBLOSECURITY` cookie and, for
// state-changing POST/PATCH calls, first obtain an `x-csrf-token` the way every
// Roblox web client does: fire the target request without a token, read the
// `x-csrf-token` response header Roblox returns on the 403, then retry the same
// request carrying that token. All run in the Rust backend (not the webview) so
// they are not subject to CORS and never expose the cookie to the renderer.

/// Maximum number of automatic retries performed on an HTTP 429 response.
const MAX_429_RETRIES: u32 = 4;

/// Compute how long to wait before retrying a rate-limited (429) request.
///
/// Roblox's guidance: honor the `Retry-After` header when present (it is a whole
/// number of seconds), otherwise fall back to exponential backoff. We cap the
/// wait at 30s so a hostile/huge `Retry-After` can't hang an action indefinitely,
/// and the exponential fallback is `0.5s * 2^attempt` (0.5s, 1s, 2s, 4s...).
fn retry_after_ms(resp: &reqwest::Response, attempt: u32) -> u64 {
    if let Some(secs) = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        return (secs.min(30)) * 1000;
    }
    let backoff = 500u64.saturating_mul(1u64 << attempt.min(6));
    backoff.min(30_000)
}

/// Send a request, transparently retrying on HTTP 429 (Too Many Requests) up to
/// [`MAX_429_RETRIES`] times, honoring `Retry-After` or exponential backoff
/// between attempts. The builder must be cloneable (string/empty bodies always
/// are); a non-cloneable builder is sent once without retry.
async fn send_retrying(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let mut attempt = 0u32;
    loop {
        let attempt_req = match req.try_clone() {
            Some(r) => r,
            // Non-cloneable (streamed body): send the original once, no retry.
            None => return req.send().await.map_err(|e| format!("request failed: {e}")),
        };
        let resp = attempt_req
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        if resp.status().as_u16() == 429 && attempt < MAX_429_RETRIES {
            let wait = retry_after_ms(&resp, attempt);
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            attempt += 1;
            continue;
        }
        return Ok(resp);
    }
}

/// Fetch an `x-csrf-token` for the given cookie. Any authenticated POST returns a
/// 403 carrying the token when no valid token is supplied; `authentication-ticket`
/// is used as a cheap, side-effect-light token source. Returns the token string,
/// or an error if none is issued. Retries on 429 with backoff.
async fn get_csrf_token(client: &reqwest::Client, cookie: &str) -> Result<String, String> {
    let req = client
        .post("https://auth.roblox.com/v1/authentication-ticket")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body("{}");
    let resp = send_retrying(req).await.map_err(|e| format!("csrf {e}"))?;
    if let Some(tok) = resp.headers().get("x-csrf-token").and_then(|v| v.to_str().ok()) {
        if !tok.is_empty() {
            return Ok(tok.to_string());
        }
    }
    Err("could not obtain CSRF token (cookie may be invalid)".to_string())
}

/// Get the presence (online / in-game / in-studio / offline) of a batch of users.
///
/// `POST https://presence.roblox.com/v1/presence/users` with `{ "userIds": [...] }`.
/// Roblox returns `userPresences[]` with `userPresenceType`
/// (0 = Offline, 1 = Online/website, 2 = InGame, 3 = InStudio), plus `placeId`,
/// `rootPlaceId`, `gameId`, `universeId`, and `lastLocation`. A cookie is included
/// when provided (presence for non-friends requires authentication). Returns the
/// raw `{ "userPresences": [...] }` object, or `Err` on transport/parse failure.
#[tauri::command]
pub async fn roblox_get_presence(
    user_ids: Vec<String>,
    cookie: Option<String>,
) -> Result<Value, String> {
    let ids: Vec<i64> = user_ids
        .iter()
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .collect();
    if ids.is_empty() {
        return Ok(serde_json::json!({ "userPresences": [] }));
    }
    let client = build_client(false)?;
    let mut req = client
        .post("https://presence.roblox.com/v1/presence/users")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", DESKTOP_UA);
    if let Some(c) = cookie.as_deref() {
        if !c.trim().is_empty() {
            req = req.header("Cookie", format!(".ROBLOSECURITY={c}"));
        }
    }
    let payload = serde_json::json!({ "userIds": ids }).to_string();
    let resp = send_retrying(req.body(payload)).await?;
    let text = resp.text().await.map_err(|e| format!("presence read failed: {e}"))?;
    if text.is_empty() {
        return Ok(serde_json::json!({ "userPresences": [] }));
    }
    serde_json::from_str(&text).map_err(|e| format!("presence parse failed: {e}"))
}

/// Resolve a place id to its game details: name, creator, universe id, live
/// player count, and an icon thumbnail URL. Used by the launch modal's game
/// preview. Returns `{ ok, name, creator, universeId, playing, iconUrl }` (or
/// `{ ok:false }` when the place cannot be resolved). Never returns `Err` for the
/// expected not-found case; reserves `Err` for build failures.
#[tauri::command]
pub async fn roblox_game_details(
    place_id: String,
    cookie: Option<String>,
) -> Result<Value, String> {
    let place = match extract_place_id(&place_id) {
        Some(p) => p,
        None => return Ok(serde_json::json!({ "ok": false })),
    };
    let cookie = cookie.unwrap_or_default();
    let client = build_client(false)?;

    // placeId -> universeId
    let uni_url = format!("https://apis.roblox.com/universes/v1/places/{place}/universe");
    let universe_id = get_json(&client, &uni_url, &cookie)
        .await
        .and_then(|u| u.get("universeId").and_then(value_to_id_string));
    let universe_id = match universe_id {
        Some(u) => u,
        None => return Ok(serde_json::json!({ "ok": false, "placeId": place })),
    };

    // universeId -> name, creator, playing
    let games_url = format!("https://games.roblox.com/v1/games?universeIds={universe_id}");
    let mut name = String::new();
    let mut creator = String::new();
    let mut playing: i64 = 0;
    if let Some(games) = get_json(&client, &games_url, &cookie).await {
        if let Some(first) = games.get("data").and_then(Value::as_array).and_then(|a| a.first()) {
            name = first.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            creator = first
                .get("creator")
                .and_then(|c| c.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            playing = first.get("playing").and_then(Value::as_i64).unwrap_or(0);
        }
    }

    // universeId -> icon thumbnail
    let icon_url = format!(
        "https://thumbnails.roblox.com/v1/games/icons?universeIds={universe_id}&size=150x150&format=Png&isCircular=false"
    );
    let mut icon = String::new();
    if let Some(icons) = get_json(&client, &icon_url, &cookie).await {
        if let Some(first) = icons.get("data").and_then(Value::as_array).and_then(|a| a.first()) {
            icon = first.get("imageUrl").and_then(Value::as_str).unwrap_or("").to_string();
        }
    }

    Ok(serde_json::json!({
        "ok": true,
        "placeId": place,
        "universeId": universe_id,
        "name": name,
        "creator": creator,
        "playing": playing,
        "iconUrl": icon,
    }))
}

/// Send a friend request from the authenticated account (identified by `cookie`)
/// to `target_user_id`.
///
/// `POST https://friends.roblox.com/v1/users/{targetUserId}/request-friendship`
/// with a CSRF token. Returns `{ ok:true }` on success, or `{ ok:false, error }`
/// with Roblox's error message (or a challenge notice) on failure.
#[tauri::command]
pub async fn roblox_send_friend_request(
    cookie: String,
    target_user_id: String,
) -> Result<Value, String> {
    if cookie.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "No cookie stored for this account" }));
    }
    let target = target_user_id.trim();
    if target.is_empty() || target.parse::<i64>().is_err() {
        return Ok(serde_json::json!({ "ok": false, "error": "Invalid target user id" }));
    }
    let client = build_client(false)?;
    let token = match get_csrf_token(&client, &cookie).await {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };
    let url = format!("https://friends.roblox.com/v1/users/{target}/request-friendship");
    let req = client
        .post(&url)
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("X-CSRF-TOKEN", &token)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body("{}");
    let resp = send_retrying(req).await?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        return Ok(serde_json::json!({ "ok": true }));
    }
    Ok(serde_json::json!({ "ok": false, "error": extract_api_error(&body, status) }))
}

/// Change the authenticated account's password (best-effort).
///
/// `POST https://auth.roblox.com/v1/user/passwords/change` with
/// `{ "currentPassword", "newPassword" }` and a CSRF token. Roblox often gates
/// this behind a security challenge (CAPTCHA / 2FA / passkey); when it responds
/// with a `rblx-challenge-*` header or a challenge body, this returns
/// `{ ok:false, challenge:true, error }` so the UI can tell the user to complete
/// it in the browser rather than reporting a generic failure.
#[tauri::command]
pub async fn roblox_change_password(
    cookie: String,
    current_password: String,
    new_password: String,
) -> Result<Value, String> {
    if cookie.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "No cookie stored for this account" }));
    }
    if new_password.len() < 6 {
        return Ok(serde_json::json!({ "ok": false, "error": "New password is too short" }));
    }
    let client = build_client(false)?;
    let token = match get_csrf_token(&client, &cookie).await {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };
    let payload = serde_json::json!({
        "currentPassword": current_password,
        "newPassword": new_password,
    })
    .to_string();
    let req = client
        .post("https://auth.roblox.com/v1/user/passwords/change")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("X-CSRF-TOKEN", &token)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body(payload);
    let resp = send_retrying(req).await?;
    let status = resp.status().as_u16();
    let challenge = resp.headers().keys().any(|k| {
        let k = k.as_str().to_ascii_lowercase();
        k.starts_with("rblx-challenge")
    });
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let err = extract_api_error(&body, status);
    if challenge || body.to_lowercase().contains("challenge") {
        return Ok(serde_json::json!({
            "ok": false,
            "challenge": true,
            "error": "Roblox requires a security challenge (CAPTCHA/2FA). Complete it in the account's browser session, then retry."
        }));
    }
    Ok(serde_json::json!({ "ok": false, "error": err }))
}

/// Change the authenticated account's display name.
///
/// `PATCH https://users.roblox.com/v1/users/{userId}/display-names` with
/// `{ "newDisplayName" }` and a CSRF token. Returns `{ ok:true }` on success or
/// `{ ok:false, error }` with Roblox's message (e.g. cooldown, taken, moderated).
#[tauri::command]
pub async fn roblox_change_display_name(
    cookie: String,
    user_id: String,
    new_display_name: String,
) -> Result<Value, String> {
    if cookie.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "No cookie stored for this account" }));
    }
    let uid = user_id.trim();
    if uid.is_empty() || uid.parse::<i64>().is_err() {
        return Ok(serde_json::json!({ "ok": false, "error": "Account has no user id" }));
    }
    let name = new_display_name.trim();
    if name.len() < 3 || name.len() > 20 {
        return Ok(serde_json::json!({ "ok": false, "error": "Display name must be 3-20 characters" }));
    }
    let client = build_client(false)?;
    let token = match get_csrf_token(&client, &cookie).await {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };
    let url = format!("https://users.roblox.com/v1/users/{uid}/display-names");
    let payload = serde_json::json!({ "newDisplayName": name }).to_string();
    let req = client
        .patch(&url)
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("X-CSRF-TOKEN", &token)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body(payload);
    let resp = send_retrying(req).await?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        return Ok(serde_json::json!({ "ok": true }));
    }
    Ok(serde_json::json!({ "ok": false, "error": extract_api_error(&body, status) }))
}

/// Quick Login: authorize a cross-device login code from an already-signed-in
/// account.
///
/// This is the "log in with another device" flow from the authorizing side: the
/// other device shows a code; this account (via its `cookie`) enters and confirms
/// it, which signs that other device in. Two calls against
/// `apis.roblox.com/auth-token-service/v1/login`:
///   1. `POST /enterCode  { code }`  → validates the code, returns its status.
///   2. `POST /confirm    { code, status }` → completes the authorization.
/// Returns `{ ok:true }` on success, or `{ ok:false, error }` (e.g. bad/expired
/// code, cookie invalid). Retries on 429 with backoff.
#[tauri::command]
pub async fn roblox_quick_login(cookie: String, code: String) -> Result<Value, String> {
    if cookie.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "No cookie stored for this account" }));
    }
    let code = code.trim().to_string();
    if code.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "Enter the code shown on the other device" }));
    }
    let client = build_client(false)?;
    let token = match get_csrf_token(&client, &cookie).await {
        Ok(t) => t,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };

    // Step 1: enter the code.
    let enter_body = serde_json::json!({ "code": code }).to_string();
    let enter_req = client
        .post("https://apis.roblox.com/auth-token-service/v1/login/enterCode")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("X-CSRF-TOKEN", &token)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body(enter_body);
    let enter_resp = send_retrying(enter_req).await?;
    let enter_status = enter_resp.status().as_u16();
    let enter_text = enter_resp.text().await.unwrap_or_default();
    if enter_status != 200 {
        return Ok(serde_json::json!({ "ok": false, "error": extract_api_error(&enter_text, enter_status) }));
    }
    // The enterCode response carries the code's current status ("Validated" etc.)
    // which /confirm expects echoed back.
    let status_str = serde_json::from_str::<Value>(&enter_text)
        .ok()
        .and_then(|v| v.get("status").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| "Validated".to_string());

    // Step 2: confirm, which signs the other device in.
    let confirm_body = serde_json::json!({ "code": code, "status": status_str }).to_string();
    let confirm_req = client
        .post("https://apis.roblox.com/auth-token-service/v1/login/confirm")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .header("Content-Type", "application/json")
        .header("X-CSRF-TOKEN", &token)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .body(confirm_body);
    let confirm_resp = send_retrying(confirm_req).await?;
    let confirm_status = confirm_resp.status().as_u16();
    let confirm_text = confirm_resp.text().await.unwrap_or_default();
    if confirm_status == 200 {
        return Ok(serde_json::json!({ "ok": true }));
    }
    Ok(serde_json::json!({ "ok": false, "error": extract_api_error(&confirm_text, confirm_status) }))
}

/// Pull a human-readable message out of a Roblox API error response body
/// (`{ "errors": [{ "message": "..." }] }`), falling back to an HTTP-status
/// description when the body carries no structured error.
fn extract_api_error(body: &str, status: u16) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            if !msg.is_empty() {
                return msg.to_string();
            }
        }
    }
    match status {
        401 => "Not authorized (cookie may be invalid)".to_string(),
        403 => "Forbidden (CSRF or challenge required)".to_string(),
        429 => "Rate limited by Roblox, try again later".to_string(),
        _ => format!("Roblox returned status {status}"),
    }
}

/// Extract the `.ROBLOSECURITY` value from a `Set-Cookie` header line, mirroring
/// the reference regex `/\.ROBLOSECURITY=([^;]+)/`.
fn parse_roblosecurity(set_cookie: &str) -> Option<String> {
    let marker = ".ROBLOSECURITY=";
    let start = set_cookie.find(marker)? + marker.len();
    let rest = &set_cookie[start..];
    let end = rest.find(';').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

// ── Pure helpers (no I/O) ────────────────────────────────────────────────────

/// Coerce a JSON value that may be a number or a string into an id string,
/// mirroring the legacy JS backend's `String(d.id)` / numeric `universeId` handling.
fn value_to_id_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Truncate a string to at most `max` bytes on a char boundary, reproducing
/// `body.slice(0, max)` closely enough for the diagnostic `reason` field.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Extract the place id from a bare id or a games/URL target, mirroring the
/// `roblox:getGameName` handler's extraction: a purely-numeric input is used
/// as-is; otherwise the URL path is inspected for a `games/<digits>` segment, and
/// failing that the original string is scanned for a `placeId=<digits>` query
/// parameter. Returns `None` when no numeric place id can be found.
pub fn extract_place_id(place_id_or_target: &str) -> Option<String> {
    let trimmed = place_id_or_target.trim();
    if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Some(trimmed.to_string());
    }

    // Prefix a scheme so the host/path split below is well-defined, matching
    // `new URL(x.startsWith('http') ? x : 'https://' + x)`.
    let with_scheme = if trimmed.starts_with("http") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    // Strip scheme, then split host/path from query/fragment.
    let after_scheme = with_scheme.splitn(2, "://").nth(1).unwrap_or("");
    let host_and_path = after_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or("");
    // Path is everything after the first '/'.
    let path = host_and_path.splitn(2, '/').nth(1).unwrap_or("");
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2
        && parts[0] == "games"
        && !parts[1].is_empty()
        && parts[1].chars().all(|c| c.is_ascii_digit())
    {
        return Some(parts[1].to_string());
    }

    // Fallback: `[?&]placeId=(\d+)` scanned against the ORIGINAL target string.
    find_query_number(place_id_or_target, "placeId")
}

/// Find a `?key=<digits>` or `&key=<digits>` value in `s`, returning the run of
/// digits. Reproduces the legacy JS backend's `[?&]<key>=(\d+)` regex without a regex crate.
fn find_query_number(s: &str, key: &str) -> Option<String> {
    for sep in ['?', '&'] {
        let needle = format!("{sep}{key}=");
        if let Some(pos) = s.find(&needle) {
            let rest = &s[pos + needle.len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
    }
    None
}

/// Parse a `resolve-link` `200` body into a [`ResolvedShareLink`], mirroring
/// the legacy JS backend's dual regex (`"placeId":<digits>` and one of
/// `linkCode`/`privateServerLinkCode`/`accessCode`/`linkcode` as a string). A
/// recursive search over the parsed JSON is used so nested payload shapes resolve
/// the same way the flat body regex did.
fn parse_share_link_body(body: &str) -> Option<ResolvedShareLink> {
    let d: Value = serde_json::from_str(body).ok()?;
    let place_id = find_number_by_key(&d, "placeId")?;
    let link_code = find_string_by_keys(
        &d,
        &["linkCode", "privateServerLinkCode", "accessCode", "linkcode"],
    )?;
    Some(ResolvedShareLink { place_id, link_code })
}

/// Extract an `accessCode` from a `sharelinks/v1/resolve` response, checking the
/// same three `privateServerInviteData` nestings as the legacy JS backend's `getAccessCode`.
fn extract_access_code(d: &Value) -> Option<String> {
    let inv = d.get("privateServerInviteData")
        .or_else(|| d.get("resolvedShareData").and_then(|x| x.get("privateServerInviteData")))
        .or_else(|| d.get("experienceInviteData").and_then(|x| x.get("privateServerInviteData")))?;
    inv.get("accessCode")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Scrape an `accessCode=<value>` (up to the next `&`) out of a redirect
/// `Location` header, reproducing the legacy JS backend's `/[?&]accessCode=([^&]+)/`.
fn scrape_access_code(location: &str) -> Option<String> {
    for sep in ['?', '&'] {
        let needle = format!("{sep}accessCode=");
        if let Some(pos) = location.find(&needle) {
            let rest = &location[pos + needle.len()..];
            let val: String = rest.chars().take_while(|c| *c != '&').collect();
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

/// Recursively find the first value at any depth stored under `key` that is a
/// number (or numeric string), returning it as a string.
fn find_number_by_key(v: &Value, key: &str) -> Option<String> {
    match v {
        Value::Object(map) => {
            if let Some(found) = map.get(key).and_then(value_to_id_string) {
                return Some(found);
            }
            for child in map.values() {
                if let Some(found) = find_number_by_key(child, key) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(arr) => arr.iter().find_map(|child| find_number_by_key(child, key)),
        _ => None,
    }
}

/// Recursively find the first non-empty string value at any depth stored under
/// any of `keys`.
fn find_string_by_keys(v: &Value, keys: &[&str]) -> Option<String> {
    match v {
        Value::Object(map) => {
            for key in keys {
                if let Some(s) = map.get(*key).and_then(Value::as_str) {
                    if !s.is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
            for child in map.values() {
                if let Some(found) = find_string_by_keys(child, keys) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(arr) => arr.iter().find_map(|child| find_string_by_keys(child, keys)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_place_id_from_bare_numeric_id() {
        assert_eq!(extract_place_id("1818"), Some("1818".to_string()));
        assert_eq!(extract_place_id("  920587237  "), Some("920587237".to_string()));
    }

    #[test]
    fn extract_place_id_from_games_url() {
        assert_eq!(
            extract_place_id("https://www.roblox.com/games/920587237/Adopt-Me"),
            Some("920587237".to_string())
        );
        // scheme-less input is prefixed with https:// like `new URL`
        assert_eq!(
            extract_place_id("www.roblox.com/games/1818/Classic"),
            Some("1818".to_string())
        );
    }

    #[test]
    fn extract_place_id_from_query_param_fallback() {
        assert_eq!(
            extract_place_id("https://www.roblox.com/home?placeId=606849621&x=1"),
            Some("606849621".to_string())
        );
    }

    #[test]
    fn extract_place_id_returns_none_for_unparseable() {
        assert_eq!(extract_place_id("not-a-place"), None);
        assert_eq!(extract_place_id(""), None);
        // a games segment that isn't numeric is not a place id
        assert_eq!(extract_place_id("https://www.roblox.com/games/discover"), None);
    }

    #[test]
    fn parse_share_link_body_extracts_place_and_link_code() {
        let body = r#"{"placeType":"Server","placeId":606849621,"linkCode":"abc_DEF-123"}"#;
        assert_eq!(
            parse_share_link_body(body),
            Some(ResolvedShareLink {
                place_id: "606849621".to_string(),
                link_code: "abc_DEF-123".to_string(),
            })
        );
    }

    #[test]
    fn parse_share_link_body_accepts_alternate_link_code_keys_and_nesting() {
        let body = r#"{"data":{"placeId":"1","privateServerLinkCode":"xyz"}}"#;
        assert_eq!(
            parse_share_link_body(body),
            Some(ResolvedShareLink {
                place_id: "1".to_string(),
                link_code: "xyz".to_string(),
            })
        );
    }

    #[test]
    fn parse_share_link_body_none_when_fields_missing() {
        assert_eq!(parse_share_link_body(r#"{"placeId":5}"#), None);
        assert_eq!(parse_share_link_body("not json"), None);
    }

    #[test]
    fn extract_access_code_checks_all_nestings() {
        let a = serde_json::json!({ "privateServerInviteData": { "accessCode": "AAA" } });
        assert_eq!(extract_access_code(&a), Some("AAA".to_string()));

        let b = serde_json::json!({ "resolvedShareData": { "privateServerInviteData": { "accessCode": "BBB" } } });
        assert_eq!(extract_access_code(&b), Some("BBB".to_string()));

        let c = serde_json::json!({ "experienceInviteData": { "privateServerInviteData": { "accessCode": "CCC" } } });
        assert_eq!(extract_access_code(&c), Some("CCC".to_string()));

        let none = serde_json::json!({ "privateServerInviteData": { "accessCode": "" } });
        assert_eq!(extract_access_code(&none), None);
    }

    #[test]
    fn scrape_access_code_from_location() {
        assert_eq!(
            scrape_access_code("https://www.roblox.com/games/start?placeId=1&accessCode=TOKEN123&x=2"),
            Some("TOKEN123".to_string())
        );
        assert_eq!(scrape_access_code("https://www.roblox.com/games/1"), None);
    }

    #[test]
    fn user_info_serializes_to_legacy_shape() {
        let ok = UserInfo::ok("Builderman".to_string(), "156".to_string());
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["username"], serde_json::json!("Builderman"));
        assert_eq!(v["userId"], serde_json::json!("156"));
        assert!(v.get("reason").is_none());

        let fail = UserInfo::fail("parse error");
        let v = serde_json::to_value(&fail).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["reason"], serde_json::json!("parse error"));
        assert!(v.get("username").is_none());
        assert!(v.get("userId").is_none());
    }

    // ── Task 11.2: share-link / private-server-link-code URL parsing edge cases ──
    //
    // These cover malformed URLs and missing/empty codes across the share-link /
    // private-server resolution chain's pure parsing helpers
    // (`parse_share_link_body`, `extract_access_code`, `scrape_access_code`,
    // `extract_place_id`), matching the None/Err semantics ported in Task 11.1.
    // No network calls are made — only the synchronous parsing logic is exercised.
    // Validates: Requirements 2.1

    #[test]
    fn parse_share_link_body_missing_link_code_is_none() {
        // placeId present but NONE of the four link-code keys → None.
        assert_eq!(
            parse_share_link_body(r#"{"placeId":606849621,"somethingElse":"x"}"#),
            None
        );
    }

    #[test]
    fn parse_share_link_body_missing_place_id_is_none() {
        // A valid link code but no placeId anywhere → None (both fields required).
        assert_eq!(
            parse_share_link_body(r#"{"linkCode":"abc123","type":"Server"}"#),
            None
        );
    }

    #[test]
    fn parse_share_link_body_empty_link_code_value_is_none() {
        // A present-but-empty link code is falsy and must not resolve.
        assert_eq!(
            parse_share_link_body(r#"{"placeId":1,"linkCode":""}"#),
            None
        );
    }

    #[test]
    fn parse_share_link_body_empty_and_blank_bodies_are_none() {
        // Empty string, whitespace, and empty JSON object are all malformed for
        // our purposes → None (never a panic).
        assert_eq!(parse_share_link_body(""), None);
        assert_eq!(parse_share_link_body("   "), None);
        assert_eq!(parse_share_link_body("{}"), None);
    }

    #[test]
    fn parse_share_link_body_truncated_json_is_none() {
        // A truncated / malformed JSON payload must parse to None, not panic.
        assert_eq!(
            parse_share_link_body(r#"{"placeId":606849621,"linkCode":"ab"#),
            None
        );
    }

    #[test]
    fn parse_share_link_body_resolves_lowercase_linkcode_key() {
        // The `linkcode` (all-lowercase) alternate key is accepted, matching the
        // set of keys ported from legacy JS backend.
        assert_eq!(
            parse_share_link_body(r#"{"placeId":"42","linkcode":"lc_val"}"#),
            Some(ResolvedShareLink {
                place_id: "42".to_string(),
                link_code: "lc_val".to_string(),
            })
        );
    }

    #[test]
    fn parse_share_link_body_resolves_access_code_key_in_array() {
        // Array-nested payload with the `accessCode` link-code key resolves via the
        // recursive search.
        assert_eq!(
            parse_share_link_body(r#"[{"placeId":7,"accessCode":"ac_9"}]"#),
            Some(ResolvedShareLink {
                place_id: "7".to_string(),
                link_code: "ac_9".to_string(),
            })
        );
    }

    #[test]
    fn extract_access_code_missing_invite_data_is_none() {
        // No privateServerInviteData nesting at all → None.
        let d = serde_json::json!({ "resolvedShareData": { "somethingElse": true } });
        assert_eq!(extract_access_code(&d), None);
        // Empty object → None.
        assert_eq!(extract_access_code(&serde_json::json!({})), None);
    }

    #[test]
    fn extract_access_code_non_string_code_is_none() {
        // accessCode present but not a string → None (never coerced).
        let d = serde_json::json!({ "privateServerInviteData": { "accessCode": 12345 } });
        assert_eq!(extract_access_code(&d), None);
    }

    #[test]
    fn scrape_access_code_missing_or_empty_is_none() {
        // No accessCode param at all.
        assert_eq!(scrape_access_code(""), None);
        assert_eq!(
            scrape_access_code("https://www.roblox.com/games/1?placeId=1"),
            None
        );
        // Present but empty value (accessCode= with nothing after) → None.
        assert_eq!(
            scrape_access_code("https://www.roblox.com/games/1?accessCode="),
            None
        );
        // Present but empty value followed by another param → None.
        assert_eq!(
            scrape_access_code("https://www.roblox.com/games/1?accessCode=&x=2"),
            None
        );
    }

    #[test]
    fn scrape_access_code_as_first_query_param() {
        // accessCode as the very first query param (after '?') and running to the
        // end of the string still resolves.
        assert_eq!(
            scrape_access_code("https://www.roblox.com/games/1?accessCode=ONLY"),
            Some("ONLY".to_string())
        );
    }

    #[test]
    fn extract_place_id_private_link_code_url_without_place_id_is_none() {
        // A private-server-link-code URL that carries NO place id (not in the
        // /games/<id> path and no placeId= query param) yields None, so the
        // resolution chain reports "no place id" rather than proceeding.
        assert_eq!(
            extract_place_id("https://www.roblox.com/home?privateServerLinkCode=abc"),
            None
        );
    }

    #[test]
    fn extract_place_id_malformed_urls_are_none() {
        // Scheme-only / empty-authority / garbage inputs must return None, never panic.
        assert_eq!(extract_place_id("https://"), None);
        assert_eq!(extract_place_id("http://"), None);
        assert_eq!(extract_place_id("://///"), None);
        assert_eq!(extract_place_id("   "), None);
    }

    #[test]
    fn extract_place_id_games_path_without_numeric_id_is_none() {
        // `/games` with a trailing non-numeric segment (or no segment) has no place id.
        assert_eq!(extract_place_id("https://www.roblox.com/games"), None);
        assert_eq!(extract_place_id("https://www.roblox.com/games/"), None);
        assert_eq!(
            extract_place_id("https://www.roblox.com/games/not-a-number/foo"),
            None
        );
    }

    #[test]
    fn extract_place_id_query_place_id_empty_value_is_none() {
        // placeId= present but with an empty / non-numeric value → None.
        assert_eq!(
            extract_place_id("https://www.roblox.com/home?placeId="),
            None
        );
        assert_eq!(
            extract_place_id("https://www.roblox.com/home?placeId=abc"),
            None
        );
    }
}
