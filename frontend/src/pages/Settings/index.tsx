// pages/Settings/index.tsx
//
// Settings page (design.md → Requirement 21). Owns the tab structure — General
// (implemented here), Clients, Mixer, Themes and Sounds — and renders the
// General panel:
//
// - App info: number of saved accounts (from the Account_Store) and the
//   detected Roblox version (`roblox_get_version`) — Requirement 21.1.
// - Interface language: EN/ES selector bound to the shared Language_System
//   (`languageStore` via `useTranslation`); switching cross-fades the UI.
// - Encryption key controls: an input + "Save key" action that invokes
//   `enc_set_key` with the entered key, unchanged — Requirement 21.2.
// - Account browser: a read-only install/update status for the standalone
//   Wayfern build plus the action that downloads it. Wayfern is now the only
//   provider, so there is no provider choice to present.
// - Multi-instance status: read-only enabled/disabled indicator from
//   `multi_instance_status`, plus the Anti-AFK toggle that reflects the stored
//   `antiAfk` setting and persists changes via `settings_save` — Requirement
//   21.5.
// - "Delete all" entry point: a destructive action gated behind a
//   ConfirmDialog that, on confirmation, removes every saved account —
//   Requirement 21.6.
//
// RACKLINE: the page renders the mandatory `.rk-page` skeleton (head / toolbar
// / one scroll port), the tab strip lives in the shared `.rk-toolbar` with a
// roving tabindex, and every individual setting is a `.rk-row` inside a
// `.rk-panel` — label and description on the left, control right-aligned. The
// gutter tick is not decoration: it reports whether the setting is on, so a
// column of toggles can be read without parsing every label.
//
// Runtime tuning is delegated to {@link MixerTab}, Themes to {@link ThemesTab}
// and Sounds to {@link SoundsTab}. Keeping these panels local to Settings
// preserves the no-cross-page-import boundary (Requirement 1.1).

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
  DatabaseBackup,
  Download,
  Globe2,
  KeyRound,
  Languages,
  Palette,
  RadioTower,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Volume2,
  Upload,
  Zap,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Switch } from '@/components/Switch';
