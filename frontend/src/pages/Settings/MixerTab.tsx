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
import type { Account } from '@/types/models';

const VOLUME_PREVIEW_DEBOUNCE_MS = 90;

function sliderFill(value: number, min: number, max: number): string {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return `linear-gradient(90deg, var(--ac) 0%, var(--acB) ${pct}%, var(--s4) ${pct}%, var(--s4) 100%)`;
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
          ? 'Graphics set to Auto'
          : `Graphics quality: ${gfxValue} (next launch)`);
      } catch {
        // The shared IPC adapter already surfaced one error toast. Roll the
        // optimistic switch back without emitting a duplicate notification.
        setGfxAuto(previous);
      } finally {
        gfxWriteInFlightRef.current = false;
        setGfxSaving(false);
      }
    })();
  }, [gfxAuto, gfxValue, showSuccess, writeGraphics]);

  const onGfxCommit = useCallback(() => {
    if (gfxAuto || gfxWriteInFlightRef.current) return;
    const previous = gfxPersistedRef.current;
    gfxWriteInFlightRef.current = true;
    setGfxSaving(true);
    void (async () => {
      try {
        await writeGraphics(gfxValue);
        gfxPersistedRef.current = gfxValue;
        showSuccess(`Graphics quality: ${gfxValue} (next launch)`);
      } catch {
        setGfxValue(previous);
      } finally {
        gfxWriteInFlightRef.current = false;
        setGfxSaving(false);
      }
    })();
  }, [gfxAuto, gfxValue, showSuccess, writeGraphics]);

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
          ? 'FPS set to unlimited (next launch)'
          : `FPS cap: ${fpsValue} (next launch)`);
      } catch {
        setFpsUnlimited(previous);
      } finally {
        fpsWriteInFlightRef.current = false;
        setFpsSaving(false);
      }
    })();
  }, [fpsUnlimited, fpsValue, showSuccess]);

  const onFpsCommit = useCallback(() => {
    if (fpsUnlimited || fpsWriteInFlightRef.current) return;
    const previous = fpsPersistedRef.current;
    fpsWriteInFlightRef.current = true;
    setFpsSaving(true);
    void (async () => {
      try {
        await ipc.writeFpsCap(fpsValue);
        fpsPersistedRef.current = fpsValue;
        showSuccess(`FPS cap: ${fpsValue} (next launch)`);
      } catch {
        setFpsValue(previous);
      } finally {
        fpsWriteInFlightRef.current = false;
        setFpsSaving(false);
      }
    })();
  }, [fpsUnlimited, fpsValue, showSuccess]);

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
        showSuccess(`Volume ${next}%`);
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
  }, [cancelScheduledVolumePreview, showSuccess]);

  const relaunchAccount = useCallback(async (account: Account) => {
    await ipc.killOneRoblox(account.id);
    await ipc.launchRoblox(account.id, account.cookie, launchTargetOf(account));
  }, []);

  const onApplyAndRelaunch = useCallback(async () => {
    if (relaunching) return;
    const running = accountsToRelaunch(accounts);
    if (running.length === 0) {
      showSuccess('No running accounts to relaunch');
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
  }, [accounts, relaunchAccount, relaunching, showError, showSuccess]);

  const runningCount = accountsToRelaunch(accounts).length;
  const gfxDisabled = manualQualityDisabled(gfxAuto);

  return (
    <div className="settings-mixer">
      <header className="settings-mixer-intro">
        <div className="settings-mixer-intro-icon" aria-hidden="true">
          <SlidersHorizontal size={20} strokeWidth={1.8} />
        </div>
        <div className="settings-mixer-intro-copy">
          <span className="settings-eyebrow">Client performance</span>
          <h2>Runtime mixer</h2>
          <p>Tune visual quality, frame pacing and live volume from one control surface.</p>
        </div>
        <div className="settings-mixer-live" aria-label={`${runningCount} running accounts`}>
          <Activity size={13} aria-hidden="true" />
          <span>{runningCount}</span>
          running
        </div>
      </header>

      <div className="settings-mixer-grid">
        <section className="settings-mixer-control" aria-labelledby="mixer-graphics-title">
          <div className="settings-mixer-control-head">
            <span className="settings-mixer-control-icon" aria-hidden="true">
              <MonitorUp size={17} />
            </span>
            <div>
              <span className="settings-eyebrow">Rendering</span>
              <h3 id="mixer-graphics-title">Graphics quality</h3>
            </div>
            <label className="settings-mixer-toggle" htmlFor="mix-gfx-auto">
              <span>Auto</span>
              <Switch
                id="mix-gfx-auto"
                aria-label="Automatic graphics quality"
                checked={gfxAuto}
                disabled={gfxSaving}
                onChange={onGfxAutoToggle}
              />
            </label>
          </div>
          <p>Override Roblox quality on the next launch, or let the client adapt.</p>
          <div className="settings-mixer-slider-row">
            <input
              id="mix-gfx"
              className="settings-mixer-slider"
              type="range"
              min={GRAPHICS_QUALITY_MIN}
              max={GRAPHICS_QUALITY_MAX}
              step={1}
              value={gfxValue}
              disabled={gfxDisabled || gfxSaving}
              aria-label="Graphics quality level"
              style={{
                background: sliderFill(gfxValue, GRAPHICS_QUALITY_MIN, GRAPHICS_QUALITY_MAX),
              }}
              onChange={(event) => setGfxValue(Number(event.target.value))}
              onMouseUp={onGfxCommit}
              onKeyUp={onGfxCommit}
              onTouchEnd={onGfxCommit}
            />
            <output className="settings-mixer-value" htmlFor="mix-gfx">
              {gfxDisabled ? 'AUTO' : String(gfxValue).padStart(2, '0')}
            </output>
          </div>
        </section>

        <section className="settings-mixer-control" aria-labelledby="mixer-fps-title">
          <div className="settings-mixer-control-head">
            <span className="settings-mixer-control-icon" aria-hidden="true">
              <Gauge size={17} />
            </span>
            <div>
              <span className="settings-eyebrow">Frame pacing</span>
              <h3 id="mixer-fps-title">FPS limit</h3>
            </div>
            <label className="settings-mixer-toggle" htmlFor="mix-fps-unl">
              <span>Unlimited</span>
              <Switch
                id="mix-fps-unl"
                aria-label="Unlimited FPS"
                checked={fpsUnlimited}
                disabled={fpsSaving}
                onChange={onFpsUnlimitedToggle}
              />
            </label>
          </div>
          <p>Set the frame ceiling applied the next time an account starts.</p>
          <div className="settings-mixer-slider-row">
            <input
              id="mix-fps"
              className="settings-mixer-slider"
              type="range"
              min={FPS_MIN}
              max={FPS_MAX}
              step={1}
              value={fpsValue}
              disabled={fpsUnlimited || fpsSaving}
              aria-label="FPS limit value"
              style={{ background: sliderFill(fpsValue, FPS_MIN, FPS_MAX) }}
              onChange={(event) => setFpsValue(Number(event.target.value))}
              onMouseUp={onFpsCommit}
              onKeyUp={onFpsCommit}
              onTouchEnd={onFpsCommit}
            />
            <output className="settings-mixer-value" htmlFor="mix-fps">
              {fpsUnlimited ? '∞' : fpsValue}
            </output>
          </div>
        </section>
      </div>

      <section className="settings-mixer-volume" aria-labelledby="mixer-volume-title">
        <span className="settings-mixer-control-icon" aria-hidden="true">
          <Volume2 size={17} />
        </span>
        <div className="settings-mixer-volume-copy">
          <span className="settings-eyebrow">Live control</span>
          <h3 id="mixer-volume-title">Master volume</h3>
          <p>Applied instantly to running Roblox sessions.</p>
        </div>
        <div className="settings-mixer-slider-row settings-mixer-slider-row--volume">
          <input
            id="mix-vol"
            className="settings-mixer-slider"
            type="range"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={1}
            value={volume}
            disabled={volumeSaving}
            aria-label="Master volume percentage"
            style={{ background: sliderFill(volume, VOLUME_MIN, VOLUME_MAX) }}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
            onPointerUp={onVolumeCommit}
            onPointerCancel={onVolumeCommit}
            onKeyUp={onVolumeCommit}
            onBlur={onVolumeCommit}
          />
          <output className="settings-mixer-value" htmlFor="mix-vol">{volume}%</output>
        </div>
      </section>

      <section className="settings-mixer-relaunch" aria-labelledby="mixer-relaunch-title">
        <div className="settings-mixer-relaunch-mark" aria-hidden="true">
          <RotateCw size={19} />
        </div>
        <div>
          <span className="settings-eyebrow">Apply changes</span>
          <h3 id="mixer-relaunch-title">Restart active sessions</h3>
          <p>
            {runningCount === 0
              ? 'No running accounts need a restart.'
              : `${runningCount} running account${runningCount === 1 ? '' : 's'} will restart with the new limits.`}
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => void onApplyAndRelaunch()}
          disabled={relaunching || runningCount === 0}
          aria-label="Apply Mixer settings and relaunch running accounts"
        >
          <RotateCw size={14} aria-hidden="true" />
          {relaunching ? 'Relaunching…' : 'Apply and relaunch'}
        </Button>
      </section>
    </div>
  );
}
