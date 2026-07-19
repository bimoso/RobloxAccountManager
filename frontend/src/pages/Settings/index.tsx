// pages/Settings/index.tsx
//
// Settings page (design.md → Requirement 21). Owns the tab structure — General
// (implemented here), Themes and Sounds — and renders the General panel:
//
// - App info: number of saved accounts (from the Account_Store) and the
//   detected Roblox version (`roblox_get_version`) — Requirement 21.1.
// - Interface language: EN/ES selector bound to the shared Language_System
//   (`languageStore` via `useTranslation`); switching cross-fades the UI.
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
  Globe2,
  HardDrive,
  KeyRound,
  Languages,
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
import { createSessionCache } from '@/lib/sessionCache';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { LANGUAGES } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { donutTokenStatus, type DonutTokenStatus } from './donutTokenStatus';
import { SessionAutomationCard } from './SessionAutomationCard';
import { ThemesTab } from './ThemesTab';
import { SoundsTab } from './SoundsTab';
import { MixerTab } from './MixerTab';
import { ClientsTab } from './ClientsTab';
import type { WayfernProgress, WayfernStatus } from '@/types/models';
import './Settings.css';

/** Settings owns local configuration, including the former standalone Mixer. */
export type SettingsTab = 'general' | 'clients' | 'mixer' | 'themes' | 'sounds';

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; labelKey: MessageKey; icon: LucideIcon }> = [
  { id: 'general', labelKey: 'settings.tab.general', icon: SlidersHorizontal },
  { id: 'clients', labelKey: 'settings.tab.clients', icon: Boxes },
  { id: 'mixer', labelKey: 'settings.tab.mixer', icon: AudioWaveform },
  { id: 'themes', labelKey: 'settings.tab.themes', icon: Palette },
  { id: 'sounds', labelKey: 'settings.tab.sounds', icon: Volume2 },
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
  const { t } = useTranslation();

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
          <span className="settings-page-kicker">{t('settings.kicker')}</span>
          <h1 className="settings-title">{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
        <span className="settings-local-badge">
          <ShieldCheck size={14} aria-hidden="true" />
          {t('settings.localBadge')}
        </span>
      </header>

      <LayoutGroup id="settings-sections">
        <div className="settings-tabs-wrap">
          <div className="settings-tab-bar" role="tablist" aria-label={t('settings.tabsAria')}>
            {SETTINGS_TABS.map((tab, index) => {
              const Icon = tab.icon;
              const selected = tab.id === activeTab;
              const label = t(tab.labelKey);
              return (
                <button
                  key={tab.id}
                  ref={(node) => { tabRefs.current[index] = node; }}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-label={label}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`settings-tab-btn${selected ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                  <span>{label}</span>
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
 * Last known General-tab data, kept across unmounts. The tab is remounted on
 * every visit to Settings (and on every tab switch), so without this the whole
 * panel showed "Unknown" badges and disabled toggles while every mount-time
 * IPC call re-resolved. The tab hydrates from this snapshot for an instant
 * paint and still re-runs the mount loads silently to pick up outside changes.
 */
interface GeneralTabSnapshot {
  robloxVersion: string | null;
  multiInstance: boolean | null;
  antiAfk: boolean | null;
  browserProvider: 'donut' | 'wayfern';
  donutStatus: DonutTokenStatus | null;
  wayfernStatus: WayfernStatus | null;
}

const generalTabCache = createSessionCache<GeneralTabSnapshot>();

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
  const { t, language, setLanguage } = useTranslation();

  // Hydrate every mount-loaded field from the session snapshot so revisiting
  // Settings paints the last known values immediately; the mount effect below
  // still re-loads everything to reconcile with outside changes.
  const cached = generalTabCache.get();

  // ── App info (Requirement 21.1) ──
  const [robloxVersion, setRobloxVersion] = useState<string | null>(cached?.robloxVersion ?? null);

  // ── Multi-instance status (Requirement 21.5) ──
  const [multiInstance, setMultiInstance] = useState<boolean | null>(cached?.multiInstance ?? null);

  // ── Anti-AFK toggle (Requirement 21.5) ──
  // Reflects the persisted `antiAfk` setting. `null` means "not yet loaded",
  // which keeps the toggle disabled until the current value is known so we
  // never render (or persist) a value that contradicts the stored setting.
  const [antiAfk, setAntiAfk] = useState<boolean | null>(cached?.antiAfk ?? null);
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
  const [donutStatus, setDonutStatus] = useState<DonutTokenStatus | null>(cached?.donutStatus ?? null);

  // ── Account browser provider ──
  const [browserProvider, setBrowserProvider] = useState<'donut' | 'wayfern'>(cached?.browserProvider ?? 'donut');
  const [savingProvider, setSavingProvider] = useState(false);
  const [wayfernStatus, setWayfernStatus] = useState<WayfernStatus | null>(cached?.wayfernStatus ?? null);
  const [wayfernProgress, setWayfernProgress] = useState<WayfernProgress | null>(null);
  const [installingWayfern, setInstallingWayfern] = useState(false);

  // Mirror the loaded/mutated values back into the session snapshot on every
  // change (loads, optimistic toggles, reverts) so the next mount hydrates
  // from exactly what was last on screen.
  useEffect(() => {
    generalTabCache.set({
      robloxVersion,
      multiInstance,
      antiAfk,
      browserProvider,
      donutStatus,
      wayfernStatus,
    });
  }, [robloxVersion, multiInstance, antiAfk, browserProvider, donutStatus, wayfernStatus]);

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
      showSuccess(t('settings.wayfern.ready', { version: status.version ?? '' }).replace(/\s{2,}/g, ' '));
    } catch {
      // Central IPC error reporting already explains the failure.
    } finally {
      setInstallingWayfern(false);
    }
  }, [installingWayfern, showSuccess, t]);

  const onSelectBrowserProvider = useCallback(async (next: 'donut' | 'wayfern') => {
    if (savingProvider || next === browserProvider) return;
    const previous = browserProvider;
    setBrowserProvider(next);
    setSavingProvider(true);
    try {
      await ipc.saveSettings({ browserProvider: next });
      showSuccess(next === 'wayfern'
        ? t('settings.provider.wayfernSelected')
        : t('settings.provider.donutSelected'));
    } catch {
      setBrowserProvider(previous);
    } finally {
      setSavingProvider(false);
    }
  }, [browserProvider, savingProvider, showSuccess, t]);

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
        showSuccess(t('settings.security.keyUpdated'));
      } else {
        showError(t('settings.security.keyUpdateFailed'));
      }
    } catch {
      // lib/ipc already reported the failure as a toast.
    } finally {
      setSavingKey(false);
    }
  }, [encKey, savingKey, showSuccess, showError, t]);

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
        showSuccess(t('settings.token.saved'));
        // Reflect the new configured/not-configured status (Requirement 21.4).
        await refreshDonutStatus();
      } else {
        showError(t('settings.token.saveFailed'));
      }
    } catch {
      // lib/ipc already reported the failure as a toast.
    } finally {
      setSavingToken(false);
    }
  }, [donutToken, savingToken, showSuccess, showError, refreshDonutStatus, t]);

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
        showSuccess(next ? t('settings.runtime.antiAfkOn') : t('settings.runtime.antiAfkOff'));
      } catch {
        // Persist failed: revert to the previous value. lib/ipc already toasted.
        setAntiAfk(previous);
      } finally {
        setSavingAntiAfk(false);
      }
    },
    [antiAfk, savingAntiAfk, showSuccess, t],
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
    multiInstance === null
      ? t('common.unknown')
      : multiInstance
        ? t('common.enabled')
        : t('common.disabled');

  return (
    <div className="settings-general">
      <section className="settings-card settings-card--overview">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><CircleGauge size={17} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.overview.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.overview.title')}</h2>
            </div>
          </div>
          <span className="settings-status-badge settings-status-badge--on">
            <Activity size={11} /> {t('settings.overview.ready')}
          </span>
        </div>
        <div className="settings-metric-grid">
          <div className="settings-metric">
            <span>{t('settings.overview.savedAccounts')}</span>
            <strong>{accountCount}</strong>
            <small>{t('settings.overview.encryptedLocally')}</small>
          </div>
          <div className="settings-metric settings-metric--version">
            <span>{t('settings.overview.robloxClient')}</span>
            <strong title={robloxVersion ?? t('common.unknown')}>{robloxVersion ?? t('common.unknown')}</strong>
            <small>{t('settings.overview.detectedInstall')}</small>
          </div>
        </div>
      </section>

      <section className="settings-card settings-card--language">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><Languages size={17} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.language.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.language.title')}</h2>
            </div>
          </div>
          <span className="settings-status-badge settings-status-badge--on">
            <Globe2 size={11} /> {language.toUpperCase()}
          </span>
        </div>
        <p className="settings-hint">{t('settings.language.hint')}</p>
        <div className="settings-provider-grid" role="radiogroup" aria-label={t('settings.language.groupAria')}>
          {LANGUAGES.map((lang) => {
            const selected = language === lang;
            return (
              <button
                key={lang}
                type="button"
                role="radio"
                aria-label={t(`lang.${lang}`)}
                aria-checked={selected}
                className={`settings-provider-option${selected ? ' selected' : ''}`}
                onClick={() => setLanguage(lang)}
              >
                <span className="settings-provider-icon"><Languages size={18} strokeWidth={1.9} /></span>
                <span className="settings-provider-copy">
                  <strong>{t(`lang.${lang}`)}</strong>
                  <small>{t(lang === 'en' ? 'settings.language.enDesc' : 'settings.language.esDesc')}</small>
                </span>
                <span className="settings-provider-check"><Check size={14} strokeWidth={2.4} /></span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-card settings-card--security">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><KeyRound size={17} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.security.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.security.title')}</h2>
            </div>
          </div>
        </div>
        <p className="settings-hint">{t('settings.security.hint')}</p>
        <label className="settings-field-label" htmlFor="settings-enc-key">{t('settings.security.newKeyLabel')}</label>
        <div className="settings-field-row">
          <input
            id="settings-enc-key"
            className="settings-input"
            type="password"
            autoComplete="new-password"
            placeholder={t('settings.security.newKeyLabel')}
            aria-label={t('settings.security.newKeyLabel')}
            value={encKey}
            onChange={(event) => setEncKey(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={() => void onSaveKey()}
            disabled={savingKey}
            aria-label={t('settings.security.saveKeyAria')}
          >
            {savingKey ? t('common.saving') : t('settings.security.saveKey')}
          </Button>
        </div>
      </section>

      <section className="settings-card settings-card--wide settings-browser-card">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon settings-card-icon--feature"><RadioTower size={18} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.provider.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.provider.title')}</h2>
            </div>
          </div>
          <span className="settings-status-badge settings-status-badge--on">
            {browserProvider === 'wayfern' ? 'Wayfern' : 'Donut'}
          </span>
        </div>
        <p className="settings-hint">
          {t('settings.provider.hint')}
        </p>
        <div className="settings-provider-grid" role="radiogroup" aria-label={t('settings.provider.groupAria')}>
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
              <strong>{t('settings.provider.donut')}</strong>
              <small>{t('settings.provider.donutDesc')}</small>
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
              <strong>{t('settings.provider.wayfern')}</strong>
              <small>{t('settings.provider.wayfernDesc')}</small>
            </span>
            <span className="settings-provider-check"><Check size={14} strokeWidth={2.4} /></span>
          </button>
        </div>

        <div className="settings-wayfern-status">
          <div>
            <strong>
              {installingWayfern
                ? wayfernProgress?.stage === 'extracting'
                  ? t('settings.wayfern.extracting')
                  : t('settings.wayfern.downloading')
                : wayfernStatus?.installed
                  ? t('settings.wayfern.installed', { version: wayfernStatus.version ?? '' }).replace(/\s{2,}/g, ' ')
                  : t('settings.wayfern.notInstalled')}
            </strong>
            <small>
              {t('settings.wayfern.buildNote')}
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
                ? t('settings.wayfern.update')
                : wayfernStatus?.installed
                  ? t('settings.wayfern.recheck')
                  : t('settings.wayfern.download')}
          </Button>
        </div>
        {installingWayfern ? (
          <div
            className="settings-download-track"
            role="progressbar"
            aria-label={t('settings.wayfern.progressAria')}
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
              <span className="settings-eyebrow">{t('settings.token.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.token.title')}</h2>
            </div>
          </div>
          <span
            className={`settings-status-badge${
              donutStatus === 'configured' ? ' settings-status-badge--on' : ''
            }`}
          >
            {donutStatus === null
              ? t('common.unknown')
              : donutStatus === 'configured'
                ? t('settings.token.configured')
                : t('settings.token.notConfigured')}
          </span>
        </div>
        <p className="settings-hint">
          {t('settings.token.hint')}
        </p>
        <label className="settings-field-label" htmlFor="settings-donut-token">{t('settings.token.label')}</label>
        <div className="settings-field-row">
          <input
            id="settings-donut-token"
            className="settings-input"
            type="password"
            autoComplete="off"
            placeholder={t('settings.token.placeholder')}
            aria-label={t('settings.token.placeholder')}
            value={donutToken}
            onChange={(event) => setDonutToken(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={() => void onSaveToken()}
            disabled={savingToken}
            aria-label={t('settings.token.saveAria')}
          >
            {savingToken ? t('common.saving') : t('settings.token.save')}
          </Button>
        </div>
      </section> : null}

      <section className={`settings-card settings-card--runtime${browserProvider === 'donut' ? '' : ' settings-card--wide'}`}>
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon"><Zap size={17} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.runtime.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.runtime.title')}</h2>
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
            <strong>{t('sidebar.antiAfk')}</strong>
            <small>{t('settings.runtime.antiAfkHint')}</small>
          </span>
          <Switch
            checked={antiAfk ?? false}
            onChange={(next) => void onToggleAntiAfk(next)}
            disabled={antiAfk === null || savingAntiAfk}
            aria-label="Anti-AFK"
          />
        </div>
      </section>

      <SessionAutomationCard />

      <BloxGenSettingsPanel className="settings-card--wide" />

      <section className="settings-card settings-card--wide settings-card--danger">
        <div className="settings-card-heading">
          <div className="settings-card-title-group">
            <span className="settings-card-icon settings-card-icon--danger"><Trash2 size={17} /></span>
            <div>
              <span className="settings-eyebrow">{t('settings.danger.eyebrow')}</span>
              <h2 className="settings-card-title">{t('settings.danger.title')}</h2>
            </div>
          </div>
        </div>
        <div className="settings-field-row settings-field-row--between">
          <p className="settings-hint">
            {t(accountCount === 1 ? 'settings.danger.hintOne' : 'settings.danger.hintMany', { count: accountCount })}
          </p>
          <Button
            variant="danger"
            onClick={() => setDeleteAllOpen(true)}
            disabled={deletingAll || accountCount === 0}
            aria-label={t('settings.danger.deleteAllAria')}
          >
            <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
            {t('settings.danger.deleteAll')}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={deleteAllOpen}
        title={t('settings.danger.confirmTitle')}
        message={t(accountCount === 1 ? 'settings.danger.confirmOne' : 'settings.danger.confirmMany', { count: accountCount })}
        confirmLabel={t('settings.danger.deleteAll')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onConfirmDeleteAll()}
        onCancel={() => setDeleteAllOpen(false)}
      />
    </div>
  );
}

export default Settings;
