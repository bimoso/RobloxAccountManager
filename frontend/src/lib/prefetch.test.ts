import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedulePrefetch } from './prefetch';

/**
 * Tests for the idle-time warm-up scheduler.
 *
 * jsdom ships neither `requestIdleCallback` nor `cancelIdleCallback`, so the
 * `setTimeout` fallback is the branch this environment takes on its own — which
 * is why it gets the bulk of the coverage here. The fallback tests still stub
 * the global to `undefined` explicitly rather than relying on that gap, so they
 * keep asserting the same thing if a future jsdom implements it. The idle
 * branch is covered by installing a stub.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Force the `setTimeout` branch regardless of what the environment provides. */
function withoutIdleCallback(): void {
  vi.stubGlobal('requestIdleCallback', undefined);
}

describe('schedulePrefetch (setTimeout fallback)', () => {
  it('runs the task at the default four-second deadline', () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn();

    schedulePrefetch(task);

    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_999);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit timeout', () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn();

    schedulePrefetch(task, 50);

    vi.advanceTimersByTime(50);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does not run a cancelled task', () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn();

    schedulePrefetch(task, 1_000)();

    vi.advanceTimersByTime(10_000);
    expect(task).not.toHaveBeenCalled();
  });

  it('is a no-op when cancelled twice or after the task ran', () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn();

    const cancel = schedulePrefetch(task, 10);
    vi.advanceTimersByTime(10);

    expect(() => {
      cancel();
      cancel();
    }).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronous throw from the task', () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn(() => {
      throw new Error('warm-up failed');
    });

    schedulePrefetch(task, 10);

    // A failing warm-up must not escape into the timer callback, where it would
    // become an uncaught error for work the user never asked for.
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected task', async () => {
    withoutIdleCallback();
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValue(new Error('offline'));

    schedulePrefetch(task, 10);
    vi.advanceTimersByTime(10);

    // Let the internal catch run; an escaping rejection would fail the suite as
    // an unhandled rejection.
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('schedulePrefetch (requestIdleCallback)', () => {
  it('schedules through the idle callback with the timeout as its deadline', () => {
    const requestIdle = vi.fn(() => 7);
    vi.stubGlobal('requestIdleCallback', requestIdle);
    const task = vi.fn();

    schedulePrefetch(task, 250);

    expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), { timeout: 250 });
    expect(task).not.toHaveBeenCalled();
  });

  it('runs the task once the browser goes idle', () => {
    let idleCallback: (() => void) | undefined;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 7;
      }),
    );
    const task = vi.fn();

    schedulePrefetch(task, 250);
    idleCallback?.();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancels through cancelIdleCallback with the returned handle', () => {
    let idleCallback: (() => void) | undefined;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 7;
      }),
    );
    const cancelIdle = vi.fn();
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const task = vi.fn();

    schedulePrefetch(task, 250)();

    expect(cancelIdle).toHaveBeenCalledWith(7);
    // A late callback from a cancelled handle must still not run the task.
    idleCallback?.();
    expect(task).not.toHaveBeenCalled();
  });

  it('cancels safely when the environment has no cancelIdleCallback', () => {
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(() => 7),
    );
    vi.stubGlobal('cancelIdleCallback', undefined);

    expect(() => schedulePrefetch(vi.fn(), 250)()).not.toThrow();
  });
});
