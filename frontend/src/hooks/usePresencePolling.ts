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
//
// Polling is also gated on document visibility: a minimised or backgrounded
// window has no presence dots to update, so its ticks are skipped and a single
// catch-up tick runs when the window is shown again.

import { useEffect, useRef } from 'react';
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
 * - Skips any tick fired while the document is hidden, and catches up with one
 *   immediate tick when it becomes visible again.
 * - Maps each `RobloxUserPresence` to the client `PresenceInfo` and dispatches
 *   the batch through the store's pure reducer.
 * - Catches any rejection so a failed tick never crashes the UI; the store
 *   keeps its last known state and the next tick retries.
 * - Clears the interval, drops the visibility listener and ignores any in-flight
 *   response on unmount (or when the inputs change).
 *
 * @param userIds - The account userIds to poll presence for.
 * @param cookies - Candidate authenticated cookies; the poller starts on the
 *   first entry and rotates to the next one whenever a tick fails (a burnt
 *   cookie must not poison every subsequent poll). With a single entry the
 *   behaviour is identical to a fixed cookie.
 * @param intervalMs - Polling interval in ms (defaults to
 *   {@link DEFAULT_PRESENCE_INTERVAL_MS}).
 */
export function usePresencePolling(
  userIds: Array<string | number>,
  cookies: string[],
  intervalMs: number = DEFAULT_PRESENCE_INTERVAL_MS,
): void {
  const applyUpdates = usePresenceStore((state) => state.applyUpdates);
  // Re-run only when the actual set of ids / cookies (not array identity)
  // changes, so a caller passing fresh arrays of the same values on every
  // render does not restart the interval.
  const idsKey = userIds.join(',');
  const cookiesKey = cookies.join(',');

  // Index into `cookies` of the candidate used by the NEXT tick; advanced on
  // each failed tick so the rotation survives re-renders without restarting
  // the interval.
  const candidateRef = useRef(0);

  useEffect(() => {
    if (userIds.length === 0 || cookies.length === 0) {
      return;
    }

    let cancelled = false;

    const tick = async (): Promise<void> => {
      // Nobody can read a presence dot on a hidden window, so the request is
      // skipped rather than spent: a session left minimised for an hour used to
      // cost 120 round trips for a UI that was never on screen.
      if (document.hidden) {
        return;
      }
      try {
        const cookie = cookies[candidateRef.current % cookies.length];
        const response = await ipc.getPresence(userIds, cookie);
        if (cancelled) {
          return;
        }
        applyUpdates(response.userPresences.map(toPresenceInfo));
      } catch {
        // Background poll: `lib/ipc.ts` stays silent (no toast). Rotate to the
        // next candidate cookie — modulo keeps a single-cookie setup pinned to
        // its only entry — and let the next tick retry with it.
        candidateRef.current = (candidateRef.current + 1) % cookies.length;
      }
    };

    // Immediate first fetch, then on the interval.
    void tick();
    // The interval keeps running through a hidden window instead of being torn
    // down and rebuilt around visibility: stopping it would restart the cadence
    // on every alt-tab, so a user flicking between windows would poll far more
    // often than every `intervalMs`, not less. A skipped tick costs nothing.
    const handle = setInterval(() => {
      void tick();
    }, intervalMs);

    // Coming back to a visible window must not wait out the rest of the current
    // interval — the presence on screen is whatever was true before hiding.
    const onVisibilityChange = (): void => {
      if (!document.hidden) {
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // `idsKey` captures the meaningful change in `userIds`; it is intentionally
    // used in place of the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, cookiesKey, intervalMs, applyUpdates]);
}
