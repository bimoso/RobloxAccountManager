// pages/Settings/SessionAutomationCard.tsx
//
// Multi-instance session automation card, rendered in the Settings General
// tab. Mirrors the classic RAM launcher options for running many accounts at
// once:
//
// - Auto-relaunch closed instances: restart an account after its Roblox window
//   exits unexpectedly (`autoRelaunch`; the backend watch loop performs the
//   relaunch — manual kills never relaunch).
// - Replace running instance: close that account's existing Roblox process
//   before launching again (`replaceRunningInstance`).
// - Window layout: arrange Roblox game windows into a grid as instances open
//   and close (`windowLayoutEnabled`), sized either from the desktop work area
//   (`windowAutoLayout`) or from the fixed target size / per-row settings
//   (`windowTargetWidth`/`windowTargetHeight`/`windowPerRow`), plus a manual
//   "Arrange now" action (`roblox_arrange_windows`).
//
// Every control persists through `ipc.saveSettings` with the same
// optimistic-update-then-revert pattern the General tab's Anti-AFK toggle
// uses; `lib/ipc` already surfaces failures as an error toast. The live
// "active windows" figure polls `roblox_window_count` (class-based Win32
// window detection) while the card is mounted, so it reflects every Roblox
// client on screen — including ones opened outside this app.

import { useCallback, useEffect, useState } from 'react';
import { AppWindow, LayoutGrid } from 'lucide-react';
import { Button } from '@/components/Button';
import { Switch } from '@/components/Switch';
import { ipc } from '@/lib/ipc';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';

/** Default manual grid-cell size, matching the backend's 350×350 default. */
const DEFAULT_TARGET_W = 350;
const DEFAULT_TARGET_H = 350;
/** Default windows-per-row, matching the backend default. */
const DEFAULT_PER_ROW = 1;

/** Cadence of the live window-count poll while the card is mounted. */
const WINDOW_COUNT_POLL_MS = 4_000;

/**
 * Parse a "WxH" target-size string (e.g. `350x350`, `640 × 360`) into a
 * `[width, height]` pair. Returns `null` when the text is not a valid pair of
 * positive integers, so the caller can revert the field.
 */
