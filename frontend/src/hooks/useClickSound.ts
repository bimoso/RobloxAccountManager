// hooks/useClickSound.ts
//
// Click-sound playback hook (Requirement 22).
//
// Exposes `playClick`, which plays the configured click sound — the custom
// uploaded buffer when one is active, otherwise the selected predefined profile
// — at the volume currently held in the `soundStore`. Because the volume is
// read at play time, adjusting it takes effect on the next click without
// re-subscribing anything (Requirement 22.3).
//
// When `useClickSound` is mounted with `{ global: true }` (the app shell does
// this once), it also installs a capture-phase `click` listener that fires the
// sound on every click landing on an interactive element of the
// Component_Library (Requirement 22.1). Individual components therefore need no
// wiring; the single global listener covers them all.
//
// Playback goes through `lib/clickSound`, which degrades to a no-op when the
// Web Audio API is unavailable (e.g. jsdom in tests), so the hook is safe to
// mount everywhere.

import { useCallback, useEffect } from 'react';
import { getAudioContext, playBuffer, SOUND_PROFILES } from '../lib/clickSound';
import { useSoundStore, type ActiveSound } from '../stores/soundStore';

/**
 * CSS selector matching the interactive elements of the Component_Library that
 * should produce a click sound (Requirement 22.1). Mirrors the interactive
 * surface the Legacy_Frontend played on.
 */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  '[role="button"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(',');

/** Play the resolved active sound at `volume` (linear gain). No-op when muted. */
function playActiveSound(active: ActiveSound, volume: number): void {
  const ctx = getAudioContext();
  // A suspended context (autoplay policy) must be resumed after a user gesture;
  // the click that triggers this counts as one.
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      /* ignore: playback below is still attempted / degrades gracefully */
    });
  }
  if (active.kind === 'custom') {
    playBuffer(ctx, active.sound.buffer, volume);
  } else {
    active.profile.play(ctx, volume);
  }
}

/** Options for {@link useClickSound}. */
export interface UseClickSoundOptions {
  /**
   * When `true`, install a document-level capture-phase listener that plays the
   * click sound on every interactive-element click (Requirement 22.1). Mount
   * exactly one global instance (in the app shell). Defaults to `false`.
   */
  global?: boolean;
}

/** Result of {@link useClickSound}. */
export interface UseClickSound {
  /**
   * Play the currently configured click sound at the configured volume. Reads
   * the live store state, so the latest profile/custom/volume always apply
   * (Requirement 22.3).
   */
  playClick: () => void;
}

/**
 * Access the click-sound player and, optionally, install the global
 * interactive-click listener.
 *
 * @param options - See {@link UseClickSoundOptions}.
 * @returns `{ playClick }` — see {@link UseClickSound}.
 */
export function useClickSound(options: UseClickSoundOptions = {}): UseClickSound {
  const { global = false } = options;

  const playClick = useCallback(() => {
    const state = useSoundStore.getState();
    // Resolve custom-vs-profile via the store's shared rule, then play at the
    // volume held right now (Requirement 22.2, 22.3).
    playActiveSound(state.getActiveSound(), state.volume);
  }, []);

  useEffect(() => {
    if (!global || typeof document === 'undefined') {
      return;
    }
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(INTERACTIVE_SELECTOR) !== null
      ) {
        playClick();
      }
    };
    // Capture phase so the sound fires even when a handler stops propagation.
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [global, playClick]);

  return { playClick };
}

/**
 * Preview a specific predefined profile once at `volume`, independent of the
 * current selection. Used by the Sounds tab's per-card preview button.
 */
export function previewProfile(
  profileId: keyof typeof SOUND_PROFILES,
  volume: number,
): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      /* ignore */
    });
  }
  SOUND_PROFILES[profileId].play(ctx, volume);
}
