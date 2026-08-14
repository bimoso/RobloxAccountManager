import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from './concurrency';

/**
 * Tests for the bounded fan-out helper.
 *
 * The three properties that matter to its callers are covered directly:
 * positional results regardless of completion order, a hard ceiling on
 * in-flight workers, and a returned promise that never rejects.
 */

/** A promise plus its settlers, so a test drives completion order by hand. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('keeps results positional when workers finish out of order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const batch = mapWithConcurrency([0, 1, 2], 3, (item) => gates[item].promise);

    // Settle backwards; the result array must still follow the input order.
    gates[2].resolve('c');
    gates[0].resolve('a');
    gates[1].resolve('b');

    await expect(batch).resolves.toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' },
    ]);
  });

  it('passes each item with its index', async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
      seen.push([item, index]);
    });
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('never exceeds the requested number of workers in flight', async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, index) => index);

    const results = await mapWithConcurrency(items, 3, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      // Two microtask turns: long enough for another runner to overlap if the
      // ceiling were not enforced.
      await Promise.resolve();
      await Promise.resolve();
      live -= 1;
      return item * 2;
    });

    expect(peak).toBe(3);
    expect(results.map((entry) => (entry.status === 'fulfilled' ? entry.value : null)))
      .toEqual(items.map((item) => item * 2));
  });

  it('reports a rejected worker without failing the whole batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it('captures a synchronous throw from the worker', async () => {
    const [outcome] = await mapWithConcurrency([1], 1, (): number => {
      throw new Error('sync');
    });

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it('runs every remaining item after one rejects', async () => {
    const attempted: number[] = [];
    const results = await mapWithConcurrency([1, 2, 3, 4], 1, async (item) => {
      attempted.push(item);
      if (item === 1) throw new Error('first');
      return item;
    });

    expect(attempted).toEqual([1, 2, 3, 4]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(3);
  });

  it('clamps a non-positive limit instead of hanging', async () => {
    const results = await mapWithConcurrency([1, 2], 0, async (item) => item);
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('caps the worker count at the number of items', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2], 50, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
    });
    expect(peak).toBe(2);
  });

  it('returns an empty array for empty input without calling the worker', async () => {
    const worker = vi.fn(async (item: number) => item);
    await expect(mapWithConcurrency<number, number>([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});
