// pages/Charts/searchGames.ts
//
// Pure, side-effect-free local search for the Charts page. This is the unit
// exercised by the Charts search property-based test (task 21.2). It holds no
// React or IPC dependency so it can be property-tested in isolation.

import type { Game } from './types';

/**
 * Filters a list of games by a free-text search query, matching on the game
 * name only (Requirements 18.2, 18.3).
 *
 * The query is normalized by trimming surrounding whitespace and lower-casing;
 * a game matches when its (lower-cased) name contains the normalized query as a
 * substring. Matching is therefore case-insensitive. A query that normalizes to
 * the empty string matches every game (every name contains `''`), and the input
 * order is always preserved. The input array is never mutated — a new array is
 * returned.
 *
 * Implements design.md Property 35 ("Búsqueda de juegos en Charts"): the result
 * contains exactly the games whose lower-cased name contains the normalized
 * query, and no others.
 *
 * @param games - The games of the active tab to search.
 * @param query - The raw search text as typed by the user.
 * @returns A new array of the matching games, in their original order.
 */
export function searchGames(games: Game[], query: string): Game[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [...games];
  }
  return games.filter((game) =>
    (game.name ?? '').toLowerCase().includes(normalized),
  );
}
