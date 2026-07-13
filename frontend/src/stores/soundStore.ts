// stores/soundStore.ts
//
// Click-sound configuration store (Requirement 22).
//
// Owns the click-sound preferences the `useClickSound` hook and the Settings
// Sounds tab share:
//
//   - `profileId`  — the selected predefined profile (Requirement 22.1);
//   - `custom`     — an optional uploaded sound (name + decoded buffer) that,
//                    once loaded, overrides the predefined profile
//                    (Requirement 22.2);
//   - `useCustom`  — whether the custom sound is the active source;
//   - `volume`     — linear gain applied to the next playback (Requirement 22.3).
//
// The selected profile and volume are persisted through `lib/persistence.ts`
// (Requirement 27.1) and restored on startup (Requirement 27.2). The custom
// sound's decoded `AudioBuffer` cannot be serialized to local storage, so it
// lives in memory only: after a reload the store falls back to the persisted
// predefined profile (mirroring the Legacy_Frontend, which required re-upload).
//
// The non-trivial resolution logic is factored into the exported pure helpers
// `resolveInitialProfile`, `resolveInitialVolume`, and `selectActiveSound` so it
// can be tested without a DOM, React, or the Web Audio API.

import { create } from 'zustand';
import {
  getPersisted,
  setPersisted,
  PERSISTENCE_KEYS,
} from '../lib/persistence';
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_VOLUME,
  SOUND_PROFILES,
  clampVolume,
  isValidProfileId,
  type SoundProfile,
  type SoundProfileId,
} from '../lib/clickSound';

/** An uploaded custom click sound held in memory for the session. */
export interface CustomSound {
  /** Display name (the uploaded file name, without extension). */
  readonly name: string;
  /** Decoded audio, ready to play. Not persistable, so session-only. */
  readonly buffer: AudioBuffer;
}

/**
 * The active click sound resolved from the current state: either the custom
 * uploaded buffer (when one is loaded and active) or a predefined profile.
 * Returned by {@link selectActiveSound} so playback and tests share one rule.
 */
export type ActiveSound =
  | { readonly kind: 'custom'; readonly sound: CustomSound }
  | { readonly kind: 'profile'; readonly profile: SoundProfile };

/**
 * Resolve the predefined profile to use on startup (Requirements 22.1, 27.2).
 * Reads the persisted `sound-profile`; returns it when valid, otherwise the
 * default. Never throws.
 */
export function resolveInitialProfile(): SoundProfileId {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.soundProfile);
  return isValidProfileId(stored) ? stored : DEFAULT_PROFILE_ID;
}

/**
 * Resolve the click volume to use on startup (Requirements 22.3, 27.2). Reads
 * the persisted `sound-volume` and clamps it to `[0, 1]`; a missing or
 * corrupted value resolves to the default. Never throws.
 */
export function resolveInitialVolume(): number {
  return clampVolume(getPersisted<unknown>(PERSISTENCE_KEYS.soundVolume));
}

/**
 * Resolve the active click sound from the given selection (Requirement 22.2):
 * a loaded, active custom sound wins over the predefined profile. Pure;
 * exported for testing.
 */
export function selectActiveSound(
  profileId: SoundProfileId,
  custom: CustomSound | null,
  useCustom: boolean,
): ActiveSound {
  if (useCustom && custom) {
    return { kind: 'custom', sound: custom };
  }
  return { kind: 'profile', profile: SOUND_PROFILES[profileId] };
}

/** Public shape of the sound store. */
export interface SoundState {
  /** The selected predefined profile (persisted). */
  profileId: SoundProfileId;
  /** The uploaded custom sound, or `null` when none is loaded (session-only). */
  custom: CustomSound | null;
  /** Whether the custom sound overrides the predefined profile. */
  useCustom: boolean;
  /** Linear gain applied to the next playback, `0..1` (persisted). */
  volume: number;

  /**
   * Select a predefined profile (Requirement 22.1). Turns off any custom
   * override so the chosen profile becomes active, and persists the selection.
   */
  setProfile: (id: SoundProfileId) => void;
  /**
   * Load an uploaded custom sound and make it the active click source
   * (Requirement 22.2). The buffer is held in memory only.
   */
  setCustomSound: (name: string, buffer: AudioBuffer) => void;
  /**
   * Remove the custom sound and fall back to the selected predefined profile.
   */
  clearCustomSound: () => void;
  /**
   * Set the click volume (Requirement 22.3). The value is clamped to `[0, 1]`
   * and persisted; it applies to the next playback.
   */
  setVolume: (volume: number) => void;
  /** Resolve the currently active sound (custom vs. predefined profile). */
  getActiveSound: () => ActiveSound;
}

export const useSoundStore = create<SoundState>((set, get) => ({
  profileId: resolveInitialProfile(),
  custom: null,
  useCustom: false,
  volume: resolveInitialVolume(),

  setProfile: (id) => {
    // In-memory selection first so the session keeps it even if the persist is
    // a no-op on failure (Requirement 3.6). Selecting a profile turns off the
    // custom override (Requirement 22.2 inverse).
    set({ profileId: id, useCustom: false });
    setPersisted(PERSISTENCE_KEYS.soundProfile, id);
  },

  setCustomSound: (name, buffer) => {
    // The decoded buffer cannot be persisted, so only the in-memory state
    // changes; the predefined profile stays persisted for the next reload.
    set({ custom: { name, buffer }, useCustom: true });
  },

  clearCustomSound: () => {
    set({ custom: null, useCustom: false });
  },

  setVolume: (volume) => {
    const clamped = clampVolume(volume);
    set({ volume: clamped });
    setPersisted(PERSISTENCE_KEYS.soundVolume, clamped);
  },

  getActiveSound: () => {
    const { profileId, custom, useCustom } = get();
    return selectActiveSound(profileId, custom, useCustom);
  },
}));

/** Re-export the default volume for consumers building the volume control. */
export { DEFAULT_VOLUME };
