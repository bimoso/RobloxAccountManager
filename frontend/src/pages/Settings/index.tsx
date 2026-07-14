// pages/Settings/index.tsx
//
// Settings page (design.md → Requirement 21). Owns the tab structure — General
// (implemented here), Themes and Sounds — and renders the General panel:
//
// - App info: number of saved accounts (from the Account_Store) and the
//   detected Roblox version (`roblox_get_version`) — Requirement 21.1.
// - Encryption key controls: an input + "Save key" action that invokes
//   `enc_set_key` with the entered key, unchanged — Requirement 21.2.
// - Donut Browser token: an input + "Save token" action that invokes
//   `settings_save_donut_token` with the entered token, unchanged —
//   Requirement 21.3 — plus a read-only configured/not-configured status
//   derived (via the pure `donutTokenStatus` helper) from the stored token,
//   which never reveals its value — Requirement 21.4.
// - Multi-instance status: read-only enabled/disabled indicator from
//   `multi_instance_status`, plus the Anti-AFK toggle that reflects the stored
//   `antiAfk` setting and persists changes via `settings_save` — Requirement
//   21.5.
// - "Delete all" entry point: a destructive action gated behind a
//   ConfirmDialog that, on confirmation, removes every saved account —
//   Requirement 21.6.
//
// Runtime tuning is delegated to {@link MixerTab}, Themes to {@link ThemesTab}
// and Sounds to {@link SoundsTab}. Keeping these panels local to Settings
// preserves the no-cross-page-import boundary (Requirement 1.1) and leaves a
// clean General grid where additional credential panels can be composed.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AudioWaveform,
  Check,
  CircleGauge,
  Download,
  HardDrive,
  KeyRound,
  MonitorCog,
  Palette,
  RadioTower,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Volume2,
  Zap,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Switch } from '@/components/Switch';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { BloxGenSettingsPanel } from '@/components/BloxGenSettingsPanel';
import { ipc } from '@/lib/ipc';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { donutTokenStatus, donutTokenStatusLabel, type DonutTokenStatus } from './donutTokenStatus';
import { ThemesTab } from './ThemesTab';
import { SoundsTab } from './SoundsTab';
import { MixerTab } from './MixerTab';
import { ClientsTab } from './ClientsTab';
import type { WayfernProgress, WayfernStatus } from '@/types/models';
import './Settings.css';

/** Settings owns local configuration, including the former standalone Mixer. */
export type SettingsTab = 'general' | 'clients' | 'mixer' | 'themes' | 'sounds';

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'clients', label: 'Clients', icon: Boxes },
  { id: 'mixer', label: 'Mixer', icon: AudioWaveform },
  { id: 'themes', label: 'Themes', icon: Palette },
  { id: 'sounds', label: 'Sounds', icon: Volume2 },
];

/**
 * The Settings page. Holds the active-tab state and delegates the General panel
 * to {@link GeneralTab}, runtime tuning to {@link MixerTab}, the Themes panel
 * to {@link ThemesTab}, and the Sounds panel to {@link SoundsTab}.
 */
