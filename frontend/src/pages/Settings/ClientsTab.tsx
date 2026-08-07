import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Box,
  Cable,
  Check,
  Download,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Route,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/Button';
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

  const refresh = useCallback(async (requestedChannel = 'LIVE', options?: { silent?: boolean }): Promise<void> => {
    // A silent refresh revalidates behind the cached data already on screen
    // without flipping the deck into its loading state.
    if (!options?.silent) setLoading(true);
    setError(null);
    void refreshRelease(requestedChannel);
    try {
      // One command for installations, protocol handlers and deployments: they
      // all derive from the same registry + disk sweep, which the backend now
      // runs once, off the main thread.
      const [snapshot, nextSettings] = await Promise.all([
        ipc.getRobloxClientsSnapshot(),
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
  // showing a binding this app no longer owns.
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

  const activateProtocol = async (installation: RobloxInstallation): Promise<void> => {
    if (!installation.protocolCapable) return;
    setBusyId(`protocol:${installation.id}`);
    try {
      const next = await ipc.activateRobloxProtocol(installation.id);
      setProtocol(next);
      setSettings((current) => current ? {
        ...current,
        robloxLaunchMode: 'protocol',
        robloxLaunchPresetId: installation.id,
      } : current);
      showSuccess(t('clients.nowHandles', { name: installation.displayName }));
    } finally {
      setBusyId(null);
    }
  };

  const restoreProtocol = async (): Promise<void> => {
    setBusyId('restore');
    try {
      const next = await ipc.restoreRobloxProtocol();
      setProtocol(next);
      setSettings((current) => current ? {
        ...current,
        robloxLaunchMode: 'direct',
        robloxLaunchPresetId: null,
      } : current);
      showSuccess(t('clients.handlersRestored'));
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

  return (
    <div className="settings-clients">
      <section className="clients-route-deck">
        <div className="clients-route-deck__intro">
          <span className="settings-card-icon settings-card-icon--feature"><Route size={18} /></span>
          <div>
            <span className="settings-card-eyebrow">{t('clients.routing.eyebrow')}</span>
            <h2>{t('clients.routing.title')}</h2>
            <p>{t('clients.routing.hint')}</p>
          </div>
          <Button variant="secondary" onClick={() => void refresh(channel.trim() || 'LIVE')} disabled={loading}>
            <RefreshCw className={loading ? 'clients-spin' : undefined} size={14} /> {t('clients.scan')}
          </Button>
        </div>

        <div className="clients-protocol-rail" aria-label={t('clients.protocolAria')}>
          <div className="clients-protocol-rail__scheme">
            <span><Cable size={13} /> roblox://</span>
            <span><Cable size={13} /> roblox-player:</span>
          </div>
          <span className="clients-protocol-rail__line" aria-hidden="true"><i /><i /><i /></span>
          <div className="clients-protocol-rail__target">
            <small>{t('clients.windowsHandler')}</small>
            <strong>{protocol?.robloxPlayer.installationId
              ? installations.find((item) => item.id === protocol.robloxPlayer.installationId)?.displayName ?? t('clients.externalHandler')
              : loading ? t('clients.scanning') : t('clients.noHandler')}</strong>
            <span>{compactPath(protocol?.robloxPlayer.executable ?? null, t('clients.pathNotExposed'))}</span>
          </div>
          <div className="clients-protocol-rail__mode">
            <small>{t('clients.appRoute')}</small>
            <strong>{launchMode === 'protocol' ? t('clients.windowsProtocol') : t('clients.directExecutable')}</strong>
            <span>{directPresetId
              ? installations.find((item) => item.id === directPresetId)?.displayName ?? directPresetId
              : t('clients.autoFallback')}</span>
          </div>
        </div>

        {protocol?.snapshotAvailable ? (
          <div className="clients-restore">
            <span><ShieldAlert size={15} /> {t('clients.snapshotStored')}</span>
            <Button variant="secondary" disabled={busyId !== null} onClick={() => void restoreProtocol()}>
              {busyId === 'restore' ? <LoaderCircle className="clients-spin" size={14} /> : <RotateCcw size={14} />}
              {t('clients.restorePrevious')}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="clients-installations">
        <div className="clients-section-head">
          <div><span>{t('clients.detected')}</span><h3>{t('clients.installationsTitle')}</h3></div>
          <span>{scanning ? t('clients.scanning') : t('clients.found', { count: installations.length })}</span>
        </div>
        {error ? (
          <p className="clients-error" role="alert">
            <ShieldAlert size={15} />
            <span>{t('clients.scanFailed', { reason: error })}</span>
            <button type="button" onClick={() => void refresh(channel.trim() || 'LIVE')}>
              <RefreshCw size={12} /> {t('clients.retry')}
            </button>
          </p>
        ) : null}
        <form className="clients-path-preset" onSubmit={(event) => {
          event.preventDefault();
          void addPathPreset();
        }}>
          <span className="clients-path-preset__icon"><FolderPlus size={17} /></span>
          <label>
            <span>{t('clients.pathLabel')}</span>
            <input
              value={presetPath}
              onChange={(event) => setPresetPath(event.target.value)}
              placeholder="C:\\RobloxVersions\\version-…  or  C:\\…\\Voidstrap.exe"
              disabled={busyId !== null}
            />
          </label>
          <label className="clients-path-preset__name">
            <span>{t('clients.presetLabel')} <em>{t('clients.optional')}</em></span>
            <input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder={t('clients.presetPlaceholder')}
              disabled={busyId !== null}
              maxLength={80}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={!presetPath.trim() || busyId !== null}>
            {busyId === 'preset:add' ? <LoaderCircle className="clients-spin" size={14} /> : <FolderPlus size={14} />}
            {t('clients.addPreset')}
          </Button>
          <small>
            {t('clients.presetHelp')}
          </small>
        </form>
        <div className="clients-installation-list">
          <AnimatePresence initial={false}>
            {installations.map((installation, index) => {
              const directActive = launchMode === 'direct' && directPresetId === installation.id;
              const protocolActive = protocolIds.has(installation.id);
              return (
                <motion.article
                  key={installation.id}
                  className="clients-installation"
                  data-active={directActive || protocolActive || undefined}
                  initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: reducedMotion ? 0 : Math.min(index, 5) * .025 }}
                >
                  <span className="clients-installation__icon"><HardDrive size={17} /></span>
                  <div className="clients-installation__copy">
                    <span>{installationBadge(installation)} · {installation.detectedBy.replace(/_/g, ' ')}</span>
                    <strong>{installation.displayName}</strong>
                    <small title={installation.executable ?? undefined}>{compactPath(installation.executable, t('clients.pathNotExposed'))}</small>
                  </div>
                  <div className="clients-installation__meta">
                    <span>{installation.versionGuid || installation.displayVersion || t('clients.versionUnknown')}</span>
                    <small>{installation.activeSchemes.length ? t('clients.protocols', { count: installation.activeSchemes.length }) : t('clients.notSystemHandler')}</small>
                  </div>
                  <div className="clients-installation__actions">
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
                        className="clients-installation__remove"
                        disabled={busyId !== null}
                        title={t('clients.forgetTitle')}
                        onClick={() => void removePathPreset(installation)}
                      >
                        {busyId === `preset:remove:${installation.id}`
                          ? <LoaderCircle className="clients-spin" size={12} />
                          : <Trash2 size={12} />}
                        {t('clients.forget')}
                      </button>
                    ) : null}
                  </div>
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

      <section className="clients-deployments">
        <div className="clients-section-head">
          <div><span>{t('clients.deployLibrary')}</span><h3>{t('clients.packageArchive')}</h3></div>
          {release ? <span className="clients-live"><i /> LIVE {release.clientVersion}</span> : null}
        </div>

        <div className="clients-release-grid">
          <div className="clients-latest">
            <span className="clients-latest__icon"><RadioTower size={18} /></span>
            <div><small>{t('clients.latest', { channel: release?.channel ?? channel })}</small><strong>{release?.versionGuid ?? t('clients.checking')}</strong><span>{release?.clientVersion ?? t('clients.versionUnavailable')}</span></div>
          </div>
          <label className="clients-field">
            <span>{t('clients.channel')}</span>
            <input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="LIVE" disabled={Boolean(operationId)} />
          </label>
          <label className="clients-field clients-field--version">
            <span>{t('clients.versionGuid')} <em>{t('clients.optional')}</em></span>
            <input value={versionGuid} onChange={(event) => setVersionGuid(event.target.value)} placeholder={release?.versionGuid ?? t('clients.versionPlaceholder')} disabled={Boolean(operationId)} />
          </label>
          {operationId ? (
            <Button variant="secondary" onClick={() => void cancelInstall()}><Square size={13} /> {t('common.cancel')}</Button>
          ) : (
            <Button variant="primary" onClick={() => void startInstall()}><Download size={14} /> {t('clients.downloadDeployment')}</Button>
          )}
        </div>

        <p className="clients-deployment-note">
          <ShieldAlert size={13} /> {t('clients.deploymentNote')}
        </p>

        <AnimatePresence initial={false}>
          {progress && operationId ? (
            <motion.div className="clients-progress" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <span><LoaderCircle className="clients-spin" size={14} /> {progress.stage.replace(/_/g, ' ')}</span>
              <strong>{progress.packageName || progress.versionGuid || t('clients.resolvingManifest')}</strong>
              <span>{progress.percent == null ? '—' : `${Math.round(progress.percent)}%`}</span>
              <div><i style={{ width: `${progress.percent ?? 3}%` }} /></div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="clients-deployment-list">
          {deployments.map((deployment) => (
            <article key={deployment.id}>
              <span><Box size={15} /></span>
              <div>
                <strong>{deployment.versionGuid}</strong>
                <small>{deployment.clientVersion} · {deployment.channel}</small>
                <code title={deployment.installLocation}>{compactPath(deployment.installLocation, t('clients.pathNotExposed'))}</code>
              </div>
              <span>{(deployment.sizeBytes / (1024 * 1024)).toFixed(0)} MB</span>
              <button type="button" onClick={() => {
                const installation = installations.find((item) => item.id === deployment.id || item.versionGuid === deployment.versionGuid);
                if (installation) void selectManagerClient(installation);
              }}>{t('clients.use')}</button>
            </article>
          ))}
          {scanning ? (
            <div className="clients-skeleton" aria-hidden="true"><span /><span /></div>
          ) : null}
          {!loading && !error && deployments.length === 0 ? <p className="clients-empty">{t('clients.noDeployments')}</p> : null}
        </div>
      </section>
    </div>
  );
}

export default ClientsTab;
