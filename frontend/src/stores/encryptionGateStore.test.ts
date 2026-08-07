import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  reduceEncStatus,
  reduceSubmit,
  isSetupModalOpen,
  isUnlockModalOpen,
  isSubmitSuccess,
  ENC_GATE_GENERIC_ERROR,
  type EncStatusOutcome,
  type EncSubmitOutcome,
  type EncGateTransition,
} from './encryptionGateStore';

/**
 * Property-based tests for the Encryption_Gate state machine (task 9.3).
 *
 * Feature: react-frontend-migration, Property 10: Máquina de estados del
 * Encryption_Gate — For any valid sequence of (a) an `enc_status` response
 * (`"setup"`, `"locked"`, `"unlocked"`, or an invocation failure) and (b) when
 * applicable, a key-submit result (success, or failure with any message), the
 * resulting Encryption_Gate state and whether `accounts_load` was invoked match
 * the transition table exactly: `"setup"`/`"locked"` with no submit yet → the
 * corresponding modal open, accessGranted=false, accounts_load NOT invoked; a
 * failed submit → the modal stays open with the error message, accessGranted=
 * false, accounts_load NOT invoked; a successful submit, `"unlocked"`, or an
 * `enc_status` invocation failure → modal closed, accessGranted=true,
 * accounts_load invoked exactly once.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 *
 * The core property is asserted against the PURE reducers
 * (`reduceEncStatus` / `reduceSubmit`) plus the modal-visibility derivations,
 * so coverage is deterministic and independent of React or `window.api`. A
 * focused store test additionally proves `accounts_load` is invoked exactly
 * once on access-granting transitions by mocking `lib/ipc.ts`.
 */

// ── Independent oracle (mirrors the design's transition table, NOT the SUT) ──

/** The gate-relevant projection the property compares against. */
interface ExpectedGateState {
  mode: EncGateTransition['mode'];
  accessGranted: boolean;
  errorMessage: string | null;
  setupModalOpen: boolean;
  unlockModalOpen: boolean;
  /** Number of access-granting (accounts_load) transitions across the sequence. */
  loadCount: number;
}

/**
 * Compute the expected end state directly from the raw inputs, per the design's
 * transition table. This is written independently of the reducers so the
 * property genuinely checks the reducers rather than restating them.
 */
function expectedState(
  status: EncStatusOutcome,
  submit: EncSubmitOutcome | undefined,
): ExpectedGateState {
  // 7.7: enc_status invocation failed → bypass, access granted, load once.
  if (!status.ok) {
    return {
      mode: 'bypassed',
      accessGranted: true,
      errorMessage: null,
      setupModalOpen: false,
      unlockModalOpen: false,
      loadCount: 1,
    };
  }
  // 7.4: already unlocked → access granted immediately, load once, no modal.
  if (status.mode === 'unlocked') {
    return {
      mode: 'unlocked',
      accessGranted: true,
      errorMessage: null,
      setupModalOpen: false,
      unlockModalOpen: false,
      loadCount: 1,
    };
  }
  // 7.2 / 7.3: setup or locked → a key submission may follow.
  const mode = status.mode; // 'setup' | 'locked'
  if (!submit) {
    // No submit yet: corresponding modal open, access denied, no load.
    return {
      mode,
      accessGranted: false,
      errorMessage: null,
      setupModalOpen: mode === 'setup',
      unlockModalOpen: mode === 'locked',
      loadCount: 0,
    };
  }
  if (submit.ok) {
    // 7.6: success closes the modal, grants access, loads once. Mode preserved.
    return {
      mode,
      accessGranted: true,
      errorMessage: null,
      setupModalOpen: false,
      unlockModalOpen: false,
      loadCount: 1,
    };
  }
  // 7.5: failure keeps the modal open with an error message, preserves mode,
  // does NOT load. A missing/blank message falls back to the generic error.
  const usable =
    typeof submit.message === 'string' && submit.message.trim().length > 0;
  return {
    mode,
    accessGranted: false,
    errorMessage: usable ? (submit.message as string) : ENC_GATE_GENERIC_ERROR,
    setupModalOpen: mode === 'setup',
    unlockModalOpen: mode === 'locked',
    loadCount: 0,
  };
}

/**
 * Drive the actual pure reducers through the same sequence and project the
 * gate state, tallying how many transitions request `accounts_load`.
 */
