//! Session logging (`logging.rs`).
//!
//! This module ports the legacy JS build's `// ── Logging ──` section from
//! the legacy JS backend. In the legacy JS build, `sendLog(level, category, message, meta)`
//! emits a single log record to the Renderer_UI over the `log:entry`
//! `webContents` channel:
//!
//! ```js
//! function sendLog(level, category, message, meta) {
//!   try {
//!     if (win && !win.isDestroyed())
//!       win.webContents.send('log:entry', { ts: Date.now(), level, category, message, meta: meta || {} });
//!   } catch {}
//! }
//! ```
//!
//! Per the design's IPC_Surface mapping table, the legacy JS runtime `log:entry`
//! `webContents` channel (subscribed via `window.api.onLogEntry`) maps to the
//! Tauri `log://entry` event. The React log store reads the
//! payload fields `ts`, `level`, `category`, `message`, and `meta` directly:
//!
//! ```js
//! api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta));
//! ```
//!
//! so the emitted payload MUST keep those exact field names (Requirement 4.1).
//! Only the timestamp value and the process/thread identity are permitted to
//! differ from the legacy JS build (Requirement 4.1).
//!
//! Scope note (Requirement 4.2): this module provides only the emission
//! *mechanism*. The set of events that get logged (the logging *scope*) is
//! determined entirely by the `send_log` call sites, which are ported 1:1 from
//! the legacy JS build's `sendLog` call sites within their respective modules
//! (`native_helper.rs`, `roblox_process.rs`, `accounts.rs`, `browser_launcher.rs`,
//! ...). No log point is added or removed here.

use crate::models::Account;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

/// The Tauri event name that replaces the legacy JS build's `log:entry`
/// `webContents` channel (design IPC_Surface mapping: `onLogEntry` ->
/// `log://entry`).
pub const LOG_ENTRY_EVENT: &str = "log://entry";

/// A single session-log record, matching the exact payload shape the
/// legacy JS build sends over `log:entry` and that the Renderer_UI's
/// `onLogEntry` callback consumes.
///
/// Field names are load-bearing: `renderer.js` reads `ts`, `level`, `category`,
/// `message`, and `meta` off this payload, so the serialized names must match
/// the legacy JS build byte-for-byte (Requirement 4.1). In particular the
/// metadata field is serialized as `meta` (not `metadata`), matching legacy JS runtime.
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    /// Emission timestamp in epoch milliseconds (legacy JS runtime: `Date.now()`).
    /// Requirement 4.1 permits this value to differ from the legacy JS build.
    pub ts: i64,
    /// Severity level (e.g. `ok`, `info`, `warn`, `err`), carried through unchanged.
    pub level: String,
    /// Log category (e.g. `afk`, `kill`, `launch`, `crash`, `browser`), unchanged.
    pub category: String,
    /// Human-readable message text, unchanged.
    pub message: String,
    /// Structured metadata. Serialized as `meta` to match legacy JS runtime. Defaults to
    /// an empty object `{}` when no metadata is supplied (legacy JS runtime: `meta || {}`).
    pub meta: Value,
}

/// Builds a [`LogEntry`] with the same field values and defaulting behavior as
/// the legacy JS build's `sendLog` payload construction, without performing the
/// emission side effect. Kept separate from [`send_log`] so the payload shape
/// is unit-testable without a live Tauri [`AppHandle`].
///
/// Mirrors legacy JS runtime's `{ ts: Date.now(), level, category, message, meta: meta || {} }`:
/// a `Value::Null` metadata is normalized to an empty object `{}`, matching
/// JavaScript's `meta || {}` for the `undefined`/`null` case.
pub fn build_log_entry(level: &str, category: &str, message: &str, metadata: Value) -> LogEntry {
    let meta = if metadata.is_null() { json!({}) } else { metadata };
    LogEntry {
        ts: now_millis(),
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        meta,
    }
}

