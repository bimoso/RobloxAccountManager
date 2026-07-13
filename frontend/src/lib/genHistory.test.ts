import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  appendGenHistory,
  capGenHistory,
  clearGenHistory,
  sanitizeGenHistory,
} from './genHistory';
import type { GenHistoryEntry } from '../types/models';

/**
 * Property-based tests for the generation-history growth helper (task 24.2).
 *
 * Feature: react-frontend-migration, Property 38: Crecimiento del historial de
 * generación — for any existing history (possibly empty) and for any generated
 * result, `appendGenHistory(history, entry)` has length `history.length + 1`,
 * its last element equals `entry`, and all previous elements remain unchanged
 * and in the same order (the input array is never mutated).
 *
 * Validates: Requirements 20.2
 */

/** Arbitrary for a single generation-history entry. */
const genHistoryEntryArb: fc.Arbitrary<GenHistoryEntry> = fc.record({
  username: fc.string(),
  password: fc.string(),
  createdAt: fc.string(),
});

/** Arbitrary for an existing history (possibly empty). */
const genHistoryArb: fc.Arbitrary<GenHistoryEntry[]> = fc.array(genHistoryEntryArb);

describe('appendGenHistory (Property 38: Crecimiento del historial de generación)', () => {
  // Feature: react-frontend-migration, Property 38: Crecimiento del historial de generación
  it('grows the history by exactly one, appending the entry at the end, preserving prior entries without mutating the input', () => {
    fc.assert(
      fc.property(genHistoryArb, genHistoryEntryArb, (history, entry) => {
        // Snapshot the input to detect any mutation afterwards.
        const before = history.slice();

        const result = appendGenHistory(history, entry);

        // Length grows by exactly one.
        expect(result).toHaveLength(history.length + 1);

        // Last element is exactly the appended entry.
        expect(result[result.length - 1]).toBe(entry);

        // All previous elements are preserved unchanged and in the same order.
        expect(result.slice(0, history.length)).toEqual(before);

        // The input `history` array is not mutated.
        expect(history).toEqual(before);
        expect(history).toHaveLength(before.length);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property-based tests for the generation-history clearing helper (task 24.3).
 *
 * Feature: react-frontend-migration, Property 39: Vaciado del historial de
 * generación — for any prior history (possibly empty), invoking
 * `clearGenHistory()` yields a fresh, empty displayed list (length 0) that does
 * not alias or mutate the prior history.
 *
 * Validates: Requirements 20.3
 */
describe('clearGenHistory (Property 39: Vaciado del historial de generación)', () => {
  // Feature: react-frontend-migration, Property 39: Vaciado del historial de generación
  it('returns a fresh empty list regardless of the prior history, without aliasing or mutating it', () => {
    fc.assert(
      fc.property(genHistoryArb, (priorHistory) => {
        // Snapshot the prior history to detect any mutation afterwards.
        const before = priorHistory.slice();

        const result = clearGenHistory();

        // The cleared list has length 0.
        expect(result).toHaveLength(0);
        expect(result).toEqual([]);

        // The result is a fresh array, not the prior history reference.
        expect(result).not.toBe(priorHistory);

        // The prior history is left untouched (not mutated by the clear).
        expect(priorHistory).toEqual(before);
        expect(priorHistory).toHaveLength(before.length);
      }),
      { numRuns: 100 },
    );
  });
});

describe('safe Generator history', () => {
  it('drops full cookies and unknown response fields from legacy history', () => {
    const result = sanitizeGenHistory([
      {
        username: 'SafeAccount',
        password: 'generated-pass',
        createdAt: '2026-07-13T01:02:03.000Z',
        result: 'added',
        step: 'add',
        cookie: '_|WARNING:-DO-NOT-SHARE-THIS.TEST_COOKIE',
        nested: { cookie: 'also-secret' },
      },
    ]);

    expect(result).toEqual([
      {
        username: 'SafeAccount',
        password: 'generated-pass',
        createdAt: '2026-07-13T01:02:03.000Z',
        result: 'added',
        step: 'add',
      },
    ]);
    expect(result[0]).not.toHaveProperty('cookie');
    expect(JSON.stringify(result)).not.toContain('TEST_COOKIE');
  });

  it('keeps the newest rows when the history reaches its bound', () => {
    const history: GenHistoryEntry[] = Array.from({ length: 5 }, (_, index) => ({
      username: `user-${index}`,
      password: '',
      createdAt: String(index),
    }));

    expect(capGenHistory(history, 3).map((entry) => entry.username)).toEqual([
      'user-2',
      'user-3',
      'user-4',
    ]);
    expect(history).toHaveLength(5);
  });
});
