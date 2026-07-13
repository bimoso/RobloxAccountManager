import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPersisted,
  setPersisted,
  removePersisted,
  PERSISTENCE_KEYS,
} from './persistence';

/**
 * Unit tests for the persistence layer (task 3.2).
 *
 * Requirement 3.6: if a preference cannot be written, the selection is kept in
 * memory for the session and the rest of the interface keeps working. Every
 * helper must therefore be resilient — a storage failure (quota exceeded,
 * disabled storage, corrupt value, serialization error) must never throw and
 * must never block the UI.
 *
 * The test-environment `localStorage` polyfill is incomplete, so each test runs
 * against a fresh, deterministic Map-backed mock installed as the global
 * `localStorage`. Failures are injected by re-spying on that mock's methods.
 */

/** Build a spec-compliant, in-memory Storage stand-in backed by a Map. */
function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('persistence layer (Requirement 3.6)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('setPersisted — write failure handling', () => {
    it('does not throw when localStorage.setItem throws (quota exceeded / storage disabled)', () => {
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });

      expect(() => setPersisted(PERSISTENCE_KEYS.theme, 'aurora')).not.toThrow();
    });

    it('silently no-ops on a serialization failure (circular reference)', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => setPersisted('cycle', circular)).not.toThrow();
      // Nothing usable should have been written.
      expect(getPersisted('cycle')).toBeUndefined();
    });
  });

  describe('getPersisted — read failure handling', () => {
    it('does not throw and returns undefined when localStorage.getItem throws', () => {
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError');
      });

      let result: unknown;
      expect(() => {
        result = getPersisted(PERSISTENCE_KEYS.theme);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });

    it('returns undefined for a missing key', () => {
      expect(getPersisted('does-not-exist')).toBeUndefined();
    });

    it('returns undefined for an unparseable / corrupt stored value', () => {
      // Write raw invalid JSON directly, bypassing setPersisted's serialization.
      localStorage.setItem(PERSISTENCE_KEYS.filter, '{not valid json');

      expect(getPersisted(PERSISTENCE_KEYS.filter)).toBeUndefined();
    });
  });

  describe('removePersisted — remove failure handling', () => {
    it('does not throw when localStorage.removeItem throws', () => {
      vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
        throw new DOMException('SecurityError');
      });

      expect(() => removePersisted(PERSISTENCE_KEYS.theme)).not.toThrow();
    });

    it('removes a previously stored value when storage works', () => {
      setPersisted(PERSISTENCE_KEYS.view, 'grid');
      expect(getPersisted(PERSISTENCE_KEYS.view)).toBe('grid');

      removePersisted(PERSISTENCE_KEYS.view);
      expect(getPersisted(PERSISTENCE_KEYS.view)).toBeUndefined();
    });
  });

  describe('round-trip when storage works', () => {
    it('persists and reads back a string', () => {
      setPersisted(PERSISTENCE_KEYS.theme, 'midnight');
      expect(getPersisted<string>(PERSISTENCE_KEYS.theme)).toBe('midnight');
    });

    it('persists and reads back a boolean', () => {
      setPersisted('flag', true);
      expect(getPersisted<boolean>('flag')).toBe(true);
    });

    it('persists and reads back a number', () => {
      setPersisted('count', 42);
      expect(getPersisted<number>('count')).toBe(42);
    });

    it('persists and reads back a structured object', () => {
      const value = { placeId: 606849621, jobId: 'abc-123', vip: false };
      setPersisted('launch-meta', value);
      expect(getPersisted<typeof value>('launch-meta')).toEqual(value);
    });
  });
});
