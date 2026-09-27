import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Gauge,
  MonitorUp,
  RotateCw,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Switch } from '@/components/Switch';
import { ipc } from '@/lib/ipc';
import {
  FPS_CAP_UNLIMITED,
  FPS_DEFAULT,
  FPS_MAX,
  FPS_MIN,
  GRAPHICS_QUALITY_DEFAULT,
  GRAPHICS_QUALITY_MAX,
  GRAPHICS_QUALITY_MIN,
  VOLUME_DEFAULT,
  VOLUME_MAX,
  VOLUME_MIN,
  accountsToRelaunch,
  clampInt,
  graphicsQualityFromFlags,
  isGraphicsAuto,
  launchTargetOf,
  manualQualityDisabled,
  relaunchResultMessage,
  relaunchRunningAccounts,
  setGraphicsQualityFlag,
  toFlagMap,
} from '@/lib/mixer';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account } from '@/types/models';
import './Settings.css';

const VOLUME_PREVIEW_DEBOUNCE_MS = 90;

/**
 * Paint the filled portion of a range track. One hard stop, accent to surface —
 * the old two-accent gradient made the same value read as a different level
 * depending on where the track happened to be.
 */
function sliderFill(value: number, min: number, max: number): string {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return `linear-gradient(90deg, var(--ac) ${pct}%, var(--surf-3) ${pct}%)`;
}

/**
 * Runtime tuning panel hosted by Settings. This is the former Mixer page with
 * its IPC and persistence behaviour kept intact, but presented as part of the
 * settings information architecture instead of a separate workspace route.
 */
