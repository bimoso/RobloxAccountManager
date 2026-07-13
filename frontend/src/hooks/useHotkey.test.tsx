// hooks/useHotkey.test.tsx
//
// Unit tests for the useHotkey shortcut hook (Requirement 23.3 wiring).

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHotkey, type HotkeyCombo, type UseHotkeyOptions } from './useHotkey';

/** Dispatch a keydown on `window` and return the event (to inspect defaults). */
function press(
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    bubbles: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe('useHotkey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the handler when the combo matches (Ctrl+F)', () => {
    const handler = vi.fn();
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, handler));

    press('f', { ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts Cmd (meta) as the platform command modifier', () => {
    const handler = vi.fn();
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, handler));

    press('f', { metaKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('matches the key case-insensitively (F matches f)', () => {
    const handler = vi.fn();
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, handler));

    press('F', { ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not fire when a required modifier is missing', () => {
    const handler = vi.fn();
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, handler));

    press('f'); // no ctrl/meta

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire for a different key', () => {
    const handler = vi.fn();
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, handler));

    press('g', { ctrlKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls preventDefault on a match by default', () => {
    renderHook(() => useHotkey({ key: 'f', ctrlOrMeta: true }, () => {}));

    const event = press('f', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not preventDefault when preventDefault is false', () => {
    renderHook(() =>
      useHotkey({ key: 'f', ctrlOrMeta: true }, () => {}, {
        preventDefault: false,
      }),
    );

    const event = press('f', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not fire while disabled', () => {
    const handler = vi.fn();
    renderHook(() =>
      useHotkey({ key: 'Escape' }, handler, { enabled: false }),
    );

    press('Escape');

    expect(handler).not.toHaveBeenCalled();
  });

  it('toggles subscription when the enabled flag changes', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useHotkey({ key: 'Escape' }, handler, { enabled }),
      { initialProps: { enabled: false } },
    );

    press('Escape');
    expect(handler).not.toHaveBeenCalled();

    rerender({ enabled: true });
    press('Escape');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useHotkey({ key: 'Escape' }, handler),
    );

    unmount();
    press('Escape');

    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the latest handler without re-subscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: (e: KeyboardEvent) => void }) =>
        useHotkey({ key: 'Escape' }, handler),
      { initialProps: { handler: first } },
    );

    rerender({ handler: second });
    press('Escape');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not bind when target is null', () => {
    const handler = vi.fn();
    const options: UseHotkeyOptions = { target: null };
    const combo: HotkeyCombo = { key: 'Escape' };
    renderHook(() => useHotkey(combo, handler, options));

    press('Escape');

    expect(handler).not.toHaveBeenCalled();
  });
});
