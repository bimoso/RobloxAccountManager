/**
 * Encryption_Gate store.
 *
 * On startup the React_Frontend must block access to every page until the user
 * either configures a new encryption key, unlocks an existing one, or the
 * backend reports that no gating is needed. This store owns that state machine.
 *
 * Design references (Requirement 7 acceptance criteria):
 * - 7.1: `enc_status` is invoked BEFORE `accounts_load` on startup.
 * - 7.2: mode "setup" → show the setup modal, block the app, allow submitting a
 *   key (or an empty key to skip) via `enc_set_key`.
 * - 7.3: mode "locked" → show the unlock modal, block the app, allow submitting
 *   a key via `enc_unlock`.
 * - 7.4: mode "unlocked" → grant access immediately with no modal.
 * - 7.5: a failed `enc_set_key` / `enc_unlock` keeps the modal open, shows the
 *   error message, preserves the current mode, and does NOT invoke
 *   `accounts_load`.
 * - 7.6: a successful `enc_set_key` / `enc_unlock` closes the modal and invokes
 *   `accounts_load` to grant access.
 * - 7.7: if the `enc_status` invocation itself fails, skip every modal, grant
 *   access, and invoke `accounts_load` immediately (bypass).
 *
 * Correctness property (property-tested in `encryptionGateStore.test.ts`, task
 * 9.3):
 * - Property 10: for any sequence of an `enc_status` outcome plus (if
 *   applicable) a key-submit outcome, the resulting gate state and whether
 *   `accounts_load` was invoked match the transition table exactly.
 *
 * The transition logic lives in the pure, deterministic helpers
 * {@link reduceEncStatus} and {@link reduceSubmit} (plus the modal-visibility
 * derivations {@link isSetupModalOpen} / {@link isUnlockModalOpen}) so it can be
 * property-tested without React or `window.api`. The store actions are thin
 * wrappers that call `lib/ipc.ts`, feed the outcome through a reducer, commit
 * the snapshot, and invoke `accounts_load` exactly once on the access-granting
 * transitions.
 */

import { create } from 'zustand';
import { ipc } from '../lib/ipc';
import { normalizeErrorMessage } from './toastStore';
import type { EncryptionGateMode } from '../types/models';

/** The three raw modes the backend `enc_status` command can report. */
export type EncStatusMode = 'setup' | 'locked' | 'unlocked';

/**
 * Outcome of invoking `enc_status`: either a successful mode read, or a failed
 * invocation (`ok: false`) which triggers the bypass path (Requirement 7.7).
 */
export type EncStatusOutcome =
  | { ok: true; mode: EncStatusMode }
  | { ok: false };

/**
 * Outcome of a key submission (`enc_set_key` / `enc_unlock`). Success is defined
 * as a truthy result; a falsy result or a rejected promise is a failure, in
 * which case an optional human-readable message may accompany it
 * (Requirement 7.5).
 */
export type EncSubmitOutcome =
  | { ok: true }
  | { ok: false; message?: string };

/**
 * Pure snapshot produced by the reducers: the gate state fields plus a flag
 * indicating whether this transition grants access and therefore must invoke
 * `accounts_load` exactly once.
 */
export interface EncGateTransition {
  /** Resulting gate mode. */
  mode: EncryptionGateMode;
  /** Whether the rest of the app is now accessible. */
  accessGranted: boolean;
  /** Error message to show inside the active modal, or `null` for none. */
  errorMessage: string | null;
  /**
   * `true` when this transition grants access and `accounts_load` must be
   * invoked (exactly once) as a result.
   */
  loadAccounts: boolean;
}

/**
 * Generic error message shown inside a modal when a key submission fails
 * without carrying a usable message of its own (e.g. `enc_unlock` resolves to
 * `false`) — Requirement 7.5.
 */
export const ENC_GATE_GENERIC_ERROR = 'The encryption key could not be verified.';