function actualState(
  status: EncStatusOutcome,
  submit: EncSubmitOutcome | undefined,
): ExpectedGateState {
  let loadCount = 0;
  let t = reduceEncStatus(status);
  if (t.loadAccounts) loadCount += 1;

  // A submit is only applicable while the gate is still waiting for a key
  // (setup/locked, access not yet granted) — exactly when a modal is open.
  const awaitingKey =
    !t.accessGranted && (t.mode === 'setup' || t.mode === 'locked');
  if (submit && awaitingKey) {
    t = reduceSubmit(t.mode, submit);
    if (t.loadAccounts) loadCount += 1;
  }

  const snapshot = { mode: t.mode, accessGranted: t.accessGranted };
  return {
    mode: t.mode,
    accessGranted: t.accessGranted,
    errorMessage: t.errorMessage,
    setupModalOpen: isSetupModalOpen(snapshot),
    unlockModalOpen: isUnlockModalOpen(snapshot),
    loadCount,
  };
}

// ── Generators ──

/** An `enc_status` outcome: a mode read, or an invocation failure. */
const encStatusArb: fc.Arbitrary<EncStatusOutcome> = fc.oneof(
  fc.constant<EncStatusOutcome>({ ok: true, mode: 'setup' }),
  fc.constant<EncStatusOutcome>({ ok: true, mode: 'locked' }),
  fc.constant<EncStatusOutcome>({ ok: true, mode: 'unlocked' }),
  fc.constant<EncStatusOutcome>({ ok: false }),
);

/**
 * A key-submit outcome: success, or failure with an arbitrary message that may
 * be `undefined`, empty, whitespace-only, or arbitrary text.
 */
const submitArb: fc.Arbitrary<EncSubmitOutcome> = fc.oneof(
  fc.constant<EncSubmitOutcome>({ ok: true }),
  fc
    .oneof(
      fc.constant<string | undefined>(undefined),
      fc.constant(''),
      fc.constantFrom('   ', '\t', '\n', ' \t \n '),
      fc.string(),
    )
    .map<EncSubmitOutcome>((message) => ({ ok: false, message })),
);