/// Emits a single session-log entry to the Renderer_UI as a `log://entry` Tauri
/// event, replacing the legacy JS build's
/// `win.webContents.send('log:entry', ...)`.
///
/// The signature takes an [`AppHandle`] (rather than a specific `Window`) so
/// that both `#[tauri::command]` handlers and detached background tasks (the
/// watch/poll loop, Native_Helper stdout readers, the launch queue, ...) can
/// call it from anywhere they hold a handle, matching how the legacy JS backend calls
/// `sendLog` from both IPC handlers and spawned-process callbacks.
///
/// Emission is best-effort and never panics: like legacy JS runtime's `try { ... } catch {}`
/// wrapper (which also guards `win && !win.isDestroyed()`), any emit failure
/// (e.g. the window is gone during shutdown) is swallowed so logging can never
/// disrupt the operation that produced the log entry.
///
/// Ordering (Requirement 4.1): `emit` runs synchronously in call order, so
/// entries are delivered in the same relative order they are logged.
///
/// Redaction integration point (Task 4.2, Requirement 4.3): the legacy JS build's
/// bare `sendLog` does NOT itself redact — secret redaction is applied by the
/// `logBrowser` wrapper (which calls `redactSecrets` on the message and metadata
/// *before* calling `sendLog`). This module deliberately mirrors that split:
/// `send_log` stays a faithful, redaction-free emitter, while the ported
/// the legacy redaction helper logic (the [`redaction`] submodule) and the [`log_browser`]
/// wrapper that applies it live alongside it. Callers that handle secrets must go
/// through [`log_browser`], exactly as in the legacy JS build.
pub fn send_log(app: &AppHandle, level: &str, category: &str, message: &str, metadata: Value) {
    let entry = build_log_entry(level, category, message, metadata);
    // Best-effort, matching legacy JS runtime's swallow-all `try { ... } catch {}`.
    let _ = app.emit(LOG_ENTRY_EVENT, entry);
}

/// Diagnostic-log category used when a `#[tauri::command]` handler resolves to an
/// internal error (`Err`). Kept separate from the session-log categories so the
/// distinction between "user-facing session log" and "backend diagnostic log" is
/// explicit at the call site.
pub const COMMAND_ERROR_CATEGORY: &str = "ipc";

/// Centralized diagnostic logger for a command handler that resolved to an
/// internal error (Requirement 7.1: "THE Tauri_Backend SHALL log the error [and]
/// return a failure response to the caller").
///
/// This deliberately writes to the backend's standard error stream rather than
/// emitting a `log://entry` session-log event. In the legacy JS build, an
/// `legacy command handler` handler that fails does NOT call `sendLog` — it returns
/// `{ ok: false, error }` (or rejects) and, where it logs at all, uses
/// `console.error(...)` for diagnostics. Emitting a session-log entry for every
/// command failure would add log points the legacy JS build never produced,
/// violating the session-log scope-parity rule (Requirement 4.2). Routing
/// command errors here — the Rust equivalent of `console.error` — logs the error
/// centrally (Requirement 7.1) without widening the user-facing session-log scope
/// (Requirement 4.2).
///
/// This never panics and never emits a Tauri event, so it is safe to call from
/// any command body (including ones that hold no [`AppHandle`]).
pub fn log_command_error(command: &str, error: &str) {
    eprintln!("[ipc] command '{command}' resolved to an error: {error}");
}

/// Threads a command handler's `Result` through [`log_command_error`]: on `Err`
/// the failure is logged centrally, then the `Result` is returned UNCHANGED so
/// the caller (and thus the Renderer_UI) receives exactly the same success/failure
/// value it would have without logging (behavior-preserving; Requirement 7.1).
///
/// Wrapping a command body's result with this is the lightweight mechanism used
/// to satisfy "an internal error resolves to `Err(...)` ... with centralized error
/// logging via `logging.rs`": the handler still cannot panic on a fallible
/// operation (it returns `Err`), and every such `Err` is logged in one place.
pub fn log_command_result<T>(command: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(ref error) = result {
        log_command_error(command, error);
    }
    result
}

/// Current time in epoch milliseconds, the Rust equivalent of `Date.now()`.
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Fragment-based secret redaction, a direct algorithmic port of the
/// legacy JS build's the legacy redaction helper (Requirement 4.3; Requirement 6 of the
/// account-browser-launcher spec).
///
/// This is pure string/set logic with no OS dependency, so the port is a
/// mechanical rewrite of the same `buildFragmentSet` / `containsFragment` /
/// `onePass` / `redactStringWith` / `redactValue` functions, operating on
/// [`HashSet<String>`] and `&str` slices instead of JavaScript `Set`/strings.
///
/// # Guarantee
///
/// For the fixed minimum fragment length [`MIN_SECRET_FRAGMENT_LEN`], no output
/// produced by [`redact_secrets`] / [`redact_args`] may contain the secret value
/// OR any substring of it whose length is `>=` that minimum. A "fragment" is any
/// window of a secret at least this long, so a leaked prefix, suffix, or middle
/// slice of a cookie/token is scrubbed just like the whole value, while short
/// incidental overlaps with ordinary log text (below the threshold) are left
/// readable.
///
/// # Unicode note
///
/// JavaScript strings are UTF-16 and the legacy redaction helper windows by code unit. This
/// port windows by Unicode scalar value (`char`), collecting each string into a
/// `Vec<char>` before slicing so a multi-byte character can never split a window
/// on a non-`char` boundary. For the secret set this module actually protects
/// (ASCII cookie/`.ROBLOSECURITY` and Donut API token values) `char`-windowing
/// and UTF-16-code-unit-windowing coincide, so behavior matches the
/// legacy JS build for every real input.
pub mod redaction {
    use serde_json::{Map, Value};
    use std::collections::HashSet;

