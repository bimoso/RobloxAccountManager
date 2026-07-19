/**
 * Session cache.
 *
 * The PageRouter unmounts a page when the user navigates away, so any data a
 * page holds in component state is lost and re-fetched — with a visible
 * loading state — on every visit. These small in-memory caches outlive the
 * component: a page hydrates its initial state from its cache (instant paint
 * with the last known data) and then refreshes in the background
 * (stale-while-revalidate), so revisiting a page never flashes a spinner or an
 * empty state.
 *
 * The caches are deliberately in-memory only (cleared on app restart): they
 * exist for navigation fluidity within a session, not for durable persistence
 * — that remains `lib/persistence.ts`'s job.
 *
 * Every cache created here registers itself in a module registry so
 * {@link resetSessionCaches} can wipe them all; the test setup calls it after
 * each test to keep test files that render a page multiple times isolated.
 */

/** Anything the registry needs to know about a cache: how to wipe it. */
interface Resettable {
  clear(): void;
}

/** Every cache ever created, so tests can reset them in one call. */
const registry = new Set<Resettable>();

/**
 * Reset every session cache created by this module. Intended for the test
 * setup (`test/setup.ts` calls it after each test); production code never
 * needs it.
 */
export function resetSessionCaches(): void {
  for (const cache of registry) {
    cache.clear();
  }
}

/** A single-value session cache. */
export interface SessionCache<T> {
  /** The cached value, or `undefined` when nothing has been stored. */
  get(): T | undefined;
  /** Store `value`, stamping the current time for {@link isFresh}. */
  set(value: T): void;
  /**
   * True when a value is stored and it is at most `maxAgeMs` old. An empty
   * cache is never fresh.
   */
  isFresh(maxAgeMs: number): boolean;
  /** Drop the stored value (back to the empty state). */
  clear(): void;
}

/**
 * Create a single-value session cache (one snapshot per page/module).
 *
 * @typeParam T - Shape of the cached snapshot.
 * @returns The cache handle; hold it in a module-level constant.
 */
export function createSessionCache<T>(): SessionCache<T> {
  let entry: { value: T; storedAt: number } | undefined;
  const cache: SessionCache<T> = {
    get: () => entry?.value,
    set: (value) => {
      entry = { value, storedAt: Date.now() };
    },
    isFresh: (maxAgeMs) =>
      entry !== undefined && Date.now() - entry.storedAt <= maxAgeMs,
    clear: () => {
      entry = undefined;
    },
  };
  registry.add(cache);
  return cache;
}

/** A keyed session cache (independent freshness per key). */
export interface KeyedSessionCache<K, V> {
  /** The value cached under `key`, or `undefined` on a miss. */
  get(key: K): V | undefined;
  /** Store `value` under `key`, stamping the current time. */
  set(key: K, value: V): void;
  /** True when `key` holds a value at most `maxAgeMs` old. */
  isFresh(key: K, maxAgeMs: number): boolean;
  /** Drop every key. */
  clear(): void;
}

/**
 * Create a keyed session cache — one independently-timestamped slot per key
 * (e.g. the Charts games listing per ranking tab, or avatar URLs per user id).
 *
 * @typeParam K - Key type.
 * @typeParam V - Cached value type.
 * @returns The cache handle; hold it in a module-level constant.
 */
export function createKeyedSessionCache<K, V>(): KeyedSessionCache<K, V> {
  const entries = new Map<K, { value: V; storedAt: number }>();
  const cache: KeyedSessionCache<K, V> = {
    get: (key) => entries.get(key)?.value,
    set: (key, value) => {
      entries.set(key, { value, storedAt: Date.now() });
    },
    isFresh: (key, maxAgeMs) => {
      const entry = entries.get(key);
      return entry !== undefined && Date.now() - entry.storedAt <= maxAgeMs;
    },
    clear: () => {
      entries.clear();
    },
  };
  registry.add(cache);
  return cache;
}
