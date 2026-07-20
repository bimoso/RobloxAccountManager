// lib/ipc.ts
//
// Typed Tauri_Bridge wrapper.
//
// This module does NOT reimplement the IPC layer: it delegates directly to
// `window.api` (built by `src-tauri/preload.js`), which remains the single source of
// truth for command names, parameter order, and event-channel names
// (Requirements 2.1, 2.4). Every member below forwards to the `window.api`
// member of the same name with the same parameters, in order.
//
// The only behaviour this layer adds is centralized error reporting
// (Requirements 2.5, 2.6): when an IPC call made as the direct result of a
// user-initiated action rejects, the error is reported to the ToastStore so an
// error toast is shown. Background-polling calls (presence polling via
// `getPresence`, running-count polling via `getRunningCount`) and event
// subscriptions pass `userInitiated = false` so a transient failure on one
// tick does NOT flash an error toast; the owning store keeps its last known
// state and retries on the next cycle.
//
// After reporting (when applicable) the error is always re-thrown so the
// calling store/page can react locally (e.g. keep a modal open, show an inline
// message, or ignore it for a background tick).

import { reportIpcError } from '../stores/toastStore';
import type { ChromeDownloadProgress, TauriApi } from '../types/window';
import type { Account, GenHistoryEntry, Package, Settings, WayfernProgress, RobloxDeploymentProgress } from '../types/models';

/**
 * Generic delegating call to a `window.api` member.
 *
 * Awaits `window.api[fn](...args)`. On rejection: if `userInitiated` is `true`
 * the error is reported to the ToastStore (Requirements 2.5, 2.6); the error is
 * then always re-thrown so callers can react.
 *
 * @typeParam K - The `window.api` member key being invoked.
 * @param fn - The `window.api` member name (identical to the IPC command name).
 * @param args - The arguments tuple, in the exact order `window.api` expects.
 * @param userInitiated - `true` for direct user actions (report errors as a
 *   toast); `false` for background polling / event subscriptions (stay silent
 *   on a failed tick).
 * @returns The resolved value of the underlying `window.api` call.
 */
async function call<K extends keyof TauriApi>(
  fn: K,
  args: Parameters<TauriApi[K]>,
  userInitiated: boolean,
): Promise<Awaited<ReturnType<TauriApi[K]>>> {
  try {
    // `window.api[fn]` is correct at runtime, but TypeScript cannot correlate
    // the generic key `K` with the heterogeneous argument tuple, so we forward
    // through an untyped callable. The public `ipc` surface below restores
    // full, per-member type safety.
    const method = window.api[fn] as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    return (await method(...args)) as Awaited<ReturnType<TauriApi[K]>>;
  } catch (err) {
    if (userInitiated) {
      reportIpcError(err);
    }
    throw err;
  }
}

/**
 * Typed IPC surface consumed by the stores and pages.
 *
 * One member per `window.api` member, same name, same parameter order
 * (Requirements 2.1, 2.4). User-initiated calls report errors via a toast;
 * background-polling calls and event subscriptions are marked
 * `userInitiated = false` and stay silent on a failed tick (Requirement 2.5).
 */
