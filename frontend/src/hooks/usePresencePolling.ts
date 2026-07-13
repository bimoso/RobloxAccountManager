// hooks/usePresencePolling.ts
//
// Real-time presence polling (Requirement 26).
//
// While mounted, this hook periodically asks the backend for the presence of
// the given accounts via the background-polling `roblox_get_presence`
// IPC_Command and feeds the result into the Presence_Store, whose subscribers
// (the account cards) then re-render with the fresh state — no manual page
// reload (Requirements 26.1, 26.2).
//
// `roblox_get_presence` is marked `userInitiated = false` in `lib/ipc.ts`, so a
// failed tick does NOT flash an error toast. This hook additionally catches the
// rejection so a transient failure never crashes the UI: the store keeps its
// last known presence and the next tick retries (see the Error Handling table
// in design.md — a background-polling command that rejects keeps the last known
// state and retries on the next cycle).

import { useEffect } from 'react';
import { ipc } from '../lib/ipc';
import { toPresenceInfo, usePresenceStore } from '../stores/presenceStore';

/** Default polling interval, in milliseconds. */
export const DEFAULT_PRESENCE_INTERVAL_MS = 30_000;

/**
 * Poll `roblox_get_presence` on an interval and push the result into the
 * Presence_Store while this hook is mounted.
 *
 * Behaviour:
 * - Polls only when `userIds` is non-empty (nothing to ask about otherwise).
 * - Performs an immediate first fetch, then repeats every `intervalMs`.
 * - Maps each `RobloxUserPresence` to the client `PresenceInfo` and dispatches
 *   the batch through the store's pure reducer.
 * - Catches any rejection so a failed tick never crashes the UI; the store
 *   keeps its last known state and the next tick retries.
 * - Clears the interval and ignores any in-flight response on unmount (or when
 *   the inputs change).
 *
 * @param userIds - The account userIds to poll presence for.
 * @param cookie - The authenticated cookie used for the request.
 * @param intervalMs - Polling interval in ms (defaults to
 *   {@link DEFAULT_PRESENCE_INTERVAL_MS}).
 */
export function usePresencePolling(
  userIds: Array<string | number>,
  cookie: string,
  intervalMs: number = DEFAULT_PRESENCE_INTERVAL_MS,
): void {
  const applyUpdates = usePresenceStore((state) => state.applyUpdates);
  // Re-run only when the actual set of ids (not the array identity) changes, so
  // a caller passing a fresh array of the same ids on every render does not
  // restart the interval.
  const idsKey = userIds.join(',');

  useEffect(() => {
    if (userIds.length === 0) {
      return;
    }

    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const response = await ipc.getPresence(userIds, cookie);
        if (cancelled) {
          return;
        }
        applyUpdates(response.userPresences.map(toPresenceInfo));
      } catch {
        // Background poll: `lib/ipc.ts` stays silent (no toast) and we swallow
        // the error here so a transient failure never crashes the UI. The store
        // keeps its last known presence and the next tick retries.
      }
    };

    // Immediate first fetch, then on the interval.
    void tick();
    const handle = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // `idsKey` captures the meaningful change in `userIds`; it is intentionally
    // used in place of the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, cookie, intervalMs, applyUpdates]);
}
