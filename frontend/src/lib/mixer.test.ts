import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  accountsToRelaunch,
  manualQualityDisabled,
  relaunchRunningAccounts,
} from './mixer';
import { isLaunched } from './filters';
import type { Account } from '../types/models';

/**
 * Property-based tests for the Mixer "Auto" toggle (task 23.2).
 *
 * Feature: react-frontend-migration, Property 36: Interruptor "Auto" deshabilita
 * el control manual de calidad gráfica — for any boolean `auto`,
 * `manualQualityDisabled(auto)` equals `auto`, i.e. the manual graphics-quality
 * control is disabled if and only if the "Auto" toggle is on.
 *
 * Validates: Requirements 19.2
 */
describe('manualQualityDisabled (Property 36: Interruptor "Auto" deshabilita el control manual de calidad gráfica)', () => {
  // Feature: react-frontend-migration, Property 36: Interruptor "Auto" deshabilita el control manual de calidad gráfica
  it('disables the manual graphics-quality control if and only if Auto is on', () => {
    fc.assert(
      fc.property(fc.boolean(), (auto) => {
        expect(manualQualityDisabled(auto)).toBe(auto);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property-based test for the Mixer "Apply and relaunch" selective relaunch
 * (task 23.4).
 *
 * Feature: react-frontend-migration, Property 37: Relanzamiento selectivo desde
 * Mixer — for any set of accounts with arbitrary launched/running states,
 * "Aplicar y relanzar" targets EXACTLY the currently-running accounts: the
 * per-account relaunch effect is invoked once for each running account (in
 * order) and never for an idle/non-running account, and the reported total
 * equals the number of running accounts. An account is "currently running" per
 * the authoritative {@link isLaunched} definition (its launched-instance count
 * is greater than zero; a missing count means idle).
 *
 * Validates: Requirements 19.5
 */

// ── Generators ──

// Small id pool so lists have distinct, easily-identified accounts.
const accountIdArb = fc.integer({ min: 1, max: 12 }).map((n) => `acc-${n}`);

/**
 * An account whose `launchedInstanceCount` spans all the relevant cases:
 * `undefined` (never launched this session → idle), `0` (explicitly idle), and
 * `> 0` (running). This exercises both branches of {@link isLaunched}.
 */
const accountArb: fc.Arbitrary<Account> = fc
  .record({
    id: accountIdArb,
    username: fc.string(),
    launchedInstanceCount: fc.oneof(
      fc.constant<number | undefined>(undefined),
      fc.integer({ min: 0, max: 4 }),
    ),
  })
  .map(({ id, username, launchedInstanceCount }) => {
    const account: Account = {
      id,
      username,
      userId: `user-${id}`,
      nickname: '',
      cookie: '',
      createdAt: '2024-01-01T00:00:00Z',
      lastUsed: null,
      donutProfileId: null,
      donutProfilePendingDelete: false,
    };
    if (launchedInstanceCount !== undefined) {
      account.launchedInstanceCount = launchedInstanceCount;
    }
    return account;
  });

// Distinct ids keep the "once per running account" tally unambiguous.
const accountsArb: fc.Arbitrary<Account[]> = fc.uniqueArray(accountArb, {
  selector: (a) => a.id,
  maxLength: 12,
});

/** Deep snapshot of an accounts list, to prove the input is never mutated. */
function snapshot(accounts: readonly Account[]): string {
  return JSON.stringify(accounts);
}

describe('Mixer selective relaunch (Property 37: Relanzamiento selectivo desde Mixer)', () => {
  // Feature: react-frontend-migration, Property 37: Relanzamiento selectivo desde Mixer
  it('accountsToRelaunch selects exactly the currently-running accounts, in order, without mutating the input', () => {
    fc.assert(
      fc.property(accountsArb, (accounts) => {
        const before = snapshot(accounts);
        const selected = accountsToRelaunch(accounts);

        // Every selected account is running; the selection preserves input
        // order and object identity (it is a filtered view, not a copy).
        const expected = accounts.filter((a) => isLaunched(a));
        expect(selected).toEqual(expected);
        selected.forEach((account) => expect(isLaunched(account)).toBe(true));

        // No idle account is ever selected.
        selected.forEach((account) =>
          expect((account.launchedInstanceCount ?? 0) > 0).toBe(true),
        );

        // The input list and its objects are never mutated.
        expect(snapshot(accounts)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 37: Relanzamiento selectivo desde Mixer
  it('relaunchRunningAccounts invokes relaunch once per running account and never for an idle account', async () => {
    await fc.assert(
      fc.asyncProperty(accountsArb, async (accounts) => {
        // Record how many times each account id is relaunched.
        const relaunchCounts = new Map<string, number>();
        const relaunch = (account: Account): Promise<void> => {
          relaunchCounts.set(
            account.id,
            (relaunchCounts.get(account.id) ?? 0) + 1,
          );
          return Promise.resolve();
        };

        const result = await relaunchRunningAccounts(accounts, relaunch);

        const running = accounts.filter((a) => isLaunched(a));
        const idle = accounts.filter((a) => !isLaunched(a));

        // Each running account is relaunched exactly once.
        running.forEach((account) =>
          expect(relaunchCounts.get(account.id)).toBe(1),
        );

        // No idle/non-running account is ever relaunched.
        idle.forEach((account) =>
          expect(relaunchCounts.has(account.id)).toBe(false),
        );

        // The total number of relaunch invocations equals the running count,
        // and the reported result agrees (all succeeded, none failed here).
        const totalInvocations = [...relaunchCounts.values()].reduce(
          (sum, n) => sum + n,
          0,
        );
        expect(totalInvocations).toBe(running.length);
        expect(result.total).toBe(running.length);
        expect(result.succeeded).toBe(running.length);
        expect(result.failed).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
