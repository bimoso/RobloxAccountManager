// stores/presenceStore.ts
//
// Presence_Store (Requirement 26).
//
// Owns the in-memory, keyed-by-userId map of the last known real-time presence
// of each account (Offline / Online / InGame / InStudio). It is fed on a timer
// by the `usePresencePolling` hook, which calls the background-polling
// `roblox_get_presence` IPC_Command and dispatches the result through this
// store's `applyUpdates` action (Requirement 26.1). Because the presence map is
// held in a zustand store, any account card subscribed to it re-renders when
// its presence changes, with no manual page reload (Requirement 26.2).
//
// The merge logic itself lives in the PURE reducer `applyPresenceUpdate` below
// (plus the pure mapping helper `toPresenceInfo`). Keeping it pure and
// side-effect free is what lets Property 43 exercise it directly
// (property-tested in task 14.2): the reducer must update the presence of ONLY
// the userIds present in the update payload and leave every other entry
// unchanged.

import { create } from 'zustand';
import type { PresenceInfo, PresenceType } from '../types/models';
import type { RobloxUserPresence } from '../types/window';

/** A single presence update accepted by {@link applyPresenceUpdate}. */
export type PresenceUpdate = PresenceInfo | RobloxUserPresence;

/**
 * Narrow a raw number to the closed {@link PresenceType} set (0/1/2/3),
 * defaulting to `0` (Offline) for any out-of-range or non-integer value. The
 * backend always sends 0–3, but this keeps the mapping total and pure.
 */
function toPresenceType(value: number): PresenceType {
  return value === 1 || value === 2 || value === 3 ? value : 0;
}

/** Type guard: does this update carry the raw `roblox_get_presence` shape? */
function isRobloxUserPresence(
  update: PresenceUpdate,
): update is RobloxUserPresence {
  return typeof (update as RobloxUserPresence).userPresenceType === 'number';
}

/**
 * Map one raw {@link RobloxUserPresence} entry (as returned by
 * `roblox_get_presence`) to the client-side {@link PresenceInfo} view.
 *
 * Pure: derives a fresh `PresenceInfo` without mutating its input.
 * - `userId` / `placeId` are stringified (the backend sends numbers; the store
 *   keys and the `Account` model both use string ids).
 * - `placeId` is omitted when the raw value is `null` (not in a place).
 * - `lastLocation` is omitted when it is empty (nothing to show).
 *
 * @param presence - One entry of the `roblox_get_presence` response.
 * @returns The corresponding client-side presence view.
 */
export function toPresenceInfo(presence: RobloxUserPresence): PresenceInfo {
  const info: PresenceInfo = {
    userId: String(presence.userId),
    type: toPresenceType(presence.userPresenceType),
  };
  if (presence.placeId !== null && presence.placeId !== undefined) {
    info.placeId = String(presence.placeId);
  }
  if (typeof presence.lastLocation === 'string' && presence.lastLocation.length > 0) {
    info.lastLocation = presence.lastLocation;
  }
  return info;
}

/**
 * Normalize any accepted {@link PresenceUpdate} to a {@link PresenceInfo}.
 *
 * Raw `roblox_get_presence` entries are mapped via {@link toPresenceInfo};
 * entries that are already `PresenceInfo` are returned as-is (they are treated
 * as immutable and never mutated by the reducer).
 */
function normalizeUpdate(update: PresenceUpdate): PresenceInfo {
  return isRobloxUserPresence(update) ? toPresenceInfo(update) : update;
}

/**
 * PURE reducer merging a batch of presence updates into the current map.
 *
 * Returns a NEW map keyed by `userId` in which every entry whose `userId`
 * appears in `updates` is overwritten with the (normalized) updated presence,
 * and every other entry from `current` is preserved unchanged. The `current`
 * map and the `updates` array are never mutated (Property 43).
 *
 * When `updates` is empty the `current` reference is returned unchanged, so a
 * background poll that yields no presences causes no state churn.
 *
 * Both the raw `RobloxUserPresence` shape (straight from `roblox_get_presence`)
 * and the already-mapped `PresenceInfo` shape are accepted; raw entries are
 * mapped via {@link toPresenceInfo}. When two updates target the same `userId`,
 * the later one in `updates` wins.
 *
 * @param current - The current presence map, keyed by `userId`.
 * @param updates - The batch of presence updates to merge.
 * @returns A new merged map, or `current` unchanged when `updates` is empty.
 */
export function applyPresenceUpdate(
  current: Record<string, PresenceInfo>,
  updates: PresenceUpdate[],
): Record<string, PresenceInfo> {
  if (updates.length === 0) {
    return current;
  }
  const next: Record<string, PresenceInfo> = { ...current };
  for (const update of updates) {
    const info = normalizeUpdate(update);
    next[info.userId] = info;
  }
  return next;
}

/** Public shape of the Presence_Store. */
export interface PresenceState {
  /** The last known presence of each account, keyed by `userId`. */
  byUserId: Record<string, PresenceInfo>;

  /**
   * Merge a batch of presence updates into the map via the pure
   * {@link applyPresenceUpdate} reducer (Requirement 26.1). Accepts either the
   * raw `roblox_get_presence` entries or already-mapped `PresenceInfo`.
   *
   * @param updates - The batch of presence updates to apply.
   */
  applyUpdates: (updates: PresenceUpdate[]) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  byUserId: {},

  applyUpdates: (updates) => {
    set((state) => {
      const byUserId = applyPresenceUpdate(state.byUserId, updates);
      // `applyPresenceUpdate` returns the same reference for an empty batch;
      // avoid a redundant state write in that case.
      return byUserId === state.byUserId ? state : { byUserId };
    });
  },
}));

/**
 * Selector reading a single account's presence from the store.
 *
 * Intended for use with `usePresenceStore(selectPresence(userId))` so a card
 * subscribes only to its own account's presence and re-renders when it changes
 * (Requirement 26.2).
 *
 * @param userId - The account's `userId`.
 * @returns A selector returning that account's `PresenceInfo`, or `undefined`
 *   when no presence has been observed yet.
 */
export function selectPresence(
  userId: string,
): (state: PresenceState) => PresenceInfo | undefined {
  return (state) => state.byUserId[userId];
}
