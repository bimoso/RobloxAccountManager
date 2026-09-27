// dev/mockApi.ts
//
// Development-only stand-in for `window.api`, the Tauri_Bridge normally
// injected by `src-tauri/preload.js`.
//
// Outside the Tauri webview (`npm run dev` in a plain browser) `window.api`
// does not exist, so the Encryption_Gate init throws on its very first call and
// the app never renders — which makes it impossible to look at the UI without a
// full Rust build. This module installs a fake bridge with the same member
// names and parameter order as {@link TauriApi}, backed by in-memory fixtures,
// so every page renders with representative content.
//
// It is wired in `main.tsx` behind an `import.meta.env.DEV` guard using a
// dynamic import, so the whole module is dead-code-eliminated from production
// builds and never ships inside the Tauri bundle. It also refuses to install
// itself when a real `window.api` is already present, so running the dev server
// *inside* Tauri still talks to the real backend.

import type {
  Account,
  GenHistoryEntry,
  Package,
  RobloxInstallation,
  RobloxProtocolState,
  Settings,
} from '../types/models';
import type { TauriApi, UnlistenFn } from '../types/window';

/** Resolves after `ms`, used to give mocked calls a realistic latency. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Deterministic ISO timestamps so the fixtures never shift between reloads. */
const DAY = 86_400_000;
const EPOCH = Date.parse('2026-09-01T12:00:00.000Z');
const iso = (daysAgo: number): string => new Date(EPOCH - daysAgo * DAY).toISOString();

