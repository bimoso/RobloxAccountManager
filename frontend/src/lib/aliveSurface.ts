// lib/aliveSurface.ts
//
// The app's "living surface" layer.
//
// The rack gives the app its structure — hairline-ruled rows on a shared
// baseline — but structure alone reads as inert. This module is what makes the
// surface respond to the person using it: a highlight that physically slides
// between rows instead of blinking on and off, and a specular sheen that tracks
// the pointer across every panel and card.
//
// It is installed ONCE, from `App.tsx`, as a single delegated pointer listener
// on the document. That is deliberate: the alternative — a hook and a ref in
// every list, every card and every panel across ten pages — would mean dozens of
// listeners, dozens of re-render paths, and a guarantee that some surface
// somewhere gets forgotten. Here, any element that matches the selectors below
// comes alive the moment it is rendered, on any page, with no page-level code
// at all.
//
// Everything it writes is a CSS custom property, so no React state changes and
// no component re-renders on pointer movement. `styles/alive.css` decides what
// those properties look like.
//
// Properties written:
//   on the row's scroll container   --hover-x, --hover-y, --hover-w, --hover-h,
//                                   --hover-on
//   on a panel / card / stat tile   --mx, --my          (pointer, in px)
//   on .app-shell                   --px, --py          (pointer, 0..1)

/** Elements that get a pointer-tracked specular sheen. */
const SHEEN_SELECTOR = '.rk-panel, .rk-card, .acc-card, .rk-stat, .pkg-card, .ram-btn--primary';

/** The scroll port a hover rail is drawn inside. */
const RAIL_HOST_SELECTOR = '.rk-page__body';

/** Rows the hover rail snaps to. */
const ROW_SELECTOR = '.rk-row';

/** The host currently showing a hover rail, so it can be cleared on exit. */
let activeRailHost: HTMLElement | null = null;

/** The sheen host under the pointer, cleared when the pointer leaves it. */
let activeSheenHost: HTMLElement | null = null;

/** Latest pointer event, coalesced into one animation frame. */
let pending: { x: number; y: number; target: Element | null } | null = null;
let frame = 0;

/** Clears the hover rail on whichever host currently owns it. */
function clearRail(): void {
  if (!activeRailHost) return;
  activeRailHost.style.setProperty('--hover-on', '0');
  activeRailHost = null;
}

/** Clears the specular sheen on whichever surface currently owns it. */
function clearSheen(): void {
  if (!activeSheenHost) return;
  activeSheenHost.style.removeProperty('--mx');
  activeSheenHost.style.removeProperty('--my');
  activeSheenHost = null;
}

/**
 * Applies the coalesced pointer position: snaps the hover rail to the row under
 * the pointer and moves the specular sheen to the surface under it.
 *
 * Runs at most once per animation frame, and touches only custom properties, so
 * a fast drag across a 400-row list costs one style recalculation per frame and
 * zero React work.
 */
function apply(): void {
  frame = 0;
  const sample = pending;
  pending = null;
  if (!sample || !sample.target) {
    clearRail();
    clearSheen();
    return;
  }

  // ── Hover rail ──
  // An element can opt in as the rail's target with data-rail-row — a
  // two-line entry wraps its .rk-row, and the rail should cover both lines.
  const row =
    sample.target.closest<HTMLElement>('[data-rail-row]') ??
    sample.target.closest<HTMLElement>(ROW_SELECTOR);
  const host = row?.closest<HTMLElement>(RAIL_HOST_SELECTOR) ?? null;

  if (row && host) {
    if (activeRailHost && activeRailHost !== host) {
      // Moving between two scroll ports: the old one must stop drawing a rail,
      // otherwise both would show a highlight at once.
      activeRailHost.style.setProperty('--hover-on', '0');
    }
    // Measured against the host's scrolled content rather than
    // `offsetTop`, so the rail stays correct regardless of which ancestor
    // happens to be the offset parent (sticky headers, transformed wrappers).
    const rowBox = row.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    const y = rowBox.top - hostBox.top + host.scrollTop;
    // The horizontal extent is measured too: rows are inset from the canvas
    // edge, and the rail has to sit exactly under the row it highlights.
    const x = rowBox.left - hostBox.left + host.scrollLeft;

    host.style.setProperty('--hover-x', `${Math.round(x)}px`);
    host.style.setProperty('--hover-y', `${Math.round(y)}px`);
    host.style.setProperty('--hover-w', `${Math.round(rowBox.width)}px`);
    host.style.setProperty('--hover-h', `${Math.round(rowBox.height)}px`);
    host.style.setProperty('--hover-on', '1');
    activeRailHost = host;
  } else {
    clearRail();
  }

  // ── Specular sheen ──
  const surface = sample.target.closest<HTMLElement>(SHEEN_SELECTOR);
  if (surface) {
    if (activeSheenHost && activeSheenHost !== surface) {
      activeSheenHost.style.removeProperty('--mx');
      activeSheenHost.style.removeProperty('--my');
    }
    const box = surface.getBoundingClientRect();
    surface.style.setProperty('--mx', `${Math.round(sample.x - box.left)}px`);
    surface.style.setProperty('--my', `${Math.round(sample.y - box.top)}px`);
    activeSheenHost = surface;
  } else {
    clearSheen();
  }
}

/**
 * Installs the living-surface listeners.
 *
 * @param shell - The `.app-shell` element, which receives the normalized
 *   pointer position driving the ambient aura's parallax.
 * @returns A teardown function removing every listener and clearing any
 *   properties still set, so a StrictMode double-mount leaves nothing behind.
 */
export function installAliveSurface(shell: HTMLElement | null): () => void {
  const onPointerMove = (event: PointerEvent): void => {
    pending = { x: event.clientX, y: event.clientY, target: event.target as Element | null };

    if (shell) {
      // Normalized 0..1 pointer position for the ambient aura. Written straight
      // through rather than coalesced: it is two properties on one element and
      // the aura's own transition does the smoothing.
      shell.style.setProperty('--px', (event.clientX / window.innerWidth).toFixed(3));
      shell.style.setProperty('--py', (event.clientY / window.innerHeight).toFixed(3));
    }

    if (!frame) {
      frame = window.requestAnimationFrame(apply);
    }
  };

  const onPointerLeave = (): void => {
    pending = null;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    clearRail();
    clearSheen();
  };

  // A scroll moves rows out from under a stationary pointer, so a rail measured
  // before the scroll would be pointing at the wrong row.
  const onScroll = (): void => clearRail();

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });

  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('scroll', onScroll, true);
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    clearRail();
    clearSheen();
    shell?.style.removeProperty('--px');
    shell?.style.removeProperty('--py');
  };
}
