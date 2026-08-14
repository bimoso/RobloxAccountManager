// stores/accountStore.ts
//
// Account_Store (Requirements 8, 11, 14, 15).
//
// Owns the in-memory list of saved accounts for the session and orchestrates
// every user-initiated mutation through the typed IPC surface (`lib/ipc.ts`),
// which already reports user-initiated failures as an error toast
// (Requirements 2.1, 2.5). The store re-throws after a failed mutation so the
// calling UI (a modal, the drag handler) can react locally — e.g. keep a modal
// open on a failed save, or revert an optimistic drag.
//
// Task 13.1 implemented the load/add/update/remove/reorder actions; task 13.2
// adds the bulk-delete confirmation orchestration (`confirmBulkDelete` /
// `executeBulkDelete` plus the pure `bulkDeleteConfirmMessage` /
// `bulkDeleteResultMessage` / `runBulkDelete` helpers). Task 13.5 adds the pure
// closed-instance event reducers (`applyClosedEvent` / `applyAllClosedEvent`,
// Property 29) and the `subscribeToCloseEvents` action that wires the
// `roblox://closed` and `roblox://all-closed` IPC_Events into `accounts` state
// (Requirements 15.4, 15.5).
//
// Reorder semantics (Requirement 11):
//   - The visual order is updated optimistically BEFORE the backend confirms
//     (Requirement 11.1): the local `accounts` list is reordered first, then
//     `accounts_reorder` is invoked with the new id order (Requirement 11.2).
//   - A drop outside a valid target position produces no order change and no
//     backend call (Requirement 11.3); the pure `reorder` helper returns the
//     original id list unchanged in that case, which the store detects by
//     reference equality.
//   - If `accounts_reorder` rejects, the previous order is restored and the
//     error is re-thrown so the drag layer can react.

import { create } from 'zustand';
import { ipc } from '../lib/ipc';
import { reorder as reorderIds } from '../lib/selection';
import { normalizeErrorMessage, useToastStore } from './toastStore';
import type { Account } from '../types/models';
import type { UnlistenFn } from '../types/window';

/**
 * Structured outcome of a bulk-delete run over a set of selected account ids
 * (Requirement 10.8). Returned by {@link AccountState.executeBulkDelete} and by
 * {@link AccountState.confirmBulkDelete} when the user confirms, so a caller (or
 * a property test — Property 22) can assert the exact counts.
 */
export interface BulkDeleteResult {
  /** Number of ids the delete was attempted for (the size of the selection). */
  total: number;
  /** Number of `accounts_remove` calls that resolved successfully. */
  succeeded: number;
  /** Number of `accounts_remove` calls that rejected. */
  failed: number;
}

/**
 * Build the confirmation-dialog message shown before a bulk delete
 * (Requirement 10.4). Pure and deterministic so it can be asserted directly by
 * Property 21: the message always embeds the exact `count` of selected accounts
 * and states that the action is irreversible.
 *
 * @param count - The number of accounts currently selected.
 * @returns The confirmation message, including the exact count and an
 *   irreversibility notice.
 */
export function bulkDeleteConfirmMessage(count: number): string {
  const noun = count === 1 ? 'cuenta seleccionada' : 'cuentas seleccionadas';
  return `Vas a eliminar ${count} ${noun}. Esta acción es irreversible y no se puede deshacer.`;
}

/**
 * Build the completion toast text summarising a bulk-delete run
 * (Requirement 10.8): how many accounts were removed successfully out of the
 * total attempted. Pure so Property 22 can assert the reported success count.
 *
 * @param succeeded - Number of accounts removed successfully.
 * @param total - Total number of accounts the delete was attempted for.
 * @returns A human-readable summary such as "Se eliminaron 3 de 5 cuentas.".
 */
export function bulkDeleteResultMessage(succeeded: number, total: number): string {
  return `Se eliminaron ${succeeded} de ${total} cuentas.`;
}