    /// The fixed minimum fragment length (`MIN_SECRET_FRAGMENT_LEN = 8` in
    /// the legacy redaction helper). Any run of `>=` this many characters that occurs inside a
    /// known secret is treated as sensitive and masked.
    pub const MIN_SECRET_FRAGMENT_LEN: usize = 8;

    /// Human-readable marker left in place of a stripped secret fragment
    /// (`DEFAULT_MASK` in the legacy redaction helper). Purely cosmetic: correctness never
    /// depends on the mask (see [`redact_string_with`], which falls back to
    /// empty-string stripping if a mask ever interacts badly).
    pub const DEFAULT_MASK: &str = "[redacted]";

    /// Builds the set of every length-`min_len` window of every secret. Removing
    /// all of these from a string is what guarantees no `>= min_len` substring of
    /// any secret survives: any longer secret slice necessarily contains a
    /// length-`min_len` window, so eliminating the windows eliminates the longer
    /// slices too.
    ///
    /// Ports `buildFragmentSet`. Secrets shorter than `min_len` contribute
    /// nothing (matching the JS `s.length < minLen` skip).
    pub fn build_fragment_set(secrets: &[String], min_len: usize) -> HashSet<String> {
        let mut set = HashSet::new();
        if min_len == 0 {
            return set;
        }
        for s in secrets {
            let chars: Vec<char> = s.chars().collect();
            if chars.len() < min_len {
                continue;
            }
            for i in 0..=(chars.len() - min_len) {
                set.insert(chars[i..i + min_len].iter().collect::<String>());
            }
        }
        set
    }

    /// True iff `text` contains any length-`min_len` fragment from `frags`.
    ///
    /// Ports `containsFragment`.
    pub fn contains_fragment(text: &str, frags: &HashSet<String>, min_len: usize) -> bool {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() < min_len || frags.is_empty() {
            return false;
        }
        for i in 0..=(chars.len() - min_len) {
            let window: String = chars[i..i + min_len].iter().collect();
            if frags.contains(&window) {
                return true;
            }
        }
        false
    }

