// pages/Charts/chartsApi.ts
//
// Charts data source. Mirrors the Legacy_Frontend (`src/renderer.js`,
// `fetchRobloxGames`): a per-tab listing is loaded from the official Roblox
// explore-api through the Tauri_Bridge (`ipc.robloxApiGet`), then game icons
// are resolved through the Roblox thumbnails-api. This module owns the impure
// fetching; the pure local search lives in `./searchGames`.

import { ipc } from '@/lib/ipc';
import type { ChartSortId, Game } from './types';

/** Roblox explore-api `get-sort-content` endpoint (per-tab listing). */
function sortContentUrl(sortId: ChartSortId, sessionId: string): string {
  return (
    'https://apis.roblox.com/explore-api/v1/get-sort-content' +
    `?sessionId=${sessionId}&sortId=${sortId}&device=computer&country=all`
  );
}

/** Roblox thumbnails-api game-icon endpoint for a batch of universe ids. */
function gameIconsUrl(universeIds: Array<string | number>): string {
  return (
    'https://thumbnails.roblox.com/v1/games/icons' +
    `?universeIds=${universeIds.join(',')}` +
    '&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false'
  );
}

/**
 * Generates a random RFC-4122-ish GUID for the explore-api `sessionId`, mirror
 * of the Legacy_Frontend's `randomGuid()`. A fresh id per load keeps the sorted
 * listing from being cached/deduplicated by the API.
 */
function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Shape of a single game entry inside the explore-api response. */
interface ExploreGame {
  universeId?: number | string;
  rootPlaceId?: number | string;
  placeId?: number | string;
  name?: string;
  playerCount?: number;
}

/** Relevant subset of the explore-api `get-sort-content` response. */
interface SortContentResponse {
  games?: ExploreGame[];
  sorts?: Array<{ games?: ExploreGame[] }>;
}

/** Relevant subset of the thumbnails-api game-icons response. */
interface ThumbnailsResponse {
  data?: Array<{ targetId?: number | string; imageUrl?: string }>;
}

/** Extracts the games array from either explore-api response shape. */
function extractGames(data: SortContentResponse): ExploreGame[] {
  if (Array.isArray(data.games)) {
    return data.games;
  }
  const first = data.sorts?.[0];
  return Array.isArray(first?.games) ? first.games : [];
}

/**
 * Resolves game icon URLs for the given universe ids, keyed by universe id.
 * A thumbnail failure is non-fatal: an empty map is returned so the listing
 * still renders with placeholder icons (mirrors the Legacy_Frontend).
 */
async function fetchThumbnails(
  universeIds: Array<string | number>,
): Promise<Record<string, string>> {
  if (universeIds.length === 0) {
    return {};
  }
  try {
    const raw = (await ipc.robloxApiGet(gameIconsUrl(universeIds))) as ThumbnailsResponse;
    const map: Record<string, string> = {};
    for (const entry of raw?.data ?? []) {
      if (entry.targetId != null && entry.imageUrl) {
        map[String(entry.targetId)] = entry.imageUrl;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Fetches the game listing for one Charts tab (Requirements 18.1, 18.2).
 *
 * Loads the tab's sorted content from the explore-api, resolves icon
 * thumbnails, and projects each entry into the page-local {@link Game} shape.
 * Rejections propagate to the caller so the load-error state (task 21.3) can
 * handle them; this module deliberately performs no error UI.
 *
 * @param sortId - The explore-api `sortId` of the tab to load.
 * @returns The tab's games, in listing order.
 */
export async function fetchChartGames(sortId: ChartSortId): Promise<Game[]> {
  const sessionId = generateSessionId();
  const data = (await ipc.robloxApiGet(
    sortContentUrl(sortId, sessionId),
  )) as SortContentResponse;

  const games = extractGames(data);
  const universeIds = games
    .map((g) => g.universeId)
    .filter((id): id is number | string => id != null);

  const thumbs = await fetchThumbnails(universeIds);

  return games.map((g) => ({
    universeId: g.universeId ?? '',
    placeId: g.rootPlaceId ?? g.placeId ?? null,
    name: g.name ?? '',
    playerCount: typeof g.playerCount === 'number' ? g.playerCount : null,
    thumbUrl: g.universeId != null ? (thumbs[String(g.universeId)] ?? '') : '',
  }));
}
