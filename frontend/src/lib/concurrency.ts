// lib/concurrency.ts
//
// Bounded-parallelism primitive for fan-out work.
//
// It exists because `Promise.all` over a batch of IPC calls is not a safe
// upgrade from a serial loop: several backend endpoints have no rate-limit
// handling at all (`roblox_get_avatar_thumbnails` never goes through the
// retry/back-off path), so releasing every request at once trades a slow page
// for a 429 storm. A fixed in-flight ceiling keeps the speed-up without that.
//
// Deliberately free of React and IPC imports so it stays a pure, directly
// testable helper that any layer may use.

/**
 * Run `worker` over `items` with at most `limit` calls in flight at any moment.
 *
 * Results are positional: `results[i]` always describes `items[i]`, whatever
 * order the workers finish in. The returned promise **never rejects** — a
 * worker that throws or rejects produces a `rejected` entry, so one bad item
 * cannot abort the items still queued behind it (which is what `Promise.all`
 * would do, and what a `try`/`catch` inside a serial loop already avoided).
 *
 * @typeParam T - Element type of the input.
 * @typeParam R - Value each worker resolves to.
 * @param items - The work items, consumed in order.
 * @param limit - Maximum concurrent workers. Non-positive, fractional or
 *   non-finite values are clamped into `[1, items.length]`.
 * @param worker - Called once per item with the item and its index. May return
 *   a value or a promise, and may throw either synchronously or as a rejection.
 * @returns One settled result per input item, in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => R | Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(
    items.length,
  );
  if (items.length === 0) return results;

  // A caller-supplied `0`, `-1` or `NaN` would otherwise start zero runners and
  // leave the returned promise pending forever, so the ceiling is clamped
  // rather than trusted.
  const runnerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(limit) || 1),
  );

  // Shared cursor: runners pull the next index instead of being handed a fixed
  // slice, so a batch of uneven costs still keeps every runner busy.
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  // Every rejection is already captured above, so no runner can reject here.
  await Promise.all(Array.from({ length: runnerCount }, () => run()));
  return results;
}
