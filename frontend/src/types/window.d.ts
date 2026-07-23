// types/window.d.ts
//
// Ambient TypeScript types for `window.api`, the Tauri_Bridge exposed by
// `src-tauri/preload.js` (injected by Tauri at document-start).
//
// This declaration mirrors EVERY member of `window.api` defined in
// `src-tauri/preload.js` — same names, same parameter order, no additions, removals,
// or renames (Requirements 2.1, 2.2, 2.4). The React_Frontend adds types only;
// it never reimplements the IPC layer. `preload.js` remains the single source
// of truth for command names and parameter shapes.

import type {
  Account,
  Package,
  Settings,
  GenHistoryEntry,
  WayfernProgress,
  WayfernStatus,
  RobloxInstallation,
  RobloxProtocolState,
  RobloxRelease,
  RobloxDeployment,
  RobloxDeploymentProgress,
} from './models';

/** Handle returned by an event subscription; call it to unsubscribe (Tauri's `UnlistenFn`). */
export type UnlistenFn = () => void;

/** Payload of `chrome://download-progress`: browser-download progress reporting. */
export type ChromeDownloadProgress = unknown;

export interface BrowserOpenResult {
  ok: boolean;
  error?: string;
  focused?: boolean;
}

export interface BrowserOpenBatchItemResult extends BrowserOpenResult {
  accountId: string;
}

export interface BrowserOpenBatchResult {
  ok: boolean;
  opened: number;
  total: number;
  results: BrowserOpenBatchItemResult[];
}

/** Response of `roblox_get_avatar_thumbnails` (documented shape in preload.js). */
export interface AvatarThumbnailsResponse {
  data: Array<{ targetId: number; state: string; imageUrl: string }>;
}

/** One entry of the `roblox_get_presence` response (userPresenceType: 0/1/2/3). */
export interface RobloxUserPresence {
  userPresenceType: number;
  placeId: number | null;
  rootPlaceId: number | null;
  gameId: string | null;
  universeId: number | null;
  lastLocation: string;
  userId: number;
}

/** Response of `roblox_get_presence` (documented shape in preload.js). */
export interface PresenceResponse {
  userPresences: RobloxUserPresence[];
}

/** Response of `roblox_game_details` (documented shape in preload.js). */
export interface GameDetails {
  ok: boolean;
  name?: string;
  creator?: string;
  universeId?: number;
  playing?: number;
  iconUrl?: string;
}

/** Renderer-facing result returned by the `roblox_launch` Tauri command. */
export interface LaunchResult {
  success: boolean;
  error?: string;
}

/**
 * Result of the `roblox_arrange_windows` Tauri command: how many Roblox client
 * windows were detected and how many were actually moved into the grid.
 */
export interface ArrangeOutcome {
  found: number;
  placed: number;
}

/**
 * The exact `window.api` surface built by `src-tauri/preload.js`. Every member below
 * corresponds one-to-one, in order, to a member of that object.
 */
export interface TauriApi {
  // ── Window controls ──
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;

  // ── Account_Store ──
  loadAccounts: () => Promise<Account[]>;
  addAccount: (a: Account) => Promise<Account>;
  removeAccount: (id: string) => Promise<void>;
  updateAccount: (id: string, data: Partial<Account>) => Promise<Account>;
  reorderAccounts: (ids: string[]) => Promise<void>;

  // ── Packages ──
  loadPackages: () => Promise<Package[]>;
  savePackages: (packages: Package[]) => Promise<boolean>;

  // ── Login (CDP cookie-capture flow) ──
  openLogin: () => Promise<void>;
  /**
   * Open the login window pre-filled with `username` / `password` (typed with a
   * humanized cadence) and resolve once the session cookie is captured and
   * verified. Resolves to the same `{ success, cookie, username, userId }` /
   * `{ success, error }` shape as {@link openLogin}; callers narrow it locally.
   */
  loginCredentials: (username: string, password: string) => Promise<unknown>;
  cancelLogin: () => Promise<void>;

