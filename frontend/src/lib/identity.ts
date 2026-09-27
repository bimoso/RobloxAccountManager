// lib/identity.ts
//
// Stable per-entity identity colour.
//
// A roster of thirty accounts rendered in one accent colour is a wall of
// identical rows: the eye has nothing to lock onto, so finding "the farm alt"
// means reading every name. Giving each account its own hue turns scanning into
// recognition — you learn that yours is the teal one and stop reading.
//
// The hue is DERIVED, never stored: the same account is the same colour on
// every machine, across restarts, with nothing persisted and no migration. It
// is also purely decorative reinforcement — status is always carried by a text
// code and a tone as well, so a user who cannot distinguish these hues loses
// nothing.

import type { CSSProperties } from 'react';

/**
 * FNV-1a, 32-bit. Chosen over a naive `charCodeAt` sum because sums collide
 * heavily on the inputs this actually sees: consecutive Roblox user ids
 * ("1284410021", "1284410022", …) differ by one digit, and a sum maps those to
 * adjacent hues — an entire roster in three near-identical colours.
 *
 * @param value - Any stable identifier.
 * @returns A well-distributed unsigned 32-bit hash.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // The FNV prime, via shifts: Math.imul keeps this in 32-bit integer space
    // instead of drifting into float territory on the multiply.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The stable hue, in degrees, for an entity.
 *
 * @param seed - A stable identifier (a Roblox user id, an account id, a group
 *   id). Falls back to a neutral hue for an empty seed.
 */
export function identityHue(seed: string): number {
  if (!seed) return 220;
  // The golden-angle step spreads sequential hashes far apart on the wheel, so
  // even a run of adjacent ids produces visibly distinct colours.
  return Math.round((hash32(seed) * 137.508) % 360);
}

/**
 * The inline style carrying an entity's identity hue.
 *
 * Returned as a custom property rather than a finished colour so the stylesheet
 * keeps control of saturation, lightness and how the hue is used (a gradient, a
 * ring, a tick), and so the value stays correct in light mode and in all twelve
 * themes.
 *
 * @param seed - A stable identifier for the entity.
 */
export function identityStyle(seed: string): CSSProperties {
  return { '--id-h': identityHue(seed) } as CSSProperties;
}