/** Seed accounts covering the states the Accounts page renders differently. */
const seedAccounts = (): Account[] => [
  {
    id: 'acc-1',
    username: 'NovaPrime',
    userId: '1284410021',
    nickname: 'Main',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock1',
    createdAt: iso(120),
    lastUsed: iso(0),
    donutProfileId: 'donut-1',
    donutProfilePendingDelete: false,
    launchedInstanceCount: 2,
  },
  {
    id: 'acc-2',
    username: 'EmberFall',
    userId: '1284410022',
    nickname: 'Farm A',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock2',
    createdAt: iso(96),
    lastUsed: iso(1),
    donutProfileId: null,
    donutProfilePendingDelete: false,
    launchedInstanceCount: 1,
  },
  {
    id: 'acc-3',
    username: 'QuietHarbor',
    userId: '1284410023',
    nickname: '',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock3',
    createdAt: iso(64),
    lastUsed: iso(9),
    donutProfileId: null,
    donutProfilePendingDelete: false,
    cookieExpired: true,
  },
  {
    id: 'acc-4',
    username: 'SolsticeRun',
    userId: '1284410024',
    nickname: 'Trader',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock4',
    createdAt: iso(41),
    lastUsed: iso(3),
    donutProfileId: 'donut-4',
    donutProfilePendingDelete: false,
    moderated: true,
  },
  {
    id: 'acc-5',
    username: 'PaleLantern',
    userId: '1284410025',
    nickname: 'Alt 05',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock5',
    createdAt: iso(28),
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
  {
    id: 'acc-6',
    username: 'GlassMeridian',
    userId: '1284410026',
    nickname: '',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock6',
    createdAt: iso(17),
    lastUsed: iso(6),
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
  {
    id: 'acc-7',
    username: 'CobaltWake',
    userId: '1284410027',
    nickname: 'Scout',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock7',
    createdAt: iso(11),
    lastUsed: iso(2),
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
  {
    id: 'acc-8',
    username: 'DriftAnchor',
    userId: '1284410028',
    nickname: '',
    cookie: '_|WARNING:-DO-NOT-SHARE-THIS.|_devmock8',
    createdAt: iso(4),
    lastUsed: iso(4),
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
];

/** Seed packages so the Packages page renders populated groups. */
const seedPackages = (): Package[] => [
  { id: 'pkg-1', name: 'Farm squad', accountIds: ['acc-2', 'acc-5', 'acc-6'], link: '' },
  { id: 'pkg-2', name: 'Trading desk', accountIds: ['acc-4', 'acc-7'], link: 'https://www.roblox.com/games/1818/dev-mock' },
  { id: 'pkg-3', name: 'Solo', accountIds: ['acc-1'], link: '' },
];

/** Seed settings mirroring a configured, unlocked install. */
const seedSettings = (): Settings => ({
  multiInstance: true,
  antiAfk: true,
  antiAfkInterval: 240,
  keyVerifier: 'dev-mock-verifier',
  donutApiTokenEnc: null,
  donutApiPort: 10108,
  pendingDonutDeletions: [],
  multiRobloxGroupId: null,
  masterVolume: 65,
  encSetupDone: true,
  browserProvider: 'wayfern',
  robloxLaunchMode: 'direct',
  robloxLaunchPresetId: 'install-live',
  autoRelaunch: false,
  replaceRunningInstance: true,
  windowLayoutEnabled: true,
  windowAutoLayout: true,
  windowTargetWidth: 640,
  windowTargetHeight: 480,
  windowPerRow: 3,
  launchSpawnGapMs: 4000,
});

/** Mutable in-memory state backing the mocked store commands. */
const state = {
  accounts: seedAccounts(),
  packages: seedPackages(),
  settings: seedSettings(),
  genHistory: [] as GenHistoryEntry[],
  fflags: {} as Record<string, unknown>,
  fpsCap: 240,
};

/**
 * One detected Roblox install, shaped exactly like `RobloxInstallation`.
 *
 * Field-for-field fidelity matters here: a mock that invents its own shape
 * makes the real UI crash on a field it was right to expect, and the resulting
 * error looks like an application bug rather than a fixture bug.
 */
const mockInstallation: RobloxInstallation = {
  id: 'install-live',
  kind: 'official',
  displayName: 'Roblox (LIVE)',
  executable: 'C:/Program Files (x86)/Roblox/Versions/version-9f2c1a7d4b1e4f60/RobloxPlayerBeta.exe',
  installLocation: 'C:/Program Files (x86)/Roblox/Versions/version-9f2c1a7d4b1e4f60',
  displayVersion: '2.712.845',
  versionGuid: 'version-9f2c1a7d4b1e4f60',
  channel: 'LIVE',
  detectedBy: 'uninstall_registry',
  protocolCapable: true,
  activeSchemes: ['roblox', 'roblox-player'],
  handlerCommand: '"C:/dev-mock/RAM.exe" "%1"',
};

/** Both protocol handlers pointed at the mocked install. */
const mockProtocol: RobloxProtocolState = {
  roblox: {
    scheme: 'roblox',
    command: '"C:/dev-mock/RAM.exe" "%1"',
    executable: 'C:/dev-mock/RAM.exe',
    arguments: ['%1'],
    installationId: 'install-live',
  },
  robloxPlayer: {
    scheme: 'roblox-player',
    command: '"C:/dev-mock/RAM.exe" "%1"',
    executable: 'C:/dev-mock/RAM.exe',
    arguments: ['%1'],
    installationId: 'install-live',
  },
  snapshotAvailable: true,
};

/** No-op unsubscribe handle for the mocked event channels. */
const noopUnlisten: UnlistenFn = () => undefined;

/**
 * Builds the fake bridge. Every member matches the name and parameter order of
 * the corresponding {@link TauriApi} member; return values are fixtures shaped
 * like the real backend's JSON.
 */
function buildMockApi(): TauriApi {
  const api: TauriApi = {
    // ── Window controls (no window to drive in a browser tab) ──
    minimize: async () => undefined,
    maximize: async () => undefined,
    close: async () => undefined,

    // ── Account_Store ──
    loadAccounts: async () => {
      await delay(140);
      return state.accounts.map((account) => ({ ...account }));
    },
    addAccount: async (account) => {
      const created = { ...account, id: account.id || `acc-${state.accounts.length + 1}` };
      state.accounts = [...state.accounts, created];
      return created;
    },
    removeAccount: async (id) => {
      state.accounts = state.accounts.filter((account) => account.id !== id);
    },
    updateAccount: async (id, data) => {
      let updated: Account | undefined;
      state.accounts = state.accounts.map((account) => {
        if (account.id !== id) return account;
        updated = { ...account, ...data };
        return updated;
      });
      return updated ?? { ...state.accounts[0] };
    },
    reorderAccounts: async (ids) => {
      const byId = new Map(state.accounts.map((account) => [account.id, account]));
      const next = ids.map((id) => byId.get(id)).filter((a): a is Account => Boolean(a));
      const missing = state.accounts.filter((account) => !ids.includes(account.id));
      state.accounts = [...next, ...missing];
    },
    exportAccountsEncrypted: async () => ({ path: 'C:/dev-mock/accounts.ramx', count: state.accounts.length }),
    importAccountsEncrypted: async () => ({ path: 'C:/dev-mock/accounts.ramx', added: 0, skipped: state.accounts.length }),

    // ── Packages ──
    loadPackages: async () => {
      await delay(90);
      return state.packages.map((pkg) => ({ ...pkg }));
    },
    savePackages: async (packages) => {
      state.packages = packages.map((pkg) => ({ ...pkg }));
      return true;
    },

    // ── Login ──
    openLogin: async () => undefined,
    loginCredentials: async (username) => ({ success: true, cookie: '_|dev-mock-cookie', username, userId: '1284410099' }),
    cancelLogin: async () => undefined,

    // ── Roblox launch / process control ──
    validateCookie: async () => ({ success: true, username: 'NovaPrime', userId: '1284410021' }),
    moderationInfo: async (username) => ({ found: true, userId: '1284410021', displayName: username, terminated: false }),
    bloxgenGenerate: async () => ({ status: 200, body: { username: 'DevMockGen01', password: 'dev-mock-pass', cookie: '_|dev-mock' } }),
    bloxgenStock: async () => ({ status: 200, body: { stock: { free: 12, premium: 3 } } }),
    refreshCookie: async (cookie) => cookie,
    setRobloxVolume: async () => undefined,
    killAllRoblox: async () => undefined,
    killOneRoblox: async () => undefined,
    getRunningCount: async () => 3,
    getWindowCount: async () => 3,
    arrangeWindows: async () => ({ found: 3, placed: 3 }),
    onAllRobloxClosed: async () => noopUnlisten,
    launchRoblox: async () => ({ success: true }),
    openExternal: async () => undefined,
    openLogsFolder: async () => undefined,
    getRobloxClientsSnapshot: async () => ({
      installations: [mockInstallation],
      protocol: mockProtocol,
      deployments: [],
    }),
    scanRobloxInstallations: async () => [mockInstallation],
    addRobloxCustomPreset: async (path, displayName) => ({
      ...mockInstallation,
      id: 'install-custom',
      kind: 'custom',
      displayName: displayName ?? 'Custom client',
      executable: path,
      installLocation: path,
      detectedBy: 'user_preset',
    }),
    removeRobloxCustomPreset: async () => true,
    getRobloxProtocolState: async () => mockProtocol,
    activateRobloxProtocol: async () => mockProtocol,
    restoreRobloxProtocol: async () => ({
      roblox: { ...mockProtocol.roblox, installationId: null, command: null, executable: null },
      robloxPlayer: { ...mockProtocol.robloxPlayer, installationId: null, command: null, executable: null },
      snapshotAvailable: true,
    }),
    getLatestRobloxRelease: async () => ({
      channel: 'LIVE',
      versionGuid: 'version-9f2c1a7d4b1e4f60',
      clientVersion: '2.712.845',
      bootstrapperVersion: null,
      checkedAt: EPOCH,
    }),
    listRobloxDeployments: async () => [],
    installRobloxDeployment: async () => ({
      id: 'deploy-1',
      channel: 'LIVE',
      versionGuid: 'version-9f2c1a7d4b1e4f60',
      clientVersion: '2.712.845',
      installedAt: EPOCH,
      installLocation: 'C:/dev-mock/Roblox/version-9f2c1a7d4b1e4f60',
      executable: 'C:/dev-mock/Roblox/version-9f2c1a7d4b1e4f60/RobloxPlayerBeta.exe',
      sizeBytes: 320_000_000,
      source: 'setup-aws.rbxcdn.com',
    }),
    cancelRobloxDeployment: async () => true,
    onRobloxDeploymentProgress: async () => noopUnlisten,
    onRobloxProtocolChanged: async () => noopUnlisten,
    onRobloxInstallationsChanged: async () => noopUnlisten,

    // ── Settings_Store ──
    loadSettings: async () => {
      await delay(70);
      return { ...state.settings };
    },
    saveSettings: async (data) => {
      state.settings = { ...state.settings, ...data };
      return true;
    },
    saveDonutToken: async () => true,

    // ── Encryption_Scheme (dev mock starts unlocked so pages render) ──
    encStatus: async () => ({ mode: 'unlocked' }),
    encUnlock: async () => true,
    encSetKey: async () => true,

    // ── Native_Helper status ──
    multiInstanceStatus: async () => true,
    antiAfkStatus: async () => true,

    // ── Generator history ──
    readGenHistory: async () => state.genHistory.map((entry) => ({ ...entry })),
    writeGenHistory: async (list) => {
      state.genHistory = list.map((entry) => ({ ...entry }));
      return true;
    },
    clearGenHistory: async () => {
      state.genHistory = [];
      return true;
    },

    // ── Fast flags / FPS cap ──
    readFFlags: async () => ({ ...state.fflags }),
    writeFFlags: async (flags) => {
      state.fflags = (flags ?? {}) as Record<string, unknown>;
      return true;
    },
    readFpsCap: async () => state.fpsCap,
    writeFpsCap: async (cap) => {
      state.fpsCap = cap;
      return true;
    },

    // ── Push events (nothing pushes in the browser) ──
    onChromeProgress: async () => noopUnlisten,
    onRobloxClosed: async () => noopUnlisten,
    onRobloxCount: async () => noopUnlisten,
    onLogEntry: async () => noopUnlisten,

    // ── Roblox metadata ──
    getRobloxVersion: async () => '2.712.845',
    getGameName: async () => 'Dev Mock Experience',
    getAvatarThumbnails: async (userIds) => ({
      data: userIds.map((id) => ({ targetId: Number(id), state: 'Completed', imageUrl: '' })),
    }),
    // Enough of the explore-api for the Charts ranking to render in a browser.
    robloxApiGet: async (url: string) =>
      url.includes('get-sort-content')
        ? {
            games: [
              ['Signal Peak', 2_184_300],
              ['Orbit Arena', 1_402_880],
              ['Neon Drift Racing', 986_120],
              ['Blox Tycoon Deluxe', 614_900],
              ['Quiet Quest', 269_210],
              ['Sky Parkour Obby', 188_455],
              ['Pet Harbor', 92_310],
              ['Null Sector', 41_800],
              ['Lantern Lore', 12_640],
            ].map(([name, playerCount], index) => ({
              universeId: 9000 + index,
              rootPlaceId: 18_000 + index,
              name,
              playerCount,
            })),
          }
        : {},
    weaoVersions: async () =>
      ({
        ok: true,
        data: {
          Windows: '2.712.845',
          WindowsDate: iso(2),
          Mac: '2.712.845',
          MacDate: iso(2),
        },
      }) as unknown as Awaited<ReturnType<TauriApi['weaoVersions']>>,
    weaoExploits: async () =>
      ({
        ok: true,
        data: [
          { title: 'Executor Alpha', updateStatus: true, version: '2.712.845', platform: 'Windows', free: false },
          { title: 'Executor Beta', updateStatus: false, version: '2.711.790', platform: 'Windows', free: true },
          { title: 'Executor Gamma', updateStatus: true, version: '2.712.845', platform: 'Android', free: true },
        ],
      }) as unknown as Awaited<ReturnType<TauriApi['weaoExploits']>>,
    getPresence: async (userIds) => ({
      userPresences: userIds.map((id, index) => ({
        userPresenceType: index % 3,
        placeId: index % 3 === 2 ? 1818 : null,
        rootPlaceId: index % 3 === 2 ? 1818 : null,
        gameId: index % 3 === 2 ? 'dev-mock-game' : null,
        universeId: index % 3 === 2 ? 99 : null,
        lastLocation: index % 3 === 2 ? 'Dev Mock Experience' : index % 3 === 1 ? 'Website' : 'Offline',
        userId: Number(id),
      })),
    }),
    getGameDetails: async () => ({ ok: true, name: 'Dev Mock Experience', creator: 'DevMock', universeId: 99, playing: 4821, iconUrl: '' }),
    sendFriendRequest: async () => ({ success: true }),
    changePassword: async () => ({ success: true }),
    changeDisplayName: async () => ({ success: true }),
    quickLogin: async () => ({ success: true }),

    // ── Account_Browser_Launcher ──
    openAccountBrowser: async () => ({ ok: true, focused: true }),
    openAccountBrowsers: async (ids) => ({
      ok: true,
      opened: ids.length,
      total: ids.length,
      results: ids.map((accountId) => ({ accountId, ok: true })),
    }),
    copyAccountCookie: async () => ({ success: true }),
    getWayfernStatus: async () => ({ installed: true, version: '1.4.0' }) as unknown as Awaited<ReturnType<TauriApi['getWayfernStatus']>>,
    copyAccountCookiesBulk: async (ids) => ({ total: ids.length, copied: ids.length, failedIds: [] }),
    installWayfern: async () => ({ installed: true, version: '1.4.0' }) as unknown as Awaited<ReturnType<TauriApi['installWayfern']>>,
    onWayfernProgress: async () => noopUnlisten,
    onBrowserSessionState: async () => noopUnlisten,
  };

  return api;
}

/**
 * Installs the mock bridge on `window.api` when none exists.
 *
 * A no-op when a real bridge is already present (running the dev server inside
 * the Tauri webview), so the mock can never shadow the real backend.
 */
export function installMockApi(): void {
  if (typeof window === 'undefined') return;
  if (window.api) return;
  window.api = buildMockApi();
  // Loud on purpose: every value on screen is fake while this is active.
  console.info('[dev] window.api not found — installed the in-memory mock bridge (dev/mockApi.ts).');
}
