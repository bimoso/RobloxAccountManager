import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useToastStore } from '@/stores/toastStore';
import type {
  RobloxDeployment,
  RobloxDeploymentProgress,
  RobloxInstallation,
  RobloxProtocolState,
  RobloxRelease,
  Settings,
} from '@/types/models';

function compactPath(path: string | null): string {
  if (!path) return 'Ruta no expuesta por esta instalación';
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

/** Roblox client, protocol-routing and isolated deployment control deck. */
export function ClientsTab(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const showSuccess = useToastStore((state) => state.showSuccess);
  const [installations, setInstallations] = useState<RobloxInstallation[]>([]);
  const [protocol, setProtocol] = useState<RobloxProtocolState | null>(null);
  const [release, setRelease] = useState<RobloxRelease | null>(null);
  const [deployments, setDeployments] = useState<RobloxDeployment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [channel, setChannel] = useState('LIVE');
  const [versionGuid, setVersionGuid] = useState('');
  const [presetPath, setPresetPath] = useState('');
  const [presetName, setPresetName] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RobloxDeploymentProgress | null>(null);

  const refresh = useCallback(async (requestedChannel = 'LIVE'): Promise<void> => {
    setLoading(true);
    try {
      const [nextInstallations, nextProtocol, nextRelease, nextDeployments, nextSettings] =
        await Promise.all([
          ipc.scanRobloxInstallations(),
          ipc.getRobloxProtocolState(),
          ipc.getLatestRobloxRelease(requestedChannel),
          ipc.listRobloxDeployments(),
          ipc.loadSettings(),
        ]);
      setInstallations(nextInstallations);
      setProtocol(nextProtocol);
      setRelease(nextRelease);
      setDeployments(nextDeployments);
      setSettings(nextSettings);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh('LIVE');
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

  const protocolIds = useMemo(
    () => new Set([
      protocol?.roblox.installationId,
      protocol?.robloxPlayer.installationId,
    ].filter((value): value is string => Boolean(value))),
    [protocol],
  );

  const directPresetId = settings?.robloxLaunchPresetId ?? null;
  const launchMode = settings?.robloxLaunchMode ?? 'direct';

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
      showSuccess(`${installation.displayName} selected for MultiRoblox sessions.`);
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
      showSuccess(`${installation.displayName} now handles roblox:// and roblox-player:.`);
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
      showSuccess('Previous Windows protocol handlers restored.');
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
      showSuccess(`${deployment.versionGuid} installed in the isolated library.`);
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
      showSuccess(`${added.displayName} added from its local path.`);
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
      showSuccess(`${installation.displayName} removed from saved presets. Files were not deleted.`);
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
            <span className="settings-card-eyebrow">Launch routing</span>
            <h2>Roblox client control</h2>
            <p>Choose the client MultiRoblox launches and, separately, which installation owns Windows links.</p>
          </div>
          <Button variant="secondary" onClick={() => void refresh(channel.trim() || 'LIVE')} disabled={loading}>
            <RefreshCw className={loading ? 'clients-spin' : undefined} size={14} /> Scan
          </Button>
        </div>

        <div className="clients-protocol-rail" aria-label="Current Roblox protocol route">
          <div className="clients-protocol-rail__scheme">
            <span><Cable size={13} /> roblox://</span>
            <span><Cable size={13} /> roblox-player:</span>
          </div>
          <span className="clients-protocol-rail__line" aria-hidden="true"><i /><i /><i /></span>
          <div className="clients-protocol-rail__target">
            <small>Windows handler</small>
            <strong>{protocol?.robloxPlayer.installationId
              ? installations.find((item) => item.id === protocol.robloxPlayer.installationId)?.displayName ?? 'External handler'
              : loading ? 'Scanning registry…' : 'No verified handler'}</strong>
            <span>{compactPath(protocol?.robloxPlayer.executable ?? null)}</span>
          </div>
          <div className="clients-protocol-rail__mode">
            <small>MultiRoblox route</small>
            <strong>{launchMode === 'protocol' ? 'Windows protocol' : 'Direct executable'}</strong>
            <span>{directPresetId
              ? installations.find((item) => item.id === directPresetId)?.displayName ?? directPresetId
              : 'Automatic official fallback'}</span>
          </div>
        </div>

        {protocol?.snapshotAvailable ? (
          <div className="clients-restore">
            <span><ShieldAlert size={15} /> A previous protocol binding is safely stored.</span>
            <Button variant="secondary" disabled={busyId !== null} onClick={() => void restoreProtocol()}>
              {busyId === 'restore' ? <LoaderCircle className="clients-spin" size={14} /> : <RotateCcw size={14} />}
              Restore previous
            </Button>
          </div>
        ) : null}
      </section>

      <section className="clients-installations">
        <div className="clients-section-head">
          <div><span>Detected clients</span><h3>Installations on this PC</h3></div>
          <span>{installations.length} found</span>
        </div>
        <form className="clients-path-preset" onSubmit={(event) => {
          event.preventDefault();
          void addPathPreset();
        }}>
          <span className="clients-path-preset__icon"><FolderPlus size={17} /></span>
          <label>
            <span>Version or bootstrapper path</span>
            <input
              value={presetPath}
              onChange={(event) => setPresetPath(event.target.value)}
              placeholder="C:\\RobloxVersions\\version-…  or  C:\\…\\Voidstrap.exe"
              disabled={busyId !== null}
            />
          </label>
          <label className="clients-path-preset__name">
            <span>Preset label <em>optional</em></span>
            <input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="QA client"
              disabled={busyId !== null}
              maxLength={80}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={!presetPath.trim() || busyId !== null}>
            {busyId === 'preset:add' ? <LoaderCircle className="clients-spin" size={14} /> : <FolderPlus size={14} />}
            Add preset
          </Button>
          <small>
            Paste a version folder or its exact .exe. Detects Roblox versions, Bloxstrap, Fishstrap,
            Froststrap, Voidstrap, Nyxstrap and the active Windows handler. Only the route is stored;
            files are never moved or deleted.
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
                    <small title={installation.executable ?? undefined}>{compactPath(installation.executable)}</small>
                  </div>
                  <div className="clients-installation__meta">
                    <span>{installation.versionGuid || installation.displayVersion || 'Version unknown'}</span>
                    <small>{installation.activeSchemes.length ? `${installation.activeSchemes.length}/2 protocols` : 'Not system handler'}</small>
                  </div>
                  <div className="clients-installation__actions">
                    <button
                      type="button"
                      disabled={!installation.executable || busyId !== null}
                      data-active={directActive || undefined}
                      onClick={() => void selectManagerClient(installation)}
                    >
                      {directActive ? <Check size={12} /> : <Route size={12} />}
                      {directActive ? 'Manager active' : 'Use in manager'}
                    </button>
                    <button
                      type="button"
                      disabled={!installation.protocolCapable || busyId !== null}
                      data-active={protocolActive || undefined}
                      title={installation.protocolCapable ? 'Set both Windows protocol handlers' : 'This installation cannot own Win32 Roblox links'}
                      onClick={() => void activateProtocol(installation)}
                    >
                      {protocolActive ? <Check size={12} /> : <RadioTower size={12} />}
                      {protocolActive ? 'Protocol active' : 'Own roblox://'}
                    </button>
                    {installation.detectedBy === 'user_preset' ? (
                      <button
                        type="button"
                        className="clients-installation__remove"
                        disabled={busyId !== null}
                        title="Forget this preset without deleting its files"
                        onClick={() => void removePathPreset(installation)}
                      >
                        {busyId === `preset:remove:${installation.id}`
                          ? <LoaderCircle className="clients-spin" size={12} />
                          : <Trash2 size={12} />}
                        Forget
                      </button>
                    ) : null}
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
          {!loading && installations.length === 0 ? (
            <p className="clients-empty">No verified Roblox installation was found.</p>
          ) : null}
        </div>
      </section>

      <section className="clients-deployments">
        <div className="clients-section-head">
          <div><span>Deployment library</span><h3>Official package archive</h3></div>
          {release ? <span className="clients-live"><i /> LIVE {release.clientVersion}</span> : null}
        </div>

        <div className="clients-release-grid">
          <div className="clients-latest">
            <span className="clients-latest__icon"><RadioTower size={18} /></span>
            <div><small>Latest {release?.channel ?? channel}</small><strong>{release?.versionGuid ?? 'Checking Roblox…'}</strong><span>{release?.clientVersion ?? 'Version unavailable'}</span></div>
          </div>
          <label className="clients-field">
            <span>Channel</span>
            <input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="LIVE" disabled={Boolean(operationId)} />
          </label>
          <label className="clients-field clients-field--version">
            <span>Version GUID <em>optional</em></span>
            <input value={versionGuid} onChange={(event) => setVersionGuid(event.target.value)} placeholder={release?.versionGuid ?? 'version-… (blank = latest)'} disabled={Boolean(operationId)} />
          </label>
          {operationId ? (
            <Button variant="secondary" onClick={() => void cancelInstall()}><Square size={13} /> Cancel</Button>
          ) : (
            <Button variant="primary" onClick={() => void startInstall()}><Download size={14} /> Download deployment</Button>
          )}
        </div>

        <p className="clients-deployment-note">
          <ShieldAlert size={13} /> Packages come from Roblox, are size/MD5 checked and extracted into an isolated folder. Historical builds may auto-update or be rejected by Roblox.
        </p>

        <AnimatePresence initial={false}>
          {progress && operationId ? (
            <motion.div className="clients-progress" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <span><LoaderCircle className="clients-spin" size={14} /> {progress.stage.replace(/_/g, ' ')}</span>
              <strong>{progress.packageName || progress.versionGuid || 'Resolving manifest'}</strong>
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
                <code title={deployment.installLocation}>{compactPath(deployment.installLocation)}</code>
              </div>
              <span>{(deployment.sizeBytes / (1024 * 1024)).toFixed(0)} MB</span>
              <button type="button" onClick={() => {
                const installation = installations.find((item) => item.id === deployment.id || item.versionGuid === deployment.versionGuid);
                if (installation) void selectManagerClient(installation);
              }}>Use</button>
            </article>
          ))}
          {!loading && deployments.length === 0 ? <p className="clients-empty">No isolated deployments installed yet.</p> : null}
        </div>
      </section>
    </div>
  );
}

export default ClientsTab;