/**
 * Core, dependency-injected bulk-delete loop (Requirement 10.8, Property 22).
 *
 * Invokes `remove` once for EVERY id in `ids`, in order, and — crucially — does
 * NOT stop at the first rejection: a failed removal is counted and the loop
 * continues with the remaining ids. This keeps the orchestration pure and
 * testable in isolation (the store wires the real `ipc.removeAccount`; a
 * property test injects a mock whose success/failure pattern it controls).
 *
 * @param ids - The selected account ids to remove, in selection order.
 * @param remove - The per-id removal effect (e.g. `ipc.removeAccount`).
 * @returns The `{ result, removedIds }` pair: `result` holds the total /
 *   succeeded / failed counts, and `removedIds` lists exactly the ids whose
 *   removal resolved successfully (used to prune the local list).
 */
export async function runBulkDelete(
  ids: readonly string[],
  remove: (id: string) => Promise<unknown>,
): Promise<{ result: BulkDeleteResult; removedIds: string[] }> {
  const removedIds: string[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await remove(id);
      succeeded += 1;
      removedIds.push(id);
    } catch {
      // Continue on partial failure (Req 10.8): count it and keep going so the
      // remaining selected ids are still attempted.
      failed += 1;
    }
  }
  return { result: { total: ids.length, succeeded, failed }, removedIds };
}

/**
 * Reorders `accounts` to match the order of `ids`.
 *
 * Pure: returns a new array whose accounts appear in the same order as their
 * ids in `ids`. IDs are consumed by occurrence, not as Map keys: when legacy
 * data contains two distinct account records with the same id, the first
 * submitted occurrence selects the first record, the second selects the
 * second record, and so on. Any occurrence omitted from `ids` is preserved and
 * appended in its prior relative order. The input array is never mutated.
 *
 * @param accounts - The current accounts.
 * @param ids - The desired id order.
 * @returns A new array of accounts ordered by `ids`.
 */
export function orderAccountsByIds(accounts: Account[], ids: string[]): Account[] {
  const byId = new Map<string, Account[]>();
  for (const account of accounts) {
    const bucket = byId.get(account.id);
    if (bucket) bucket.push(account);
    else byId.set(account.id, [account]);
  }

  const consumedById = new Map<string, number>();
  const ordered: Account[] = [];
  for (const id of ids) {
    const bucket = byId.get(id);
    const consumed = consumedById.get(id) ?? 0;
    const account = bucket?.[consumed];
    if (account) {
      ordered.push(account);
      consumedById.set(id, consumed + 1);
    }
  }

  // Preserve every unconsumed occurrence in original cross-id order. Tracking
  // occurrence indices avoids the data loss caused by a Map<string, Account>,
  // which collapsed distinct legacy records sharing the same id.
  const seenById = new Map<string, number>();
  for (const account of accounts) {
    const seen = seenById.get(account.id) ?? 0;
    seenById.set(account.id, seen + 1);
    if (seen >= (consumedById.get(account.id) ?? 0)) {
      ordered.push(account);
    }
  }
  return ordered;
}

/** True when two records identify the same Roblox account. */
export function sameAccountIdentity(left: Account, right: Account): boolean {
  const leftUserId = left.userId.trim();
  const rightUserId = right.userId.trim();
  if (leftUserId && rightUserId) return leftUserId === rightUserId;

  const leftUsername = left.username.trim();
  const rightUsername = right.username.trim();
  return !!leftUsername && !!rightUsername && leftUsername.localeCompare(rightUsername, undefined, {
    sensitivity: 'accent',
  }) === 0;
}

/**
 * Reconcile the backend result of `accounts_add` into local state. The backend
 * may return an existing record when the imported cookie resolves to an account
 * already on disk, so blindly appending here would recreate the duplicate in
 * memory even though persistence correctly performed an upsert.
 */
