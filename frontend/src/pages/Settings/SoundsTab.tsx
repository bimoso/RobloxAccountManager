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

import { useCallback, useRef, useState } from 'react';
import {
  CircleDot,
  Droplets,
  FileAudio,
  FileText,
  Keyboard,
  LoaderCircle,
  Piano,
  Play,
  Trash2,
  Upload,
  VolumeX,
} from 'lucide-react';
import {
  SOUND_PROFILE_IDS,
  SOUND_PROFILES,
  VOLUME_MAX,
  VOLUME_MIN,
  decodeAudioFile,
  getAudioContext,
  playBuffer,
} from '@/lib/clickSound';
import { useSoundStore } from '@/stores/soundStore';
import { useClickSound, previewProfile } from '@/hooks/useClickSound';
import { useToastStore } from '@/stores/toastStore';
import './Settings.css';

/** Convert the stored `0..1` gain to a whole-percent slider value. */
function toPercent(volume: number): number {
  return Math.round(volume * 100);
}

/** Fill the range track up to `pct`, matching the Mixer slider look. */
function sliderFill(pct: number): string {
  return `linear-gradient(90deg, var(--ac) ${pct}%, var(--s4) ${pct}%)`;
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
 * The Sounds tab body. Renders the predefined profile cards, the custom-sound
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
        showSuccess('Custom sound loaded.');
      } catch {
        showError('Could not decode that audio file.');
      } finally {
        setLoadingFile(false);
      }
    },
    [setCustomSound, showSuccess, showError, volume],
  );

  const volumePct = toPercent(volume);

  return (
    <div className="settings-sounds">
      <p className="settings-hint">
        Choose a click sound, or upload your own. Your selection plays on every
        interactive element and is remembered next time.
      </p>

      {/* ── Predefined profiles (Requirement 22.1) ── */}
      <div
        className="settings-sound-grid"
        role="radiogroup"
        aria-label="Click sound profile"
      >
        {SOUND_PROFILE_IDS.map((id) => {
          const profile = SOUND_PROFILES[id];
          const selected = !useCustom && id === profileId;
          const ProfileIcon = PROFILE_ICONS[id];
          return (
            <div
              key={id}
              role="radio"
              aria-checked={selected}
              aria-label={profile.label}
              tabIndex={0}
              className={`settings-sound-card${selected ? ' selected' : ''}`}
              onClick={() => onSelectProfile(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectProfile(id);
                }
              }}
            >
              <ProfileIcon className="settings-sound-icon" aria-hidden="true" />
              <span className="settings-sound-label">{profile.label}</span>
              <span className="settings-sound-desc">{profile.desc}</span>
              <button
                type="button"
                className="settings-sound-preview"
                aria-label={`Preview ${profile.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  previewProfile(id, volume);
                }}
              >
                <Play size={14} fill="currentColor" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Custom uploaded sound (Requirement 22.2) ── */}
      <section className="settings-card">
        <h2 className="settings-card-title">Custom sound</h2>
        <p className="settings-hint">
          Upload an audio file (WAV, MP3, OGG) to use as your click sound instead
          of a profile.
        </p>
        {custom ? (
          <div className="settings-info-row">
            <span
              className={`settings-status-badge${useCustom ? ' settings-status-badge--on' : ''}`}
              title={custom.name}
            >
              {custom.name}
            </span>
            <div className="settings-field-row">
              <button
                type="button"
                className="settings-sound-preview"
                aria-label="Preview custom sound"
                onClick={() => playBuffer(getAudioContext(), custom.buffer, volume)}
              >
                <Play size={14} fill="currentColor" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="settings-sound-preview settings-sound-preview--danger"
                aria-label="Remove custom sound"
                onClick={() => {
                  clearCustomSound();
                  showSuccess('Custom sound removed.');
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        <div className="settings-sound-upload">
          <input
            ref={fileInputRef}
            id="settings-custom-sound"
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => void onFileChange(e)}
          />
          <button
            type="button"
            className="settings-sound-upload-button"
            disabled={loadingFile}
            onClick={() => fileInputRef.current?.click()}
          >
            {loadingFile ? (
              <LoaderCircle className="settings-sound-upload-spinner" size={16} aria-hidden="true" />
            ) : (
              <Upload size={16} aria-hidden="true" />
            )}
            {loadingFile ? 'Decoding audio…' : 'Choose audio file'}
          </button>
          <div className="settings-sound-upload-copy" aria-hidden="true">
            <span className="settings-sound-upload-icon">
              <FileAudio size={17} />
            </span>
            <span>
              <strong>WAV, MP3 or OGG</strong>
              <small>Processed locally on this device</small>
            </span>
          </div>
        </div>
        {loadingFile ? (
          <p className="sr-only" role="status">Decoding audio…</p>
        ) : null}
      </section>

      {/* ── Volume (Requirement 22.3) ── */}
      <section className="settings-card">
        <div className="settings-info-row">
          <label className="settings-card-title" htmlFor="settings-sound-volume">
            Click volume
          </label>
          <span className="settings-info-value">{volumePct}%</span>
        </div>
        <input
          id="settings-sound-volume"
          className="settings-sound-slider"
          type="range"
          min={VOLUME_MIN * 100}
          max={VOLUME_MAX * 100}
          step={1}
          value={volumePct}
          aria-label="Click sound volume percentage"
          style={{ background: sliderFill(volumePct) }}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
        />
      </section>
    </div>
  );
}

export default SoundsTab;