    /// One left-to-right redaction pass: every maximal region whose every
    /// length-`min_len` window is a secret fragment collapses to a single `mask`.
    /// Non-matching text is copied verbatim.
    ///
    /// Ports `onePass`. The extend loop advances one character at a time while the
    /// window *ending* at the current position is still a fragment
    /// (`text.slice(j - minLen + 1, j + 1)` in the JS), producing the same
    /// maximal-span collapse.
    pub fn one_pass(text: &str, frags: &HashSet<String>, min_len: usize, mask: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let n = chars.len();
        let mut out = String::new();
        let mut i = 0;
        while i < n {
            let starts_fragment = i + min_len <= n && {
                let window: String = chars[i..i + min_len].iter().collect();
                frags.contains(&window)
            };
            if starts_fragment {
                // Extend across the maximal span every trailing window of which is
                // a fragment.
                let mut j = i + min_len;
                while j < n {
                    let window: String = chars[j - min_len + 1..=j].iter().collect();
                    if frags.contains(&window) {
                        j += 1;
                    } else {
                        break;
                    }
                }
                out.push_str(mask);
                i = j;
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    /// Strips every `>= min_len` secret fragment from a single string.
    ///
    /// Ports `redactStringWith`. Runs the masking pass to a fixpoint (bounded at
    /// 50 iterations, matching the JS) so any fragment newly exposed by an earlier
    /// replacement is also caught; iteration stops as soon as a pass makes no
    /// change (`next == cur`). As a bulletproof backstop, if a (non-empty) mask
    /// ever interacts with surrounding text to leave a fragment behind, it
    /// re-strips with an empty mask (bounded at 1000 iterations, matching the JS)
    /// — which strictly shortens the string each pass and so terminates while
    /// provably removing all remaining fragments.
    pub fn redact_string_with(
        text: &str,
        frags: &HashSet<String>,
        min_len: usize,
        mask: &str,
    ) -> String {
        if frags.is_empty() || text.chars().count() < min_len {
            return text.to_string();
        }
        let mut cur = text.to_string();
        for _ in 0..50 {
            let next = one_pass(&cur, frags, min_len, mask);
            if next == cur {
                break;
            }
            cur = next;
        }
        if contains_fragment(&cur, frags, min_len) {
            let mut pass = 0;
            while pass < 1000 && contains_fragment(&cur, frags, min_len) {
                cur = one_pass(&cur, frags, min_len, "");
                pass += 1;
            }
        }
        cur
    }

    /// Recursively redacts a JSON value: strings are scrubbed, arrays/objects are
    /// walked (both keys and values, in case a secret ends up used as an object
    /// key), and everything else (numbers, bools, null) is returned unchanged.
    ///
    /// Ports `redactValue`. The JS circular-reference guard (`seen`) is
    /// unnecessary here: [`serde_json::Value`] is an owned, acyclic tree, so no
    /// `[circular]` case can arise.
    pub fn redact_value(
        value: &Value,
        frags: &HashSet<String>,
        min_len: usize,
        mask: &str,
    ) -> Value {
        match value {
            Value::String(s) => Value::String(redact_string_with(s, frags, min_len, mask)),
            Value::Array(arr) => Value::Array(
                arr.iter()
                    .map(|v| redact_value(v, frags, min_len, mask))
                    .collect(),
            ),
            Value::Object(map) => {
                let mut out = Map::new();
                for (k, v) in map {
                    let rk = redact_string_with(k, frags, min_len, mask);
                    out.insert(rk, redact_value(v, frags, min_len, mask));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    /// Picks the effective mask: the caller's mask, unless that mask itself
    /// contains a secret fragment (which would defeat the purpose), in which case
    /// empty-string stripping is used instead.
    ///
    /// Ports `effectiveMask`.
    pub fn effective_mask<'a>(mask: &'a str, frags: &HashSet<String>, min_len: usize) -> &'a str {
        if contains_fragment(mask, frags, min_len) {
            ""
        } else {
            mask
        }
    }

    /// Redacts any secret fragments out of a log message string, a metadata
    /// object/array, or any nested combination thereof, using
    /// [`MIN_SECRET_FRAGMENT_LEN`] and [`DEFAULT_MASK`].
    ///
    /// Ports the public `redactSecrets`. Returns a new, scrubbed value; the input
    /// is never mutated. Passing no/short/empty secrets is a no-op that clones the
    /// value unchanged (the fragment set comes out empty).
    pub fn redact_secrets(value: &Value, secrets: &[String]) -> Value {
        redact_secrets_with(value, secrets, MIN_SECRET_FRAGMENT_LEN, DEFAULT_MASK)
    }

    /// [`redact_secrets`] with an explicit minimum fragment length and mask,
    /// mirroring the JS `redactSecrets(value, secrets, { minLen, mask })` options.
    pub fn redact_secrets_with(
        value: &Value,
        secrets: &[String],
        min_len: usize,
        mask: &str,
    ) -> Value {
        let frags = build_fragment_set(secrets, min_len);
        if frags.is_empty() {
            return value.clone();
        }
        let mask = effective_mask(mask, &frags, min_len);
        redact_value(value, &frags, min_len, mask)
    }

    /// Convenience: redact secret fragments out of a plain message string using
    /// [`MIN_SECRET_FRAGMENT_LEN`] and [`DEFAULT_MASK`]. Equivalent to
    /// [`redact_secrets`] on a [`Value::String`], returning a `String` directly.
    pub fn redact_string(text: &str, secrets: &[String]) -> String {
        let frags = build_fragment_set(secrets, MIN_SECRET_FRAGMENT_LEN);
        if frags.is_empty() {
            return text.to_string();
        }
        let mask = effective_mask(DEFAULT_MASK, &frags, MIN_SECRET_FRAGMENT_LEN);
        redact_string_with(text, &frags, MIN_SECRET_FRAGMENT_LEN, mask)
    }

    /// Redacts any secret fragments out of an argument list constructed for an
    /// external process. Returns a new vector; each entry is scrubbed with
    /// [`MIN_SECRET_FRAGMENT_LEN`] / [`DEFAULT_MASK`].
    ///
    /// Ports the public `redactArgs`. (The JS "non-string entries pass through"
    /// clause is moot here because Rust process args are already `String`s.)
    pub fn redact_args(args: &[String], secrets: &[String]) -> Vec<String> {
        let frags = build_fragment_set(secrets, MIN_SECRET_FRAGMENT_LEN);
        if frags.is_empty() {
            return args.to_vec();
        }
        let mask = effective_mask(DEFAULT_MASK, &frags, MIN_SECRET_FRAGMENT_LEN);
        args.iter()
            .map(|a| redact_string_with(a, &frags, MIN_SECRET_FRAGMENT_LEN, mask))
            .collect()
    }
}

/// Builds the account-identifying fields for a log entry about an action
/// involving that account's cookie (account-browser-launcher Requirement 6.3 /
/// design Property 18). Includes the `username` when present and the `userId`
/// when present, guaranteeing at least one of the two is emitted whenever either
/// is available — and never the cookie itself. Absent/empty identifiers are
/// simply omitted.
///
/// Ports `accountLogIdentity`. The [`Account`] struct types `username` and
/// `user_id` as `String` (not `Option`), so "present" here means non-empty,
/// matching the JS `!= null && !== ''` guard.
pub fn account_log_identity(account: &Account) -> Value {
    let mut out = Map::new();
    if !account.username.is_empty() {
        out.insert("username".to_string(), Value::String(account.username.clone()));
    }
    if !account.user_id.is_empty() {
        out.insert("userId".to_string(), Value::String(account.user_id.clone()));
    }
    Value::Object(out)
}

/// Gathers every secret that could otherwise leak from the browser launcher: the
/// stored Donut_API_Token (decrypted only in memory) plus any cookie value(s)
/// the caller is currently handling.
///
/// Ports `launcherSecrets`. In the legacy JS build this function calls
/// `getDonutToken()` itself; the Tauri Settings_Store / token-decryption module
/// that provides that value is ported in a later task, so the decrypted token is
/// threaded in here as `donut_token` (integration point). `extra_secrets` carries
/// any cookie value the caller is handling, so redaction can strip it from log
/// text/metadata even though the cookie is never intentionally logged. Empty
/// strings are dropped, matching the JS `if (typeof e === 'string' && e)` guard.
pub fn launcher_secrets(donut_token: Option<&str>, extra_secrets: &[&str]) -> Vec<String> {
    let mut secrets = Vec::new();
    if let Some(token) = donut_token {
        if !token.is_empty() {
            secrets.push(token.to_string());
        }
    }
    for e in extra_secrets {
        if !e.is_empty() {
            secrets.push((*e).to_string());
        }
    }
    secrets
}

/// [`send_log`] wrapper for every Account_Browser_Launcher log entry, ported from
/// the legacy JS build's `logBrowser`. It:
///   1. forces the `browser` log category,
///   2. strips any cookie/Donut_API_Token fragment from the message text and the
///      metadata *before* it is emitted (Requirement 4.3 / launcher Req 6.1, 6.4),
///      and
///   3. when an `account` is supplied, stamps the entry with that account's
///      `username` and/or `userId` so cookie-related actions are always
///      attributable (launcher Req 6.3 / design Property 18).
///
/// `cookie` is accepted ONLY so its value is added to the redaction set; it is
/// never placed into the message or metadata. `donut_token` is the decrypted
/// Donut_API_Token to protect (see [`launcher_secrets`]).
///
/// Mirrors the JS `stamped = account ? { ...(meta||{}), ...accountLogIdentity(account) } : (meta||{})`:
/// identity fields are merged last so a cookie-action entry always carries
/// whichever of `username`/`userId` is available. A `Null` metadata normalizes to
/// an empty object, matching `meta || {}`.
#[allow(clippy::too_many_arguments)]
pub fn log_browser(
    app: &AppHandle,
    level: &str,
    message: &str,
    meta: Value,
    account: Option<&Account>,
    cookie: Option<&str>,
    donut_token: Option<&str>,
) {
    let extras: Vec<&str> = cookie.into_iter().collect();
    let secrets = launcher_secrets(donut_token, &extras);

    let stamped = if let Some(acc) = account {
        // `{ ...(meta || {}), ...accountLogIdentity(account) }`.
        let mut obj = match meta {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Value::Object(identity) = account_log_identity(acc) {
            for (k, v) in identity {
                obj.insert(k, v);
            }
        }
        Value::Object(obj)
    } else if meta.is_null() {
        // `meta || {}`.
        Value::Object(Map::new())
    } else {
        meta
    };

    let safe_message = redaction::redact_string(message, &secrets);
    let safe_meta = redaction::redact_secrets(&stamped, &secrets);
    send_log(app, level, "browser", &safe_message, safe_meta);
}

/// Redacts any cookie/Donut_API_Token fragment out of an argument list before it
/// is handed to an external process (launcher Req 6.2, 6.5). Defense in depth for
/// any spawn site that touches a secret.
///
/// Ports `redactExternalArgs`.
pub fn redact_external_args(
    args: &[String],
    donut_token: Option<&str>,
    extra_secrets: &[&str],
) -> Vec<String> {
    redaction::redact_args(args, &launcher_secrets(donut_token, extra_secrets))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_entry_serializes_with_legacy_field_names() {
        let entry = LogEntry {
            ts: 1_700_000_000_000,
            level: "ok".to_string(),
            category: "launch".to_string(),
            message: "Launched Roblox".to_string(),
            meta: json!({ "accountId": "abc", "pid": 1234 }),
        };
        let v = serde_json::to_value(&entry).unwrap();
        // The renderer reads exactly these keys off the payload.
        assert_eq!(v["ts"], json!(1_700_000_000_000i64));
        assert_eq!(v["level"], json!("ok"));
        assert_eq!(v["category"], json!("launch"));
        assert_eq!(v["message"], json!("Launched Roblox"));
        assert_eq!(v["meta"], json!({ "accountId": "abc", "pid": 1234 }));
        // The metadata field must be named `meta`, not `metadata` (legacy JS runtime parity).
        assert!(v.get("metadata").is_none());
    }

    #[test]
    fn build_log_entry_defaults_null_metadata_to_empty_object() {
        // Mirrors legacy JS runtime's `meta: meta || {}`.
        let entry = build_log_entry("warn", "afk", "Anti-AFK stopped", Value::Null);
        assert_eq!(entry.meta, json!({}));
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.category, "afk");
        assert_eq!(entry.message, "Anti-AFK stopped");
    }

    #[test]
    fn build_log_entry_preserves_supplied_metadata() {
        let entry = build_log_entry("info", "afk", "tapped windows", json!({ "windows": 2 }));
        assert_eq!(entry.meta, json!({ "windows": 2 }));
    }

    #[test]
    fn log_command_result_returns_ok_unchanged() {
        // The Ok value must pass through untouched (behavior-preserving).
        let out: Result<i32, String> = log_command_result("some_command", Ok(42));
        assert_eq!(out, Ok(42));
    }

    #[test]
    fn log_command_result_returns_err_unchanged() {
        // An internal error still resolves to the SAME Err the caller expects
        // (logging is a side effect only; the failure value is preserved).
        let out: Result<i32, String> =
            log_command_result("some_command", Err("boom".to_string()));
        assert_eq!(out, Err("boom".to_string()));
    }

    // ── redaction submodule ────────────────────────────────────────────────
    mod redaction_tests {
        use super::super::redaction::*;
        use proptest::prelude::*;
        use serde_json::{json, Value};

        const MIN: usize = MIN_SECRET_FRAGMENT_LEN;

        /// Asserts no `>= MIN`-length substring of `secret` survives in `text`.
        fn assert_no_fragment_survives(text: &str, secret: &str) {
            let s: Vec<char> = secret.chars().collect();
            let t: Vec<char> = text.chars().collect();
            if s.len() < MIN {
                return;
            }
            for i in 0..=(s.len() - MIN) {
                for len in MIN..=(s.len() - i) {
                    let frag: String = s[i..i + len].iter().collect();
                    let frag_chars: Vec<char> = frag.chars().collect();
                    let present = t
                        .windows(frag_chars.len())
                        .any(|w| w == frag_chars.as_slice());
                    assert!(
                        !present,
                        "fragment {:?} (len {}) of secret leaked into output {:?}",
                        frag, len, text
                    );
                }
            }
        }

        #[test]
        fn build_fragment_set_windows_every_min_len_slice() {
            // "abcdefghij" has 3 windows of length 8: [0..8], [1..9], [2..10].
            let frags = build_fragment_set(&["abcdefghij".to_string()], MIN);
            assert_eq!(frags.len(), 3);
            assert!(frags.contains("abcdefgh"));
            assert!(frags.contains("bcdefghi"));
            assert!(frags.contains("cdefghij"));
        }

        #[test]
        fn build_fragment_set_skips_secrets_shorter_than_min_len() {
            let frags = build_fragment_set(&["short".to_string()], MIN);
            assert!(frags.is_empty());
        }

        #[test]
        fn redact_full_secret_is_masked() {
            let secret = "SUPERSECRETTOKEN123456";
            let frags = build_fragment_set(&[secret.to_string()], MIN);
            let mask = effective_mask(DEFAULT_MASK, &frags, MIN);
            let out = redact_string_with(secret, &frags, MIN, mask);
            assert_eq!(out, DEFAULT_MASK);
            assert_no_fragment_survives(&out, secret);
        }

        #[test]
        fn redact_embedded_and_partial_secret_leaves_surrounding_text() {
            let secret = "abcdefghijklmnop";
            // A middle slice (>= MIN) embedded in ordinary text must be scrubbed,
            // while the surrounding text survives.
            let out = redact_string(
                "before abcdefghijkl after",
                &[secret.to_string()],
            );
            assert!(out.starts_with("before "));
            assert!(out.ends_with(" after"));
            assert!(out.contains(DEFAULT_MASK));
            assert_no_fragment_survives(&out, secret);
        }

        #[test]
        fn short_incidental_overlap_below_threshold_is_left_readable() {
            // A 7-char overlap (< MIN = 8) is not a fragment and stays put.
            let out = redact_string("the word abcdefg is fine", &["abcdefgXYZ123".to_string()]);
            assert_eq!(out, "the word abcdefg is fine");
        }

        #[test]
        fn empty_string_strip_fallback_when_mask_leaks_a_fragment() {
            // If the caller's mask itself contains a secret fragment, effective_mask
            // switches to empty-string stripping so the mask can't reintroduce a leak.
            let secret = "MASKMASKMASK";
            let frags = build_fragment_set(&[secret.to_string()], MIN);
            let mask = effective_mask("MASKMASK-here", &frags, MIN);
            assert_eq!(mask, "", "a mask containing a fragment must fall back to empty");
            let out = redact_secrets_with(
                &json!("prefix MASKMASKMASK suffix"),
                &[secret.to_string()],
                MIN,
                "MASKMASK-here",
            );
            assert_eq!(out, json!("prefix  suffix"));
        }

        #[test]
        fn fixpoint_catches_fragments_exposed_by_earlier_replacement() {
            // Two secrets that, once the first is stripped, splice into a fragment of
            // the second at the seam. Fixpoint iteration must catch the exposed one.
            let secrets = vec!["11112222".to_string(), "AAAABBBB".to_string()];
            let out = redact_string("xxAAAA11112222BBBBxx", &secrets);
            assert_no_fragment_survives(&out, "11112222");
            assert_no_fragment_survives(&out, "AAAABBBB");
        }

        #[test]
        fn redact_value_recurses_over_arrays_objects_and_keys() {
            let secret = "TOPSECRET-VALUE-XYZ";
            let value = json!({
                "note": "leak: TOPSECRET-VALUE-XYZ here",
                "nested": ["clean", "TOPSECRET-VALUE-XYZ"],
                "count": 3,
                "flag": true,
                "TOPSECRET-VALUE-XYZ": "keyed by the secret"
            });
            let out = redact_secrets(&value, &[secret.to_string()]);
            // Non-string scalars are untouched.
            assert_eq!(out["count"], json!(3));
            assert_eq!(out["flag"], json!(true));
            // No secret fragment survives anywhere in the serialized output.
            assert_no_fragment_survives(&serde_json::to_string(&out).unwrap(), secret);
            // The secret used as a key is scrubbed too (no such key remains).
            assert!(out.get(secret).is_none());
        }

        #[test]
        fn empty_or_short_secrets_are_a_noop() {
            let value = json!({ "msg": "nothing to hide here" });
            assert_eq!(redact_secrets(&value, &[]), value);
            assert_eq!(redact_secrets(&value, &["tiny".to_string()]), value);
        }

        #[test]
        fn redact_args_scrubs_each_entry() {
            let secret = "COMMANDLINESECRET99";
            let args = vec![
                "--flag".to_string(),
                "value-COMMANDLINESECRET99-tail".to_string(),
            ];
            let out = redact_args(&args, &[secret.to_string()]);
            assert_eq!(out[0], "--flag");
            assert_no_fragment_survives(&out[1], secret);
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            // Feature: native-tauri-backend, Property 13: Log redaction removes every secret fragment at or above the minimum length
            //
            // For an arbitrary secret embedded (in full and in a truncated slice) in
            // arbitrary surrounding text — both as a plain message string and nested
            // inside a JSON metadata value (string field, array element, and object
            // key) — redaction with that secret in the active set leaves NO substring
            // of length >= MIN_SECRET_FRAGMENT_LEN that also occurs in the secret.
            //
            // Secrets are drawn from the ASCII cookie/token domain (`.ROBLOSECURITY`
            // and Donut API token characters). These are JSON-safe (no `"`/`\`), so a
            // surviving secret window can never be an artifact of JSON escaping, and
            // ASCII means the port's per-`char` windowing coincides with the survival
            // check below (Unicode note in the `redaction` module docs).
            #[test]
            fn prop_redaction_removes_every_secret_fragment(
                secret in "[A-Za-z0-9._%+/=|-]{1,48}",
                prefix in "[ -~]{0,32}",
                suffix in "[ -~]{0,32}",
                frag_offset in 0usize..64,
                frag_take in 0usize..64,
            ) {
                let secrets = vec![secret.clone()];
                let s_chars: Vec<char> = secret.chars().collect();

                // A slice of the secret at an arbitrary offset/length. May be a full
                // fragment (>= MIN), a short (< MIN) prefix/suffix/middle, or empty —
                // exercising the "truncated / embedded within other text" cases.
                let partial: String = {
                    let start = frag_offset % s_chars.len();
                    let max_take = s_chars.len() - start;
                    let take = frag_take % (max_take + 1);
                    s_chars[start..start + take].iter().collect()
                };

                // 1) Plain message string: the whole secret appears twice (so a seam
                //    is formed) plus the truncated slice, all wrapped in arbitrary text.
                let message = format!("{prefix}{secret}{suffix}{secret} [{partial}]");
                let redacted_msg = redact_string(&message, &secrets);
                assert_no_fragment_survives(&redacted_msg, &secret);

                // 2) JSON metadata value: secret embedded in a string field, inside an
                //    array, and used as an object key — redacted recursively.
                let mut map = serde_json::Map::new();
                map.insert(
                    "note".to_string(),
                    Value::String(format!("token={secret} tail")),
                );
                map.insert("partial".to_string(), Value::String(partial.clone()));
                map.insert(
                    "nested".to_string(),
                    json!([prefix, secret, suffix, partial]),
                );
                // The secret itself used as an object key must be scrubbed too.
                map.insert(secret.clone(), Value::String("keyed".to_string()));
                let value = Value::Object(map);

                let redacted_val = redact_secrets(&value, &secrets);
                let serialized = serde_json::to_string(&redacted_val).unwrap();
                assert_no_fragment_survives(&serialized, &secret);
            }
        }
    }

    #[test]
    fn account_log_identity_includes_present_fields_only() {
        let mut account = Account {
            id: "id1".to_string(),
            username: "alice".to_string(),
            user_id: "42".to_string(),
            nickname: String::new(),
            cookie: String::new(),
            created_at: String::new(),
            last_used: None,
            donut_profile_id: None,
            donut_profile_pending_delete: false,
            extra: serde_json::Map::new(),
        };
        assert_eq!(
            account_log_identity(&account),
            json!({ "username": "alice", "userId": "42" })
        );

        account.user_id = String::new();
        assert_eq!(account_log_identity(&account), json!({ "username": "alice" }));

        account.username = String::new();
        assert_eq!(account_log_identity(&account), json!({}));
    }

    #[test]
    fn launcher_secrets_gathers_token_and_nonempty_extras() {
        assert_eq!(
            launcher_secrets(Some("tok"), &["cookieval", ""]),
            vec!["tok".to_string(), "cookieval".to_string()]
        );
        assert_eq!(launcher_secrets(None, &[]), Vec::<String>::new());
        assert_eq!(launcher_secrets(Some(""), &["x"]), vec!["x".to_string()]);
    }

    // ── command-error isolation (Property 14) ───────────────────────────────
    //
    // Real `#[tauri::command]` handlers need a live Tauri runtime + `AppHandle`,
    // which can't be spun up in a unit test. But every handler funnels its
    // fallible work through the same seam this module owns:
    // `logging::log_command_result(name, core())`, where `core()` is a closure
    // returning `Result<_, String>` and `?` turns any internal error into an
    // `Err(...)` instead of a panic (see `accounts.rs`, `commands.rs`,
    // `packages.rs`, `window.rs`, `browser_launcher.rs`). Modeling the property
    // at that seam is the faithful, runtime-free way to exercise Property 14.
    mod command_error_isolation_tests {
        use super::super::log_command_result;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            // Feature: native-tauri-backend, Property 14: An error while handling one command does not crash the backend or block subsequent commands
            //
            // For an arbitrary sequence of command invocations where some hit an
            // injected internal error and some succeed, driven through the shared
            // command-dispatch seam (`log_command_result` over a `Result`-returning
            // core closure):
            //   (a) every failing invocation resolves to `Err(...)` — never a panic
            //       or hang — and leaves the modeled backend state untouched (a
            //       failure is isolated and does not poison shared state), and
            //   (b) a subsequent, unrelated always-ok command still responds
            //       normally afterward, no matter how many prior commands failed.
            #[test]
            fn prop_command_error_is_isolated_and_next_command_responds(
                injected_errors in prop::collection::vec(any::<bool>(), 0..32),
                error_msg in "[ -~]{0,40}",
            ) {
                // `shared` models backend state that outlives individual commands
                // (the real `AppState`): each successful command advances it, and a
                // failing command must neither corrupt it nor block later commands.
                let shared = std::cell::Cell::new(0i64);

                // The dispatch seam: fallible work runs in a `Result`-returning core
                // closure (so `?`/early-return produce `Err`, never a panic), and the
                // result is threaded through the central logger UNCHANGED — exactly
                // how every registered command is wrapped.
                let run_handler = |should_fail: bool| -> Result<i64, String> {
                    let core = || -> Result<i64, String> {
                        if should_fail {
                            return Err(format!("internal: {error_msg}"));
                        }
                        let next = shared.get() + 1;
                        shared.set(next);
                        Ok(next)
                    };
                    log_command_result("modeled_command", core())
                };

                for &should_fail in &injected_errors {
                    let state_before = shared.get();
                    let result = run_handler(should_fail);
                    if should_fail {
                        // (a) A handled internal error resolves to Err, not a crash.
                        prop_assert!(result.is_err());
                        prop_assert_eq!(
                            result.unwrap_err(),
                            format!("internal: {error_msg}")
                        );
                        // The failure did not poison shared backend state.
                        prop_assert_eq!(shared.get(), state_before);
                    } else {
                        prop_assert!(result.is_ok());
                        prop_assert_eq!(result.unwrap(), state_before + 1);
                    }
                }

                // (b) A subsequent, unrelated always-ok command still responds
                // normally regardless of how many prior commands failed.
                let successes_so_far = shared.get();
                let follow_up = run_handler(false);
                prop_assert!(follow_up.is_ok());
                prop_assert_eq!(follow_up.unwrap(), successes_so_far + 1);
            }
        }
    }
}