/**
 * Map an `enc_status` outcome to the initial gate transition (Requirement
 * 7.2–7.4, 7.7). Pure and deterministic.
 *
 * - `"setup"`  → setup modal, access denied, `accounts_load` NOT invoked.
 * - `"locked"` → unlock modal, access denied, `accounts_load` NOT invoked.
 * - `"unlocked"` → no modal, access granted, `accounts_load` invoked once.
 * - failed invocation → bypass: no modal, access granted, `accounts_load`
 *   invoked once.
 *
 * @param outcome - The result of invoking `enc_status`.
 * @returns The transition snapshot to commit.
 */
export function reduceEncStatus(outcome: EncStatusOutcome): EncGateTransition {
  if (!outcome.ok) {
    // Requirement 7.7: enc_status invocation failed → bypass the gate entirely.
    return { mode: 'bypassed', accessGranted: true, errorMessage: null, loadAccounts: true };
  }
  switch (outcome.mode) {
    case 'setup':
      return { mode: 'setup', accessGranted: false, errorMessage: null, loadAccounts: false };
    case 'locked':
      return { mode: 'locked', accessGranted: false, errorMessage: null, loadAccounts: false };
    case 'unlocked':
      return { mode: 'unlocked', accessGranted: true, errorMessage: null, loadAccounts: true };
    default: {
      // Exhaustiveness guard: an unrecognized mode is treated as a bypass so a
      // future/unknown backend value never leaves the user locked out.
      const _never: never = outcome.mode;
      void _never;
      return { mode: 'bypassed', accessGranted: true, errorMessage: null, loadAccounts: true };
    }
  }
}

/**
 * Map a key-submission outcome to the resulting gate transition, preserving the
 * current mode (Requirement 7.5, 7.6). Pure and deterministic.
 *
 * - success → close the modal (access granted), clear the error, invoke
 *   `accounts_load` once; the mode is preserved.
 * - failure → keep the modal open (access still denied), set the error message,
 *   do NOT invoke `accounts_load`; the mode is preserved.
 *
 * @param currentMode - The gate mode at the time of submission (`"setup"` or
 *   `"locked"`), preserved on failure per Requirement 7.5.
 * @param outcome - The result of the `enc_set_key` / `enc_unlock` call.
 * @returns The transition snapshot to commit.
 */
export function reduceSubmit(
  currentMode: EncryptionGateMode,
  outcome: EncSubmitOutcome,
): EncGateTransition {
  if (outcome.ok) {
    // Requirement 7.6: success closes the modal and grants access.
    return { mode: currentMode, accessGranted: true, errorMessage: null, loadAccounts: true };
  }
  // Requirement 7.5: failure keeps the modal open with an error, preserves the
  // mode, and must not invoke accounts_load.
  const message =
    outcome.message && outcome.message.trim().length > 0
      ? outcome.message
      : ENC_GATE_GENERIC_ERROR;
  return { mode: currentMode, accessGranted: false, errorMessage: message, loadAccounts: false };
}

/**
 * Whether the setup modal should be visible for the given snapshot: only while
 * in `"setup"` mode and access has not yet been granted (Requirement 7.2).
 */
export function isSetupModalOpen(snapshot: {
  mode: EncryptionGateMode;
  accessGranted: boolean;
}): boolean {
  return !snapshot.accessGranted && snapshot.mode === 'setup';
}

/**
 * Whether the unlock modal should be visible for the given snapshot: only while
 * in `"locked"` mode and access has not yet been granted (Requirement 7.3).
 */
export function isUnlockModalOpen(snapshot: {
  mode: EncryptionGateMode;
  accessGranted: boolean;
}): boolean {
  return !snapshot.accessGranted && snapshot.mode === 'locked';
}

/**
 * Whether a key-submission result counts as a success.
 *
 * The bridge contract declares a boolean, but the underlying `enc_unlock` /
 * `enc_set_key` commands answer with an `{ ok }` record. Testing truthiness
 * alone would accept the rejection shape `{ ok: false }` — a truthy JS object —
 * as a successful unlock, opening the gate while the backend key session stays
 * locked, which makes every later account write fail with "locked". Records are
 * therefore read through their `ok` field; anything else keeps plain truthiness.
 *
 * @param result - The value the IPC call resolved with.
 * @returns `true` only when the submission actually verified.
 */