describe('Encryption_Gate state machine (Property 10)', () => {
  // Feature: react-frontend-migration, Property 10: Máquina de estados del Encryption_Gate
  it('resulting gate state and accounts_load match the transition table for any sequence', () => {
    fc.assert(
      fc.property(
        encStatusArb,
        // The submit outcome is only consumed when a modal is open, but we
        // always generate one so the "no submit yet" branch is also exercised.
        fc.option(submitArb, { nil: undefined }),
        (status, submit) => {
          const actual = actualState(status, submit);
          const expected = expectedState(status, submit);

          expect(actual.mode).toBe(expected.mode);
          expect(actual.accessGranted).toBe(expected.accessGranted);
          expect(actual.errorMessage).toBe(expected.errorMessage);
          expect(actual.setupModalOpen).toBe(expected.setupModalOpen);
          expect(actual.unlockModalOpen).toBe(expected.unlockModalOpen);

          // accounts_load is invoked exactly once iff access ends up granted,
          // and never while a modal is still open.
          expect(actual.loadCount).toBe(expected.loadCount);
          expect(actual.loadCount).toBe(actual.accessGranted ? 1 : 0);

          // An open modal always means access is still denied, and at most one
          // modal is open at a time.
          if (actual.setupModalOpen || actual.unlockModalOpen) {
            expect(actual.accessGranted).toBe(false);
          }
          expect(actual.setupModalOpen && actual.unlockModalOpen).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: react-frontend-migration, Property 10: Máquina de estados del Encryption_Gate
  it('a failed submit always surfaces a non-empty error message and preserves the mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'setup' | 'locked'>('setup', 'locked'),
        submitArb.filter((o): o is Extract<EncSubmitOutcome, { ok: false }> => !o.ok),
        (mode, failure) => {
          const t = reduceSubmit(mode, failure);
          expect(t.mode).toBe(mode); // 7.5: mode preserved
          expect(t.accessGranted).toBe(false);
          expect(t.loadAccounts).toBe(false);
          expect(typeof t.errorMessage).toBe('string');
          expect((t.errorMessage as string).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Focused store test: accounts_load is invoked exactly once ──
//
// The pure property above proves the transition table. This block proves the
// store wiring honours it: on any access-granting startup/submit it invokes
// `accounts_load` exactly once (Requirements 7.1, 7.6, 7.7), and on a blocking
// transition it does not invoke it at all (Requirements 7.2, 7.3, 7.5).

// `vi.hoisted` runs before the hoisted `vi.mock` factory, so these spies are
// safe to reference inside it (a plain `const` would be used-before-init).
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

describe('useEncryptionGateStore invokes accounts_load exactly once on access', () => {
  beforeEach(() => {
    loadAccounts.mockReset().mockResolvedValue(undefined);
    encStatus.mockReset();
    encSetKey.mockReset();
    encUnlock.mockReset();
    // Reset to the initial (pre-init) gate state.
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

  it('7.4: init with "unlocked" grants access and loads accounts once', async () => {
    encStatus.mockResolvedValue({ mode: 'unlocked' });
    await useEncryptionGateStore.getState().init();

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(true);
    expect(s.setupModalOpen).toBe(false);
    expect(s.unlockModalOpen).toBe(false);
    expect(loadAccounts).toHaveBeenCalledTimes(1);
  });

  it('7.7: init bypasses the gate and loads accounts once when enc_status fails', async () => {
    encStatus.mockRejectedValue(new Error('boom'));
    await useEncryptionGateStore.getState().init();

    const s = useEncryptionGateStore.getState();
    expect(s.mode).toBe('bypassed');
    expect(s.accessGranted).toBe(true);
    expect(loadAccounts).toHaveBeenCalledTimes(1);
  });

  it('7.2/7.6: setup then a successful key submit loads accounts exactly once', async () => {
    encStatus.mockResolvedValue({ mode: 'setup' });
    await useEncryptionGateStore.getState().init();

    expect(useEncryptionGateStore.getState().setupModalOpen).toBe(true);
    expect(loadAccounts).not.toHaveBeenCalled();

    encSetKey.mockResolvedValue(true);
    await useEncryptionGateStore.getState().submitSetup('hunter2');

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(true);
    expect(s.setupModalOpen).toBe(false);
    expect(loadAccounts).toHaveBeenCalledTimes(1);
  });

  it('7.3/7.5: a failed unlock keeps the modal open and never loads accounts', async () => {
    encStatus.mockResolvedValue({ mode: 'locked' });
    await useEncryptionGateStore.getState().init();

    encUnlock.mockResolvedValue(false);
    await useEncryptionGateStore.getState().submitUnlock('wrong');

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(false);
    expect(s.unlockModalOpen).toBe(true);
    expect(s.errorMessage).toBe(ENC_GATE_GENERIC_ERROR);
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  // Regression: `enc_unlock` / `enc_set_key` answer with an `{ ok, error? }`
  // record even though the bridge declares a boolean. The store used to test
  // the resolved value for truthiness, so the rejection shape `{ ok: false }` —
  // a truthy object — passed as a successful unlock. The gate opened over a key
  // session that was still locked, and every later account write failed with
  // `encrypt_field`'s "locked". The casts below are deliberate: they reproduce
  // the real runtime shape that the declared type does not describe.
  it('7.5: a rejected unlock answering { ok: false } keeps the gate closed', async () => {
    encStatus.mockResolvedValue({ mode: 'locked' });
    await useEncryptionGateStore.getState().init();

    encUnlock.mockResolvedValue({ ok: false } as unknown as boolean);
    await useEncryptionGateStore.getState().submitUnlock('wrong');

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(false);
    expect(s.unlockModalOpen).toBe(true);
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  it('7.6: an accepted unlock answering { ok: true } grants access', async () => {
    encStatus.mockResolvedValue({ mode: 'locked' });
    await useEncryptionGateStore.getState().init();

    encUnlock.mockResolvedValue({ ok: true } as unknown as boolean);
    await useEncryptionGateStore.getState().submitUnlock('right');

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(true);
    expect(s.unlockModalOpen).toBe(false);
    expect(loadAccounts).toHaveBeenCalledTimes(1);
  });

  it('7.5: a rejected setup answering { ok: false } keeps the gate closed', async () => {
    encStatus.mockResolvedValue({ mode: 'setup' });
    await useEncryptionGateStore.getState().init();

    encSetKey.mockResolvedValue({ ok: false } as unknown as boolean);
    await useEncryptionGateStore.getState().submitSetup('hunter2');

    const s = useEncryptionGateStore.getState();
    expect(s.accessGranted).toBe(false);
    expect(s.setupModalOpen).toBe(true);
    expect(loadAccounts).not.toHaveBeenCalled();
  });
});

describe('isSubmitSuccess', () => {
  it('reads the `ok` field of a record result', () => {
    expect(isSubmitSuccess({ ok: true })).toBe(true);
    expect(isSubmitSuccess({ ok: false })).toBe(false);
    expect(isSubmitSuccess({ ok: false, error: 'decrypt failed' })).toBe(false);
  });

  it('falls back to truthiness for a plain boolean result', () => {
    expect(isSubmitSuccess(true)).toBe(true);
    expect(isSubmitSuccess(false)).toBe(false);
    expect(isSubmitSuccess(undefined)).toBe(false);
    expect(isSubmitSuccess(null)).toBe(false);
  });
});
