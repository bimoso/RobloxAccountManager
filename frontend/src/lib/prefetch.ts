// lib/prefetch.ts
//
// Idle-time warm-up scheduling.
//
// Warming a cache is only worth doing while the app has nothing better to do:
// running it eagerly on mount competes with the first paint and with whatever
// the user actually asked for. `requestIdleCallback` expresses exactly that,
// and its `timeout` option keeps a permanently busy app from starving the
// warm-up forever.
//
// ⚠️ jsdom implements neither `requestIdleCallback` nor `cancelIdleCallback`,
// so the `setTimeout` fallback below is not a rarely-taken branch: it is the
// path every test in this repo exercises. Both paths therefore have to honour
// the same contract (fire at most once, be cancellable, swallow failures), and
// the fallback must stay the one that is easiest to reason about.

/** Default deadline: warm up within four seconds even if the app never idles. */
const DEFAULT_PREFETCH_TIMEOUT_MS = 4000;

/**
 * The two globals this module probes for.
 *
 * Declared locally and read off `globalThis` — not off `window` — because under
 * vitest's jsdom environment those are two different objects: the jsdom `Window`
 * versus the Node global the DOM keys are copied onto. Reading from `globalThis`
 * is what makes both the real webview (where the two are the same object) and
 * the test stubs resolve to the same place.
 */
interface IdleScope {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Cancels a scheduled prefetch. Idempotent, and a no-op once the task has
 * already run, so a React cleanup can call it unconditionally.
 */
export type CancelPrefetch = () => void;

/**
 * Schedule `task` to run when the browser is idle, or by `timeoutMs` at the
 * latest.
 *
 * The task runs at most once and its failure is swallowed: a warm-up is
 * best-effort by definition, and letting it reject would surface a toast — or
 * an unhandled rejection in the test run — for work the user never requested.
 *
 * @param task - The warm-up to run. May be synchronous or return a promise.
 * @param timeoutMs - Deadline for the idle callback; also the plain delay used
 *   by the `setTimeout` fallback.
 * @returns A canceller to call from the caller's cleanup path.
 */
export function schedulePrefetch(
  task: () => void | Promise<unknown>,
  timeoutMs = DEFAULT_PREFETCH_TIMEOUT_MS,
): CancelPrefetch {
  const scope = globalThis as unknown as IdleScope;

  // Guards both directions: the canceller must not cancel a task that already
  // ran, and a late idle callback must not run a task that was cancelled.
  let settled = false;

  const fire = (): void => {
    if (settled) return;
    settled = true;
    try {
      void Promise.resolve(task()).catch(() => undefined);
    } catch {
      /* A synchronous throw is exactly as ignorable as a rejection. */
    }
  };

  const requestIdle = scope.requestIdleCallback;
  if (typeof requestIdle === 'function') {
    const handle = requestIdle.call(scope, fire, { timeout: timeoutMs });
    return () => {
      if (settled) return;
      settled = true;
      // Probed separately: an environment may ship the request half without the
      // cancel half, and losing the cancel must not throw.
      const cancelIdle = scope.cancelIdleCallback;
      if (typeof cancelIdle === 'function') cancelIdle.call(scope, handle);
    };
  }

  const timer = setTimeout(fire, timeoutMs);
  return () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };
}
