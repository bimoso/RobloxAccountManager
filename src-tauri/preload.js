// preload.js — Tauri IPC adapter for the Renderer_UI.
//
// Builds the exact same flat `window.api.*` object that `renderer.js` already
// consumes, backed by Tauri v2's command/event system. Every member name,
// parameter order, and event callback payload shape is kept stable so
// `renderer.js` and `index.html` need no bundler or framework layer.
//
// Transport: this file is a plain (classic) script and relies on the globals
// Tauri injects when `app.withGlobalTauri = true` in `tauri.conf.json`:
//   * `window.__TAURI__.core.invoke`
//   * `window.__TAURI__.event.listen`
// Using the injected globals (rather than `import` from `@tauri-apps/api`) keeps
// the renderer bundler-free — no build step is introduced.
//
// Request/response: `invoke(cmd, args)` sends `args` as a keyed object whose keys
// match each Tauri command's Rust parameter names (snake_case).
//
// Events: Tauri's `listen` delivers an event object whose `.payload` carries what
// the backend passed when emitting. We unwrap `.payload` so each renderer
// callback receives the backend payload directly.
(function () {
  'use strict';

  // One-time diagnostic so we can see exactly which Tauri globals are present in
  // the webview (visible in devtools console). Helps confirm the invoke bridge.
  try {
    var t0 = window.__TAURI__;
    console.log('[preload] Tauri globals:', {
      hasTauri: !!t0,
      tauriKeys: t0 ? Object.keys(t0) : null,
      coreInvoke: !!(t0 && t0.core && typeof t0.core.invoke === 'function'),
      flatInvoke: !!(t0 && typeof t0.invoke === 'function'),
      hasInternals: !!window.__TAURI_INTERNALS__,
      internalsInvoke: !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function'),
    });
  } catch (e) {}

  // Request/response bridge.
  // Resolved robustly across Tauri v2 global shapes:
  //   * `window.__TAURI__.core.invoke`  (stable v2 + withGlobalTauri)
  //   * `window.__TAURI__.invoke`       (some builds expose it flat)
  //   * `window.__TAURI_INTERNALS__.invoke` (always injected by Tauri)
  // Resolving per-call avoids any load-order coupling. Returns the Promise
  // `invoke` produces: resolves with the command's `Ok` value, rejects with its
  // `Err` string — the same success/failure duality the renderer branches on.
  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args || {});
    if (t && typeof t.invoke === 'function') return t.invoke(cmd, args || {});
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    }
    return Promise.reject(new Error('Tauri invoke bridge unavailable (cmd: ' + cmd + ')'));
  }

  // Event subscription bridge. Hands the renderer callback the unwrapped
  // `.payload` so callers receive the backend payload directly.
  function on(channel, handler) {
    var t = window.__TAURI__;
    if (t && t.event && typeof t.event.listen === 'function') return t.event.listen(channel, handler);
    return Promise.resolve(function () {});
  }

  window.api = {
    // ── Window controls ──
    minimize: () => invoke('window_minimize'),
    maximize: () => invoke('window_maximize'),
    close: () => invoke('window_close'),

    // ── Account_Store ──
    loadAccounts: () => invoke('accounts_load'),
    addAccount: (a) => invoke('accounts_add', { account: a }),
    removeAccount: (id) => invoke('accounts_remove', { id }),
    updateAccount: (id, data) => invoke('accounts_update', { id, data }),
    reorderAccounts: (ids) => invoke('accounts_reorder', { ids }),

    // ── Packages ──
    loadPackages: () => invoke('packages_load'),
    savePackages: (packages) => invoke('packages_save', { packages }),

    // ── Login (CDP cookie-capture flow) ──
    openLogin: () => invoke('roblox_open_login'),
    loginCredentials: (username, password) =>
        invoke('roblox_login_credentials', { username, password }),
    cancelLogin: () => invoke('login_cancel'),

    // ── Roblox launch / process control ──
    validateCookie: (cookie) => invoke('roblox_validate_cookie', { cookie }),
    moderationInfo: (username) => invoke('roblox_moderation_info', { username }),
    // Runs server-side: the webview blocks a direct fetch to core.bloxgen.net (CORS).
    bloxgenGenerate: (apiKey, accountType, region) =>
        invoke('bloxgen_generate', { apiKey, accountType, region: region ?? null }),
    // Refresh/rotate an account's .ROBLOSECURITY via the backend (no CORS).
    // Returns the new cookie, or the same one if it is still alive/unchanged.
    refreshCookie: (cookie) => invoke('roblox_refresh_cookie', { cookie }),
    setRobloxVolume: (percent) => invoke('roblox_set_volume', { percent }),
    killAllRoblox: () => invoke('roblox_kill_all'),
    killOneRoblox: (id) => invoke('roblox_kill_one', { accountId: id }),
    getRunningCount: () => invoke('roblox_running_count'),
    getWindowCount: () => invoke('roblox_window_count'),
    arrangeWindows: () => invoke('roblox_arrange_windows'),
    onAllRobloxClosed: (cb) => on('roblox://all-closed', () => cb()),
    launchRoblox: (id, cookie, target) =>
      invoke('roblox_launch', { accountId: id, cookie, target }),
    openExternal: (url) => invoke('open_external', { url }),
    scanRobloxInstallations: () => invoke('roblox_installations_scan'),
    addRobloxCustomPreset: (path, displayName) =>
      invoke('roblox_custom_preset_add', {
        path,
        displayName: displayName == null ? null : displayName,
      }),
    removeRobloxCustomPreset: (installationId) =>
      invoke('roblox_custom_preset_remove', { installationId }),
    getRobloxProtocolState: () => invoke('roblox_protocol_state'),
    activateRobloxProtocol: (installationId) =>
      invoke('roblox_protocol_activate', { installationId }),
    restoreRobloxProtocol: () => invoke('roblox_protocol_restore'),
    getLatestRobloxRelease: (channel) =>
      invoke('roblox_release_latest', { channel: channel == null ? null : channel }),
    listRobloxDeployments: () => invoke('roblox_deployments_list'),
    installRobloxDeployment: (operationId, channel, versionGuid) =>
      invoke('roblox_deployment_install', {
        operationId,
        channel: channel == null ? null : channel,
        versionGuid: versionGuid == null ? null : versionGuid,
      }),
    cancelRobloxDeployment: (operationId) =>
      invoke('roblox_deployment_cancel', { operationId }),
    onRobloxDeploymentProgress: (cb) =>
      on('roblox://deployment-progress', (e) => cb(e.payload)),

    // ── Settings_Store ──
    loadSettings: () => invoke('settings_load'),
    saveSettings: (data) => invoke('settings_save', { data }),
    saveDonutToken: (t) => invoke('settings_save_donut_token', { token: t }),

    // ── Encryption_Scheme ──
    encStatus: () => invoke('enc_status'),
    encUnlock: (pass) => invoke('enc_unlock', { pass }),
    encSetKey: (pass) => invoke('enc_set_key', { pass }),

    // ── Native_Helper status ──
    multiInstanceStatus: () => invoke('multiinstance_status'),
    antiAfkStatus: () => invoke('antiafk_status'),

    // ── Generator history ──
    readGenHistory: () => invoke('genhistory_read'),
    writeGenHistory: (list) => invoke('genhistory_write', { list }),
    clearGenHistory: () => invoke('genhistory_clear'),

    // ── Fast flags / FPS cap ──
    readFFlags: () => invoke('fflag_read'),
    writeFFlags: (flags) => invoke('fflag_write', { flags }),
    readFpsCap: () => invoke('fps_read'),
    writeFpsCap: (cap) => invoke('fps_write', { cap }),

    // ── Push events ──
    onChromeProgress: (cb) => on('chrome://download-progress', (e) => cb(e.payload)),
    onRobloxClosed: (cb) => on('roblox://closed', (e) => cb(e.payload)),
    onRobloxCount: (cb) => on('roblox://count', (e) => cb(e.payload)),
    onLogEntry: (cb) => on('log://entry', (e) => cb(e.payload)),

    // ── Roblox metadata ──
    getRobloxVersion: () => invoke('roblox_get_version'),
    getGameName: (placeId, cookie) =>
      invoke('roblox_get_game_name', { placeIdOrTarget: placeId, cookie }),
    // Avatar thumbnails fetched via the backend (bypasses WebView2 CORS on
    // thumbnails.roblox.com). Returns { data: [{ targetId, state, imageUrl }] }.
    getAvatarThumbnails: (userIds) =>
      invoke('roblox_get_avatar_thumbnails', { userIds }),
    // Generic server-side GET for public *.roblox.com JSON APIs (bypasses CORS).
    // Returns the parsed JSON body; rejects on a disallowed URL or failure.
    robloxApiGet: (url) => invoke('roblox_api_get', { url }),
    // Presence for a batch of user ids -> { userPresences: [{ userPresenceType,
    // placeId, rootPlaceId, gameId, universeId, lastLocation, userId }] }.
    // userPresenceType: 0 Offline, 1 Online, 2 InGame, 3 InStudio.
    getPresence: (userIds, cookie) => invoke('roblox_get_presence', { userIds, cookie }),
    // Game preview details for a place id -> { ok, name, creator, universeId,
    // playing, iconUrl }.
    getGameDetails: (placeId, cookie) => invoke('roblox_game_details', { placeId, cookie }),
    // Account actions (authenticated, per-cookie, with CSRF handled backend-side).
    sendFriendRequest: (cookie, targetUserId) =>
      invoke('roblox_send_friend_request', { cookie, targetUserId }),
    changePassword: (cookie, currentPassword, newPassword) =>
      invoke('roblox_change_password', { cookie, currentPassword, newPassword }),
    changeDisplayName: (cookie, userId, newDisplayName) =>
      invoke('roblox_change_display_name', { cookie, userId, newDisplayName }),
    // Quick Login: authorize a cross-device login code from this account.
    quickLogin: (cookie, code) => invoke('roblox_quick_login', { cookie, code }),

    // ── Account_Browser_Launcher ──
    openAccountBrowser: (id) => invoke('browser_open', { accountId: id }),
    openAccountBrowsers: (ids) => invoke('browser_open_batch', { accountIds: ids }),
    copyAccountCookie: (id) => invoke('browser_copy_cookie', { accountId: id }),
    getWayfernStatus: () => invoke('browser_wayfern_status'),
    installWayfern: () => invoke('browser_wayfern_install'),
    onWayfernProgress: (cb) => on('wayfern://download-progress', (e) => cb(e.payload)),
    onBrowserSessionState: (cb) => on('browser://session-state', (e) => cb(e.payload)),
  };
})();