export function parseTargetSize(text: string): [number, number] | null {
  const match = /^\s*(\d{2,5})\s*[xX×]\s*(\d{2,5})\s*$/.exec(text);
  if (!match) return null;
  const w = Number.parseInt(match[1], 10);
  const h = Number.parseInt(match[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return [w, h];
}

/** Session-automation card for the Settings General tab. */
export function SessionAutomationCard(): JSX.Element {
  const showSuccess = useToastStore((s) => s.showSuccess);
  const showError = useToastStore((s) => s.showError);
  const { t } = useTranslation();

  // `null` = not yet loaded; the controls stay disabled until the stored
  // values are known so a render can never contradict (or clobber) the store.
  const [autoRelaunch, setAutoRelaunch] = useState<boolean | null>(null);
  const [replaceRunning, setReplaceRunning] = useState<boolean | null>(null);
  const [layoutEnabled, setLayoutEnabled] = useState<boolean | null>(null);
  const [autoLayout, setAutoLayout] = useState<boolean | null>(null);
  const [sizeText, setSizeText] = useState(`${DEFAULT_TARGET_W}x${DEFAULT_TARGET_H}`);
  const [perRowText, setPerRowText] = useState(String(DEFAULT_PER_ROW));
  const [savedSize, setSavedSize] = useState<[number, number]>([DEFAULT_TARGET_W, DEFAULT_TARGET_H]);
  const [savedPerRow, setSavedPerRow] = useState(DEFAULT_PER_ROW);
  const [saving, setSaving] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [runningCount, setRunningCount] = useState(0);

  // Load the stored settings once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await ipc.loadSettings();
        if (cancelled) return;
        setAutoRelaunch(settings.autoRelaunch === true);
        setReplaceRunning(settings.replaceRunningInstance === true);
        setLayoutEnabled(settings.windowLayoutEnabled === true);
        setAutoLayout(settings.windowAutoLayout === true);
        const w = typeof settings.windowTargetWidth === 'number' ? settings.windowTargetWidth : DEFAULT_TARGET_W;
        const h = typeof settings.windowTargetHeight === 'number' ? settings.windowTargetHeight : DEFAULT_TARGET_H;
        const perRow = typeof settings.windowPerRow === 'number' && settings.windowPerRow >= 1
          ? Math.floor(settings.windowPerRow)
          : DEFAULT_PER_ROW;
        setSavedSize([w, h]);
        setSizeText(`${w}x${h}`);
        setSavedPerRow(perRow);
        setPerRowText(String(perRow));
      } catch {
        // lib/ipc already surfaced the failure; controls stay disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live active-window figure: poll the class-based window count while the
  // card is mounted. Polling (rather than the `roblox://count` event) also
  // covers clients opened outside this app or before it started — the event
  // only fires while app-launched accounts are being watched.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void ipc.getWindowCount().then((count) => {
        if (!cancelled) setRunningCount(count);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, WINDOW_COUNT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * Persist one boolean setting optimistically: flip the control, save, and
   * roll back on failure (the shared IPC layer already toasted the error).
   */
  const persistToggle = useCallback(async (
    key: 'autoRelaunch' | 'replaceRunningInstance' | 'windowLayoutEnabled' | 'windowAutoLayout',
    next: boolean,
    previous: boolean | null,
    apply: (value: boolean | null) => void,
    successMessage: string,
  ) => {
    if (saving) return;
    apply(next);
    setSaving(true);
    try {
      await ipc.saveSettings({ [key]: next });
      showSuccess(successMessage);
    } catch {
      apply(previous);
    } finally {
      setSaving(false);
    }
  }, [saving, showSuccess]);

  /** Commit the "WxH" target-size field (blur / Enter). Invalid text reverts. */
  const commitTargetSize = useCallback(async () => {
    const parsed = parseTargetSize(sizeText);
    if (!parsed) {
      setSizeText(`${savedSize[0]}x${savedSize[1]}`);
      return;
    }
    const [w, h] = parsed;
    if (w === savedSize[0] && h === savedSize[1]) {
      setSizeText(`${w}x${h}`);
      return;
    }
    setSizeText(`${w}x${h}`);
    try {
      await ipc.saveSettings({ windowTargetWidth: w, windowTargetHeight: h });
      setSavedSize([w, h]);
      showSuccess(t('settings.session.layoutSaved'));
    } catch {
      setSizeText(`${savedSize[0]}x${savedSize[1]}`);
    }
  }, [sizeText, savedSize, showSuccess, t]);

  /** Commit the per-row field (blur / Enter). Invalid text reverts. */
  const commitPerRow = useCallback(async () => {
    const parsed = Number.parseInt(perRowText, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setPerRowText(String(savedPerRow));
      return;
    }
    const next = Math.min(parsed, 20);
    if (next === savedPerRow) {
      setPerRowText(String(next));
      return;
    }
    setPerRowText(String(next));
    try {
      await ipc.saveSettings({ windowPerRow: next });
      setSavedPerRow(next);
      showSuccess(t('settings.session.layoutSaved'));
    } catch {
      setPerRowText(String(savedPerRow));
    }
  }, [perRowText, savedPerRow, showSuccess, t]);

  /** "Arrange now": place every Roblox window into the grid immediately. */
  const onArrangeNow = useCallback(async () => {
    if (arranging) return;
    setArranging(true);
    try {
      const outcome = await ipc.arrangeWindows();
      setRunningCount(outcome.found);
      if (outcome.found === 0) {
        showError(t('settings.session.arrangedNone'));
      } else if (outcome.placed < outcome.found) {
        // Windows refused some moves — usually an elevated Roblox client.
        showError(t('settings.session.arrangedPartial', {
          placed: outcome.placed,
          found: outcome.found,
        }));
      } else {
        showSuccess(t(
          outcome.placed === 1 ? 'settings.session.arrangedOne' : 'settings.session.arrangedMany',
          { count: outcome.placed },
        ));
      }
    } catch {
      // lib/ipc already reported the failure.
    } finally {
      setArranging(false);
    }
  }, [arranging, showError, showSuccess, t]);

  const layoutOn = layoutEnabled === true;
  const manualDisabled = !layoutOn || autoLayout !== false;
  const windowsLabel = t(
    runningCount === 1 ? 'settings.session.windowLayoutHintOne' : 'settings.session.windowLayoutHintMany',
    { count: runningCount },
  );

  return (
    <section className="settings-card settings-card--wide settings-session-card">
      <div className="settings-card-heading">
        <div className="settings-card-title-group">
          <span className="settings-card-icon"><LayoutGrid size={17} /></span>
          <div>
            <span className="settings-eyebrow">{t('settings.session.eyebrow')}</span>
            <h2 className="settings-card-title">{t('settings.session.title')}</h2>
          </div>
        </div>
        <span className={`settings-status-badge${runningCount > 0 ? ' settings-status-badge--on' : ''}`}>
          <AppWindow size={11} aria-hidden="true" /> {windowsLabel}
        </span>
      </div>
      <p className="settings-hint">{t('settings.session.hint')}</p>

      <div className="settings-session-grid">
        <div className="settings-toggle-row">
          <span>
            <strong>{t('settings.session.autoRelaunch')}</strong>
            <small>{t('settings.session.autoRelaunchHint')}</small>
          </span>
          <Switch
            checked={autoRelaunch ?? false}
            disabled={autoRelaunch === null || saving}
            aria-label={t('settings.session.autoRelaunch')}
            onChange={(next) => void persistToggle(
              'autoRelaunch',
              next,
              autoRelaunch,
              setAutoRelaunch,
              t(next ? 'settings.session.autoRelaunchOn' : 'settings.session.autoRelaunchOff'),
            )}
          />
        </div>

        <div className="settings-toggle-row">
          <span>
            <strong>{t('settings.session.replaceRunning')}</strong>
            <small>{t('settings.session.replaceRunningHint')}</small>
          </span>
          <Switch
            checked={replaceRunning ?? false}
            disabled={replaceRunning === null || saving}
            aria-label={t('settings.session.replaceRunning')}
            onChange={(next) => void persistToggle(
              'replaceRunningInstance',
              next,
              replaceRunning,
              setReplaceRunning,
              t(next ? 'settings.session.replaceRunningOn' : 'settings.session.replaceRunningOff'),
            )}
          />
        </div>

        <div className="settings-toggle-row">
          <span>
            <strong>{t('settings.session.windowLayout')}</strong>
            <small>{windowsLabel}</small>
          </span>
          <Switch
            checked={layoutOn}
            disabled={layoutEnabled === null || saving}
            aria-label={t('settings.session.windowLayout')}
            onChange={(next) => void persistToggle(
              'windowLayoutEnabled',
              next,
              layoutEnabled,
              setLayoutEnabled,
              t(next ? 'settings.session.windowLayoutOn' : 'settings.session.windowLayoutOff'),
            )}
          />
        </div>

        <div className={`settings-toggle-row${layoutOn ? '' : ' settings-toggle-row--muted'}`}>
          <span>
            <strong>{t('settings.session.autoLayout')}</strong>
            <small>{t('settings.session.autoLayoutHint')}</small>
          </span>
          <Switch
            checked={autoLayout ?? false}
            disabled={autoLayout === null || !layoutOn || saving}
            aria-label={t('settings.session.autoLayout')}
            onChange={(next) => void persistToggle(
              'windowAutoLayout',
              next,
              autoLayout,
              setAutoLayout,
              t(next ? 'settings.session.autoLayoutOn' : 'settings.session.autoLayoutOff'),
            )}
          />
        </div>
      </div>

      <div className="settings-session-controls">
        <div className="settings-session-field">
          <label className="settings-field-label" htmlFor="session-target-size">
            {t('settings.session.targetSize')}
          </label>
          <input
            id="session-target-size"
            className="settings-input settings-session-input"
            type="text"
            inputMode="numeric"
            placeholder={`${DEFAULT_TARGET_W}x${DEFAULT_TARGET_H}`}
            aria-label={t('settings.session.targetSizeAria')}
            value={sizeText}
            disabled={manualDisabled}
            onChange={(event) => setSizeText(event.target.value)}
            onBlur={() => void commitTargetSize()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </div>
        <div className="settings-session-field">
          <label className="settings-field-label" htmlFor="session-per-row">
            {t('settings.session.perRow')}
          </label>
          <div className="settings-session-inline">
            <input
              id="session-per-row"
              className="settings-input settings-session-input settings-session-input--narrow"
              type="number"
              min={1}
              max={20}
              step={1}
              aria-label={t('settings.session.perRowAria')}
              value={perRowText}
              disabled={manualDisabled}
              onChange={(event) => setPerRowText(event.target.value)}
              onBlur={() => void commitPerRow()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span className="settings-session-unit">{t('settings.session.perRowUnit')}</span>
          </div>
        </div>
        <div className="settings-session-actions">
          <Button
            variant="primary"
            onClick={() => void onArrangeNow()}
            disabled={arranging}
            aria-label={t('settings.session.arrangeNowAria')}
          >
            <LayoutGrid size={14} aria-hidden="true" />
            {t('settings.session.arrangeNow')}
          </Button>
        </div>
      </div>
    </section>
  );
}