export function reconcileAddedAccount(accounts: Account[], saved: Account): Account[] {
  const matching = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => account.id === saved.id || sameAccountIdentity(account, saved));
  if (matching.length === 0) return [...accounts, saved];

  const first = matching[0];
  const duplicateIndexes = new Set(matching.slice(1).map(({ index }) => index));
  return accounts
    .map((account, index) =>
      index === first.index
        ? { ...account, ...saved }
        : account,
    )
    .filter((_, index) => !duplicateIndexes.has(index));
}

/**
 * Apply a per-account `roblox://closed` event to an accounts list
 * (Requirement 15.4, Property 29).
 *
 * PURE and deterministic: returns a NEW array in which ONLY the account whose
 * id matches `accountId` is marked "not launched" (its `launchedInstanceCount`
 * is set to `0`); every other account is preserved by reference, unchanged. If
 * no account matches `accountId`, the same array reference is returned. The
 * input array and its account objects are never mutated.
 *
 * "Not launched" is modelled as `launchedInstanceCount === 0` — the closed
 * event clears the launched indicator outright rather than decrementing, per
 * Property 29 (`launched=false`) and Requirement 15.4 ("no lanzada").
 *
 * @param accounts - The current accounts.
 * @param accountId - The id carried by the `roblox://closed` event.
 * @returns A new accounts list with the matching account marked not launched,
 *   or the original array when no account matches.
 */
export function applyClosedEvent(
  accounts: Account[],
  accountId: string,
): Account[] {
  let changed = false;
  const next = accounts.map((account) => {
    if (account.id !== accountId) {
      return account;
    }
    changed = true;
    return { ...account, launchedInstanceCount: 0 };
  });
  // No account matched: nothing to update, keep the original reference.
  return changed ? next : accounts;
}

/**
 * Apply a `roblox://all-closed` event to an accounts list
 * (Requirement 15.5, Property 29).
 *
 * PURE and deterministic: returns a NEW array in which EVERY account is marked
 * "not launched" (`launchedInstanceCount` set to `0`). The input array and its
 * account objects are never mutated.
 *
 * @param accounts - The current accounts.
 * @returns A new accounts list with every account marked not launched.
 */
export function applyAllClosedEvent(accounts: Account[]): Account[] {
  return accounts.map((account) => ({ ...account, launchedInstanceCount: 0 }));
}

/** Public shape of the Account_Store. */
export interface AccountState {
  /** The accounts held in memory for the session, in display order. */
  accounts: Account[];
  /** True while the initial {@link AccountState.load} is in flight. */
  loading: boolean;
  /** Message of the most recent {@link AccountState.load} failure, or `null`. */
  error: string | null;

  /**
   * Load the account list from the backend (`accounts_load`) and replace the
   * in-memory list (Requirement 2.1). Sets {@link AccountState.loading} while
   * in flight and records a {@link AccountState.error} message on failure. Does
   * not re-throw: a failed initial load is surfaced via the error toast (from
   * `lib/ipc.ts`) and the recorded `error`, leaving the last known list intact.
   */
  load: () => Promise<void>;

  /**
   * Add an account via `accounts_add` and append the created account (as
   * returned by the backend) to the local list. Re-throws on failure so the
   * add flow (e.g. an add modal) can react.
   *
   * @param account - The account to add.
   */
  add: (account: Account) => Promise<void>;

  /**
   * Update the changed fields of an account via `accounts_update` and update
   * the local list with the backend's returned account, preserving any
   * client-derived state (launched count, expired flag) already held locally
   * (Requirement 14.2). Re-throws on failure so the edit modal can react.
   *
   * @param id - The id of the account to update.
   * @param changedFields - Only the fields that changed.
   */
  update: (id: string, changedFields: Partial<Account>) => Promise<void>;

  /**
   * Remove an account via `accounts_remove` and drop it from the local list.
   * Re-throws on failure so the caller can react.
   *
   * @param id - The id of the account to remove.
   */
  remove: (id: string) => Promise<void>;