import { BackupPassphraseModal, type BackupMode } from './BackupPassphraseModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { BloxGenSettingsPanel } from '@/components/BloxGenSettingsPanel';
import { ipc } from '@/lib/ipc';
import { createSessionCache } from '@/lib/sessionCache';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { LANGUAGES } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
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
    <div className="rk-page settings-page">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1>{t('settings.title')}</h1>
          <span className="rk-page__sub">{t('settings.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <span className="rk-chip" data-tone="ok">
            <ShieldCheck size={12} aria-hidden="true" />
            {t('settings.localBadge')}
          </span>
        </div>
      </header>

      <div className="rk-toolbar">
        <LayoutGroup id="settings-sections">
          <div className="set-tabs" role="tablist" aria-label={t('settings.tabsAria')}>
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
                  className="set-tab"
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {/* Rendered first so the label paints above the moving fill. */}
                  {selected ? (
                    <motion.span
                      className="set-tab__signal"
                      layoutId="settings-tab-signal"
                      transition={reducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 520, damping: 38, mass: 0.62 }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
      </div>

      <div className="rk-page__body">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={activeTab}
            id={`settings-panel-${activeTab}`}
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

  // ── Encrypted backup (.rambak) flow ──
  const [backupMode, setBackupMode] = useState<BackupMode | null>(null);

  // ── Account browser (standalone Wayfern; the only provider) ──
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
      wayfernStatus,
    });
  }, [robloxVersion, multiInstance, antiAfk, wayfernStatus]);

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
        if (!cancelled) setAntiAfk(settings.antiAfk);
      } catch {
        /* leave "unknown" — toggle stays disabled */
      }
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
  }, []);

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

  const wayfernPercent = Math.round(wayfernProgress?.percent ?? 0);
  // The extract stage reports no byte percentage, so the meter is pinned full
  // while the archive unpacks rather than snapping back to zero.
  const wayfernFill = wayfernProgress?.stage === 'extracting' ? 100 : wayfernPercent;
  const wayfernLabel = installingWayfern
    ? wayfernProgress?.stage === 'extracting'
      ? t('settings.wayfern.extracting')
      : t('settings.wayfern.downloading')
    : wayfernStatus?.installed
      ? t('settings.wayfern.installed', { version: wayfernStatus.version ?? '' }).replace(/\s{2,}/g, ' ')
      : t('settings.wayfern.notInstalled');

  return (
    <div className="set-stack settings-general">
      {/* ── Overview (Requirement 21.1) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><CircleGauge size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.overview.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.overview.title')}</h2>
          </div>
          <span className="rk-chip" data-tone="ok">
            <Activity size={11} aria-hidden="true" /> {t('settings.overview.ready')}
          </span>
        </div>
        <div className="rk-stats">
          <div className="rk-stat">
            <span className="rk-stat__label">{t('settings.overview.savedAccounts')}</span>
            <span className="rk-stat__value u-num">{accountCount}</span>
            <span className="set-stat__note">{t('settings.overview.encryptedLocally')}</span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">{t('settings.overview.robloxClient')}</span>
            <span className="rk-stat__value u-num" title={robloxVersion ?? t('common.unknown')}>
              {robloxVersion ?? t('common.unknown')}
            </span>
            <span className="set-stat__note">{t('settings.overview.detectedInstall')}</span>
          </div>
        </div>
      </section>

      {/* ── Interface language ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Languages size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.language.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.language.title')}</h2>
          </div>
          <span className="rk-chip" data-tone="accent">
            <Globe2 size={11} aria-hidden="true" /> {language.toUpperCase()}
          </span>
        </div>
        <p className="set-hint">{t('settings.language.hint')}</p>
        <div className="set-rows" role="radiogroup" aria-label={t('settings.language.groupAria')}>
          {LANGUAGES.map((lang) => {
            const selected = language === lang;
            return (
              <button
                key={lang}
                type="button"
                role="radio"
                aria-label={t(`lang.${lang}`)}
                aria-checked={selected}
                data-interactive="true"
                className="rk-row set-row"
                onClick={() => setLanguage(lang)}
              >
                <span className="rk-row__gutter">
                  <i className="rk-row__tick" data-tone={selected ? 'accent' : undefined} />
                </span>
                <span className="rk-row__main">
                  <span className="rk-row__title">{t(`lang.${lang}`)}</span>
                  <span className="rk-row__meta">
                    {t(lang === 'en' ? 'settings.language.enDesc' : 'settings.language.esDesc')}
                  </span>
                </span>
                <span className="set-row__control">
                  {selected ? <Check size={15} strokeWidth={2.4} aria-hidden="true" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Encryption key (Requirement 21.2) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><KeyRound size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.security.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.security.title')}</h2>
          </div>
        </div>
        <p className="set-hint">{t('settings.security.hint')}</p>
        <div className="set-rows">
          <div className="rk-row set-row">
            <span className="rk-row__gutter">
              <i className="rk-row__tick" data-tone="accent" />
            </span>
            <span className="rk-row__main">
              <label className="rk-row__title" htmlFor="settings-enc-key">
                {t('settings.security.newKeyLabel')}
              </label>
              <span className="set-field-row">
                <input
                  id="settings-enc-key"
                  className="fm-input set-input set-input--grow"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('settings.security.newKeyLabel')}
                  aria-label={t('settings.security.newKeyLabel')}
                  value={encKey}
                  onChange={(event) => setEncKey(event.target.value)}
                />
              </span>
            </span>
            <span className="set-row__control">
              <Button
                variant="primary"
                size="lg"
                onClick={() => void onSaveKey()}
                disabled={savingKey}
                aria-label={t('settings.security.saveKeyAria')}
              >
                {savingKey ? t('common.saving') : t('settings.security.saveKey')}
              </Button>
            </span>
          </div>
        </div>
      </section>

      {/* ── Encrypted backup ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><DatabaseBackup size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.backup.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.backup.title')}</h2>
          </div>
        </div>
        <p className="set-hint">{t('settings.backup.hint')}</p>
        <div className="set-actions">
          <Button
            variant="secondary"
            onClick={() => setBackupMode('export')}
            aria-label={t('settings.backup.exportAria')}
          >
            <Download size={15} aria-hidden="true" />
            {t('settings.backup.export')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setBackupMode('import')}
            aria-label={t('settings.backup.importAria')}
          >
            <Upload size={15} aria-hidden="true" />
            {t('settings.backup.import')}
          </Button>
        </div>
      </section>

      {/* ── Account browser (Wayfern) ── */}
      <section className="rk-panel set-panel settings-browser-card">
        <div className="rk-panel__head">
          <span className="set-icon" data-tone="accent" aria-hidden="true"><RadioTower size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.provider.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.provider.title')}</h2>
          </div>
          <span className="rk-chip" data-tone={wayfernStatus?.installed ? 'ok' : 'neutral'}>
            Wayfern
          </span>
        </div>
        <p className="set-hint">{t('settings.provider.hint')}</p>
        <div className="set-rows">
          <div className="rk-row set-row">
            <span className="rk-row__gutter">
              <i
                className="rk-row__tick"
                data-tone={
                  installingWayfern
                    ? 'accent'
                    : wayfernStatus?.updateAvailable
                      ? 'warn'
                      : wayfernStatus?.installed
                        ? 'ok'
                        : undefined
                }
              />
            </span>
            <span className="rk-row__main">
              <span className="rk-row__title">{wayfernLabel}</span>
              <span className="rk-row__meta">{t('settings.wayfern.buildNote')}</span>
            </span>
            <span className="set-row__control">
              <Button
                variant="primary"
                onClick={() => void installWayfern()}
                disabled={installingWayfern}
              >
                {installingWayfern
                  ? <span className="rk-spin" aria-hidden="true" />
                  : <Download size={15} strokeWidth={2} aria-hidden="true" />}
                {installingWayfern
                  ? `${wayfernPercent}%`
                  : wayfernStatus?.updateAvailable
                    ? t('settings.wayfern.update')
                    : wayfernStatus?.installed
                      ? t('settings.wayfern.recheck')
                      : t('settings.wayfern.download')}
              </Button>
            </span>
          </div>
        </div>
        {installingWayfern ? (
          <div
            className="set-meter"
            role="progressbar"
            aria-label={t('settings.wayfern.progressAria')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={wayfernPercent}
          >
            {/* Spec motion #6: scaleX from a left origin, never an animated width. */}
            <span className="set-meter__fill" style={{ transform: `scaleX(${wayfernFill / 100})` }} />
          </div>
        ) : null}
      </section>

      {/* ── Runtime / Anti-AFK (Requirement 21.5) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Zap size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.runtime.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.runtime.title')}</h2>
          </div>
          <span className="rk-chip" data-tone={multiInstance ? 'ok' : 'neutral'}>
            {multiInstanceLabel}
          </span>
        </div>
        <div className="set-rows">
          <div className="rk-row set-row">
            <span className="rk-row__gutter">
              <i className="rk-row__tick" data-tone={antiAfk ? 'ok' : undefined} />
            </span>
            <span className="rk-row__main">
              <span className="rk-row__title">{t('sidebar.antiAfk')}</span>
              <span className="rk-row__meta">{t('settings.runtime.antiAfkHint')}</span>
            </span>
            <span className="set-row__control">
              <Switch
                checked={antiAfk ?? false}
                onChange={(next) => void onToggleAntiAfk(next)}
                disabled={antiAfk === null || savingAntiAfk}
                aria-label="Anti-AFK"
              />
            </span>
          </div>
        </div>
      </section>

      <SessionAutomationCard />

      <BloxGenSettingsPanel />

      {/* ── Danger zone (Requirement 21.6) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" data-tone="danger" aria-hidden="true"><Trash2 size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.danger.eyebrow')}</span>
            <h2 className="rk-panel__title">{t('settings.danger.title')}</h2>
          </div>
        </div>
        <div className="set-rows">
          <div className="rk-row set-row">
            <span className="rk-row__gutter">
              <i className="rk-row__tick" data-tone="danger" />
            </span>
            <span className="rk-row__main">
              <span className="rk-row__title">{t('settings.danger.deleteAll')}</span>
              <span className="rk-row__meta">
                {t(accountCount === 1 ? 'settings.danger.hintOne' : 'settings.danger.hintMany', { count: accountCount })}
              </span>
            </span>
            <span className="set-row__control">
              <Button
                variant="danger"
                onClick={() => setDeleteAllOpen(true)}
                disabled={deletingAll || accountCount === 0}
                aria-label={t('settings.danger.deleteAllAria')}
              >
                <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                {t('settings.danger.deleteAll')}
              </Button>
            </span>
          </div>
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

      {backupMode !== null && (
        <BackupPassphraseModal mode={backupMode} onClose={() => setBackupMode(null)} />
      )}
    </div>
  );
}

export default Settings;
