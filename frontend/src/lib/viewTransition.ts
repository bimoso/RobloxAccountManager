/**
 * lib/viewTransition.ts
 *
 * Small wrapper around the View Transitions API used by the Theme_System and
 * the Language_System to cross-fade the whole interface when a global visual
 * state changes (theme palette or UI language).
 *
 * The wrapper degrades gracefully:
 * - When `document.startViewTransition` is unavailable (older engines, jsdom
 *   in tests) the mutation runs synchronously, exactly as before.
 * - When the user prefers reduced motion the transition is skipped entirely so
 *   the change is instant (Requirement 6.2).
 *
 * The animation itself is tuned in `styles/global.css` via the
 * `::view-transition-old(root)` / `::view-transition-new(root)` selectors.
 */

/**
 * `true` when the user has asked the OS for reduced motion. Never throws:
 * environments without `matchMedia` (jsdom) simply report `false`.
 */
function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Run `mutate` inside a document-level view transition when the platform
 * supports it and the user has not requested reduced motion; otherwise run it
 * synchronously.
 *
 * The mutation MUST perform the visible DOM change (class swap, state flush);
 * the browser snapshots the page before it runs and cross-fades to the result.
 *
 * @param mutate - Side-effectful callback that applies the visual change.
 */
export function withViewTransition(mutate: () => void): void {
  const doc = typeof document !== 'undefined' ? document : undefined;

  if (!doc || typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    mutate();
    return;
  }

  doc.startViewTransition(mutate);
}
