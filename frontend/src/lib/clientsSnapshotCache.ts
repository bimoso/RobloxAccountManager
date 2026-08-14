// lib/clientsSnapshotCache.ts
//
// Shared session cache over `ipc.getRobloxClientsSnapshot()`.
//
// The backend sweep behind that command walks the registry and the disk and
// costs hundreds of milliseconds, and it now has three consumers instead of
// one: the Clients deck, the WEAO executor hub and the idle warm-up. The cache
// used to be a private module constant inside `pages/Settings/ClientsTab`, but
// `pages/Weao` may not import it — the cross-page import rule forbids reaching
// into a sibling page — so it moves here, to the shared layer every page may
// use.

import { ipc } from './ipc';
import { createSessionCache } from './sessionCache';
import type { RobloxClientsSnapshot } from '../types/models';

/** Default staleness window: a sweep is reused for five minutes. */
export const CLIENTS_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The last sweep.
 *
 * Built with `createSessionCache` and **not** a bare module-level `Map` or
 * variable: only caches created there register with the module registry that
 * `resetSessionCaches()` wipes, which `test/setup.ts` calls after every test. A
 * hand-rolled container would survive across test files, and `Weao.test.tsx`
 * would then hydrate from whatever `ClientsTab.test.tsx` happened to leave
 * behind (or vice versa) — a contamination that only shows up as an
 * order-dependent failure.
 */
const snapshotCache = createSessionCache<RobloxClientsSnapshot>();

/**
 * The sweep currently in flight, so consumers mounting in the same tick share
 * one backend call instead of each paying for its own registry walk.
 *
 * Held in a session cache for the same reset reason as the snapshot itself: a
 * promise left pending by one test must never be handed to the next.
 */
const inFlight = createSessionCache<Promise<RobloxClientsSnapshot>>();

/** Options for {@link loadClientsSnapshot}. */
export interface LoadClientsSnapshotOptions {
  /**
   * Reuse a cached sweep up to this age, in milliseconds. Defaults to
   * {@link CLIENTS_SNAPSHOT_MAX_AGE_MS}. Pass `0` to accept only a sweep taken
   * in this very millisecond, i.e. to always revalidate.
   */
  maxAgeMs?: number;
  /**
   * Ignore both the cached value and any in-flight sweep and go to the backend
   * now. For the explicit Refresh action and for reloading after a mutation
   * (a preset added, a deployment installed) invalidated the previous result.
   */
  force?: boolean;
}

/**
 * The last sweep, fresh or stale, without triggering one.
 *
 * Intended for the synchronous hydration path — a page seeds its initial state
 * from this for an instant paint, then calls {@link loadClientsSnapshot} to
 * revalidate in the background.
 *
 * @returns The cached snapshot, or `undefined` when none has been taken yet.
 */
export function peekClientsSnapshot(): RobloxClientsSnapshot | undefined {
  return snapshotCache.get();
}

/**
 * Read the Roblox clients snapshot, reusing a recent sweep when possible.
 *
 * @param options - Freshness window and force flag; see
 *   {@link LoadClientsSnapshotOptions}.
 * @returns The snapshot. Rejects only when the backend call itself fails.
 */
export async function loadClientsSnapshot(
  options: LoadClientsSnapshotOptions = {},
): Promise<RobloxClientsSnapshot> {
  const { maxAgeMs = CLIENTS_SNAPSHOT_MAX_AGE_MS, force = false } = options;

  if (!force) {
    const cached = snapshotCache.get();
    if (cached !== undefined && snapshotCache.isFresh(maxAgeMs)) return cached;
    const pending = inFlight.get();
    if (pending !== undefined) return pending;
  }

  const request = ipc.getRobloxClientsSnapshot().then((snapshot) => {
    snapshotCache.set(snapshot);
    return snapshot;
  });
  inFlight.set(request);

  // A forced refresh may start while an earlier sweep is still running; clear
  // the slot only when it still holds *this* request, so the older one settling
  // last cannot evict the newer one.
  const release = (): void => {
    if (inFlight.get() === request) inFlight.clear();
  };
  void request.then(release, release);

  return request;
}
