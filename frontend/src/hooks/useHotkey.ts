// hooks/useHotkey.ts
//
// Keyboard-shortcut hook (used by the Logs page Ctrl+F search — Requirement
// 23.3, and reusable by any other page-scoped shortcut).
//
// While mounted and `enabled`, this hook installs a single `keydown` listener
// on the given target (the window by default) and invokes `handler` when the
// pressed key matches the declared {@link HotkeyCombo}. Key matching is
// case-insensitive (so `f` matches both `f` and `F`, mirroring the legacy
// legacy renderer's `e.key === 'f' || e.key === 'F'` check).
//
// Because the Logs page component is only mounted while the Logs page is
// active, mounting the Ctrl+F hotkey inside it naturally scopes the shortcut to
// "while the Logs page is active" (Requirement 23.3) without any global routing
// state — the listener is added on mount and torn down on unmount.
//
// The handler is held in a ref so passing a fresh inline callback on every
// render does NOT re-subscribe the listener; the effect only re-runs when the
// combo, options, or target actually change.

import { useEffect, useRef } from 'react';

/**
 * A declarative description of a keyboard shortcut.
 *
 * `key` is matched case-insensitively against `KeyboardEvent.key` (e.g. `'f'`,
 * `'Escape'`, `'/'`). Modifier flags are only enforced when set to `true`; a
 * flag left `undefined`/`false` means "don't care" about that modifier, which
 * matches the loose modifier handling of the Legacy_Frontend shortcuts.
 */
export interface HotkeyCombo {
  /** The `KeyboardEvent.key` to match, compared case-insensitively. */
  readonly key: string;
  /**
   * Require the platform "command" modifier: `Ctrl` on Windows/Linux or `Cmd`
   * (meta) on macOS. Satisfied when either `ctrlKey` or `metaKey` is held.
   */
  readonly ctrlOrMeta?: boolean;
  /** Require the Shift modifier. */
  readonly shift?: boolean;
  /** Require the Alt/Option modifier. */
  readonly alt?: boolean;
}

/** Options controlling {@link useHotkey}. */
export interface UseHotkeyOptions {
  /** When `false`, the listener is not installed. Defaults to `true`. */
  readonly enabled?: boolean;
  /**
   * Call `event.preventDefault()` on a match so the browser's own binding (e.g.
   * the native Ctrl+F find) does not also fire. Defaults to `true`.
   */
  readonly preventDefault?: boolean;
  /**
   * The event target to bind to. Defaults to `window`. Passing `null` (e.g. a
   * not-yet-mounted ref) skips binding until a real target is provided.
   */
  readonly target?: Window | HTMLElement | null;
}

/** Whether `event` satisfies every part of `combo`. */
function matchesCombo(event: KeyboardEvent, combo: HotkeyCombo): boolean {
  if (event.key.toLowerCase() !== combo.key.toLowerCase()) {
    return false;
  }
  if (combo.ctrlOrMeta === true && !(event.ctrlKey || event.metaKey)) {
    return false;
  }
  if (combo.shift === true && !event.shiftKey) {
    return false;
  }
  if (combo.alt === true && !event.altKey) {
    return false;
  }
  return true;
}

/**
 * Fire `handler` when the {@link HotkeyCombo} is pressed while this hook is
 * mounted and enabled.
 *
 * @param combo - The keyboard shortcut to listen for.
 * @param handler - Called with the originating event when the combo matches.
 * @param options - See {@link UseHotkeyOptions}.
 */
export function useHotkey(
  combo: HotkeyCombo,
  handler: (event: KeyboardEvent) => void,
  options: UseHotkeyOptions = {},
): void {
  const { enabled = true, preventDefault = true, target } = options;

  // Keep the latest handler without re-subscribing the listener each render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { key, ctrlOrMeta, shift, alt } = combo;

  useEffect(() => {
    // `target === undefined` means "use the default window"; `target === null`
    // means "caller has no target yet" → skip binding.
    const boundTarget =
      target === undefined
        ? typeof window !== 'undefined'
          ? window
          : null
        : target;

    if (!enabled || boundTarget === null) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesCombo(event, { key, ctrlOrMeta, shift, alt })) {
        if (preventDefault) {
          event.preventDefault();
        }
        handlerRef.current(event);
      }
    };

    boundTarget.addEventListener('keydown', onKeyDown as EventListener);
    return () => {
      boundTarget.removeEventListener('keydown', onKeyDown as EventListener);
    };
  }, [enabled, preventDefault, target, key, ctrlOrMeta, shift, alt]);
}

export default useHotkey;
