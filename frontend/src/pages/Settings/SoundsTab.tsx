// pages/Settings/SoundsTab.tsx
//
// Sounds tab of the Settings page (Requirement 22). Lets the user:
//
//   - choose one of the predefined click-sound profiles (Requirement 22.1);
//   - upload a custom audio file to use instead of any profile
//     (Requirement 22.2);
//   - adjust the click volume, applied to the next playback (Requirement 22.3).
//
// All state lives in the shared `soundStore`; this component owns no sound
// logic of its own. Selecting a profile or loading a custom sound also plays a
// short preview so the choice is audible immediately. It imports nothing from
// other pages (Requirement 1.1).
//
// RACKLINE: each profile is a `.rk-row` inside a `.rk-panel` — the gutter tick
// marks the active one, the description sits under the name, and the preview
// action is right-aligned in the same column as every other control on the
// page. The six profile cards, their hover lift and their bespoke badge are
// gone.

import { useCallback, useRef, useState } from 'react';
import {
  CircleDot,
  Droplets,
  FileAudio,
  FileText,
  Keyboard,
  Piano,
  Play,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@/components/Button';
import {
  SOUND_PROFILE_IDS,
  VOLUME_MAX,
  VOLUME_MIN,
  decodeAudioFile,
  getAudioContext,
  playBuffer,
} from '@/lib/clickSound';
import { useSoundStore } from '@/stores/soundStore';
import { useClickSound, previewProfile } from '@/hooks/useClickSound';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import './Settings.css';

/** Convert the stored `0..1` gain to a whole-percent slider value. */
function toPercent(volume: number): number {
  return Math.round(volume * 100);
}

/** Fill the range track up to `pct`, matching the Mixer slider look. */
function sliderFill(pct: number): string {
  return `linear-gradient(90deg, var(--ac) ${pct}%, var(--surf-3) ${pct}%)`;
}

const PROFILE_ICONS = {
  clicky: Keyboard,
  thocky: Piano,
  creamy: Droplets,
  poppy: CircleDot,
  typewriter: FileText,
  off: VolumeX,
} as const;

/**
 * The Sounds tab body. Renders the predefined profile rows, the custom-sound
 * uploader, and the volume slider, each wired to the `soundStore`.
 */
export function SoundsTab(): JSX.Element {
  const profileId = useSoundStore((s) => s.profileId);
  const custom = useSoundStore((s) => s.custom);
  const useCustom = useSoundStore((s) => s.useCustom);
  const volume = useSoundStore((s) => s.volume);
  const setProfile = useSoundStore((s) => s.setProfile);
  const setCustomSound = useSoundStore((s) => s.setCustomSound);
  const clearCustomSound = useSoundStore((s) => s.clearCustomSound);
  const setVolume = useSoundStore((s) => s.setVolume);

  const showSuccess = useToastStore((s) => s.showSuccess);
  const showError = useToastStore((s) => s.showError);
  const { t } = useTranslation();

  // Keep the global click-sound listener from previewing on top of the explicit
  // previews below is unnecessary — the hook here is used only for its player.
  useClickSound();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  // Select a predefined profile and preview it at the current volume
  // (Requirement 22.1).
  const onSelectProfile = useCallback(
    (id: (typeof SOUND_PROFILE_IDS)[number]) => {
      setProfile(id);
      previewProfile(id, volume);
    },
    [setProfile, volume],
  );

  // Upload a custom audio file, decode it, and make it the active click sound
  // (Requirement 22.2).
  const onFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input so re-selecting the same file fires `change` again.
      event.target.value = '';
      if (!file) {
        return;
      }
      setLoadingFile(true);
      try {
        const buffer = await decodeAudioFile(file);
        const name = file.name.replace(/\.[^.]+$/, '');
        setCustomSound(name, buffer);
        // Preview the newly loaded sound.
        playBuffer(getAudioContext(), buffer, volume);
        showSuccess(t('settings.sounds.customLoaded'));
      } catch {
        showError(t('settings.sounds.decodeFailed'));
      } finally {
        setLoadingFile(false);
      }
    },
    [setCustomSound, showSuccess, showError, volume, t],
  );

  const volumePct = toPercent(volume);

  return (
    <div className="set-stack settings-sounds">
      {/* ── Predefined profiles (Requirement 22.1) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Keyboard size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.tab.sounds')}</span>
            <h2 className="rk-panel__title">{t('settings.sounds.groupAria')}</h2>
          </div>
        </div>
        <p className="set-hint">{t('settings.sounds.hint')}</p>
        <div
          className="set-rows"
          role="radiogroup"
          aria-label={t('settings.sounds.groupAria')}
        >
          {SOUND_PROFILE_IDS.map((id) => {
            const label = t(`sounds.profile.${id}.label`);
            const desc = t(`sounds.profile.${id}.desc`);
            const selected = !useCustom && id === profileId;
            const ProfileIcon = PROFILE_ICONS[id];
            return (
              <div
                key={id}
                role="radio"
                aria-checked={selected}
                aria-label={label}
                tabIndex={0}
                data-interactive="true"
                className="rk-row set-row"
                onClick={() => onSelectProfile(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectProfile(id);
                  }
                }}
              >
                <span className="rk-row__gutter">
                  <i className="rk-row__tick" data-tone={selected ? 'accent' : undefined} />
                </span>
                <span className="rk-row__main">
                  <span className="rk-row__title">
                    <ProfileIcon size={13} aria-hidden="true" /> {label}
                  </span>
                  <span className="rk-row__meta">{desc}</span>
                </span>
                <span className="set-row__control">
                  <button
                    type="button"
                    className="set-sound-preview"
                    aria-label={t('settings.sounds.preview', { label })}
                    onClick={(e) => {
                      e.stopPropagation();
                      previewProfile(id, volume);
                    }}
                  >
                    <Play size={12} fill="currentColor" aria-hidden="true" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Custom uploaded sound (Requirement 22.2) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><FileAudio size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.sounds.formats')}</span>
            <h2 className="rk-panel__title">{t('settings.sounds.customTitle')}</h2>
          </div>
        </div>
        <p className="set-hint">{t('settings.sounds.customHint')}</p>
        {custom ? (
          <div className="set-rows">
            <div className="rk-row set-row">
              <span className="rk-row__gutter">
                <i className="rk-row__tick" data-tone={useCustom ? 'ok' : undefined} />
              </span>
              <span className="rk-row__main">
                <span className="rk-row__title" title={custom.name}>{custom.name}</span>
                <span className="rk-row__meta">{t('settings.sounds.processedLocally')}</span>
              </span>
              <span className="set-row__control">
                <button
                  type="button"
                  className="set-sound-preview"
                  aria-label={t('settings.sounds.previewCustom')}
                  onClick={() => playBuffer(getAudioContext(), custom.buffer, volume)}
                >
                  <Play size={12} fill="currentColor" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="set-sound-preview"
                  data-tone="danger"
                  aria-label={t('settings.sounds.removeCustom')}
                  onClick={() => {
                    clearCustomSound();
                    showSuccess(t('settings.sounds.customRemoved'));
                  }}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </span>
            </div>
          </div>
        ) : null}
        <div className="set-upload">
          <input
            ref={fileInputRef}
            id="settings-custom-sound"
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => void onFileChange(e)}
          />
          <Button
            variant="secondary"
            disabled={loadingFile}
            onClick={() => fileInputRef.current?.click()}
          >
            {loadingFile
              ? <span className="rk-spin" aria-hidden="true" />
              : <Upload size={15} aria-hidden="true" />}
            {loadingFile ? t('settings.sounds.decoding') : t('settings.sounds.chooseFile')}
          </Button>
          <span className="set-upload__copy" aria-hidden="true">
            <strong>{t('settings.sounds.formats')}</strong>
            <small>{t('settings.sounds.processedLocally')}</small>
          </span>
        </div>
        {loadingFile ? (
          <p className="sr-only" role="status">{t('settings.sounds.decoding')}</p>
        ) : null}
      </section>

      {/* ── Volume (Requirement 22.3) ── */}
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Volume2 size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('mixer.liveControl')}</span>
            <label className="rk-panel__title" htmlFor="settings-sound-volume">
              {t('settings.sounds.volumeTitle')}
            </label>
          </div>
        </div>
        <div className="set-slider-row">
          <input
            id="settings-sound-volume"
            className="set-slider"
            type="range"
            min={VOLUME_MIN * 100}
            max={VOLUME_MAX * 100}
            step={1}
            value={volumePct}
            aria-label={t('settings.sounds.volumeAria')}
            style={{ background: sliderFill(volumePct) }}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
          />
          <output className="u-num" htmlFor="settings-sound-volume">{volumePct}%</output>
        </div>
      </section>
    </div>
  );
}

export default SoundsTab;
