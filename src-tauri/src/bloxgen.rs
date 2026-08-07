//! BloxGen account-generation API client.
//!
//! This call runs in the Rust backend rather than the Renderer_UI on purpose:
//! the WebView2 webview enforces CORS, and `core.bloxgen.net` sends no
//! `Access-Control-Allow-Origin`, so a direct `fetch` from the page (origin
//! `http://tauri.localhost`) is blocked and surfaces as "Failed to fetch". A
//! server-side request is not subject to CORS — the same rationale as
//! [`crate::roblox_api::roblox_get_avatar_thumbnails`].
//!
//! The API contract (per <https://docs.bloxgen.net/api-reference/generate>):
//!   `POST https://core.bloxgen.net/api/generate`
//!   body `{ "apiKey": "BLOX-…", "type": "alt", "region": "GB"? }`
//!   success `{ "success": true, "data": { username, password, cookie, … } }`
//!   failure `{ "success": false, "message": "…" }` with a meaningful HTTP status
//!   (401 invalid key, 403 not verified / rules, 404 out of stock, 429 cooldown
//!   or daily limit, 5xx transient).
//!
//! Both the status and the parsed body are returned so the Renderer_UI can
//! surface the API's own `message` (and the 429 `timeRemaining` / daily-limit
//! fields) instead of a generic failure.

use std::time::Duration;

use serde_json::Value;

/// The BloxGen generation endpoint.
pub const BLOXGEN_ENDPOINT: &str = "https://core.bloxgen.net/api/generate";

/// The BloxGen stock endpoint.
///
/// Per <https://docs.bloxgen.net/api-reference/stock>:
///   `GET https://core.bloxgen.net/api/stock?apiKey=BLOX-…`
///   success `{ "success": true, "data": { "<type>": { available, regions[] } } }`
/// The map only contains the account types the key's role may generate, so it
/// doubles as the authoritative list of types to offer.
pub const BLOXGEN_STOCK_ENDPOINT: &str = "https://core.bloxgen.net/api/stock";

/// How long to wait for the stock lookup. Far shorter than a generation: this
/// call only gates which options the picker enables, so a slow answer must not
/// hold the page.
const BLOXGEN_STOCK_TIMEOUT_SECS: u64 = 15;

/// How long to wait for a generation before giving up. Generation can take a
/// while under load, so this is deliberately generous.
const BLOXGEN_TIMEOUT_SECS: u64 = 60;

/// `bloxgen:generate` — request one account from BloxGen.
///
/// Returns `{ "status": <http status>, "body": <parsed JSON> }`. A non-JSON body
/// is reported as `{ "message": "<truncated raw text>" }` so the caller always
/// has something to show. Only a transport-level failure (DNS, TLS, timeout)
/// resolves to `Err`; an API-level rejection is a successful call with a
/// non-2xx `status`, which the caller branches on.
///
/// `account_type` maps to the API's `type` field (`type` is a Rust keyword), and
/// `region` is optional — it is only accepted on the Ultra plan, so it is
/// omitted entirely when absent rather than sent as null.
#[tauri::command]
pub async fn bloxgen_generate(
    api_key: String,
    account_type: String,
    region: Option<String>,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut payload = serde_json::Map::new();
    payload.insert("apiKey".to_string(), Value::String(api_key.trim().to_string()));
    payload.insert("type".to_string(), Value::String(account_type));
    if let Some(region) = region.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
        payload.insert("region".to_string(), Value::String(region));
    }

    let response = client
        .post(BLOXGEN_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(Value::Object(payload).to_string())
        .timeout(Duration::from_secs(BLOXGEN_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| format!("BloxGen request failed: {e}"))?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("failed to read the BloxGen response: {e}"))?;

    let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
        // Not JSON (e.g. an HTML error page from an edge proxy): keep a short
        // excerpt under `message` so the UI can still explain what happened.
        serde_json::json!({ "message": truncate(text.trim(), 200) })
    });

    Ok(serde_json::json!({ "status": status, "body": body }))
}

/// `bloxgen:stock` — read per-account-type availability for an API key.
///
/// Returns the same `{ "status": <http status>, "body": <parsed JSON> }` shape as
/// [`bloxgen_generate`], so the caller branches on the status and can surface the
/// API's own `message`. Runs in the backend for the same CORS reason as
/// generation.
#[tauri::command]
pub async fn bloxgen_stock(api_key: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let response = client
        .get(BLOXGEN_STOCK_ENDPOINT)
        .query(&[("apiKey", api_key.trim())])
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(BLOXGEN_STOCK_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| format!("BloxGen stock request failed: {e}"))?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("failed to read the BloxGen stock response: {e}"))?;

    let body = serde_json::from_str::<Value>(&text)
        .unwrap_or_else(|_| serde_json::json!({ "message": truncate(text.trim(), 200) }));

    Ok(serde_json::json!({ "status": status, "body": body }))
}

/// Truncate `s` to at most `max` bytes without splitting a UTF-8 character.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_input_and_never_splits_a_char() {
        assert_eq!(truncate("hola", 200), "hola");
        // "é" is two bytes: truncating at 3 must not split it.
        let s = "aaé";
        assert_eq!(truncate(s, 3), "aa");
    }
}
