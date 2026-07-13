import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyClosedEvent, applyAllClosedEvent } from './accountStore';
import type { Account } from '../types/models';

/**
 * Property-based test for the pure closed-instance event reducers (task 13.6).
 *
 * Feature: react-frontend-migration, Property 29: Reducer de eventos de cierre
 * de instancias de Roblox — For any accounts list and any accountId:
 *   - `applyClosedEvent(accounts, accountId)` marks ONLY the matching account
 *     (if present) as not-launched (`launchedInstanceCount === 0`); every other
 *     account is preserved by reference, unchanged; and when no account matches
 *     the original list reference is returned. The input is never mutated
 *     (Requirement 15.4).
 *   - `applyAllClosedEvent(accounts)` marks EVERY account as not-launched
 *     (`launchedInstanceCount === 0`), preserves the length, and never mutates
 *     the input (Requirement 15.5).
 *
 * Validates: Requirements 15.4, 15.5
 */

// ── Generators ──

// Small id pool so a randomly-chosen `accountId` collides with an existing
// account frequently (matching case) but also sometimes misses (no-op case).
const accountIdArb = fc.integer({ min: 1, max: 8 }).map((n) => `acc-${n}`);

/**
 * An account with a varied `launchedInstanceCount` (0 and >0) so both the
 * already-idle and the currently-launched transitions are exercised. Other
 * fields are filled with representative values; they must round-trip untouched.
 */
const accountArb: fc.Arbitrary<Account> = fc
  .record({
    id: accountIdArb,
    username: fc.string(),
    launchedInstanceCount: fc.integer({ min: 0, max: 5 }),
  })
  .map(({ id, username, launchedInstanceCount }) => ({
    id,
    username,
    userId: `user-${id}`,
    nickname: '',
    cookie: '',
    createdAt: '2024-01-01T00:00:00Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
    launchedInstanceCount,
  }));

// Accounts share a small id pool, so lists frequently contain the target id.
// A `uniqueArray` on id keeps the "only the matching account changes"
// assertions unambiguous (at most one account per id).
const accountsArb: fc.Arbitrary<Account[]> = fc.uniqueArray(accountArb, {
  selector: (a) => a.id,
  maxLength: 8,
});

/** Deep snapshot of an accounts list, to prove the input is never mutated. */
function snapshot(accounts: Account[]): string {
  return JSON.stringify(accounts);
}

describe('applyClosedEvent / applyAllClosedEvent reducers (Property 29)', () => {
  // Feature: react-frontend-migration, Property 29: Reducer de eventos de cierre de instancias de Roblox
  it('applyClosedEvent marks only the matching account not-launched, preserves the rest by reference, and never mutates the input', () => {
    fc.assert(
      fc.property(accountsArb, accountIdArb, (accounts, accountId) => {
        const before = snapshot(accounts);
        const result = applyClosedEvent(accounts, accountId);

        const hasMatch = accounts.some((a) => a.id === accountId);

        if (!hasMatch) {
          // No account matched: the original reference is returned unchanged.
          expect(result).toBe(accounts);
        } else {
          // A new array is produced (no in-place mutation of the list).
          expect(result).not.toBe(accounts);
          expect(result).toHaveLength(accounts.length);

          result.forEach((account, index) => {
            const original = accounts[index];
            expect(account.id).toBe(original.id);
            if (account.id === accountId) {
              // The matching account is marked not-launched.
              expect(account.launchedInstanceCount).toBe(0);
            } else {
              // Every other account is preserved by reference, unchanged.
              expect(account).toBe(original);
            }
          });
        }

        // The input list and its objects are never mutated.
        expect(snapshot(accounts)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 29: Reducer de eventos de cierre de instancias de Roblox
  it('applyAllClosedEvent marks every account not-launched, preserves length, and never mutates the input', () => {
    fc.assert(
      fc.property(accountsArb, (accounts) => {
        const before = snapshot(accounts);
        const result = applyAllClosedEvent(accounts);

        // A new array with the same length is produced.
        expect(result).not.toBe(accounts);
        expect(result).toHaveLength(accounts.length);

        result.forEach((account, index) => {
          // Every account is marked not-launched; identity fields survive.
          expect(account.launchedInstanceCount).toBe(0);
          expect(account.id).toBe(accounts[index].id);
        });

        // The input list and its objects are never mutated.
        expect(snapshot(accounts)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });
});
