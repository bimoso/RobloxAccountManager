import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_VOLUME,
  SOUND_PROFILES,
  SOUND_PROFILE_IDS,
  VOLUME_MAX,
  VOLUME_MIN,
  clampVolume,
  isValidProfileId,
  type SoundProfileId,
} from '../lib/clickSound';
import { PERSISTENCE_KEYS } from '../lib/persistence';
import {
  resolveInitialProfile,
  resolveInitialVolume,
  selectActiveSound,
  useSoundStore,
  type CustomSound,
} from './soundStore';

/**
 * Unit + property coverage for the click-sound store and its pure helpers
 * (task 25.7). Pins the guarantees the `useClickSound` hook and Sounds tab rely
 * on: a valid predefined profile / clamped volume is always resolved from
 * storage (Requirements 22.1, 22.3, 27.2), selecting a profile turns off any
 * custom override while a loaded custom sound wins otherwise (Requirement 22.2).
 *
 * The Web-Audio playback itself (mocked) is covered by task 25.8; these tests
 * only exercise DOM/React-free logic, so a fake buffer stands in for the
 * decoded `AudioBuffer`.
 */

const profileIdArb = fc.constantFrom<SoundProfileId>(...SOUND_PROFILE_IDS);

/** A stand-in for a decoded custom sound; only identity/typing matter here. */
const fakeCustom: CustomSound = {
  name: 'my-sound',
  buffer: {} as AudioBuffer,
};

/**
 * Build a spec-compliant, in-memory Storage stand-in. The test-environment
 * `localStorage` polyfill is incomplete (no `clear`), so — mirroring
 * `persistence.test.ts` — each test runs against a fresh Map-backed mock.
 */
function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Reset the store to a known baseline so tests stay independent.
  useSoundStore.setState({
    profileId: DEFAULT_PROFILE_ID,
    custom: null,
    useCustom: false,
    volume: DEFAULT_VOLUME,
  });
});

describe('clampVolume', () => {
  it('clamps into [0, 1] and defaults on non-finite input', () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-1)).toBe(VOLUME_MIN);
    expect(clampVolume(2)).toBe(VOLUME_MAX);
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_VOLUME);
    expect(clampVolume('loud')).toBe(DEFAULT_VOLUME);
    expect(clampVolume(undefined)).toBe(DEFAULT_VOLUME);
  });

  it('always returns a value within [0, 1] for any number', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (v) => {
        const result = clampVolume(v);
        expect(result).toBeGreaterThanOrEqual(VOLUME_MIN);
        expect(result).toBeLessThanOrEqual(VOLUME_MAX);
      }),
    );
  });
});

describe('isValidProfileId', () => {
  it('accepts every known profile id and rejects others', () => {
    for (const id of SOUND_PROFILE_IDS) {
      expect(isValidProfileId(id)).toBe(true);
    }
    expect(isValidProfileId('__custom__')).toBe(false);
    expect(isValidProfileId(3)).toBe(false);
    expect(isValidProfileId(undefined)).toBe(false);
  });
});

describe('resolveInitialProfile / resolveInitialVolume', () => {
  it('falls back to defaults when nothing is persisted', () => {
    expect(resolveInitialProfile()).toBe(DEFAULT_PROFILE_ID);
    expect(resolveInitialVolume()).toBe(DEFAULT_VOLUME);
  });

  it('restores a persisted valid profile and clamps a persisted volume', () => {
    localStorage.setItem(PERSISTENCE_KEYS.soundProfile, JSON.stringify('thocky'));
    localStorage.setItem(PERSISTENCE_KEYS.soundVolume, JSON.stringify(0.8));
    expect(resolveInitialProfile()).toBe('thocky');
    expect(resolveInitialVolume()).toBe(0.8);
  });

  it('ignores a corrupted persisted profile', () => {
    localStorage.setItem(PERSISTENCE_KEYS.soundProfile, JSON.stringify('bogus'));
    expect(resolveInitialProfile()).toBe(DEFAULT_PROFILE_ID);
  });
});

describe('selectActiveSound', () => {
  it('returns the predefined profile when no custom is active', () => {
    fc.assert(
      fc.property(profileIdArb, fc.boolean(), (id, useCustom) => {
        // No custom sound loaded => always the profile, regardless of the flag.
        const active = selectActiveSound(id, null, useCustom);
        expect(active).toEqual({ kind: 'profile', profile: SOUND_PROFILES[id] });
      }),
    );
  });

  it('returns the custom sound only when loaded and active (Req 22.2)', () => {
    expect(selectActiveSound('clicky', fakeCustom, true)).toEqual({
      kind: 'custom',
      sound: fakeCustom,
    });
    // Loaded but not active => still the profile.
    expect(selectActiveSound('clicky', fakeCustom, false)).toEqual({
      kind: 'profile',
      profile: SOUND_PROFILES.clicky,
    });
  });
});

describe('useSoundStore', () => {
  it('setProfile selects the profile, disables custom, and persists it', () => {
    useSoundStore.getState().setCustomSound('x', {} as AudioBuffer);
    useSoundStore.getState().setProfile('poppy');
    const state = useSoundStore.getState();
    expect(state.profileId).toBe('poppy');
    expect(state.useCustom).toBe(false);
    expect(state.getActiveSound()).toEqual({
      kind: 'profile',
      profile: SOUND_PROFILES.poppy,
    });
    expect(localStorage.getItem(PERSISTENCE_KEYS.soundProfile)).toBe(
      JSON.stringify('poppy'),
    );
  });

  it('setCustomSound makes the custom sound the active source (Req 22.2)', () => {
    useSoundStore.getState().setCustomSound('boop', fakeCustom.buffer);
    const state = useSoundStore.getState();
    expect(state.useCustom).toBe(true);
    expect(state.custom?.name).toBe('boop');
    expect(state.getActiveSound().kind).toBe('custom');
  });

  it('clearCustomSound falls back to the selected profile', () => {
    useSoundStore.getState().setProfile('creamy');
    useSoundStore.getState().setCustomSound('boop', fakeCustom.buffer);
    useSoundStore.getState().clearCustomSound();
    const state = useSoundStore.getState();
    expect(state.custom).toBeNull();
    expect(state.useCustom).toBe(false);
    expect(state.getActiveSound()).toEqual({
      kind: 'profile',
      profile: SOUND_PROFILES.creamy,
    });
  });

  it('setVolume clamps and persists so it applies to the next playback (Req 22.3)', () => {
    useSoundStore.getState().setVolume(1.5);
    expect(useSoundStore.getState().volume).toBe(VOLUME_MAX);
    useSoundStore.getState().setVolume(0.42);
    expect(useSoundStore.getState().volume).toBe(0.42);
    expect(localStorage.getItem(PERSISTENCE_KEYS.soundVolume)).toBe(
      JSON.stringify(0.42),
    );
  });
});
