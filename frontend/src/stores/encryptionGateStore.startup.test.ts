import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Startup ordering test for the Encryption_Gate store (task 9.4).
 *
 * Feature: react-frontend-migration.
 * Validates: Requirements 7.1 — on startup (`init()`), `enc_status` is invoked
 * BEFORE `accounts_load`.
 *
 * This lives in a separate file from `encryptionGateStore.test.ts` so the two
 * suites keep independent `lib/ipc` mocks. Ordering is proven with Vitest's
 * `mock.invocationCallOrder`: every mock created via `vi.fn` records a
 * globally-monotonic sequence number each time it is called, so comparing the
 * first recorded order of `encStatus` against the first of `loadAccounts`
 * establishes which ran first regardless of async timing.
 */

// `vi.hoisted` runs before the hoisted `vi.mock` factory so these spies can be
// referenced inside it.
const { loadAccounts, encStatus, encSetKey, encUnlock } = vi.hoisted(() => ({
  loadAccounts: vi.fn<() => Promise<unknown>>(),
  encStatus: vi.fn<() => Promise<{ mode: 'setup' | 'locked' | 'unlocked' }>>(),
  encSetKey: vi.fn<(pass: string) => Promise<boolean>>(),
  encUnlock: vi.fn<(pass: string) => Promise<boolean>>(),
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    loadAccounts: () => loadAccounts(),
    encStatus: () => encStatus(),
    encSetKey: (pass: string) => encSetKey(pass),
    encUnlock: (pass: string) => encUnlock(pass),
  },
}));

// Imported after vi.mock so the store binds to the mocked ipc.
import { useEncryptionGateStore } from './encryptionGateStore';

describe('Encryption_Gate startup ordering (Requirement 7.1)', () => {
  beforeEach(() => {
    loadAccounts.mockReset().mockResolvedValue(undefined);
    encStatus.mockReset();
    encSetKey.mockReset();
    encUnlock.mockReset();
    // Reset the store to its initial (pre-init) state.
    useEncryptionGateStore.setState({
      mode: 'checking',
      accessGranted: false,
      errorMessage: null,
      setupModalOpen: false,
      unlockModalOpen: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('invokes enc_status before accounts_load on init()', async () => {
    // "unlocked" makes init() take the access-granting path so accounts_load
    // actually runs, letting us compare the two invocation orders.
    encStatus.mockResolvedValue({ mode: 'unlocked' });

    await useEncryptionGateStore.getState().init();

    // Both commands must have run for the ordering comparison to be meaningful.
    expect(encStatus).toHaveBeenCalledTimes(1);
    expect(loadAccounts).toHaveBeenCalledTimes(1);

    // Vitest assigns each call a monotonically-increasing invocation order.
    const statusOrder = encStatus.mock.invocationCallOrder[0];
    const loadOrder = loadAccounts.mock.invocationCallOrder[0];

    // enc_status ran strictly before accounts_load.
    expect(statusOrder).toBeLessThan(loadOrder);
  });
});
