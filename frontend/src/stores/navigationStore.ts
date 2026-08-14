// stores/navigationStore.ts
//
// Navigation store (Requirement 4).
//
// Owns which navigation page is currently active and its ordinal index within
// the sidebar list. The ordinal index (1-based, mirroring Requirement 4.2/4.3)
// is the single input the `PageRouter` (task 29.3) feeds to
// `lib/animation.ts` → `navDirection(fromIndex, toIndex)` to decide whether an
// incoming page slides in from the left (forward) or the right (backward).
//
// The ordered page list `NAV_PAGES` is the single source of truth for both the
// `Sidebar` rendering order and the ordinal indices. Its order mirrors the
// current workspace sidebar: Accounts, Groups (Packages), Charts, Generator,
// Settings, Logs, Credits. Runtime tuning formerly exposed as the standalone
// Mixer destination now lives inside Settings.

import { create } from 'zustand';

/**
 * Identifier for each navigation page. The union is the single source of truth
 * for page validity; every id here appears exactly once in {@link NAV_PAGES}.
 */
export type PageId =
  | 'accounts'
  | 'packages'
  | 'charts'
  | 'weao'
  | 'generator'
  | 'settings'
  | 'logs'
  | 'credits';

/** A single navigation entry rendered by the `Sidebar`. */
export interface NavPage {
  /** Stable page identifier used by the store and `PageRouter`. */
  readonly id: PageId;
  /** Human-readable label shown in the sidebar (mirrors the Legacy_Frontend). */
  readonly label: string;
  /**
   * Material Icons (round) ligature name for the entry's leading icon, matching
   * the Legacy_Frontend sidebar icons.
   */
  readonly icon: string;
}

/**
 * The navigation pages in sidebar order — the single source of truth for both
 * the `Sidebar` render order and every page's ordinal index. The ordinal index
 * of a page is its 1-based position in this array (Requirement 4.2/4.3).
 *
 * Order and icons mirror the retired Legacy_Frontend sidebar.
 */
export const NAV_PAGES: readonly NavPage[] = [
  { id: 'accounts', label: 'Accounts', icon: 'manage_accounts' },
  { id: 'packages', label: 'Groups', icon: 'inventory_2' },
  { id: 'charts', label: 'Charts', icon: 'bar_chart' },
  // `label` is a proper noun, so it is identical in both dictionaries — and it
  // must stay byte-identical to `nav.weao` in `en.ts`, which `Sidebar.test.tsx`
  // compares against this field.
  { id: 'weao', label: 'WEAO', icon: 'radar' },
  { id: 'generator', label: 'Generator', icon: 'shuffle' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'credits', label: 'Credits', icon: 'favorite' },
] as const;

/** The page shown on startup (first entry of the sidebar). */
export const DEFAULT_PAGE: PageId = NAV_PAGES[0].id;

/**
 * Type guard: `true` iff `value` names one of the navigation pages.
 *
 * @param value - Any candidate value (e.g. read from a URL or storage).
 */
export function isValidPage(value: unknown): value is PageId {
  return (
    typeof value === 'string' &&
    NAV_PAGES.some((page) => page.id === value)
  );
}

/**
 * The 1-based ordinal index of `pageId` within the sidebar list
 * (Requirement 4.2/4.3). Every valid {@link PageId} resolves to an index in
 * `1..NAV_PAGES.length`.
 *
 * Pure and exported so the `PageRouter` and tests can compute navigation
 * direction without going through the store.
 *
 * @param pageId - The page whose ordinal position is requested.
 * @returns The 1-based position of `pageId` in {@link NAV_PAGES}.
 */
export function pageOrdinal(pageId: PageId): number {
  return NAV_PAGES.findIndex((page) => page.id === pageId) + 1;
}

/** Public shape of the navigation store. */
export interface NavigationState {
  /** The currently active navigation page. */
  activePage: PageId;
  /**
   * The 1-based ordinal index of {@link NavigationState.activePage} within the
   * sidebar list. Kept in sync with `activePage` so the `PageRouter` can read
   * it directly to compute `navDirection` (Requirement 4.2/4.3).
   */
  activeIndex: number;
  /**
   * Select `pageId` as the active page and update the ordinal index to match.
   * Selecting the already-active page is idempotent — it leaves the state
   * unchanged so the `PageRouter` starts no transition (Requirement 4.5).
   */
  navigate: (pageId: PageId) => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  activePage: DEFAULT_PAGE,
  activeIndex: pageOrdinal(DEFAULT_PAGE),
  navigate: (pageId) => {
    if (pageId === get().activePage) {
      // No-op: re-selecting the active page must not restart animation.
      return;
    }
    set({ activePage: pageId, activeIndex: pageOrdinal(pageId) });
  },
}));