  // ── Roblox launch / process control ──
  validateCookie: (cookie: string) => Promise<unknown>;
  /**
   * Resolve moderation details for an account by username via public endpoints.
   * Resolves `{ found, userId?, displayName?, terminated }` — `terminated: true`
   * is a permanent ban; `false` on a moderated account means temporary.
   */
  moderationInfo: (username: string) => Promise<unknown>;
  /**
   * Generate an account via BloxGen, server-side (the webview blocks a direct
   * `fetch` to `core.bloxgen.net` under CORS). Resolves
   * `{ status, body }` — the HTTP status plus the parsed API response, so the
   * caller can surface the API's own `message` on a rejection.
   */
  bloxgenGenerate: (
    apiKey: string,
    accountType: string,
    region?: string,
  ) => Promise<unknown>;
  refreshCookie: (cookie: string) => Promise<string>;
  setRobloxVolume: (percent: number) => Promise<void>;
  killAllRoblox: () => Promise<void>;
  killOneRoblox: (id: string) => Promise<void>;
  getRunningCount: () => Promise<number>;
  getWindowCount: () => Promise<number>;
  arrangeWindows: () => Promise<ArrangeOutcome>;
  onAllRobloxClosed: (cb: () => void) => Promise<UnlistenFn>;
  launchRoblox: (id: string, cookie: string, target: string) => Promise<LaunchResult>;
  openExternal: (url: string) => Promise<void>;
  scanRobloxInstallations: () => Promise<RobloxInstallation[]>;
  addRobloxCustomPreset: (path: string, displayName?: string | null) => Promise<RobloxInstallation>;
  removeRobloxCustomPreset: (installationId: string) => Promise<boolean>;
  getRobloxProtocolState: () => Promise<RobloxProtocolState>;
  activateRobloxProtocol: (installationId: string) => Promise<RobloxProtocolState>;
  restoreRobloxProtocol: () => Promise<RobloxProtocolState>;
  getLatestRobloxRelease: (channel?: string | null) => Promise<RobloxRelease>;
  listRobloxDeployments: () => Promise<RobloxDeployment[]>;
  installRobloxDeployment: (
    operationId: string,
    channel?: string | null,
    versionGuid?: string | null,
  ) => Promise<RobloxDeployment>;
  cancelRobloxDeployment: (operationId: string) => Promise<boolean>;
  onRobloxDeploymentProgress: (
    cb: (payload: RobloxDeploymentProgress) => void,
  ) => Promise<UnlistenFn>;

  // ── Settings_Store ──
  loadSettings: () => Promise<Settings>;
  saveSettings: (data: Partial<Settings>) => Promise<boolean>;
  saveDonutToken: (t: string) => Promise<boolean>;

  // ── Encryption_Scheme ──
  encStatus: () => Promise<{ mode: 'setup' | 'locked' | 'unlocked' }>;
  encUnlock: (pass: string) => Promise<boolean>;
  encSetKey: (pass: string) => Promise<boolean>;

  // ── Native_Helper status ──
  multiInstanceStatus: () => Promise<boolean>;
  antiAfkStatus: () => Promise<boolean>;

  // ── Generator history ──
  readGenHistory: () => Promise<GenHistoryEntry[]>;
  writeGenHistory: (list: GenHistoryEntry[]) => Promise<boolean>;
  clearGenHistory: () => Promise<boolean>;

  // ── Fast flags / FPS cap ──
  readFFlags: () => Promise<unknown>;
  writeFFlags: (flags: unknown) => Promise<boolean>;
  readFpsCap: () => Promise<number>;
  writeFpsCap: (cap: number) => Promise<boolean>;

  // ── Push events ──
  onChromeProgress: (cb: (payload: ChromeDownloadProgress) => void) => Promise<UnlistenFn>;
  onRobloxClosed: (cb: (accountId: string) => void) => Promise<UnlistenFn>;
  onRobloxCount: (cb: (count: number) => void) => Promise<UnlistenFn>;
  onLogEntry: (cb: (payload: unknown) => void) => Promise<UnlistenFn>;

  // ── Roblox metadata ──
  getRobloxVersion: () => Promise<string>;
  getGameName: (placeId: string, cookie: string) => Promise<string>;
  getAvatarThumbnails: (userIds: Array<string | number>) => Promise<AvatarThumbnailsResponse>;
  robloxApiGet: (url: string) => Promise<unknown>;
  getPresence: (userIds: Array<string | number>, cookie: string) => Promise<PresenceResponse>;
  getGameDetails: (placeId: string, cookie: string) => Promise<GameDetails>;
  sendFriendRequest: (cookie: string, targetUserId: string | number) => Promise<unknown>;
  changePassword: (cookie: string, currentPassword: string, newPassword: string) => Promise<unknown>;
  changeDisplayName: (cookie: string, userId: string | number, newDisplayName: string) => Promise<unknown>;
  quickLogin: (cookie: string, code: string) => Promise<unknown>;

  // ── Account_Browser_Launcher ──
  openAccountBrowser: (id: string) => Promise<BrowserOpenResult>;
  openAccountBrowsers: (ids: string[]) => Promise<BrowserOpenBatchResult>;
  copyAccountCookie: (id: string) => Promise<unknown>;
  getWayfernStatus: () => Promise<WayfernStatus>;
  installWayfern: () => Promise<WayfernStatus>;
  onWayfernProgress: (cb: (payload: WayfernProgress) => void) => Promise<UnlistenFn>;
  onBrowserSessionState: (cb: (payload: unknown) => void) => Promise<UnlistenFn>;
}

declare global {
  interface Window {
    api: TauriApi;
  }
}
