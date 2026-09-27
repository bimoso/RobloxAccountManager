import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Box,
  Cable,
  Check,
  Download,
  FolderPlus,
  HardDrive,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Route,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { loadClientsSnapshot } from '@/lib/clientsSnapshotCache';
import { ipc } from '@/lib/ipc';
import { createSessionCache } from '@/lib/sessionCache';
import { normalizeErrorMessage, useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type {
  RobloxDeployment,
  RobloxDeploymentProgress,
  RobloxInstallation,
  RobloxProtocolState,
  RobloxRelease,
  Settings,
} from '@/types/models';
import './Settings.css';

function compactPath(path: string | null, missingLabel: string): string {
  if (!path) return missingLabel;
  if (path.length <= 68) return path;
  return `${path.slice(0, 28)}…${path.slice(-35)}`;
}

function installationBadge(installation: RobloxInstallation): string {
  switch (installation.kind) {
    case 'official': return 'Roblox';
    case 'bloxstrap': return 'Bloxstrap';
    case 'fishstrap': return 'Fishstrap';
    case 'froststrap': return 'Froststrap';
    case 'voidstrap': return 'Voidstrap';
    case 'nyxstrap': return 'Nyxstrap';
    case 'other_bootstrapper': return 'Bootstrapper';
    case 'custom': return 'Custom';
    case 'microsoft_store': return 'Store app';
  }
}

function makeOperationId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `deployment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Last known scan results, kept across unmounts. Opening the Clients tab runs
 * a full refresh (installation scan, protocol state, latest-release network
 * check, deployment listing, settings), so without this every visit showed
 * the whole deck in its loading state. The tab hydrates from this snapshot
 * for an instant paint. A fresh snapshot is reused for five minutes; an older
 * one is silently revalidated on mount, while the explicit Refresh action
 * always scans immediately.
 */
interface ClientsSnapshot {
  installations: RobloxInstallation[];
  protocol: RobloxProtocolState | null;
  release: RobloxRelease | null;
  deployments: RobloxDeployment[];
  settings: Settings | null;
}

const clientsCache = createSessionCache<ClientsSnapshot>();
const CLIENTS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/** Roblox client, protocol-routing and isolated deployment control deck. */
export function ClientsTab(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const showSuccess = useToastStore((state) => state.showSuccess);
  const { t } = useTranslation();
  // Hydrate from the session snapshot so a revisit paints the last scan
  // immediately; the mount refresh below reconciles silently.
  const cached = clientsCache.get();
  // Capture freshness before the mirror effect writes the initial state back
  // into the cache. Otherwise a first-ever empty render would stamp itself as
  // "fresh" and incorrectly suppress the real scan.
  const refreshOnMount = useRef(!clientsCache.isFresh(CLIENTS_CACHE_MAX_AGE_MS));
  const skipInitialCacheWrite = useRef(cached !== undefined);
  const [installations, setInstallations] = useState<RobloxInstallation[]>(cached?.installations ?? []);
  const [protocol, setProtocol] = useState<RobloxProtocolState | null>(cached?.protocol ?? null);
  const [release, setRelease] = useState<RobloxRelease | null>(cached?.release ?? null);
  const [deployments, setDeployments] = useState<RobloxDeployment[]>(cached?.deployments ?? []);
  const [settings, setSettings] = useState<Settings | null>(cached?.settings ?? null);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const [cacheReady, setCacheReady] = useState(cached !== undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [channel, setChannel] = useState('LIVE');
  const [versionGuid, setVersionGuid] = useState('');
  const [presetPath, setPresetPath] = useState('');
  const [presetName, setPresetName] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RobloxDeploymentProgress | null>(null);

  // Mirror every loaded/mutated slice back into the session snapshot so the
  // next mount hydrates from exactly what was last on screen.
  useEffect(() => {
    // Do not refresh the timestamp merely because a cached component mounted;
    // freshness must reflect a successful scan or a real state mutation.
    if (skipInitialCacheWrite.current) {
      skipInitialCacheWrite.current = false;
      return;
    }
    if (!cacheReady) return;
    clientsCache.set({ installations, protocol, release, deployments, settings });
  }, [cacheReady, installations, protocol, release, deployments, settings]);

  // The LIVE-release lookup is a network round trip that the backend caps at 30
  // seconds. It is deliberately kept off the scan path so a slow or unreachable
  // endpoint cannot hold the client list — and the loading state — hostage.
  const refreshRelease = useCallback(async (requestedChannel: string): Promise<void> => {
    try {
      setRelease(await ipc.getLatestRobloxRelease(requestedChannel));
    } catch {
      // Nothing else on the deck depends on it; the card falls back to
      // "version unavailable".
    }
  }, []);

  const refresh = useCallback(async (
    requestedChannel = 'LIVE',
    options?: { silent?: boolean; fresh?: boolean },
  ): Promise<void> => {
    // A silent refresh revalidates behind the cached data already on screen
    // without flipping the deck into its loading state.
    if (!options?.silent) setLoading(true);
    setError(null);
    void refreshRelease(requestedChannel);
    try {
      // One command for installations, protocol handlers and deployments. The
      // backend answers from its cached sweep (memory, then the copy persisted
      // by the previous session) and verifies it in the background; only the
      // explicit Scan action (`fresh`) waits for a full registry + disk walk.
      const [snapshot, nextSettings] = await Promise.all([
        // Through the shared cache so the result this deck reads is also the
        // one the idle warm-up and the WEAO hub read. `force` because the
        // deck's own richer snapshot above already decided this read is due.
        loadClientsSnapshot({ force: true, fresh: options?.fresh === true }),
        ipc.loadSettings(),
      ]);
      setInstallations(snapshot.installations);
      setProtocol(snapshot.protocol);
      setDeployments(snapshot.deployments);
      setSettings(nextSettings);
      setCacheReady(true);
    } catch (cause) {
      // Without this the rejection was unhandled and the deck sat blank with no
      // explanation of why nothing had loaded.
      setError(normalizeErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [refreshRelease]);

  useEffect(() => {
    // A manual Refresh remains available, but normal tab hopping reuses a fresh
    // snapshot instead of re-scanning the registry, disk and release endpoint
    // every time the component mounts.
    if (refreshOnMount.current) {
      void refresh('LIVE', { silent: true });
    }
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void ipc.onRobloxDeploymentProgress((event) => {
      if (!cancelled) setProgress(event);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Held in a ref so the subscription below is not torn down and rebuilt on
  // every keystroke in the channel field.
  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Roblox and the *strap forks reclaim the roblox:// handlers on launch and
  // update. Re-reading on that signal keeps the routing rail honest instead of
  // showing a binding this app no longer owns. The backend re-derives the
  // cached sweep's bindings before emitting, so this read is cheap: no scan.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void ipc.onRobloxProtocolChanged(() => {
      if (!cancelled) void refresh(channelRef.current.trim() || 'LIVE', { silent: true });
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // A background verification found the installed clients changed (one was
  // installed, removed or moved outside this app): repaint from the cache the
  // backend just replaced.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void ipc.onRobloxInstallationsChanged(() => {
      if (!cancelled) void refresh(channelRef.current.trim() || 'LIVE', { silent: true });
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const protocolIds = useMemo(
    () => new Set([
      protocol?.roblox.installationId,
      protocol?.robloxPlayer.installationId,
    ].filter((value): value is string => Boolean(value))),
    [protocol],
  );

  const directPresetId = settings?.robloxLaunchPresetId ?? null;
  const launchMode = settings?.robloxLaunchMode ?? 'direct';
  // A first scan with nothing cached to paint behind it: the deck shows
  // placeholder rows rather than an empty container and a "0 found" badge.
  const scanning = loading && installations.length === 0;

  const selectManagerClient = async (installation: RobloxInstallation): Promise<void> => {
    if (!installation.executable) return;
    setBusyId(`direct:${installation.id}`);
    try {
      await ipc.saveSettings({
        robloxLaunchMode: 'direct',
        robloxLaunchPresetId: installation.id,
      });
      setSettings((current) => current ? {
        ...current,
        robloxLaunchMode: 'direct',
        robloxLaunchPresetId: installation.id,
      } : current);
      showSuccess(t('clients.selectedForSessions', { name: installation.displayName }));
    } finally {
      setBusyId(null);
    }
  };

  // Which route the Manager's own launches take. Independent of the Windows
  // handlers: handing roblox:// to another client used to flip this too and
  // silently replace the client the Manager was using.
  const selectRouteMode = async (mode: 'direct' | 'protocol'): Promise<void> => {
    if (mode === launchMode) return;
    setBusyId(`route:${mode}`);
    try {
      await ipc.saveSettings({ robloxLaunchMode: mode });
      setSettings((current) => current ? { ...current, robloxLaunchMode: mode } : current);
      showSuccess(t(mode === 'protocol' ? 'clients.routeProtocolOn' : 'clients.routeDirectOn'));
    } finally {
      setBusyId(null);
    }
  };

  const activateProtocol = async (installation: RobloxInstallation): Promise<void> => {
    if (!installation.protocolCapable) return;
    setBusyId(`protocol:${installation.id}`);
    try {
      const next = await ipc.activateRobloxProtocol(installation.id);
      setProtocol(next);
      showSuccess(t('clients.nowHandles', { name: installation.displayName }));
      // Only the registry moved; the cached sweep re-derived each client's
      // bindings, so a cached read is enough to repaint the chips. The
      // protocol state itself comes from the activation, which is authoritative.
      try {
        const snapshot = await loadClientsSnapshot({ force: true });
        setInstallations(snapshot.installations);
      } catch {
        // The activation itself succeeded; the chips catch up on the next read.
      }
    } finally {
      setBusyId(null);
    }
  };

  const restoreProtocol = async (): Promise<void> => {
    setBusyId('restore');
    try {
      const next = await ipc.restoreRobloxProtocol();
      setProtocol(next);
      showSuccess(t('clients.handlersRestored'));
      try {
        const snapshot = await loadClientsSnapshot({ force: true });
        setInstallations(snapshot.installations);
      } catch {
        // As above: the restore succeeded; only the chips lag.
      }
    } finally {
      setBusyId(null);
    }
  };

  const startInstall = async (): Promise<void> => {
    const id = makeOperationId();
    setOperationId(id);
    setProgress({
      operationId: id,
      stage: 'resolving_manifest',
      channel: channel.trim() || 'LIVE',
      versionGuid: versionGuid.trim() || null,
      packageName: null,
      downloadedBytes: 0,
      totalBytes: null,
      percent: null,
      message: null,
    });
    try {
      const deployment = await ipc.installRobloxDeployment(
        id,
        channel.trim() || 'LIVE',
        versionGuid.trim() || null,
      );
      setDeployments((current) => [deployment, ...current.filter((item) => item.id !== deployment.id)]);
      setVersionGuid('');
      showSuccess(t('clients.installedIsolated', { version: deployment.versionGuid }));
      const rescanned = await ipc.scanRobloxInstallations();
      setInstallations(rescanned);
    } finally {
      setOperationId(null);
    }
  };

  const cancelInstall = async (): Promise<void> => {
    if (!operationId) return;
    await ipc.cancelRobloxDeployment(operationId);
  };

  const addPathPreset = async (): Promise<void> => {
    const path = presetPath.trim();
    if (!path) return;
    setBusyId('preset:add');
    try {
      const added = await ipc.addRobloxCustomPreset(path, presetName.trim() || null);
      const rescanned = await ipc.scanRobloxInstallations();
      setInstallations(rescanned);
      setPresetPath('');
      setPresetName('');
      showSuccess(t('clients.presetAdded', { name: added.displayName }));
    } finally {
      setBusyId(null);
    }
  };

  const removePathPreset = async (installation: RobloxInstallation): Promise<void> => {
    setBusyId(`preset:remove:${installation.id}`);
    try {
      const removed = await ipc.removeRobloxCustomPreset(installation.id);
      if (!removed) return;
      const [rescanned, nextSettings] = await Promise.all([
        ipc.scanRobloxInstallations(),
        ipc.loadSettings(),
      ]);
      setInstallations(rescanned);
      setSettings(nextSettings);
      showSuccess(t('clients.presetRemoved', { name: installation.displayName }));
    } finally {
      setBusyId(null);
    }
  };

  const handlerName = protocol?.robloxPlayer.installationId
    ? installations.find((item) => item.id === protocol.robloxPlayer.installationId)?.displayName
      ?? t('clients.externalHandler')
    : loading ? t('clients.scanning') : t('clients.noHandler');
  const routeTarget = launchMode === 'protocol'
    ? handlerName
    : directPresetId
      ? installations.find((item) => item.id === directPresetId)?.displayName ?? directPresetId
      : t('clients.autoFallback');
  const deployPercent = progress?.percent == null ? 0 : Math.round(progress.percent);

  return (
    <div className="set-stack settings-clients">
      <header className="set-tabhead">
        <span className="set-icon" data-tone="accent" aria-hidden="true"><Route size={15} /></span>
        <div className="set-tabhead__text">
          <span className="rk-eyebrow">{t('clients.routing.eyebrow')}</span>
          <h2>{t('clients.routing.title')}</h2>
          <p>{t('clients.routing.hint')}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refresh(channel.trim() || 'LIVE', { fresh: true })}
          disabled={loading}
        >
          {loading ? <span className="rk-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {t('clients.scan')}
        </Button>
      </header>

      {/* ── Where roblox:// currently goes ── */}
      <section className="rk-panel set-panel" aria-label={t('clients.protocolAria')}>
        <div className="rk-stats">
          <div className="rk-stat">
            <span className="rk-stat__label">{t('clients.protocolAria')}</span>
            <span className="clients-scheme">
              <span><Cable size={12} aria-hidden="true" /> roblox://</span>
              <span><Cable size={12} aria-hidden="true" /> roblox-player:</span>
            </span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">{t('clients.windowsHandler')}</span>
            <span className="set-stat__strong">{handlerName}</span>
            <span className="clients-path" title={protocol?.robloxPlayer.executable ?? undefined}>
              {compactPath(protocol?.robloxPlayer.executable ?? null, t('clients.pathNotExposed'))}
            </span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">{t('clients.appRoute')}</span>
            <div className="rk-seg clients-route" role="group" aria-label={t('clients.routeModeAria')}>
              <button
                type="button"
                aria-pressed={launchMode === 'direct'}
                disabled={busyId !== null || settings === null}
                onClick={() => void selectRouteMode('direct')}
              >
                <Route size={12} aria-hidden="true" /> {t('clients.directExecutable')}
              </button>
              <button
                type="button"
                aria-pressed={launchMode === 'protocol'}
                disabled={busyId !== null || settings === null}
                onClick={() => void selectRouteMode('protocol')}
              >
                <Cable size={12} aria-hidden="true" /> {t('clients.windowsProtocol')}
              </button>
            </div>
            <span className="clients-path">{routeTarget}</span>
          </div>
        </div>

        {protocol?.snapshotAvailable ? (
          <div className="set-rows">
            <div className="rk-row set-row">
              <span className="rk-row__gutter">
                <i className="rk-row__tick" data-tone="warn" />
              </span>
              <span className="rk-row__main">
                <span className="rk-row__title">
                  <ShieldAlert size={14} aria-hidden="true" /> {t('clients.snapshotStored')}
                </span>
              </span>
              <span className="set-row__control">
                <Button variant="secondary" size="sm" disabled={busyId !== null} onClick={() => void restoreProtocol()}>
                  {busyId === 'restore'
                    ? <span className="rk-spin" aria-hidden="true" />
                    : <RotateCcw size={14} aria-hidden="true" />}
                  {t('clients.restorePrevious')}
                </Button>
              </span>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Detected installations ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><HardDrive size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('clients.detected')}</span>
            <h3 className="rk-panel__title">{t('clients.installationsTitle')}</h3>
          </div>
          <span className="rk-chip" data-tone={installations.length > 0 ? 'ok' : 'neutral'}>
            {scanning ? t('clients.scanning') : t('clients.found', { count: installations.length })}
          </span>
        </div>

        {error ? (
          <p className="clients-error" role="alert">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>{t('clients.scanFailed', { reason: error })}</span>
            <button type="button" onClick={() => void refresh(channel.trim() || 'LIVE')}>
              <RefreshCw size={12} aria-hidden="true" /> {t('clients.retry')}
            </button>
          </p>
        ) : null}

        <form className="clients-preset" onSubmit={(event) => {
          event.preventDefault();
          void addPathPreset();
        }}>
          <label className="fm-label">
            <span>{t('clients.pathLabel')}</span>
            <input
              className="fm-input"
              value={presetPath}
              onChange={(event) => setPresetPath(event.target.value)}
              placeholder="C:\\RobloxVersions\\version-…  or  C:\\…\\Voidstrap.exe"
              disabled={busyId !== null}
            />
          </label>
          <label className="fm-label">
            <span>{t('clients.presetLabel')} <em>{t('clients.optional')}</em></span>
            <input
              className="fm-input"
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder={t('clients.presetPlaceholder')}
              disabled={busyId !== null}
              maxLength={80}
            />
          </label>
          <Button type="submit" variant="secondary" size="lg" disabled={!presetPath.trim() || busyId !== null}>
            {busyId === 'preset:add'
              ? <span className="rk-spin" aria-hidden="true" />
              : <FolderPlus size={14} aria-hidden="true" />}
            {t('clients.addPreset')}
          </Button>
          <p className="clients-preset__help">{t('clients.presetHelp')}</p>
        </form>

        <div className="set-rows">
          <AnimatePresence initial={false}>
            {installations.map((installation, index) => {
              const directActive = launchMode === 'direct' && directPresetId === installation.id;
              const protocolActive = protocolIds.has(installation.id);
              return (
                <motion.article
                  key={installation.id}
                  className="rk-row set-row"
                  data-active={directActive || protocolActive || undefined}
                  initial={{ opacity: 0, y: reducedMotion ? 0 : 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, delay: reducedMotion ? 0 : Math.min(index, 6) * 0.04 }}
                >
                  <span className="rk-row__gutter">
                    <i
                      className="rk-row__tick"
                      data-tone={protocolActive ? 'ok' : directActive ? 'accent' : undefined}
                    />
                  </span>
                  <span className="rk-row__main">
                    <span className="rk-row__title">{installation.displayName}</span>
                    <span className="rk-row__meta">
                      {installationBadge(installation)} · {installation.detectedBy.replace(/_/g, ' ')} ·{' '}
                      {installation.versionGuid || installation.displayVersion || t('clients.versionUnknown')}
                    </span>
                    <span className="clients-path" title={installation.executable ?? undefined}>
                      {compactPath(installation.executable, t('clients.pathNotExposed'))}
                    </span>
                  </span>
                  <span className="set-row__control clients-actions">
                    <span className="rk-chip rk-chip--sm" data-tone={installation.activeSchemes.length ? 'ok' : 'neutral'}>
                      {installation.activeSchemes.length
                        ? t('clients.protocols', { count: installation.activeSchemes.length })
                        : t('clients.notSystemHandler')}
                    </span>
                    <button
                      type="button"
                      disabled={!installation.executable || busyId !== null}
                      data-active={directActive || undefined}
                      onClick={() => void selectManagerClient(installation)}
                    >
                      {directActive ? <Check size={12} /> : <Route size={12} />}
                      {directActive ? t('clients.managerActive') : t('clients.useInManager')}
                    </button>
                    <button
                      type="button"
                      disabled={!installation.protocolCapable || busyId !== null}
                      data-active={protocolActive || undefined}
                      title={installation.protocolCapable ? t('clients.protocolTitle') : t('clients.protocolIncapable')}
                      onClick={() => void activateProtocol(installation)}
                    >
                      {protocolActive ? <Check size={12} /> : <RadioTower size={12} />}
                      {protocolActive ? t('clients.protocolActive') : t('clients.ownProtocol')}
                    </button>
                    {installation.detectedBy === 'user_preset' ? (
                      <button
                        type="button"
                        data-tone="danger"
                        disabled={busyId !== null}
                        title={t('clients.forgetTitle')}
                        onClick={() => void removePathPreset(installation)}
                      >
                        {busyId === `preset:remove:${installation.id}`
                          ? <span className="rk-spin" aria-hidden="true" />
                          : <Trash2 size={12} />}
                        {t('clients.forget')}
                      </button>
                    ) : null}
                  </span>
                </motion.article>
              );
            })}
          </AnimatePresence>
          {scanning ? (
            <div className="clients-skeleton" aria-hidden="true">
              <span /><span /><span />
            </div>
          ) : null}
          {!loading && !error && installations.length === 0 ? (
            <p className="clients-empty">{t('clients.noInstallations')}</p>
          ) : null}
        </div>
      </section>

      {/* ── Isolated deployment library ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Box size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('clients.deployLibrary')}</span>
            <h3 className="rk-panel__title">{t('clients.packageArchive')}</h3>
          </div>
          {release ? (
            <span className="rk-chip" data-tone="ok">
              <i className="rk-dot rk-dot--live" data-tone="ok" aria-hidden="true" /> LIVE {release.clientVersion}
            </span>
          ) : null}
        </div>

        <div className="rk-stats">
          <div className="rk-stat">
            <span className="rk-stat__label">{t('clients.latest', { channel: release?.channel ?? channel })}</span>
            <span className="set-stat__strong">{release?.versionGuid ?? t('clients.checking')}</span>
            <span className="clients-path u-num">{release?.clientVersion ?? t('clients.versionUnavailable')}</span>
          </div>
        </div>

        <div className="clients-release">
          <label className="fm-label">
            <span>{t('clients.channel')}</span>
            <input
              className="fm-input"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              placeholder="LIVE"
              disabled={Boolean(operationId)}
            />
          </label>
          <label className="fm-label">
            <span>{t('clients.versionGuid')} <em>{t('clients.optional')}</em></span>
            <input
              className="fm-input"
              value={versionGuid}
              onChange={(event) => setVersionGuid(event.target.value)}
              placeholder={release?.versionGuid ?? t('clients.versionPlaceholder')}
              disabled={Boolean(operationId)}
            />
          </label>
          {operationId ? (
            <Button variant="secondary" size="lg" onClick={() => void cancelInstall()}>
              <Square size={13} aria-hidden="true" /> {t('common.cancel')}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void startInstall()}>
              <Download size={14} aria-hidden="true" /> {t('clients.downloadDeployment')}
            </Button>
          )}
          <p className="clients-release__note">
            <ShieldAlert size={13} aria-hidden="true" /> {t('clients.deploymentNote')}
          </p>
        </div>

        <AnimatePresence initial={false}>
          {progress && operationId ? (
            <motion.div
              className="clients-progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <span className="rk-spin" aria-hidden="true" />
              <span>{progress.stage.replace(/_/g, ' ')}</span>
              <strong>{progress.packageName || progress.versionGuid || t('clients.resolvingManifest')}</strong>
              <span className="u-num">{progress.percent == null ? '—' : `${deployPercent}%`}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {progress && operationId ? (
          // Spec motion #6: scaleX from a left origin, never an animated width.
          <div
            className="set-meter"
            role="progressbar"
            aria-label={t('clients.downloadDeployment')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={deployPercent}
          >
            <span className="set-meter__fill" style={{ transform: `scaleX(${(progress.percent ?? 3) / 100})` }} />
          </div>
        ) : null}

        <div className="set-rows">
          {deployments.map((deployment) => (
            <article key={deployment.id} className="rk-row set-row">
              <span className="rk-row__gutter">
                <i className="rk-row__tick" data-tone="ok" />
              </span>
              <span className="rk-row__main">
                <span className="rk-row__title">{deployment.versionGuid}</span>
                <span className="rk-row__meta">
                  {deployment.clientVersion} · {deployment.channel} ·{' '}
                  <span className="u-num">{(deployment.sizeBytes / (1024 * 1024)).toFixed(0)} MB</span>
                </span>
                <span className="clients-path" title={deployment.installLocation}>
                  {compactPath(deployment.installLocation, t('clients.pathNotExposed'))}
                </span>
              </span>
              <span className="set-row__control clients-actions">
                <button type="button" onClick={() => {
                  const installation = installations.find((item) => item.id === deployment.id || item.versionGuid === deployment.versionGuid);
                  if (installation) void selectManagerClient(installation);
                }}>{t('clients.use')}</button>
              </span>
            </article>
          ))}
          {scanning ? (
            <div className="clients-skeleton" aria-hidden="true"><span /><span /></div>
          ) : null}
          {!loading && !error && deployments.length === 0 ? (
            <p className="clients-empty">{t('clients.noDeployments')}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export default ClientsTab;
