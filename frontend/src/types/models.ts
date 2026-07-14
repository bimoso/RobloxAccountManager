// types/models.ts
//
// Domain model TypeScript types for the React_Frontend.
//
// These mirror exactly the JSON shapes the Tauri_Backend already produces and
// consumes (see `src-tauri/src/models.rs`, `src-tauri/src/packages.rs`, and the
// retired legacy consumer), preserving the original camelCase field
// names. Where a value is derived on the client (never persisted by the
// backend) it is marked optional and documented as such.
//
// The models here are the authoritative reconciliation of the design.md "Data
// Models" sketch against the actual Rust structs and the legacy renderer; where
// the design sketch and the real source disagreed, the real source wins.

/**
 * A single saved Roblox account, as persisted in the Account_Store
 * (`accounts.json`) and returned by `window.api.loadAccounts()`.
 *
 * Field-for-field mirror of the Rust `Account` struct in
 * `src-tauri/src/models.rs` (camelCase JSON names). The Rust struct carries a
 * `#[serde(flatten)] extra` catch-all that preserves unrecognized/legacy
 * fields on round-trip, mirrored here by the index signature.
 */
export interface Account {
  id: string;
  username: string;
  userId: string;
  /** Legacy accounts saved before nicknames existed omit this; treated as "". */
  nickname: string;
  /** Encrypted at rest; never shown in plain text in the UI. */
  cookie: string;
  createdAt: string;
  lastUsed: string | null;
  donutProfileId: string | null;
  donutProfilePendingDelete: boolean;

  // ── Client-derived state (not persisted by the backend) ──
  /** Cookie marked expired by the client-side re-check (Requirement 8.5). */
  cookieExpired?: boolean;
  /** Number of currently launched Roblox instances for this account. */
  launchedInstanceCount?: number;

  /** Catch-all for any unrecognized/legacy field preserved on round-trip. */
  [key: string]: unknown;
}

/**
 * A saved group of accounts, as persisted in the Packages store
 * (`packages.json`) and returned by `window.api.loadPackages()`.
 *
 * Packages are stored by the backend as arbitrary JSON (`Vec<Value>` in
 * `src-tauri/src/packages.rs`), so the authoritative shape comes from the
 * retired legacy renderer: `{ id, name, accountIds, link }`.
 * (Reconciliation: design.md sketched `privateServerLink`, but the renderer
 * uses `link` — the renderer is authoritative.)
 */
export interface Package {
  id: string;
  name: string;
  accountIds: string[];
  /** Private-server / last-launched link; created as "" by the renderer. */
  link?: string;
  /** Catch-all: packages round-trip as arbitrary JSON, so extra keys survive. */
  [key: string]: unknown;
}

/**
 * Application-wide settings, as persisted in the Settings_Store
 * (`settings.json`) and returned by `window.api.loadSettings()`.
 *
 * Field-for-field mirror of the Rust `Settings` struct in
 * `src-tauri/src/models.rs` (camelCase JSON names, all optional/defaulted).
 * (Reconciliation: the design.md sketch trimmed this to a UI-oriented subset
 * and added a derived `donutTokenConfigured`; the raw shape returned by
 * `settings_load` is the full Rust struct below. The Donut token status shown
 * in the UI (Requirement 21.4) is derived from `donutApiTokenEnc` by the
 * settings store/page, never by exposing its value.)
 */
export interface Settings {
  multiInstance: boolean;
  antiAfk: boolean;
  antiAfkInterval: number | null;
  keyVerifier: string | null;
  donutApiTokenEnc: string | null;
  donutApiPort: number | null;
  pendingDonutDeletions: string[];
  multiRobloxGroupId: string | null;
  masterVolume: number | null;
  encSetupDone: boolean | null;
  /** Browser backend used by the account "Open in browser" action. */
  browserProvider?: 'donut' | 'wayfern';
  /** Catch-all preserving any unrecognized/legacy field on round-trip. */
  [key: string]: unknown;
}

export interface WayfernStatus {
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface WayfernProgress {
  stage: 'downloading' | 'extracting' | 'ready';
  version: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

/** The 12 selectable themes, matching the ported legacy palettes. */
export type ThemeName =
  | 'dark' | 'light' | 'midnight' | 'aurora' | 'sunset' | 'crimson'
  | 'ocean' | 'grape' | 'forest' | 'amber' | 'rose' | 'graphite';

/** Accounts page layout mode (Requirement 8). */
export type AccountsView = 'grid' | 'list';

/** Accounts page filter (Requirement 9). */
export type AccountFilter = 'all' | 'running' | 'idle' | 'valid-first' | 'invalid-first';

/**
 * One generation-history entry, as persisted by `genhistory_read` /
 * `genhistory_write`.
 */
export interface GenHistoryEntry {
  username: string;
  password: string;
  createdAt: string;
}

/** A toast notification held by the ToastStore (Requirement 2.5–2.7, 25). */
export interface ToastMessage {
  id: string;
  kind: 'success' | 'error';
  text: string;
}

/** Roblox presence type: 0 Offline, 1 Online, 2 InGame, 3 InStudio. */
export type PresenceType = 0 | 1 | 2 | 3;

/** Client-side presence view for one account (derived from `roblox_get_presence`). */
export interface PresenceInfo {
  userId: string;
  type: PresenceType;
  placeId?: string;
  lastLocation?: string;
}

/**
 * Encryption_Gate mode. The raw `enc_status` command returns only `"setup"`,
 * `"locked"`, or `"unlocked"`; `"checking"` and `"bypassed"` are additional
 * client-side states used by the Encryption_Gate store (Requirement 7).
 */
export type EncryptionGateMode = 'checking' | 'setup' | 'locked' | 'unlocked' | 'bypassed';
