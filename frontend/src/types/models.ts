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
  /**
   * The account's login password, saved so the app can re-sign-in when the
   * cookie expires. Encrypted at rest by the backend (same format as `cookie`);
   * empty/absent when the user never attached credentials.
   */
  password?: string;
  /**
   * The login identifier (username or email) used to sign in, which may differ
   * from the cookie-resolved `username`. Used verbatim for re-login; falls back
   * to `username` when absent.
   */
  loginUsername?: string;
  createdAt: string;
  lastUsed: string | null;
  donutProfileId: string | null;
  donutProfilePendingDelete: boolean;

  /**
   * `true` when the account was added despite being under Roblox moderation
   * (via the "accept moderated accounts" toggle). Round-trips through the
   * backend's catch-all; used by the UI to flag the account.
   */
  moderated?: boolean;

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
  /** How account sessions reach the selected Roblox client. */
  robloxLaunchMode?: 'direct' | 'protocol';
  /** Installation id selected in the Clients control deck. */
  robloxLaunchPresetId?: string | null;
  /** Relaunch an account after its instance exits unexpectedly. */
  autoRelaunch?: boolean;
  /** Close an account's existing instance before launching it again. */
  replaceRunningInstance?: boolean;
  /** Arrange Roblox game windows into a grid as instances open/close. */
  windowLayoutEnabled?: boolean;
  /** Size the grid from the desktop work area instead of the target size. */
  windowAutoLayout?: boolean;
  /** Fixed grid-cell width in pixels for the manual window layout. */
  windowTargetWidth?: number;
  /** Fixed grid-cell height in pixels for the manual window layout. */
  windowTargetHeight?: number;
  /** Windows placed per grid row in the manual window layout. */
  windowPerRow?: number;
  /**
   * Milliseconds the backend waits between successive client spawns in a bulk
   * launch. Absent means the backend default (4000).
   */
  launchSpawnGapMs?: number;
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

export type RobloxLauncherKind =
  | 'official'
  | 'bloxstrap'
  | 'fishstrap'
  | 'froststrap'
  | 'voidstrap'
  | 'nyxstrap'
  | 'other_bootstrapper'
  | 'custom'
  | 'microsoft_store';

export type RobloxDetectionSource =
  | 'uninstall_registry'
  | 'protocol_registry'
  | 'known_path'
  | 'managed_deployment'
  | 'user_preset'
  | 'appx_registry';

export interface RobloxInstallation {
  id: string;
  kind: RobloxLauncherKind;
  displayName: string;
  executable: string | null;
  installLocation: string | null;
  displayVersion: string | null;
  versionGuid: string | null;
  channel: string | null;
  detectedBy: RobloxDetectionSource;
  protocolCapable: boolean;
  activeSchemes: Array<'roblox' | 'roblox-player'>;
  handlerCommand: string | null;
}

export interface ProtocolHandlerState {
  scheme: 'roblox' | 'roblox-player';
  command: string | null;
  executable: string | null;
  arguments: string[];
  installationId: string | null;
}

export interface RobloxProtocolState {
  roblox: ProtocolHandlerState;
  robloxPlayer: ProtocolHandlerState;
  snapshotAvailable: boolean;
}

export interface RobloxRelease {
  channel: string;
  versionGuid: string;
  clientVersion: string;
  bootstrapperVersion: string | null;
  checkedAt: number;
}

export interface RobloxDeployment {
  id: string;
  channel: string;
  versionGuid: string;
  clientVersion: string;
  installedAt: number;
  installLocation: string;
  executable: string;
  sizeBytes: number;
  source: 'setup-aws.rbxcdn.com';
}

/**
 * Everything the Clients deck reads, produced by a single backend sweep
 * (`roblox_clients_snapshot`). Protocol state is derived from the same
 * installation scan as `installations`, so requesting the three pieces together
 * costs one registry + disk walk instead of two.
 */
export interface RobloxClientsSnapshot {
  installations: RobloxInstallation[];
  protocol: RobloxProtocolState;
  deployments: RobloxDeployment[];
}

export type RobloxDeploymentStage =
  | 'resolving_manifest'
  | 'downloading'
  | 'extracting'
  | 'activating'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface RobloxDeploymentProgress {
  operationId: string;
  stage: RobloxDeploymentStage;
  channel: string;
  versionGuid: string | null;
  packageName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  message: string | null;
}

/**
 * Envelope returned by `weao_versions` / `weao_exploits`.
 *
 * `data` is `unknown` on purpose: the backend forwards the weao.xyz body
 * untouched because the live schema already contradicts its own documentation,
 * so the shape is narrowed by the defensive normalizer in `pages/Weao/weaoApi`
 * rather than being asserted here. A populated `data` alongside a non-null
 * `staleReason` is the normal degraded path — the backend serves its cached
 * copy instead of failing whenever it has one.
 */
export interface WeaoPayload {
  data: unknown;
  fetchedAt: number;
  fromCache: boolean;
  /** Stable reason id (`refresh_throttled`, `rate_limited`, `request_failed`). */
  staleReason: string | null;
  retryAfterMs: number | null;
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
