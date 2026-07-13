import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyPresenceUpdate,
  toPresenceInfo,
  type PresenceUpdate,
} from './presenceStore';
import type { PresenceInfo, PresenceType } from '../types/models';
import type { RobloxUserPresence } from '../types/window';

/**
 * Property-based test for the pure presence-update reducer (task 14.2).
 *
 * Feature: react-frontend-migration, Property 43: Reducer de actualización de
 * presencia — For any current presence map (keyed by userId) and any batch of
 * presence updates, `applyPresenceUpdate` returns a new map in which every
 * userId present in the batch maps to the (normalized) updated presence, every
 * userId NOT in the batch keeps its previous value unchanged, the resulting key
 * set is exactly the union of the previous keys and the batch userIds, the
 * input map is never mutated, an empty batch returns the current map reference
 * unchanged, and when a batch targets the same userId more than once the later
 * update wins.
 *
 * Validates: Requirements 26.2
 */

// ── Independent oracle: normalize one update exactly as the store does, but
// written here so the property genuinely checks the reducer rather than the
// reducer checking itself. A raw `roblox_get_presence` entry is mapped via the
// exported `toPresenceInfo`; an already-`PresenceInfo` update is used as-is.
function normalize(update: PresenceUpdate): PresenceInfo {
  return typeof (update as RobloxUserPresence).userPresenceType === 'number'
    ? toPresenceInfo(update as RobloxUserPresence)
    : (update as PresenceInfo);
}

// ── Generators ──

// Small id pool so `current` keys, batch userIds, and intra-batch duplicates
// collide frequently — the interesting overlap cases the property must cover.
const userIdArb = fc.integer({ min: 1, max: 8 }).map(String);
const presenceTypeArb = fc.constantFrom<PresenceType>(0, 1, 2, 3);

/** An already-mapped `PresenceInfo` update (used by the reducer as-is). */
const presenceInfoArb: fc.Arbitrary<PresenceInfo> = fc
  .record({
    userId: userIdArb,
    type: presenceTypeArb,
    placeId: fc.option(fc.integer({ min: 1, max: 999_999 }).map(String), {
      nil: undefined,
    }),
    lastLocation: fc.option(fc.string(), { nil: undefined }),
  })
  .map(({ userId, type, placeId, lastLocation }) => {
    const info: PresenceInfo = { userId, type };
    if (placeId !== undefined) info.placeId = placeId;
    if (lastLocation !== undefined) info.lastLocation = lastLocation;
    return info;
  });

/** A raw `roblox_get_presence` entry (normalized via `toPresenceInfo`). */
const robloxUserPresenceArb: fc.Arbitrary<RobloxUserPresence> = fc.record({
  // Include out-of-range values so `toPresenceType`'s clamping is exercised.
  userPresenceType: fc.integer({ min: -2, max: 6 }),
  placeId: fc.option(fc.integer({ min: 1, max: 999_999 }), { nil: null }),
  rootPlaceId: fc.constant(null),
  gameId: fc.constant(null),
  universeId: fc.constant(null),
  lastLocation: fc.string(),
  userId: fc.integer({ min: 1, max: 8 }),
});

/** Either update shape is accepted by the reducer. */
const presenceUpdateArb: fc.Arbitrary<PresenceUpdate> = fc.oneof(
  presenceInfoArb,
  robloxUserPresenceArb,
);

/** A current presence map, keyed by userId (values' userId match their key). */
const currentMapArb: fc.Arbitrary<Record<string, PresenceInfo>> = fc
  .array(presenceInfoArb, { maxLength: 8 })
  .map((entries) => {
    const map: Record<string, PresenceInfo> = {};
    for (const info of entries) map[info.userId] = info;
    return map;
  });

const updatesArb = fc.array(presenceUpdateArb, { maxLength: 12 });

describe('applyPresenceUpdate reducer (Property 43)', () => {
  // Feature: react-frontend-migration, Property 43: Reducer de actualización de presencia
  it('updates only the batch userIds (later wins), preserves the rest, unions the keys, and never mutates the input', () => {
    fc.assert(
      fc.property(currentMapArb, updatesArb, (current, updates) => {
        // Snapshot the input to prove it is not mutated by the reducer.
        const beforeKeys = Object.keys(current);
        const beforeRefs: Record<string, PresenceInfo> = { ...current };

        const result = applyPresenceUpdate(current, updates);

        // Oracle: the last normalized update wins for each targeted userId.
        const lastByUserId = new Map<string, PresenceInfo>();
        for (const update of updates) {
          const info = normalize(update);
          lastByUserId.set(info.userId, info);
        }

        // 1) Result keys are exactly the union of prior keys and batch userIds.
        expect(new Set(Object.keys(result))).toEqual(
          new Set([...beforeKeys, ...lastByUserId.keys()]),
        );

        // 2) Every updated userId maps to the (normalized) later-wins value.
        for (const [userId, expected] of lastByUserId) {
          expect(result[userId]).toEqual(expected);
        }

        // 3) Every userId NOT in the batch keeps its previous value unchanged
        //    (same reference — the reducer only shallow-copies the map).
        for (const userId of beforeKeys) {
          if (!lastByUserId.has(userId)) {
            expect(result[userId]).toBe(current[userId]);
          }
        }

        // 4) The input map is not mutated: same keys and same value references.
        expect(Object.keys(current)).toEqual(beforeKeys);
        for (const userId of beforeKeys) {
          expect(current[userId]).toBe(beforeRefs[userId]);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: react-frontend-migration, Property 43: Reducer de actualización de presencia
  it('returns the current map reference unchanged for an empty batch', () => {
    fc.assert(
      fc.property(currentMapArb, (current) => {
        expect(applyPresenceUpdate(current, [])).toBe(current);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 43: Reducer de actualización de presencia
  it('when a batch targets the same userId more than once, the later update wins', () => {
    fc.assert(
      fc.property(
        currentMapArb,
        userIdArb,
        fc.array(presenceTypeArb, { minLength: 2, maxLength: 6 }),
        (current, userId, types) => {
          // Build a batch that repeatedly targets the SAME userId; only the
          // final entry's presence type should survive in the result.
          const updates: PresenceUpdate[] = types.map((type) => ({
            userId,
            type,
          }));
          const result = applyPresenceUpdate(current, updates);
          expect(result[userId]).toEqual({
            userId,
            type: types[types.length - 1],
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