export function Settings(): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reducedMotion = useReducedMotion() ?? false;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % SETTINGS_TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = SETTINGS_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex];
    setActiveTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <span className="settings-page-kicker">Control deck / preferences</span>
          <h1 className="settings-title">Settings</h1>
          <p>Configure account sessions, local security and workspace behavior.</p>
        </div>
        <span className="settings-local-badge">
          <ShieldCheck size={14} aria-hidden="true" />
          Local configuration
        </span>
      </header>

      <LayoutGroup id="settings-sections">
        <div className="settings-tabs-wrap">
          <div className="settings-tab-bar" role="tablist" aria-label="Settings sections">
            {SETTINGS_TABS.map((tab, index) => {
              const Icon = tab.icon;
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  ref={(node) => { tabRefs.current[index] = node; }}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-label={tab.label}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`settings-tab-btn${selected ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                  <span>{tab.label}</span>
                  {selected ? (
                    <motion.span
                      className="settings-tab-signal"
                      layoutId="settings-tab-signal"
                      transition={reducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 520, damping: 38, mass: 0.62 }}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </LayoutGroup>

      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={activeTab}
          id={`settings-panel-${activeTab}`}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          initial={reducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion
            ? { opacity: 1 }
            : {
                opacity: 0,
                y: -3,
                transition: { duration: 0.12, ease: [0.4, 0, 1, 1] },
              }}
          transition={reducedMotion
            ? { duration: 0 }
            : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'clients' && <ClientsTab />}
          {activeTab === 'mixer' && <MixerTab />}
          {activeTab === 'themes' && <ThemesTab />}
          {activeTab === 'sounds' && <SoundsTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * The General tab body (Requirement 21.1–21.3, 21.5, 21.6). All controls wire
 * directly to the shared IPC surface; `lib/ipc` already surfaces failures as an
 * error toast, so success is the only extra feedback this component adds.
 */
function GeneralTab(): JSX.Element {
  const accountCount = useAccountStore((s) => s.accounts.length);
  const accounts = useAccountStore((s) => s.accounts);
  const executeBulkDelete = useAccountStore((s) => s.executeBulkDelete);
  const showSuccess = useToastStore((s) => s.showSuccess);
  const showError = useToastStore((s) => s.showError);

  // ── App info (Requirement 21.1) ──
  const [robloxVersion, setRobloxVersion] = useState<string | null>(null);

  // ── Multi-instance status (Requirement 21.5) ──
  const [multiInstance, setMultiInstance] = useState<boolean | null>(null);

  // ── Anti-AFK toggle (Requirement 21.5) ──
  // Reflects the persisted `antiAfk` setting. `null` means "not yet loaded",
  // which keeps the toggle disabled until the current value is known so we
  // never render (or persist) a value that contradicts the stored setting.
  const [antiAfk, setAntiAfk] = useState<boolean | null>(null);
  const [savingAntiAfk, setSavingAntiAfk] = useState(false);

  // ── Encryption key control (Requirement 21.2) ──
  const [encKey, setEncKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  // ── Donut Browser token control (Requirement 21.3) ──
  const [donutToken, setDonutToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);

  // ── Donut Browser token status (Requirement 21.4) ──
  // Only the configured / not-configured status is ever held or shown here —
  // never the token value itself. `null` means "not yet loaded".
  const [donutStatus, setDonutStatus] = useState<DonutTokenStatus | null>(null);

  // ── Account browser provider ──
  const [browserProvider, setBrowserProvider] = useState<'donut' | 'wayfern'>('donut');
  const [savingProvider, setSavingProvider] = useState(false);
  const [wayfernStatus, setWayfernStatus] = useState<WayfernStatus | null>(null);
  const [wayfernProgress, setWayfernProgress] = useState<WayfernProgress | null>(null);
  const [installingWayfern, setInstallingWayfern] = useState(false);

  // Load the current settings and derive the Donut token status. Kept as a
  // stable callback so it can be reused on mount and to refresh after a save.
  const refreshDonutStatus = useCallback(async () => {
    try {
      const settings = await ipc.loadSettings();
      // `donutTokenStatus` is pure and returns only 'configured' /
      // 'not-configured' — the raw token never reaches component state.
      setDonutStatus(donutTokenStatus(settings));
    } catch {
      // Failure already surfaced as a toast by lib/ipc; leave "unknown".
    }
  }, []);

  // ── Delete all (Requirement 21.6) ──
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Load the detected Roblox version and the multi-instance status on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const version = await ipc.getRobloxVersion();
        if (!cancelled) setRobloxVersion(version);
      } catch {
        // Failure already surfaced as a toast by lib/ipc; leave "unknown".
      }
      try {
        const status = await ipc.multiInstanceStatus();
        if (!cancelled) setMultiInstance(status);
      } catch {
        /* leave "unknown" */
      }
      // Load the current Anti-AFK setting so the toggle reflects it on mount
      // (Requirement 21.5). Until this resolves the toggle stays disabled.
      try {
        const settings = await ipc.loadSettings();
        if (!cancelled) {
          setAntiAfk(settings.antiAfk);
          setBrowserProvider(settings.browserProvider === 'wayfern' ? 'wayfern' : 'donut');
        }
      } catch {
        /* leave "unknown" — toggle stays disabled */
      }
      // Load the Donut token status (Requirement 21.4). `refreshDonutStatus`
      // only sets the derived configured/not-configured status, never a value.
      if (!cancelled) await refreshDonutStatus();
      try {
        const status = await ipc.getWayfernStatus();
        if (!cancelled) setWayfernStatus(status);
      } catch {
        /* Offline is fine: installed status remains unknown until requested. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDonutStatus]);

  // The backend streams the ~1 GB archive and emits byte progress. Subscribe
  // once so installs triggered by this page or the account launcher update the
  // same progress bar.
  useEffect(() => {
    if (!ipc.onWayfernProgress) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void ipc.onWayfernProgress((progress) => {
      if (!cancelled) setWayfernProgress(progress);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const installWayfern = useCallback(async () => {
    if (installingWayfern) return;
    setInstallingWayfern(true);
    try {
      const status = await ipc.installWayfern();
      setWayfernStatus(status);
      showSuccess(`Wayfern ${status.version ?? ''} is ready.`.trim());
    } catch {
      // Central IPC error reporting already explains the failure.
    } finally {
      setInstallingWayfern(false);
    }
  }, [installingWayfern, showSuccess]);

  const onSelectBrowserProvider = useCallback(async (next: 'donut' | 'wayfern') => {
    if (savingProvider || next === browserProvider) return;
    const previous = browserProvider;
    setBrowserProvider(next);
    setSavingProvider(true);
    try {
      await ipc.saveSettings({ browserProvider: next });
      showSuccess(next === 'wayfern' ? 'Standalone Wayfern selected.' : 'Donut Browser selected.');
    } catch {
      setBrowserProvider(previous);
    } finally {
      setSavingProvider(false);
    }
  }, [browserProvider, savingProvider, showSuccess]);

  // Save a new encryption key: invoke `enc_set_key` with the entered key,
  // exactly as typed (Requirement 21.2). An empty key is allowed (it disables
  // encryption / skips the gate, mirroring the setup flow).
  const onSaveKey = useCallback(async () => {
    if (savingKey) return;
    setSavingKey(true);
    try {
      const ok = await ipc.encSetKey(encKey);
      if (ok) {
        setEncKey('');
        showSuccess('Encryption key updated.');
      } else {
        showError('The encryption key could not be updated.');
      }
    } catch {
      // lib/ipc already reported the failure as a toast.
    } finally {
      setSavingKey(false);
    }
  }, [encKey, savingKey, showSuccess, showError]);

  // Save a Donut Browser token: invoke `settings_save_donut_token` with the
  // entered token, exactly as typed (Requirement 21.3). The token value is
  // never echoed back; only the configured/not-configured status is refreshed
  // afterwards (Requirement 21.4).
  const onSaveToken = useCallback(async () => {
    if (savingToken) return;
    setSavingToken(true);
    try {
      const ok = await ipc.saveDonutToken(donutToken);
      if (ok) {
        setDonutToken('');
        showSuccess('Donut Browser token saved.');
        // Reflect the new configured/not-configured status (Requirement 21.4).
        await refreshDonutStatus();
      } else {
        showError('The Donut Browser token could not be saved.');
      }
    } catch {
      // lib/ipc already reported the failure as a toast.
    } finally {
      setSavingToken(false);
    }
  }, [donutToken, savingToken, showSuccess, showError, refreshDonutStatus]);

  // Toggle Anti-AFK (Requirement 21.5): persist the new value via `settings_save`
  // (through `ipc.saveSettings`). The UI updates optimistically for immediate
  // feedback and rolls back if the persist fails (lib/ipc already surfaces the
  // failure as an error toast).
  const onToggleAntiAfk = useCallback(
    async (next: boolean) => {
      if (savingAntiAfk) return;
      const previous = antiAfk;
      setAntiAfk(next);
      setSavingAntiAfk(true);
      try {
        await ipc.saveSettings({ antiAfk: next });
        showSuccess(next ? 'Anti-AFK enabled.' : 'Anti-AFK disabled.');
      } catch {
        // Persist failed: revert to the previous value. lib/ipc already toasted.
        setAntiAfk(previous);
      } finally {
        setSavingAntiAfk(false);
      }
    },
    [antiAfk, savingAntiAfk, showSuccess],
  );

  // Confirm handler for "Delete all" (Requirement 21.6): remove every saved
  // account. Delegates to the Account_Store's bulk-delete, which prunes the
  // local list and shows the completion toast.
  const onConfirmDeleteAll = useCallback(async () => {
    if (deletingAll) return;
    setDeletingAll(true);
    try {
      await executeBulkDelete(accounts.map((account) => account.id));
    } finally {
      setDeletingAll(false);
      setDeleteAllOpen(false);
    }
  }, [accounts, deletingAll, executeBulkDelete]);

  const multiInstanceLabel =
    multiInstance === null ? 'Unknown' : multiInstance ? 'Enabled' : 'Disabled';

  return (
    <div className="settings-general">
      <section className="settings-card settings-card--overview">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><CircleGauge size={17} /></span>
            <div>
              <span className="settings-eyebrow">System overview</span>
              <h2 className="settings-card-title">Application</h2>
            </div>
          </div>
          <span className="settings-status-badge settings-status-badge--on">
            <Activity size={11} /> Ready
          </span>
        </div>
        <div className="settings-metric-grid">
          <div className="settings-metric">
            <span>Saved accounts</span>
            <strong>{accountCount}</strong>
            <small>Encrypted locally</small>
          </div>
          <div className="settings-metric settings-metric--version">
            <span>Roblox client</span>
            <strong title={robloxVersion ?? 'Unknown'}>{robloxVersion ?? 'Unknown'}</strong>
            <small>Detected installation</small>
          </div>
        </div>
      </section>

      <section className="settings-card settings-card--security">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><KeyRound size={17} /></span>
            <div>
              <span className="settings-eyebrow">Local security</span>
              <h2 className="settings-card-title">Encryption key</h2>
            </div>
          </div>
        </div>
        <p className="settings-hint">Protect saved cookies with a custom key, or leave it empty for device-bound encryption.</p>
        <label className="settings-field-label" htmlFor="settings-enc-key">New encryption key</label>
        <div className="settings-field-row">
          <input
            id="settings-enc-key"
            className="settings-input"
            type="password"
            autoComplete="new-password"
            placeholder="New encryption key"
            aria-label="New encryption key"
            value={encKey}
            onChange={(event) => setEncKey(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={() => void onSaveKey()}
            disabled={savingKey}
            aria-label="Save encryption key"
          >
            {savingKey ? 'Saving…' : 'Save key'}
          </Button>
        </div>
      </section>

      <section className="settings-card settings-card--wide settings-browser-card">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon settings-card-icon--feature"><RadioTower size={18} /></span>
            <div>
              <span className="settings-eyebrow">Account sessions</span>
              <h2 className="settings-card-title">Browser provider</h2>
            </div>
          </div>
          <span className="settings-status-badge settings-status-badge--on">
            {browserProvider === 'wayfern' ? 'Wayfern' : 'Donut'}
          </span>
        </div>
        <p className="settings-hint">
          Pick how isolated account browsers are launched. Donut uses its Local API;
          Wayfern runs as a standalone portable browser with one profile per account.
        </p>
        <div className="settings-provider-grid" role="radiogroup" aria-label="Account browser provider">
          <button
            type="button"
            role="radio"
            aria-label="Donut Browser"
            aria-checked={browserProvider === 'donut'}
            className={`settings-provider-option${browserProvider === 'donut' ? ' selected' : ''}`}
            disabled={savingProvider || installingWayfern}
            onClick={() => void onSelectBrowserProvider('donut')}
          >
            <span className="settings-provider-icon"><HardDrive size={18} strokeWidth={1.9} /></span>
            <span className="settings-provider-copy">
              <strong>Donut Browser</strong>
              <small>Managed profiles through the local API</small>
            </span>
            <span className="settings-provider-check"><Check size={14} strokeWidth={2.4} /></span>
          </button>
          <button
            type="button"
            role="radio"
            aria-label="Wayfern portable"
            aria-checked={browserProvider === 'wayfern'}
            className={`settings-provider-option${browserProvider === 'wayfern' ? ' selected' : ''}`}
            disabled={savingProvider || installingWayfern}
            onClick={() => void onSelectBrowserProvider('wayfern')}
          >
            <span className="settings-provider-icon"><MonitorCog size={18} strokeWidth={1.9} /></span>
            <span className="settings-provider-copy">
              <strong>Wayfern portable</strong>
              <small>Standalone browser with isolated profiles</small>
            </span>
            <span className="settings-provider-check"><Check size={14} strokeWidth={2.4} /></span>
          </button>
        </div>

        <div className="settings-wayfern-status">
          <div>
            <strong>
              {installingWayfern
                ? wayfernProgress?.stage === 'extracting' ? 'Extracting Wayfern…' : 'Downloading Wayfern…'
                : wayfernStatus?.installed
                  ? `Wayfern ${wayfernStatus.version ?? ''} installed`
                  : 'Wayfern is not installed'}
            </strong>
            <small>
              Official windows-x64 portable build · download is approximately 1.06 GB
            </small>
          </div>
          <Button
            variant="primary"
            onClick={() => void installWayfern()}
            disabled={installingWayfern}
          >
            <Download size={15} strokeWidth={2} aria-hidden="true" />
            {installingWayfern
              ? `${Math.round(wayfernProgress?.percent ?? 0)}%`
              : wayfernStatus?.updateAvailable
                ? 'Update'
                : wayfernStatus?.installed
                  ? 'Recheck'
                  : 'Download'}
          </Button>
        </div>
        {installingWayfern ? (
          <div
            className="settings-download-track"
            role="progressbar"
            aria-label="Wayfern download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(wayfernProgress?.percent ?? 0)}
          >
            <span style={{ width: `${wayfernProgress?.stage === 'extracting' ? 100 : wayfernProgress?.percent ?? 0}%` }} />
          </div>
        ) : null}
      </section>

      {browserProvider === 'donut' ? <section className="settings-card settings-card--token">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><ShieldCheck size={17} /></span>
            <div>
              <span className="settings-eyebrow">Authentication</span>
              <h2 className="settings-card-title">Donut Browser token</h2>
            </div>
          </div>
          <span
            className={`settings-status-badge${
              donutStatus === 'configured' ? ' settings-status-badge--on' : ''
            }`}
          >
            {donutStatus === null ? 'Unknown' : donutTokenStatusLabel(donutStatus)}
          </span>
        </div>
        <p className="settings-hint">
          Authorize profile control through Donut Browser's local API.
        </p>
        <label className="settings-field-label" htmlFor="settings-donut-token">API token</label>
        <div className="settings-field-row">
          <input
            id="settings-donut-token"
            className="settings-input"
            type="password"
            autoComplete="off"
            placeholder="Donut Browser token"
            aria-label="Donut Browser token"
            value={donutToken}
            onChange={(event) => setDonutToken(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={() => void onSaveToken()}
            disabled={savingToken}
            aria-label="Save Donut Browser token"
          >
            {savingToken ? 'Saving…' : 'Save token'}
          </Button>
        </div>
      </section> : null}

      <section className={`settings-card settings-card--runtime${browserProvider === 'donut' ? '' : ' settings-card--wide'}`}>
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><Zap size={17} /></span>
            <div>
              <span className="settings-eyebrow">Runtime</span>
              <h2 className="settings-card-title">Instance behavior</h2>
            </div>
          </div>
          <span
            className={`settings-status-badge${
              multiInstance ? ' settings-status-badge--on' : ''
            }`}
          >
            {multiInstanceLabel}
          </span>
        </div>
        <div className="settings-toggle-row">
          <span>
            <strong>Anti-AFK</strong>
            <small>Keep active sessions from timing out while idle.</small>
          </span>
          <Switch
            checked={antiAfk ?? false}
            onChange={(next) => void onToggleAntiAfk(next)}
            disabled={antiAfk === null || savingAntiAfk}
            aria-label="Anti-AFK"
          />
        </div>
      </section>

      <BloxGenSettingsPanel className="settings-card--wide" />

      <section className="settings-card settings-card--wide settings-card--danger">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon settings-card-icon--danger"><Trash2 size={17} /></span>
            <div>
              <span className="settings-eyebrow">Destructive action</span>
              <h2 className="settings-card-title">Danger zone</h2>
            </div>
          </div>
        </div>
        <div className="settings-field-row settings-field-row--between">
          <p className="settings-hint">
            Permanently remove all {accountCount} saved account{accountCount === 1 ? '' : 's'} and their local metadata.
          </p>
          <Button
            variant="danger"
            onClick={() => setDeleteAllOpen(true)}
            disabled={deletingAll || accountCount === 0}
            aria-label="Delete all saved accounts"
          >
            <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
            Delete all
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={deleteAllOpen}
        title="Delete all accounts"
        message={`This will permanently remove all ${accountCount} saved account${
          accountCount === 1 ? '' : 's'
        }. This action is irreversible and cannot be undone.`}
        confirmLabel="Delete all"
        cancelLabel="Cancel"
        onConfirm={() => void onConfirmDeleteAll()}
        onCancel={() => setDeleteAllOpen(false)}
      />
    </div>
  );
}

export default Settings;
