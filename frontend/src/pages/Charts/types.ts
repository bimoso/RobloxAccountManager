// pages/Charts/types.ts
//
// Local domain types for the Charts page (design.md → Requirement 18). The
// Charts page keeps its own page-local state and models; these types are not
// persisted by the Tauri_Backend, they are derived from the Roblox explore /
// thumbnails APIs consumed through `ipc.robloxApiGet`.

/**
 * A single game shown in the Charts listing.
 *
 * Shape mirrors the projection from the retired Legacy_Frontend,
 * `fetchRobloxGames`) built from the Roblox explore-api response plus the
 * thumbnails-api icon lookup.
 */
export interface Game {
  /** Roblox universe id (used to fetch the icon thumbnail). */
  universeId: number | string;
  /** Root place id, used to open/launch the game. May be absent in a response. */
  placeId: number | string | null;
  /** The game's display name — the field matched by {@link searchGames}. */
  name: string;
  /** Concurrent player count, when the API reports one. */
  playerCount: number | null;
  /** Resolved icon URL, or `''` when no thumbnail is available. */
  thumbUrl: string;
}

/**
 * The `sortId` accepted by the Roblox explore-api `get-sort-content` endpoint,
 * one per Charts tab (Requirement 18.1).
 */
export type ChartSortId = 'top-playing-now' | 'top-rated' | 'top-earning';

/** A Charts tab: its explore-api `sortId` and the label shown to the user. */
export interface ChartTab {
  /** The explore-api `sortId` fetched for this tab. */
  id: ChartSortId;
  /** Human-readable tab label (Requirement 18.1). */
  label: string;
}

/**
 * The three Charts tabs, in display order (Requirement 18.1): "Top Playing
 * Now", "Top Rated" and "Top Earning", mapped to the explore-api `sortId`
 * values used by the Legacy_Frontend.
 */
export const CHART_TABS: readonly ChartTab[] = [
  { id: 'top-playing-now', label: 'Top Playing Now' },
  { id: 'top-rated', label: 'Top Rated' },
  { id: 'top-earning', label: 'Top Earning' },
] as const;