export function isSubmitSuccess(result: unknown): boolean {
  if (typeof result === 'object' && result !== null && 'ok' in result) {
    return Boolean((result as { ok: unknown }).ok);
  }
  return Boolean(result);
}

/** Encryption_Gate store state and actions. */
export interface EncryptionGateState {
  /** Current gate mode; starts as `'checking'` before `enc_status` resolves. */
  mode: EncryptionGateMode;
  /** Whether the rest of the app is accessible. */
  accessGranted: boolean;
  /** Error message shown inside the active modal, or `null`. */
  errorMessage: string | null;
  /** Derived: whether the setup modal is currently visible (Requirement 7.2). */
  setupModalOpen: boolean;
  /** Derived: whether the unlock modal is currently visible (Requirement 7.3). */
  unlockModalOpen: boolean;
  /**
   * Startup entry point: invoke `enc_status` (before `accounts_load`,
   * Requirement 7.1) and route to the matching transition.
   */
  init: () => Promise<void>;
  /**
   * Submit a key to `enc_set_key` (the key may be empty to skip, Requirement
   * 7.2). Success grants access; failure keeps the setup modal open.
   */
  submitSetup: (key: string) => Promise<void>;
  /**
   * Submit a key to `enc_unlock` (Requirement 7.3). Success grants access;
   * failure keeps the unlock modal open.
   */
  submitUnlock: (key: string) => Promise<void>;
}

/**
 * Build the committable state slice from a pure transition, deriving the
 * modal-visibility flags so they always stay consistent with `mode` /
 * `accessGranted`.
 */
function sliceFromTransition(t: EncGateTransition): Omit<
  EncryptionGateState,
  'init' | 'submitSetup' | 'submitUnlock'
> {
  const snapshot = { mode: t.mode, accessGranted: t.accessGranted };
  return {
    mode: t.mode,
    accessGranted: t.accessGranted,
    errorMessage: t.errorMessage,
    setupModalOpen: isSetupModalOpen(snapshot),
    unlockModalOpen: isUnlockModalOpen(snapshot),
  };
}

export const useEncryptionGateStore = create<EncryptionGateState>((set, get) => {
  /**
   * Commit a transition and, when it grants access, invoke `accounts_load`
   * exactly once. The guard on the previous `accessGranted` ensures repeated or
   * concurrent access-granting transitions can never trigger a second load.
   */
  const commit = async (t: EncGateTransition): Promise<void> => {
    const alreadyGranted = get().accessGranted;
    set(sliceFromTransition(t));
    if (t.loadAccounts && !alreadyGranted) {
      try {
        await ipc.loadAccounts();
      } catch {
        // Access has already been granted; `lib/ipc.ts` surfaces the failure as
        // an error toast. Swallow here so init/submit resolve cleanly.
      }
    }
  };

  /** Shared submit path for setup/unlock: call the IPC fn, reduce, commit. */
  const runSubmit = async (
    call: (key: string) => Promise<boolean>,
    key: string,
  ): Promise<void> => {
    const currentMode = get().mode;
    let outcome: EncSubmitOutcome;
    try {
      const result = await call(key);
      outcome = isSubmitSuccess(result) ? { ok: true } : { ok: false };
    } catch (err) {
      outcome = { ok: false, message: normalizeErrorMessage(err) };
    }
    await commit(reduceSubmit(currentMode, outcome));
  };

  return {
    mode: 'checking',
    accessGranted: false,
    errorMessage: null,
    setupModalOpen: false,
    unlockModalOpen: false,

    init: async () => {
      // Requirement 7.1: enc_status is invoked before accounts_load.
      let outcome: EncStatusOutcome;
      try {
        const status = await ipc.encStatus();
        outcome = { ok: true, mode: status.mode };
      } catch {
        // Requirement 7.7: a failed enc_status invocation bypasses the gate.
        outcome = { ok: false };
      }
      await commit(reduceEncStatus(outcome));
    },

    submitSetup: (key: string) => runSubmit(ipc.encSetKey, key),

    submitUnlock: (key: string) => runSubmit(ipc.encUnlock, key),
  };
});
