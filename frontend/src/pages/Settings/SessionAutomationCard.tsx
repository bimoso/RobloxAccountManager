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
import { createSessionCache } from '@/lib/sessionCache';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';

/** Default manual grid-cell size, matching the backend's 350×350 default. */
const DEFAULT_TARGET_W = 350;
const DEFAULT_TARGET_H = 350;
/** Default windows-per-row, matching the backend default. */
const DEFAULT_PER_ROW = 1;

/**
 * Spawn-gap bounds, mirroring `resolve_spawn_gap_ms` in the backend. The gap is
 * the pause between successive client launches in a bulk run and dominates how
 * long launching many accounts takes, so it is worth tuning — but it also has a
 * floor that is not merely cosmetic: the native helper closes the Roblox
 * singleton-event handles of *already running* clients, so if the next client
 * spawns before the previous one has created its handle, the two collapse into
 * a single instance. 4000 ms is the long-standing safe default; lower it a step
 * at a time and confirm every account really opened.
 */
const DEFAULT_SPAWN_GAP_MS = 4000;
const MIN_SPAWN_GAP_MS = 250;
const MAX_SPAWN_GAP_MS = 60_000;

/** Clamp a spawn gap into the range the backend accepts. */
function clampSpawnGap(value: number): number {
  return Math.min(Math.max(Math.floor(value), MIN_SPAWN_GAP_MS), MAX_SPAWN_GAP_MS);
}

/** Cadence of the live window-count poll while the card is mounted. */
const WINDOW_COUNT_POLL_MS = 4_000;

/**
 * Last known card state, kept across unmounts. The card is remounted on every
 * visit to Settings, so without this every control started disabled (values
 * `null`) until the stored settings re-resolved. The card hydrates from this
 * snapshot for an instant, interactive paint and still re-loads the settings
 * on mount to reconcile with outside changes.
 */
interface SessionAutomationSnapshot {
  autoRelaunch: boolean | null;
  replaceRunning: boolean | null;
  layoutEnabled: boolean | null;
  autoLayout: boolean | null;
  savedSize: [number, number];
  savedPerRow: number;
  savedSpawnGap: number;
  runningCount: number;
}

const sessionAutomationCache = createSessionCache<SessionAutomationSnapshot>();

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
  // A previous mount's snapshot counts as "known": hydrating from it keeps the
  // controls interactive across revisits while the mount load reconciles.
  const cached = sessionAutomationCache.get();
  const [autoRelaunch, setAutoRelaunch] = useState<boolean | null>(cached?.autoRelaunch ?? null);
  const [replaceRunning, setReplaceRunning] = useState<boolean | null>(cached?.replaceRunning ?? null);
  const [layoutEnabled, setLayoutEnabled] = useState<boolean | null>(cached?.layoutEnabled ?? null);
  const [autoLayout, setAutoLayout] = useState<boolean | null>(cached?.autoLayout ?? null);
  const [sizeText, setSizeText] = useState(
    cached ? `${cached.savedSize[0]}x${cached.savedSize[1]}` : `${DEFAULT_TARGET_W}x${DEFAULT_TARGET_H}`,
  );
  const [perRowText, setPerRowText] = useState(
    cached ? String(cached.savedPerRow) : String(DEFAULT_PER_ROW),
  );
  const [savedSize, setSavedSize] = useState<[number, number]>(
    cached?.savedSize ?? [DEFAULT_TARGET_W, DEFAULT_TARGET_H],
  );
  const [savedPerRow, setSavedPerRow] = useState(cached?.savedPerRow ?? DEFAULT_PER_ROW);
  const [spawnGapText, setSpawnGapText] = useState(
    String(cached?.savedSpawnGap ?? DEFAULT_SPAWN_GAP_MS),
  );
  const [savedSpawnGap, setSavedSpawnGap] = useState(cached?.savedSpawnGap ?? DEFAULT_SPAWN_GAP_MS);
  const [saving, setSaving] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [runningCount, setRunningCount] = useState(cached?.runningCount ?? 0);

  // Mirror the loaded/mutated values back into the session snapshot so the
  // next mount hydrates from exactly what was last on screen.
  useEffect(() => {
    sessionAutomationCache.set({
      autoRelaunch,
      replaceRunning,
      layoutEnabled,
      autoLayout,
      savedSize,
      savedPerRow,
      savedSpawnGap,
      runningCount,
    });
  }, [autoRelaunch, replaceRunning, layoutEnabled, autoLayout, savedSize, savedPerRow, savedSpawnGap, runningCount]);

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
        const gap = typeof settings.launchSpawnGapMs === 'number'
          ? clampSpawnGap(settings.launchSpawnGapMs)
          : DEFAULT_SPAWN_GAP_MS;
        setSavedSpawnGap(gap);
        setSpawnGapText(String(gap));
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

  /** Commit the spawn-gap field (blur / Enter). Invalid text reverts. */
  const commitSpawnGap = useCallback(async () => {
    const parsed = Number.parseInt(spawnGapText, 10);
    if (!Number.isFinite(parsed)) {
      setSpawnGapText(String(savedSpawnGap));
      return;
    }
    const next = clampSpawnGap(parsed);
    setSpawnGapText(String(next));
    if (next === savedSpawnGap) return;
    try {
      await ipc.saveSettings({ launchSpawnGapMs: next });
      setSavedSpawnGap(next);
      showSuccess(t('settings.session.spawnGapSaved'));
    } catch {
      setSpawnGapText(String(savedSpawnGap));
    }
  }, [spawnGapText, savedSpawnGap, showSuccess, t]);

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
        {/* Not gated by `manualDisabled`: the spawn gap governs launching, not
            the window grid, so it applies whether or not layout is enabled. */}
        <div className="settings-session-field">
          <label className="settings-field-label" htmlFor="session-spawn-gap">
            {t('settings.session.spawnGap')}
          </label>
          <div className="settings-session-inline">
            <input
              id="session-spawn-gap"
              className="settings-input settings-session-input settings-session-input--narrow"
              type="number"
              min={MIN_SPAWN_GAP_MS}
              max={MAX_SPAWN_GAP_MS}
              step={250}
              aria-label={t('settings.session.spawnGapAria')}
              aria-describedby="session-spawn-gap-hint"
              value={spawnGapText}
              onChange={(event) => setSpawnGapText(event.target.value)}
              onBlur={() => void commitSpawnGap()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span className="settings-session-unit">{t('settings.session.spawnGapUnit')}</span>
          </div>
          <small id="session-spawn-gap-hint" className="settings-hint">
            {t('settings.session.spawnGapHint')}
          </small>
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
