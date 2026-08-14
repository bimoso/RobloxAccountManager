//! Serde data models for the Account_Store (`accounts.json`) and Settings_Store
//! (`settings.json`).
//!
//! These structs mirror the exact on-disk JSON shapes the legacy JS build
//! (the legacy JS backend) already reads and writes, field-for-field, so that
//! `serde_json::from_str` -> `serde_json::to_string` round-trips through the same
//! JSON without any schema migration (Requirement 11.6, Requirement 13.3).
//!
//! Two rules make the round-trip lossless:
//!   1. Every camelCase JSON field name the legacy JS build uses is mapped with
//!      `#[serde(rename = ...)]` to its snake_case Rust counterpart, so the
//!      serialized bytes keep the original field names.
//!   2. Both structs carry a `#[serde(flatten)] extra: serde_json::Map<String, Value>`
//!      catch-all, so any unrecognized/legacy field present in an existing file
//!      (e.g. a stray `_deviceKey`, `customKeyEnc`, or a field not yet modeled)
//!      is preserved on a load-then-save round-trip rather than silently dropped.
//!      This mirrors the legacy JS build's habit of spreading (`{ ...s, ... }`)
//!      plain JS objects instead of validating against a fixed shape.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// How launches initiated by this application reach the selected Roblox
/// client. `Direct` preserves the existing multi-instance path; `Protocol`
/// delegates the completed `roblox-player:` URI to Windows' active handler.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RobloxLaunchMode {
    #[default]
    Direct,
    Protocol,
}

impl RobloxLaunchMode {
    fn is_direct(value: &Self) -> bool {
        matches!(value, Self::Direct)
    }
}

/// A single saved Roblox account, as persisted in the Account_Store
/// (`accounts.json`).
///
/// Field name mapping (Rust field -> JSON key), matching the legacy JS backend:
///   `user_id`                     -> `userId`
///   `created_at`                  -> `createdAt`
///   `last_used`                   -> `lastUsed`
///   `donut_profile_id`            -> `donutProfileId`
///   `donut_profile_pending_delete`-> `donutProfilePendingDelete`
///
/// `cookie` holds the encrypted-at-rest `.ROBLOSECURITY` value in the same
/// tag-prefixed format the legacy JS build uses. `donut_profile_id` /
/// `donut_profile_pending_delete` are stored unencrypted (they are not
/// credentials), consistent with the account-browser-launcher design.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub username: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    /// Legacy accounts saved before nicknames existed omit this field. Match the
    /// renderer's `nickname || username` behavior by treating it as blank.
    #[serde(default)]
    pub nickname: String,
    /// Encrypted at rest, same tag-prefixed format as the legacy JS build.
    pub cookie: String,
    /// The account's login password, stored so the app can re-sign-in when the
    /// cookie expires. Encrypted at rest exactly like [`Self::cookie`] (same
    /// tag-prefixed format); empty when the user never attached credentials.
    /// Optional in the on-disk JSON (defaulted on load) and omitted entirely when
    /// empty, so an account without saved credentials keeps its prior byte shape.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    /// The login identifier typed for this account (a username or email), which
    /// may differ from the cookie-resolved [`Self::username`] — e.g. when the
    /// account signs in with an email. Used verbatim for re-login; falls back to
    /// `username` when absent. Not a secret, so stored plaintext like `username`.
    /// Omitted from the JSON when absent to preserve the prior on-disk shape.
    #[serde(rename = "loginUsername", default, skip_serializing_if = "Option::is_none")]
    pub login_username: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastUsed")]
    pub last_used: Option<String>,
    /// Unencrypted, per the account-browser-launcher design.
    #[serde(rename = "donutProfileId")]
    pub donut_profile_id: Option<String>,
    #[serde(rename = "donutProfilePendingDelete", default)]
    pub donut_profile_pending_delete: bool,
    /// Catch-all preserving any unrecognized/legacy field on round-trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Application-wide settings, as persisted in the Settings_Store
