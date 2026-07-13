/**
 * Animation_System — pure functions.
 *
 * These functions concentrate every animation decision as pure, side-effect-free
 * logic so the animation components (`PageRouter`, `Modal`, `Button`, status
 * indicators) consume them without holding decision logic themselves. They are the
 * units exercised by property-based tests (design.md, Properties 6-9).
 */

/**
 * Direction of a page navigation transition.
 *
 * - `'none'`   — origin and destination are the same page (no transition).
 * - `'from-left'`  — navigating forward (destination has a higher ordinal index).
 * - `'from-right'` — navigating backward (destination has a lower ordinal index).
 */
export type NavDirection = 'from-left' | 'from-right' | 'none';

/** Whether the launched-account status indicator pulses or stays static. */
export type StatusIndicatorAnimation = 'pulse' | 'static';

/** How a button communicates a press: an animated scale, or a color change. */
export type PressFeedbackKind = 'color' | 'scale';

/**
 * Computes the direction of a page transition from the ordinal index of the
 * origin page to the ordinal index of the destination page in the sidebar.
 *
 * Requirements 4.2, 4.3, 4.5 — Property 6.
 *
 * @param fromIndex Ordinal index of the current page.
 * @param toIndex Ordinal index of the destination page.
 * @returns `'none'` if the indices are equal, `'from-left'` if `toIndex` is
 * greater than `fromIndex`, and `'from-right'` if `toIndex` is less than
 * `fromIndex`.
 */
export function navDirection(fromIndex: number, toIndex: number): NavDirection {
  if (fromIndex === toIndex) return 'none';
  return toIndex > fromIndex ? 'from-left' : 'from-right';
}

/**
 * Resolves the effective duration of a motion, collapsing to `0` when reduced
 * motion is requested.
 *
 * Requirement 6.2 — Property 7.
 *
 * @param baseMs The base duration in milliseconds.
 * @param reducedMotion Whether the user prefers reduced motion.
 * @returns `0` when `reducedMotion` is `true`, otherwise `baseMs`.
 */
export function motionDuration(baseMs: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : baseMs;
}

/**
 * Decides whether a launched-account status indicator should pulse or remain
 * static. The indicator communicates the launched/idle state through means other
 * than animation as well, so a `'static'` result never hides that state.
 *
 * Requirements 5.4, 5.5, 6.1 — Property 8.
 *
 * @param launched Whether the account has at least one running instance.
 * @param reducedMotion Whether the user prefers reduced motion.
 * @returns `'pulse'` if and only if `launched` is `true` and `reducedMotion` is
 * `false`; otherwise `'static'`.
 */
export function statusIndicatorAnimation(
  launched: boolean,
  reducedMotion: boolean,
): StatusIndicatorAnimation {
  return launched && !reducedMotion ? 'pulse' : 'static';
}

/**
 * Selects the kind of press feedback a button uses.
 *
 * Requirements 5.3, 6.3 — Property 9.
 *
 * @param reducedMotion Whether the user prefers reduced motion.
 * @returns `'color'` when `reducedMotion` is `true`, otherwise `'scale'`.
 */
export function pressFeedbackKind(reducedMotion: boolean): PressFeedbackKind {
  return reducedMotion ? 'color' : 'scale';
}
