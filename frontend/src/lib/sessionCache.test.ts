import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKeyedSessionCache,
  createSessionCache,
  resetSessionCaches,
} from './sessionCache';

afterEach(() => {
  vi.useRealTimers();
});

describe('createSessionCache', () => {
  it('stores one value and reports freshness by age', () => {
    vi.useFakeTimers();
    const cache = createSessionCache<string>();

    expect(cache.get()).toBeUndefined();
    expect(cache.isFresh(1_000)).toBe(false);

    cache.set('hello');
    expect(cache.get()).toBe('hello');
    expect(cache.isFresh(1_000)).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(cache.isFresh(1_000)).toBe(false);
    // A stale value is still readable — staleness only signals "revalidate".
    expect(cache.get()).toBe('hello');
  });

  it('clears back to the empty state', () => {
    const cache = createSessionCache<number>();
    cache.set(7);
    cache.clear();
    expect(cache.get()).toBeUndefined();
    expect(cache.isFresh(60_000)).toBe(false);
  });
});

describe('createKeyedSessionCache', () => {
  it('tracks value and freshness independently per key', () => {
    vi.useFakeTimers();
    const cache = createKeyedSessionCache<string, number>();

    cache.set('a', 1);
    vi.advanceTimersByTime(500);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('missing')).toBeUndefined();

    vi.advanceTimersByTime(600);
    // 'a' is now 1100ms old, 'b' only 600ms old.
    expect(cache.isFresh('a', 1_000)).toBe(false);
    expect(cache.isFresh('b', 1_000)).toBe(true);
    expect(cache.isFresh('missing', 1_000)).toBe(false);
  });
});

describe('resetSessionCaches', () => {
  it('wipes every cache created by the module', () => {
    const single = createSessionCache<string>();
    const keyed = createKeyedSessionCache<string, string>();
    single.set('value');
    keyed.set('k', 'v');

    resetSessionCaches();

    expect(single.get()).toBeUndefined();
    expect(keyed.get('k')).toBeUndefined();
  });
});