export const ipc = {
  // ── Window controls ──
  minimize: () => call('minimize', [], true),
  maximize: () => call('maximize', [], true),
  close: () => call('close', [], true),

  // ── Account_Store ──
  loadAccounts: () => call('loadAccounts', [], true),
  addAccount: (a: Account) => call('addAccount', [a], true),
  removeAccount: (id: string) => call('removeAccount', [id], true),
  updateAccount: (id: string, data: Partial<Account>) =>
    call('updateAccount', [id, data], true),
  reorderAccounts: (ids: string[]) => call('reorderAccounts', [ids], true),

  // ── Packages ──
  loadPackages: () => call('loadPackages', [], true),
  savePackages: (packages: Package[]) => call('savePackages', [packages], true),

  // ── Login (CDP cookie-capture flow) ──
  openLogin: () => call('openLogin', [], true),
  loginCredentials: (username: string, password: string) =>
    call('loginCredentials', [username, password], true),
  cancelLogin: () => call('cancelLogin', [], true),

  // ── Roblox launch / process control ──
  validateCookie: (cookie: string) => call('validateCookie', [cookie], true),
  refreshCookie: (cookie: string) => call('refreshCookie', [cookie], true),
  setRobloxVolume: (percent: number) => call('setRobloxVolume', [percent], true),
  killAllRoblox: () => call('killAllRoblox', [], true),
  killOneRoblox: (id: string) => call('killOneRoblox', [id], true),
  // Background polling: the running-instance count is refreshed on a timer.
  getRunningCount: () => call('getRunningCount', [], false),
  // Background polling: the session panel refreshes the window count on a timer.
  getWindowCount: () => call('getWindowCount', [], false),
  arrangeWindows: () => call('arrangeWindows', [], true),
  // Event subscription: registered during setup, not a user action.
  onAllRobloxClosed: (cb: () => void) => call('onAllRobloxClosed', [cb], false),
  launchRoblox: (id: string, cookie: string, target: string) =>
    call('launchRoblox', [id, cookie, target], true),
  openExternal: (url: string) => call('openExternal', [url], true),
  scanRobloxInstallations: () => call('scanRobloxInstallations', [], false),
  addRobloxCustomPreset: (path: string, displayName?: string | null) =>
    call('addRobloxCustomPreset', [path, displayName], true),
  removeRobloxCustomPreset: (installationId: string) =>
    call('removeRobloxCustomPreset', [installationId], true),
  getRobloxProtocolState: () => call('getRobloxProtocolState', [], false),
  activateRobloxProtocol: (installationId: string) =>
    call('activateRobloxProtocol', [installationId], true),
  restoreRobloxProtocol: () => call('restoreRobloxProtocol', [], true),
  getLatestRobloxRelease: (channel?: string | null) =>
    call('getLatestRobloxRelease', [channel], false),
  listRobloxDeployments: () => call('listRobloxDeployments', [], false),
  installRobloxDeployment: (
    operationId: string,
    channel?: string | null,
    versionGuid?: string | null,
  ) => call('installRobloxDeployment', [operationId, channel, versionGuid], true),
  cancelRobloxDeployment: (operationId: string) =>
    call('cancelRobloxDeployment', [operationId], true),
  onRobloxDeploymentProgress: (cb: (payload: RobloxDeploymentProgress) => void) =>
    call('onRobloxDeploymentProgress', [cb], false),

  // ── Settings_Store ──
  loadSettings: () => call('loadSettings', [], true),
  saveSettings: (data: Partial<Settings>) => call('saveSettings', [data], true),
  saveDonutToken: (t: string) => call('saveDonutToken', [t], true),

  // ── Encryption_Scheme ──
  encStatus: () => call('encStatus', [], true),
  encUnlock: (pass: string) => call('encUnlock', [pass], true),
  encSetKey: (pass: string) => call('encSetKey', [pass], true),

  // ── Native_Helper status ──
  multiInstanceStatus: () => call('multiInstanceStatus', [], true),
  antiAfkStatus: () => call('antiAfkStatus', [], true),

  // ── Generator history ──
  readGenHistory: () => call('readGenHistory', [], true),
  writeGenHistory: (list: GenHistoryEntry[]) =>
    call('writeGenHistory', [list], true),
  clearGenHistory: () => call('clearGenHistory', [], true),

  // ── Fast flags / FPS cap ──
  readFFlags: () => call('readFFlags', [], true),
  writeFFlags: (flags: unknown) => call('writeFFlags', [flags], true),
  readFpsCap: () => call('readFpsCap', [], true),
  writeFpsCap: (cap: number) => call('writeFpsCap', [cap], true),

  // ── Push events (subscriptions: registered in the background) ──
  onChromeProgress: (cb: (payload: ChromeDownloadProgress) => void) =>
    call('onChromeProgress', [cb], false),
  onRobloxClosed: (cb: (accountId: string) => void) =>
    call('onRobloxClosed', [cb], false),
  onRobloxCount: (cb: (count: number) => void) =>
    call('onRobloxCount', [cb], false),
  onLogEntry: (cb: (payload: unknown) => void) =>
    call('onLogEntry', [cb], false),

  // ── Roblox metadata ──
  getRobloxVersion: () => call('getRobloxVersion', [], true),
  getGameName: (placeId: string, cookie: string) =>
    call('getGameName', [placeId, cookie], true),
  getAvatarThumbnails: (userIds: Array<string | number>) =>
    call('getAvatarThumbnails', [userIds], true),
  robloxApiGet: (url: string) => call('robloxApiGet', [url], true),
  // Background polling: presence is refreshed on a timer.
  getPresence: (userIds: Array<string | number>, cookie: string) =>
    call('getPresence', [userIds, cookie], false),
  getGameDetails: (placeId: string, cookie: string) =>
    call('getGameDetails', [placeId, cookie], true),
  sendFriendRequest: (cookie: string, targetUserId: string | number) =>
    call('sendFriendRequest', [cookie, targetUserId], true),
  changePassword: (cookie: string, currentPassword: string, newPassword: string) =>
    call('changePassword', [cookie, currentPassword, newPassword], true),
  changeDisplayName: (
    cookie: string,
    userId: string | number,
    newDisplayName: string,
  ) => call('changeDisplayName', [cookie, userId, newDisplayName], true),
  quickLogin: (cookie: string, code: string) =>
    call('quickLogin', [cookie, code], true),

  // ── Account_Browser_Launcher ──
  openAccountBrowser: (id: string) => call('openAccountBrowser', [id], true),
  openAccountBrowsers: (ids: string[]) =>
    call('openAccountBrowsers', [ids], true),
  copyAccountCookie: (id: string) => call('copyAccountCookie', [id], true),
  getWayfernStatus: () => call('getWayfernStatus', [], false),
  installWayfern: () => call('installWayfern', [], true),
  onWayfernProgress: (cb: (payload: WayfernProgress) => void) =>
    call('onWayfernProgress', [cb], false),
  // Event subscription: registered during setup, not a user action.
  onBrowserSessionState: (cb: (payload: unknown) => void) =>
    call('onBrowserSessionState', [cb], false),
} as const;
