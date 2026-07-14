// pages/Accounts/friendRequest.ts
//
// Pure, dependency-injected orchestration for the batch "Enviar solicitud de
// amistad" flow (Requirement 16.1). Kept free of React and of `window.api` so
// it can be tested in isolation by injecting a `send` effect whose
// success/failure pattern the test controls.
//
// The `FriendRequestModal` component wires the real effect here:
//   - `send` → `ipc.sendFriendRequest(cookie, targetUserId)`
//
// Nothing in this module touches the DOM, timers, or IPC directly. It sends a
// friend request to a single target user id FROM each selected account and
// reports the individual result of every send (Requirement 16.1), so one
// account's failure never stops the rest.

/**
 * A single account a friend request is sent *from* in a batch run.
 *
 * Carries the account `id` (stable identity), a human-readable `label`
 * (nickname or username, for reporting which account a result belongs to) and
 * the `cookie` the send is authenticated with.
 */
export interface FriendRequestSender {
  /** Stable account id. */
  id: string;
  /** Human-readable label (nickname or username) identifying the account. */
  label: string;
  /** The cookie the friend request is sent with. */
  cookie: string;
}

/**
 * The result of sending a friend request from a single account (Requirement
 * 16.1). Identifies WHICH account it belongs to (`id` / `label`) and whether
 * the send succeeded, with a backend/thrown reason when it failed.
 */
export interface FriendRequestResult {
  /** Stable id of the account the request was sent from. */
  id: string;
  /** Human-readable label of that account. */
  label: string;
  /** Whether the send succeeded. */
  ok: boolean;
  /** Failure reason when `ok` is `false`. */
  reason?: string;
}

/**
 * Summary of a completed batch friend-request run (Requirement 16.1).
 *
 * `succeeded` equals the number of accounts whose send was accepted by Roblox,
 * and `results` holds one entry per account, in input order, reporting its
 * individual outcome.
 */
export interface FriendRequestSummary {
  /** Total number of accounts processed. */
  total: number;
  /** Number of accounts whose friend request was sent successfully. */
  succeeded: number;
  /** One result per account, in input order. */
  results: FriendRequestResult[];
}

/**
 * Progress event emitted before each per-account send so the UI can show which
 * account is currently being processed.
 */
export interface FriendRequestProgressEvent {
  /** Zero-based index of the account currently being processed. */
  index: number;
  /** Total number of accounts in the run. */
  total: number;
  /** The account currently being processed. */
  account: FriendRequestSender;
}

/**
 * Effects injected into {@link processBatchFriendRequests}. The modal wires the
 * real IPC effect; a test injects a controlled mock.
 */
export interface ProcessFriendRequestDeps {
  /**
   * Send a friend request to `targetUserId` authenticated with `cookie`.
   * Invoked exactly once per account, awaited before the next account is
   * touched (sequential, no overlap).
   */
  send: (cookie: string, targetUserId: string) => Promise<unknown> | unknown;
  /** Optional progress callback, invoked before each per-account send. */
  onProgress?: (event: FriendRequestProgressEvent) => void;
}

/**
 * Extract a human-readable message from a thrown value, falling back to a
 * generic default so a rejected `send` still produces a reason.
 */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  return 'No se pudo enviar la solicitud de amistad.';
}

/**
 * Interpret the resolved object returned by the Rust friend-request command.
 *
 * The Tauri command deliberately resolves transport-successful requests as
 * `{ ok: false, error }` when Roblox rejects the operation. Treating every
 * resolved promise as success would therefore report rejected requests as
 * sent. Older/injected senders that resolve without an `ok` field retain the
 * previous success contract.
 */
function resolvedFailureReason(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return null;
  }

  const response = value as { ok?: unknown; error?: unknown };
  if (response.ok !== false) return null;

  if (typeof response.error === 'string' && response.error.trim()) {
    return response.error.trim();
  }
  return 'Roblox rechazó la solicitud de amistad.';
}

/**
 * Send a friend request to a single `targetUserId` FROM each account,
 * SEQUENTIALLY (Requirement 16.1).
 *
 * For every account in `accounts`, in input order:
 *   1. Emits a progress event, then invokes `send(cookie, targetUserId)` exactly
 *      once and awaits it before touching the next account (no overlap).
 *   2. Records a {@link FriendRequestResult} for that account — `ok: true` on a
 *      accepted send, otherwise `ok: false` with the reason — and CONTINUES with
 *      the rest, so one account's failure never stops another.
 *
 * On completion `succeeded` equals the number of accounts whose send was
 * accepted, and `results` reports every account's individual outcome.
 *
 * @param targetUserId - The user id the friend request is sent to.
 * @param accounts - The accounts to send from, in order.
 * @param deps - The injected `send` / `onProgress` effects.
 * @returns A {@link FriendRequestSummary} of the run.
 */
export async function processBatchFriendRequests(
  targetUserId: string,
  accounts: readonly FriendRequestSender[],
  deps: ProcessFriendRequestDeps,
): Promise<FriendRequestSummary> {
  const { send, onProgress } = deps;
  const total = accounts.length;
  const results: FriendRequestResult[] = [];
  let succeeded = 0;

  for (let index = 0; index < total; index += 1) {
    const account = accounts[index];
    onProgress?.({ index, total, account });
    try {
      const response = await send(account.cookie, targetUserId);
      const resolvedFailure = resolvedFailureReason(response);
      if (resolvedFailure) {
        results.push({
          id: account.id,
          label: account.label,
          ok: false,
          reason: resolvedFailure,
        });
        continue;
      }
      results.push({ id: account.id, label: account.label, ok: true });
      succeeded += 1;
    } catch (err) {
      results.push({
        id: account.id,
        label: account.label,
        ok: false,
        reason: describeError(err),
      });
    }
  }

  return { total, succeeded, results };
}

/**
 * Normalize a raw user-id input into the digits-only form the friend-request
 * endpoint expects.
 *
 * Accepts either a positive, digits-only id or an official Roblox profile URL
 * (`https://www.roblox.com/users/123/profile`). Arbitrary strings containing
 * digits, non-Roblox hosts and other Roblox URL shapes are rejected instead of
 * silently targeting the wrong account. Pure so the modal and tests share the
 * exact same parsing.
 *
 * @param raw - The raw target-user input.
 * @returns The validated numeric id, or `''` when the input is not supported.
 */
export function parseTargetUserId(raw: string): string {
  const candidate = raw.trim();
  if (/^[1-9]\d*$/.test(candidate)) return candidate;

  const withProtocol = /^https?:\/\//i.test(candidate)
    ? candidate
    : /^(?:www\.)?roblox\.com\//i.test(candidate)
      ? `https://${candidate}`
      : '';
  if (!withProtocol) return '';

  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'roblox.com' && hostname !== 'www.roblox.com') return '';

    return url.pathname.match(/^\/users\/([1-9]\d*)\/profile\/?$/i)?.[1] ?? '';
  } catch {
    return '';
  }
}
