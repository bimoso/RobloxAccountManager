// stores/themeStore.ts
//
// Theme_System store (Requirement 3).
//
// Owns the active theme selection, applies the matching `<body>` class, and
// persists the choice through `lib/persistence.ts`. The non-trivial logic is
// factored into exported pure helpers (`resolveInitialTheme`,
// `nextToggledTheme`, `isValidTheme`) so it can be property-tested without a
// DOM or React (design.md Properties 3, 4, 5).
//
// Theme -> body class convention (mirrors the Legacy_Frontend
// the retired renderer's `applyTheme`, and the class names in `styles/theme.css`):
//   - dark  -> no body class (the `:root` defaults)
//   - light -> body.light
//   - every other theme -> body.theme-<name>

import { create } from 'zustand';
import { getPersisted, setPersisted, PERSISTENCE_KEYS } from '../lib/persistence';
import type { ThemeName } from '../types/models';

/**
 * The 12 selectable themes, in the canonical order used by the Legacy_Frontend
 * and the Themes tab. This is the single source of truth for theme validity.
 */
export const THEME_NAMES: readonly ThemeName[] = [
  'dark', 'light', 'midnight', 'aurora', 'sunset', 'crimson',
  'ocean', 'grape', 'forest', 'amber', 'rose', 'graphite',
] as const;

/** The theme applied when nothing valid is persisted (Requirement 3.5). */
export const DEFAULT_THEME: ThemeName = 'dark';

/**
 * Type guard: `true` iff `value` is one of the 12 valid theme names.
 *
 * Exported for property testing (design.md Property 3).
 *
 * @param value - Any value read from storage or user input.
 */
export function isValidTheme(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve the theme to apply on startup (Requirements 3.4, 3.5).
 *
 * Reads the persisted `ui-theme` value; returns it when it names one of the 12
 * valid themes, otherwise returns `"dark"`. Never throws — a missing value,
 * unavailable storage, or corrupted/invalid value all resolve to `"dark"`.
 *
 * Pure with respect to storage input; exported for property testing
 * (design.md Property 3).
 */
export function resolveInitialTheme(): ThemeName {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.theme);
  return isValidTheme(stored) ? stored : DEFAULT_THEME;
}

/**
 * The theme produced by the title-bar toggle (Requirements 3.7, 3.8).
 *
 * When the active theme is `"light"` the toggle switches to `"dark"`; for any
 * other active theme (including the 10 accent themes) it switches to
 * `"light"`. Pure; exported for property testing (design.md Property 5).
 *
 * @param active - The currently active theme.
 */
export function nextToggledTheme(active: ThemeName): ThemeName {
  return active === 'light' ? 'dark' : 'light';
}

/**
 * Apply the `<body>` class for `theme`, mirroring the Legacy_Frontend
 * `applyTheme`. Synchronous class swap so the palette changes well within the
 * 300ms budget (Requirement 3.2). No-op when there is no DOM (e.g. tests).
 *
 * @param theme - The theme whose class should be applied.
 */
function applyThemeClass(theme: ThemeName): void {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }
  const { classList } = document.body;
  // Clear every non-default theme class, then add the one for `theme`.
  classList.remove('light');
  for (const name of THEME_NAMES) {
    if (name !== 'dark' && name !== 'light') {
      classList.remove(`theme-${name}`);
    }
  }
  if (theme === 'light') {
    classList.add('light');
  } else if (theme !== 'dark') {
    classList.add(`theme-${theme}`);
  }
}

/** Public shape of the theme store. */
export interface ThemeState {
  /** The active theme held in memory for the session. */
  theme: ThemeName;
  /**
   * Select `theme`: update the in-memory active theme, swap the body class,
   * and persist the choice. Persistence never throws (Requirement 3.6), so a
   * storage failure leaves the in-memory theme selected for the session.
   */
  setTheme: (theme: ThemeName) => void;
  /**
   * Title-bar quick toggle between `"light"` and `"dark"` (Requirements 3.7,
   * 3.8). Delegates to {@link setTheme} with {@link nextToggledTheme}.
   */
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveInitialTheme(),
  setTheme: (theme) => {
    // In-memory selection first so the session keeps the theme even if the
    // subsequent persist is a no-op on failure (Requirement 3.6, Property 4).
    set({ theme });
    applyThemeClass(theme);
    setPersisted(PERSISTENCE_KEYS.theme, theme);
  },
  toggleTheme: () => {
    get().setTheme(nextToggledTheme(get().theme));
  },
}));

/**
 * Apply the resolved startup theme to the DOM. Call once during app bootstrap
 * (before first paint) to restore the persisted theme (Requirement 27.2).
 */
export function initTheme(): void {
  applyThemeClass(useThemeStore.getState().theme);
}