/// (`settings.json`).
///
/// Every recognized field is optional/defaulted (container-level
/// `#[serde(default)]`) so a file missing a field simply gets that field's Rust
/// default (Requirement 11.2); the legacy JS build's documented runtime defaults
/// (e.g. `donutApiPort` = 10108, `pendingDonutDeletions` = []) are applied by the
/// settings-load logic in a later task, not baked into the struct's `Default`.
///
/// Field name mapping (Rust field -> JSON key), matching the legacy JS backend:
///   `multi_instance`         -> `multiInstance`
///   `anti_afk`               -> `antiAfk`
///   `anti_afk_interval`      -> `antiAfkInterval`
///   `key_verifier`           -> `keyVerifier`
///   `donut_api_token_enc`    -> `donutApiTokenEnc`
///   `donut_api_port`         -> `donutApiPort`
///   `pending_donut_deletions`-> `pendingDonutDeletions`
///   `multi_roblox_group_id`  -> `multiRobloxGroupId`
///   `master_volume`          -> `masterVolume`
///   `enc_setup_done`         -> `encSetupDone`
///
/// All remaining/legacy fields the legacy JS build may have written
/// (`customKey`, `customKeyEnc`, `encryptionType`, `_deviceKey`, etc.) are kept
/// via the `extra` catch-all rather than being modeled explicitly, so they
/// survive a load-then-save round-trip untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    #[serde(rename = "multiInstance")]
    pub multi_instance: bool,
    #[serde(rename = "antiAfk")]
    pub anti_afk: bool,
    #[serde(rename = "antiAfkInterval")]
    pub anti_afk_interval: Option<i64>,
    #[serde(rename = "keyVerifier")]
    pub key_verifier: Option<String>,
    #[serde(rename = "donutApiTokenEnc")]
    pub donut_api_token_enc: Option<String>,
    #[serde(rename = "donutApiPort")]
    pub donut_api_port: Option<u16>,
    #[serde(rename = "pendingDonutDeletions")]
    pub pending_donut_deletions: Vec<String>,
    #[serde(rename = "multiRobloxGroupId")]
    pub multi_roblox_group_id: Option<String>,
    #[serde(rename = "masterVolume")]
    pub master_volume: Option<f64>,
    #[serde(rename = "encSetupDone")]
    pub enc_setup_done: Option<bool>,
    /// Stable installation id selected in the Clients settings surface.
    #[serde(
        rename = "robloxLaunchPresetId",
        skip_serializing_if = "Option::is_none"
    )]
    pub roblox_launch_preset_id: Option<String>,
    /// Whether account launches spawn the preset directly or use the active
    /// Windows `roblox-player:` protocol handler.
    #[serde(
        rename = "robloxLaunchMode",
        skip_serializing_if = "RobloxLaunchMode::is_direct"
    )]
    pub roblox_launch_mode: RobloxLaunchMode,
    /// Relaunch an account automatically after its Roblox client exits
    /// unexpectedly (a watch-detected close; manual kills never relaunch).
    /// Absent (`None`) means disabled.
    #[serde(rename = "autoRelaunch", skip_serializing_if = "Option::is_none")]
    pub auto_relaunch: Option<bool>,
    /// Close an account's existing tracked Roblox process before launching it
    /// again, so each account keeps at most one client. Absent means disabled.
    #[serde(
        rename = "replaceRunningInstance",
        skip_serializing_if = "Option::is_none"
    )]
    pub replace_running_instance: Option<bool>,
    /// Arrange Roblox game windows into a grid as instances open and close.
    /// Absent means disabled.
    #[serde(
        rename = "windowLayoutEnabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub window_layout_enabled: Option<bool>,
    /// Size the grid cells from the desktop work area (`true`) instead of the
    /// fixed `windowTargetWidth`/`windowTargetHeight`. Absent means disabled.
    #[serde(rename = "windowAutoLayout", skip_serializing_if = "Option::is_none")]
    pub window_auto_layout: Option<bool>,
    /// Fixed grid-cell width in pixels for the manual window layout (350 when
    /// absent).
    #[serde(rename = "windowTargetWidth", skip_serializing_if = "Option::is_none")]
    pub window_target_width: Option<u32>,
    /// Fixed grid-cell height in pixels for the manual window layout (350 when
    /// absent).
    #[serde(
        rename = "windowTargetHeight",
        skip_serializing_if = "Option::is_none"
    )]
    pub window_target_height: Option<u32>,
    /// Windows placed per grid row in the manual window layout (1 when absent).
    #[serde(rename = "windowPerRow", skip_serializing_if = "Option::is_none")]
    pub window_per_row: Option<u32>,
    /// Minimum gap, in milliseconds, between two successive Roblox client
    /// spawns. Absent means the built-in default; the value is resolved and
    /// clamped at read time (`roblox_process::configured_spawn_gap_ms`) rather
    /// than by the load-time runtime defaults, so leaving it unset does not
    /// materialize a number into every user's `settings.json` on the next save.
    #[serde(rename = "launchSpawnGapMs", skip_serializing_if = "Option::is_none")]
    pub launch_spawn_gap_ms: Option<u64>,
    /// Catch-all preserving any unrecognized/legacy field on round-trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    //! Round-trip tests for the serde data models (Requirement 11.6).
    //!
    //! These assert that `serde_json::from_str` -> `serde_json::to_string`
    //! preserves every field name — both the recognized (renamed) fields and any
    //! unrecognized/legacy field carried through the `#[serde(flatten)] extra`
    //! catch-all. Equality is checked as `serde_json::Value` so key ordering is
    //! irrelevant; only the set of keys and their values must match.

    use super::{Account, Settings};
    use serde_json::Value;

    /// Deserialize `input` into `T`, re-serialize it, and assert the result is
    /// `Value`-equal to the original input (field names and values preserved,
    /// order-insensitive).
    fn assert_round_trip<T>(input: &str)
    where
        T: serde::de::DeserializeOwned + serde::Serialize,
    {
        let original: Value =
            serde_json::from_str(input).expect("fixture must be valid JSON");

        let model: T =
            serde_json::from_str(input).expect("fixture must deserialize into the model");
        let reserialized =
            serde_json::to_string(&model).expect("model must re-serialize to JSON");
        let round_tripped: Value =
            serde_json::from_str(&reserialized).expect("re-serialized JSON must parse");

        assert_eq!(
            original, round_tripped,
            "round-trip changed the JSON.\n  before: {original}\n  after:  {round_tripped}"
        );
    }

    #[test]
    fn account_round_trip_preserves_all_and_legacy_fields() {
        // A realistic accounts.json-shaped entry with every known Account field
        // present, PLUS unrecognized/legacy fields that must survive the
        // round-trip via `extra`.
        let input = r#"{
            "id": "acc_01HXYZ",
            "username": "exampleuser",
            "userId": "123456789",
            "nickname": "Main",
            "cookie": "gs:AQID.encryptedcookievalue",
            "createdAt": "2024-01-02T03:04:05.000Z",
            "lastUsed": "2024-06-07T08:09:10.000Z",
            "donutProfileId": "profile-abc",
            "donutProfilePendingDelete": true,
            "_legacyField": "should be preserved",
            "someOldKey": { "nested": [1, 2, 3], "flag": false },
            "legacyNumber": 42
        }"#;

        assert_round_trip::<Account>(input);
    }

    #[test]
    fn account_round_trip_with_null_optionals_and_no_extra() {
        // Optional fields explicitly null / minimal shape, no legacy fields.
        let input = r#"{
            "id": "acc_minimal",
            "username": "user2",
            "userId": "987654321",
            "nickname": "Alt",
            "cookie": "safe:AQIDdpapiblob",
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null,
            "donutProfileId": null,
            "donutProfilePendingDelete": false
        }"#;

        assert_round_trip::<Account>(input);
    }

    #[test]
    fn account_missing_legacy_nickname_defaults_to_empty_string() {
        let input = r#"{
            "id": "acc_legacy",
            "username": "legacyuser",
            "userId": "123456789",
            "cookie": "plain-cookie",
            "createdAt": "2024-01-01T00:00:00.000Z",
            "lastUsed": null
        }"#;

        let account: Account =
            serde_json::from_str(input).expect("legacy account without nickname must load");

        assert_eq!(account.nickname, "");
        assert_eq!(account.username, "legacyuser");
        assert_eq!(account.donut_profile_id, None);
        assert!(!account.donut_profile_pending_delete);
    }

    #[test]
    fn settings_round_trip_preserves_all_and_legacy_fields() {
        // A realistic settings.json-shaped object with every known Settings field
        // present, PLUS unrecognized/legacy fields that must survive via `extra`.
        let input = r#"{
            "multiInstance": true,
            "antiAfk": false,
            "antiAfkInterval": 300,
            "keyVerifier": "gs:AQID.verifiertoken",
            "donutApiTokenEnc": "gcm:AQID.encryptedtoken",
            "donutApiPort": 10108,
            "pendingDonutDeletions": ["profile-x", "profile-y"],
            "multiRobloxGroupId": "group-42",
            "masterVolume": 0.75,
            "encSetupDone": true,
            "customKey": "legacy-plaintext-key",
            "encryptionType": "cbc",
            "_deviceKey": "device-specific-blob",
            "someRemovedFeatureFlag": true
        }"#;

        assert_round_trip::<Settings>(input);
    }

    /// Assert that deserializing then re-serializing `input` as `T` preserves
    /// every field name present in `input` with its exact value. The output may
    /// be a superset (the `Settings` struct defaults absent recognized fields on
    /// serialize per Requirement 11.2), but it must never drop or alter a field
    /// that was present — recognized OR unrecognized/legacy.
    fn assert_preserves_all_input_fields<T>(input: &str)
    where
        T: serde::de::DeserializeOwned + serde::Serialize,
    {
        let original: Value =
            serde_json::from_str(input).expect("fixture must be valid JSON");

        let model: T =
            serde_json::from_str(input).expect("fixture must deserialize into the model");
        let round_tripped: Value = serde_json::to_value(&model)
            .expect("model must re-serialize to a JSON value");

        let original_obj = original.as_object().expect("fixture must be a JSON object");
        let out_obj = round_tripped
            .as_object()
            .expect("round-trip output must be a JSON object");

        for (key, value) in original_obj {
            match out_obj.get(key) {
                Some(round_tripped_value) => assert_eq!(
                    value, round_tripped_value,
                    "field `{key}` changed value across round-trip"
                ),
                None => panic!("field `{key}` was dropped across round-trip"),
            }
        }
    }

    #[test]
    fn settings_round_trip_empty_object_preserves_legacy_and_adds_only_known_defaults() {
        // An empty settings object has no fields to lose. Because recognized
        // fields are defaulted on serialize (Requirement 11.2), the output may
        // gain recognized keys — but it must NOT invent any unrecognized key.
        let input = r#"{}"#;
        assert_preserves_all_input_fields::<Settings>(input);

        let model: Settings = serde_json::from_str(input).unwrap();
        // The catch-all stays empty: no phantom/unknown fields are ever created.
        assert!(
            model.extra.is_empty(),
            "an empty settings object must not produce any unrecognized fields, got: {:?}",
            model.extra
        );
    }

    #[test]
    fn settings_round_trip_only_legacy_fields_are_all_preserved() {
        // A settings file that contains ONLY unrecognized/legacy fields (a real
        // possibility for an older on-disk file) must preserve every one of them,
        // untouched, via the `extra` catch-all.
        let input = r#"{
            "customKey": "abc",
            "encryptionType": "pbkdf2",
            "_deviceKey": "xyz",
            "legacyObject": { "a": 1, "b": [true, null, "s"] }
        }"#;
        assert_preserves_all_input_fields::<Settings>(input);
    }
}