  /**
   * Move the account at index `from` to index `to`, updating the visual order
   * optimistically before confirming with the backend (Requirements 11.1,
   * 11.2). A drop outside a valid target position (an out-of-range or no-op
   * index) changes nothing and makes no backend call (Requirement 11.3).
   * Delegates the optimistic-apply-and-persist to
   * {@link AccountState.applyReorderedIds}.
   *
   * @param from - The index of the account being moved.
   * @param to - The destination index.
   */
  reorder: (from: number, to: number) => Promise<void>;

  /**
   * Apply an explicit id order (e.g. produced by a drag-and-drop drop handler):
   * reorder the local `accounts` optimistically to match `ids`
   * (Requirement 11.1), then persist the new order via `accounts_reorder`
   * (Requirement 11.2). If the backend call rejects, the previous order is
   * restored and the error is re-thrown (Requirement 11.3 revert behaviour).
   *
   * @param ids - The account ids in their new order.
   */
  applyReorderedIds: (ids: string[]) => Promise<void>;

  /**
   * Orchestrate a bulk delete over the selected `ids` behind a confirmation
   * gate (Requirements 10.4, 10.7, 10.8; Properties 21 & 22).
   *
   * The `confirm` callback is invoked with the confirmation message produced by
   * {@link bulkDeleteConfirmMessage} (which embeds the exact selection count and
   * the irreversibility notice — Req 10.4). `accounts_remove` is invoked for the
   * selected ids IF AND ONLY IF `confirm` resolves truthy (Req 10.7, Property
   * 21). On cancellation nothing is removed and `null` is returned; the caller
   * keeps its existing selection intact (Req 10.7). On confirmation the delete
   * is delegated to {@link AccountState.executeBulkDelete} and its
   * {@link BulkDeleteResult} is returned.
   *
   * @param ids - The selected account ids to delete.
   * @param confirm - Confirmation gate; receives the message to display and
   *   returns (or resolves to) `true` to proceed, `false`/falsy to cancel.
   * @returns The delete result when confirmed, or `null` when cancelled.
   */
  confirmBulkDelete: (
    ids: readonly string[],
    confirm: (message: string) => boolean | Promise<boolean>,
  ) => Promise<BulkDeleteResult | null>;

  /**
   * Execute a bulk delete over `ids` WITHOUT prompting (the confirmation is the
   * caller's/`confirmBulkDelete`'s responsibility). Invokes `accounts_remove`
   * for every id, continuing past individual failures (Req 10.8, Property 22),
   * drops the successfully-removed ids from the local list, and shows a single
   * completion toast reporting successes-over-total (Req 10.8).
   *
   * @param ids - The account ids to remove.
   * @returns The `{ total, succeeded, failed }` result of the run.
   */
  executeBulkDelete: (ids: readonly string[]) => Promise<BulkDeleteResult>;