export function MixerTab(): JSX.Element {
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
  const accounts = useAccountStore((state) => state.accounts);
  const { t } = useTranslation();

  const [relaunching, setRelaunching] = useState(false);
  const [gfxAuto, setGfxAuto] = useState(true);
  const [gfxValue, setGfxValue] = useState(GRAPHICS_QUALITY_DEFAULT);
  const [gfxSaving, setGfxSaving] = useState(false);
  const [fpsUnlimited, setFpsUnlimited] = useState(false);
  const [fpsValue, setFpsValue] = useState(FPS_DEFAULT);
  const [fpsSaving, setFpsSaving] = useState(false);
  const [volume, setVolume] = useState(VOLUME_DEFAULT);
  const [volumeSaving, setVolumeSaving] = useState(false);

  const gfxPersistedRef = useRef(GRAPHICS_QUALITY_DEFAULT);
  const gfxWriteInFlightRef = useRef(false);
  const fpsPersistedRef = useRef(FPS_DEFAULT);
  const fpsWriteInFlightRef = useRef(false);
  const volumeRef = useRef(VOLUME_DEFAULT);
  const volumePersistedRef = useRef(VOLUME_DEFAULT);
  const volumePreviewFrameRef = useRef<number | null>(null);
  const volumePreviewTimerRef = useRef<number | null>(null);
  const volumePreviewPromiseRef = useRef<Promise<unknown> | null>(null);
  const volumePreviewFailedRef = useRef(false);
  const volumeCommitInFlightRef = useRef(false);
  const volumeDirtyRef = useRef(false);

  const cancelScheduledVolumePreview = useCallback(() => {
    if (volumePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(volumePreviewFrameRef.current);
      volumePreviewFrameRef.current = null;
    }
    if (volumePreviewTimerRef.current !== null) {
      window.clearTimeout(volumePreviewTimerRef.current);
      volumePreviewTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const flags = toFlagMap(await ipc.readFFlags());
        if (!cancelled) {
          setGfxAuto(isGraphicsAuto(flags.DFIntDebugFRMQualityLevelOverride));
          const quality = graphicsQualityFromFlags(flags);
          gfxPersistedRef.current = quality;
          setGfxValue(quality);
        }
      } catch {
        // The shared IPC adapter already reports failures.
      }

      try {
        const cap = await ipc.readFpsCap();
        if (!cancelled) {
          const unlimited = cap === FPS_CAP_UNLIMITED;
          setFpsUnlimited(unlimited);
          const nextFps = unlimited
            ? FPS_DEFAULT
            : clampInt(cap, FPS_MIN, FPS_MAX, FPS_DEFAULT);
          fpsPersistedRef.current = nextFps;
          setFpsValue(nextFps);
        }
      } catch {
        // Keep the safe local default when the client is unavailable.
      }

      try {
        const settings = await ipc.loadSettings();
        if (!cancelled) {
          const nextVolume = typeof settings.masterVolume === 'number'
            ? clampInt(settings.masterVolume, VOLUME_MIN, VOLUME_MAX, VOLUME_DEFAULT)
            : VOLUME_DEFAULT;
          volumeRef.current = nextVolume;
          volumePersistedRef.current = nextVolume;
          volumeDirtyRef.current = false;
          setVolume(nextVolume);
        }
      } catch {
        // Keep the safe local default when settings cannot be read.
      }
    })();

    return () => {
      cancelled = true;
      cancelScheduledVolumePreview();
    };
  }, [cancelScheduledVolumePreview]);

  const writeGraphics = useCallback(async (value: number | null) => {
    const flags = toFlagMap(await ipc.readFFlags());
    await ipc.writeFFlags(setGraphicsQualityFlag(flags, value));
  }, []);

  const onGfxAutoToggle = useCallback((checked: boolean) => {
    if (gfxWriteInFlightRef.current) return;
    const previous = gfxAuto;
    gfxWriteInFlightRef.current = true;
    setGfxAuto(checked);
    setGfxSaving(true);
    void (async () => {
      try {
        await writeGraphics(checked ? null : gfxValue);
        if (!checked) gfxPersistedRef.current = gfxValue;
        showSuccess(checked
          ? t('mixer.gfxAuto')
          : t('mixer.gfxSet', { value: gfxValue }));
      } catch {
        // The shared IPC adapter already surfaced one error toast. Roll the
        // optimistic switch back without emitting a duplicate notification.
        setGfxAuto(previous);
      } finally {
        gfxWriteInFlightRef.current = false;
        setGfxSaving(false);
      }
    })();
  }, [gfxAuto, gfxValue, showSuccess, writeGraphics, t]);

  const onGfxCommit = useCallback(() => {
    if (gfxAuto || gfxWriteInFlightRef.current) return;
    const previous = gfxPersistedRef.current;
    gfxWriteInFlightRef.current = true;
    setGfxSaving(true);
    void (async () => {
      try {
        await writeGraphics(gfxValue);
        gfxPersistedRef.current = gfxValue;
        showSuccess(t('mixer.gfxSet', { value: gfxValue }));
      } catch {
        setGfxValue(previous);
      } finally {
        gfxWriteInFlightRef.current = false;
        setGfxSaving(false);
      }
    })();
  }, [gfxAuto, gfxValue, showSuccess, writeGraphics, t]);

  const onFpsUnlimitedToggle = useCallback((checked: boolean) => {
    if (fpsWriteInFlightRef.current) return;
    const previous = fpsUnlimited;
    fpsWriteInFlightRef.current = true;
    setFpsUnlimited(checked);
    setFpsSaving(true);
    void (async () => {
      try {
        await ipc.writeFpsCap(checked ? FPS_CAP_UNLIMITED : fpsValue);
        if (!checked) fpsPersistedRef.current = fpsValue;
        showSuccess(checked
          ? t('mixer.fpsUnlimitedSet')
          : t('mixer.fpsCapSet', { value: fpsValue }));
      } catch {
        setFpsUnlimited(previous);
      } finally {
        fpsWriteInFlightRef.current = false;
        setFpsSaving(false);
      }
    })();
  }, [fpsUnlimited, fpsValue, showSuccess, t]);

  const onFpsCommit = useCallback(() => {
    if (fpsUnlimited || fpsWriteInFlightRef.current) return;
    const previous = fpsPersistedRef.current;
    fpsWriteInFlightRef.current = true;
    setFpsSaving(true);
    void (async () => {
      try {
        await ipc.writeFpsCap(fpsValue);
        fpsPersistedRef.current = fpsValue;
        showSuccess(t('mixer.fpsCapSet', { value: fpsValue }));
      } catch {
        setFpsValue(previous);
      } finally {
        fpsWriteInFlightRef.current = false;
        setFpsSaving(false);
      }
    })();
  }, [fpsUnlimited, fpsValue, showSuccess, t]);

  const onVolumeChange = useCallback((next: number) => {
    volumeRef.current = next;
    volumeDirtyRef.current = true;
    setVolume(next);
    if (volumePreviewFailedRef.current) return;

    // Coalesce the range input's pixel-level event stream into one trailing
    // live preview. Pointer/key commit cancels this timer and writes the exact
    // final value, so an older preview can never overtake the final commit.
    cancelScheduledVolumePreview();
    volumePreviewFrameRef.current = window.requestAnimationFrame(() => {
      volumePreviewFrameRef.current = null;
      volumePreviewTimerRef.current = window.setTimeout(() => {
        volumePreviewTimerRef.current = null;
        const preview = ipc.setRobloxVolume(volumeRef.current).catch(() => {
          // `ipc` already displayed the error. Block more previews for this
          // interaction so a missing audio endpoint cannot create a toast storm.
          volumePreviewFailedRef.current = true;
        });
        volumePreviewPromiseRef.current = preview;
        void preview.then(() => {
          if (volumePreviewPromiseRef.current === preview) {
            volumePreviewPromiseRef.current = null;
          }
        });
      }, VOLUME_PREVIEW_DEBOUNCE_MS);
    });
  }, [cancelScheduledVolumePreview]);

  const onVolumeCommit = useCallback(() => {
    cancelScheduledVolumePreview();
    if (volumeCommitInFlightRef.current || !volumeDirtyRef.current) return;

    const next = volumeRef.current;
    const previous = volumePersistedRef.current;
    volumeCommitInFlightRef.current = true;
    setVolumeSaving(true);
    void (async () => {
      try {
        // If a paused drag already started a preview, serialize behind it so
        // this exact final value is guaranteed to be the last audio write.
        await volumePreviewPromiseRef.current;
        await ipc.saveSettings({ masterVolume: next });
        volumePersistedRef.current = next;
        await ipc.setRobloxVolume(next);
        volumePreviewFailedRef.current = false;
        volumeDirtyRef.current = false;
        showSuccess(t('mixer.volumeSet', { value: next }));
      } catch {
        // A failed persistence write means the previous value remains the
        // source of truth. `ipc` already emitted the single failure toast.
        if (volumePersistedRef.current === previous) {
          volumeRef.current = previous;
          volumeDirtyRef.current = false;
          setVolume(previous);
        } else {
          // Persistence succeeded but the live audio endpoint failed. Keep the
          // saved value visible; it will be applied again on the next session.
          volumeDirtyRef.current = false;
        }
      } finally {
        volumeCommitInFlightRef.current = false;
        setVolumeSaving(false);
      }
    })();
  }, [cancelScheduledVolumePreview, showSuccess, t]);

  const relaunchAccount = useCallback(async (account: Account) => {
    await ipc.killOneRoblox(account.id);
    await ipc.launchRoblox(account.id, account.cookie, launchTargetOf(account));
  }, []);

  const onApplyAndRelaunch = useCallback(async () => {
    if (relaunching) return;
    const running = accountsToRelaunch(accounts);
    if (running.length === 0) {
      showSuccess(t('mixer.noRunning'));
      return;
    }

    setRelaunching(true);
    try {
      const result = await relaunchRunningAccounts(accounts, relaunchAccount);
      const message = relaunchResultMessage(result.succeeded, result.total);
      if (result.failed === 0) showSuccess(message);
      else showError(message);
    } finally {
      setRelaunching(false);
    }
  }, [accounts, relaunchAccount, relaunching, showError, showSuccess, t]);

  const runningCount = accountsToRelaunch(accounts).length;
  const gfxDisabled = manualQualityDisabled(gfxAuto);

  return (
    <div className="set-stack settings-mixer">
      <header className="set-tabhead">
        <span className="set-icon" data-tone="accent" aria-hidden="true">
          <SlidersHorizontal size={15} strokeWidth={1.9} />
        </span>
        <div className="set-tabhead__text">
          <span className="rk-eyebrow">{t('mixer.eyebrow')}</span>
          <h2>{t('mixer.title')}</h2>
          <p>{t('mixer.subtitle')}</p>
        </div>
        <span
          className="rk-chip"
          data-tone={runningCount > 0 ? 'ok' : 'neutral'}
          aria-label={t('mixer.runningAria', { count: runningCount })}
        >
          <Activity size={11} aria-hidden="true" />
          <span className="u-num">{runningCount}</span>
          {t('mixer.running')}
        </span>
      </header>

      <section className="rk-panel set-panel" aria-labelledby="mixer-graphics-title">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true">
            <MonitorUp size={15} />
          </span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('mixer.rendering')}</span>
            <h3 id="mixer-graphics-title" className="rk-panel__title">{t('mixer.graphicsTitle')}</h3>
          </div>
          <label className="set-headtoggle" htmlFor="mix-gfx-auto">
            <span>{t('mixer.auto')}</span>
            <Switch
              id="mix-gfx-auto"
              aria-label={t('mixer.autoAria')}
              checked={gfxAuto}
              disabled={gfxSaving}
              onChange={onGfxAutoToggle}
            />
          </label>
        </div>
        <p className="set-hint">{t('mixer.graphicsHint')}</p>
        <div className="set-slider-row">
          <input
            id="mix-gfx"
            className="set-slider"
            type="range"
            min={GRAPHICS_QUALITY_MIN}
            max={GRAPHICS_QUALITY_MAX}
            step={1}
            value={gfxValue}
            disabled={gfxDisabled || gfxSaving}
            aria-label={t('mixer.graphicsAria')}
            style={{
              background: sliderFill(gfxValue, GRAPHICS_QUALITY_MIN, GRAPHICS_QUALITY_MAX),
            }}
            onChange={(event) => setGfxValue(Number(event.target.value))}
            onMouseUp={onGfxCommit}
            onKeyUp={onGfxCommit}
            onTouchEnd={onGfxCommit}
          />
          <output className="u-num" htmlFor="mix-gfx">
            {gfxDisabled ? 'AUTO' : String(gfxValue).padStart(2, '0')}
          </output>
        </div>
      </section>

      <section className="rk-panel set-panel" aria-labelledby="mixer-fps-title">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true">
            <Gauge size={15} />
          </span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('mixer.framePacing')}</span>
            <h3 id="mixer-fps-title" className="rk-panel__title">{t('mixer.fpsTitle')}</h3>
          </div>
          <label className="set-headtoggle" htmlFor="mix-fps-unl">
            <span>{t('mixer.unlimited')}</span>
            <Switch
              id="mix-fps-unl"
              aria-label={t('mixer.unlimitedAria')}
              checked={fpsUnlimited}
              disabled={fpsSaving}
              onChange={onFpsUnlimitedToggle}
            />
          </label>
        </div>
        <p className="set-hint">{t('mixer.fpsHint')}</p>
        <div className="set-slider-row">
          <input
            id="mix-fps"
            className="set-slider"
            type="range"
            min={FPS_MIN}
            max={FPS_MAX}
            step={1}
            value={fpsValue}
            disabled={fpsUnlimited || fpsSaving}
            aria-label={t('mixer.fpsAria')}
            style={{ background: sliderFill(fpsValue, FPS_MIN, FPS_MAX) }}
            onChange={(event) => setFpsValue(Number(event.target.value))}
            onMouseUp={onFpsCommit}
            onKeyUp={onFpsCommit}
            onTouchEnd={onFpsCommit}
          />
          <output className="u-num" htmlFor="mix-fps">
            {fpsUnlimited ? '∞' : fpsValue}
          </output>
        </div>
      </section>

      <section className="rk-panel set-panel" aria-labelledby="mixer-volume-title">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true">
            <Volume2 size={15} />
          </span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('mixer.liveControl')}</span>
            <h3 id="mixer-volume-title" className="rk-panel__title">{t('mixer.volumeTitle')}</h3>
          </div>
        </div>
        <p className="set-hint">{t('mixer.volumeHint')}</p>
        <div className="set-slider-row">
          <input
            id="mix-vol"
            className="set-slider"
            type="range"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={1}
            value={volume}
            disabled={volumeSaving}
            aria-label={t('mixer.volumeAria')}
            style={{ background: sliderFill(volume, VOLUME_MIN, VOLUME_MAX) }}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
            onPointerUp={onVolumeCommit}
            onPointerCancel={onVolumeCommit}
            onKeyUp={onVolumeCommit}
            onBlur={onVolumeCommit}
          />
          <output className="u-num" htmlFor="mix-vol">{volume}%</output>
        </div>
      </section>

      <section className="rk-panel set-panel" aria-labelledby="mixer-relaunch-title">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true">
            <RotateCw size={15} />
          </span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('mixer.applyChanges')}</span>
            <h3 id="mixer-relaunch-title" className="rk-panel__title">{t('mixer.relaunchTitle')}</h3>
          </div>
        </div>
        <p className="set-hint">
          {runningCount === 0
            ? t('mixer.relaunchNone')
            : t(runningCount === 1 ? 'mixer.relaunchOne' : 'mixer.relaunchMany', { count: runningCount })}
        </p>
        <div className="set-actions">
          <Button
            variant="primary"
            onClick={() => void onApplyAndRelaunch()}
            disabled={relaunching || runningCount === 0}
            aria-label={t('mixer.relaunchAria')}
          >
            <RotateCw size={14} aria-hidden="true" />
            {relaunching ? t('mixer.relaunching') : t('mixer.applyRelaunch')}
          </Button>
        </div>
      </section>
    </div>
  );
}
