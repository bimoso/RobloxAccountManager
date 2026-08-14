// hooks/usePresencePolling.test.tsx
//
// Unit tests for the presence poller's visibility gating.
//
// Only the scheduling contract is covered here — that a hidden window costs no
// round trips, that becoming visible catches up immediately, and that nothing
// survives unmount. The mapping of a response into the Presence_Store is the
// pure reducer's job and is tested with it.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPresence } = vi.hoisted(() => ({ getPresence: vi.fn() }));

vi.mock('../lib/ipc', () => ({
  ipc: {
    getPresence: (userIds: Array<string | number>, cookie: string) =>
      getPresence(userIds, cookie),
  },
}));

import {
  DEFAULT_PRESENCE_INTERVAL_MS,
  usePresencePolling,
} from './usePresencePolling';

/** Module-level so the hook's `idsKey` memo sees a stable input across renders. */
const USER_IDS = ['1', '2'];
const COOKIE = '.ROBLOSECURITY=test-cookie';

/**
 * Force `document.hidden`.
 *
 * jsdom exposes it as a `Document.prototype` getter derived from
 * `visibilityState`, with no public setter, so the only way to drive it is to
 * shadow it with an own property (removed again in `afterEach`).
 */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

/** Fire the event the browser sends when the tab or window is shown/hidden. */
function fireVisibilityChange(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // An empty batch leaves the store reference untouched, so a resolving tick
  // triggers no re-render and therefore no act() warning.
  getPresence.mockResolvedValue({ userPresences: [] });
  setHidden(false);
});

afterEach(() => {
  delete (document as { hidden?: boolean }).hidden;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('usePresencePolling', () => {
  it('polls immediately and again on the interval while visible', () => {
    renderHook(() => usePresencePolling(USER_IDS, COOKIE));

    expect(getPresence).toHaveBeenCalledTimes(1);
    expect(getPresence).toHaveBeenCalledWith(USER_IDS, COOKIE);

    act(() => {
      vi.advanceTimersByTime(DEFAULT_PRESENCE_INTERVAL_MS);
    });

    expect(getPresence).toHaveBeenCalledTimes(2);
  });

  it('makes no request while the document is hidden', () => {
    setHidden(true);
    renderHook(() => usePresencePolling(USER_IDS, COOKIE));

    expect(getPresence).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DEFAULT_PRESENCE_INTERVAL_MS * 3);
    });

    expect(getPresence).not.toHaveBeenCalled();
  });

  it('runs one catch-up tick when the document becomes visible again', () => {
    setHidden(true);
    renderHook(() => usePresencePolling(USER_IDS, COOKIE));
    expect(getPresence).not.toHaveBeenCalled();

    setHidden(false);
    fireVisibilityChange();

    expect(getPresence).toHaveBeenCalledTimes(1);
    expect(getPresence).toHaveBeenCalledWith(USER_IDS, COOKIE);
  });

  it('does not tick on the visibilitychange that reports going hidden', () => {
    renderHook(() => usePresencePolling(USER_IDS, COOKIE));
    expect(getPresence).toHaveBeenCalledTimes(1);

    setHidden(true);
    fireVisibilityChange();

    expect(getPresence).toHaveBeenCalledTimes(1);
  });

  it('resumes on the original cadence after a hidden stretch', () => {
    renderHook(() => usePresencePolling(USER_IDS, COOKIE));
    expect(getPresence).toHaveBeenCalledTimes(1);

    // The interval is deliberately left running while hidden, so its ticks are
    // skipped rather than rescheduled — visibility must not reset the cadence.
    setHidden(true);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_PRESENCE_INTERVAL_MS * 2);
    });
    expect(getPresence).toHaveBeenCalledTimes(1);

    setHidden(false);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_PRESENCE_INTERVAL_MS);
    });
    expect(getPresence).toHaveBeenCalledTimes(2);
  });

  it('clears the interval and the visibility listener on unmount', () => {
    const { unmount } = renderHook(() => usePresencePolling(USER_IDS, COOKIE));
    expect(getPresence).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      vi.advanceTimersByTime(DEFAULT_PRESENCE_INTERVAL_MS * 2);
    });
    fireVisibilityChange();

    expect(getPresence).toHaveBeenCalledTimes(1);
  });
});