  /**
   * Subscribe to the Roblox instance-close IPC_Events and keep the local
   * launched indicators in sync (Requirements 15.4, 15.5).
   *
   * Registers two subscriptions via the typed IPC surface:
   *   - `roblox://closed` (per account): applies {@link applyClosedEvent} so the
   *     closed account's launched indicator is cleared (Req 15.4).
   *   - `roblox://all-closed`: applies {@link applyAllClosedEvent} so every
   *     account is marked not launched (Req 15.5).
   *
   * The reducers are pure; this action wires their result back into the store's
   * `accounts` state. Resolves to a single cleanup function that tears down BOTH
   * subscriptions; the App wiring (task 29.6) calls it on unmount.
   *
   * @returns A promise resolving to an {@link UnlistenFn} that unsubscribes from
   *   both close events.
   */
  subscribeToCloseEvents: () => Promise<UnlistenFn>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await ipc.loadAccounts();
      set({ accounts, loading: false });
    } catch (err) {
      // `lib/ipc.ts` already surfaced the failure as an error toast; record the
      // message for any inline error UI and keep the last known list.
      set({ loading: false, error: normalizeErrorMessage(err) });
    }
  },

  add: async (account) => {
    const created = await ipc.addAccount(account);
    set((state) => ({ accounts: reconcileAddedAccount(state.accounts, created) }));
  },

  update: async (id, changedFields) => {
    const updated = await ipc.updateAccount(id, changedFields);
    set((state) => ({
      accounts: state.accounts.map((account) =>
        // Merge so backend-authoritative fields win while client-derived state
        // (launchedInstanceCount, cookieExpired) held locally is preserved.
        account.id === id ? { ...account, ...updated } : account,
      ),
    }));
  },

  remove: async (id) => {
    await ipc.removeAccount(id);
    set((state) => ({
      accounts: state.accounts.filter((account) => account.id !== id),
    }));
  },

  reorder: async (from, to) => {
    const currentIds = get().accounts.map((account) => account.id);
    const newIds = reorderIds(currentIds, from, to);
    // The pure helper returns the SAME reference when the move is a no-op or the
    // target position is invalid: nothing to persist (Requirement 11.3).
    if (newIds === currentIds) {
      return;
    }
    await get().applyReorderedIds(newIds);
  },

  applyReorderedIds: async (ids) => {
    const previous = get().accounts;
    // Optimistic visual reorder BEFORE confirming with the backend (Req 11.1).
    set({ accounts: orderAccountsByIds(previous, ids) });
    try {
      await ipc.reorderAccounts(ids);
    } catch (err) {
      // Persisting the new order failed: restore the previous order and let the
      // drag layer react (the error toast was already shown by `lib/ipc.ts`).
      set({ accounts: previous });
      throw err;
    }
  },

  confirmBulkDelete: async (ids, confirm) => {
    // The confirmation gate: `accounts_remove` runs IF AND ONLY IF the user
    // confirms (Property 21). The message always embeds the exact count and the
    // irreversibility notice (Req 10.4).
    const confirmed = await confirm(bulkDeleteConfirmMessage(ids.length));
    if (!confirmed) {
      // Cancelled: no removal calls; the caller preserves its selection
      // (Req 10.7). Signal the no-op with `null`.
      return null;
    }
    return get().executeBulkDelete(ids);
  },

  executeBulkDelete: async (ids) => {
    // Attempt every id, continuing past failures (Req 10.8, Property 22). The
    // pure loop is injected the real IPC removal effect here.
    const { result, removedIds } = await runBulkDelete(ids, (id) =>
      ipc.removeAccount(id),
    );

    // Drop the successfully-removed accounts from the local list.
    if (removedIds.length > 0) {
      const removed = new Set(removedIds);
      set((state) => ({
        accounts: state.accounts.filter((account) => !removed.has(account.id)),
      }));
    }

    // Single completion toast reporting successes over the total (Req 10.8). A
    // clean run is a success toast; a partially-failed run is an error toast so
    // the shortfall is visible.
    const message = bulkDeleteResultMessage(result.succeeded, result.total);
    const toast = useToastStore.getState();
    if (result.failed === 0) {
      toast.showSuccess(message);
    } else {
      toast.showError(message);
    }

    return result;
  },

  subscribeToCloseEvents: async () => {
    // Per-account close: clear that account's launched indicator (Req 15.4).
    const unlistenClosed = await ipc.onRobloxClosed((accountId) => {
      set((state) => ({
        accounts: applyClosedEvent(state.accounts, accountId),
      }));
    });
    // All-closed: mark every account not launched (Req 15.5).
    const unlistenAllClosed = await ipc.onAllRobloxClosed(() => {
      set((state) => ({
        accounts: applyAllClosedEvent(state.accounts),
      }));
    });
    // Single cleanup that tears down both subscriptions (App wiring 29.6).
    return () => {
      unlistenClosed();
      unlistenAllClosed();
    };
  },
}));
