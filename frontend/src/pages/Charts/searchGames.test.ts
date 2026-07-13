import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { searchGames } from './searchGames';
import type { Game } from './types';

/**
 * Property-based tests for the Charts local game search (task 21.2).
 *
 * Feature: react-frontend-migration, Property 35: Búsqueda de juegos en Charts —
 * for any list of games and any search text (with mixed upper/lower case), the
 * result of `searchGames(games, query)` contains exactly the games whose name
 * (normalized to lower-case) contains the normalized (trimmed, lower-cased)
 * search text, and no others; order is preserved and the input is not mutated.
 *
 * Validates: Requirements 18.2, 18.3
 */

/** Arbitrary that produces a single Game with a name drawn from a broad space. */
const gameArb: fc.Arbitrary<Game> = fc.record({
  universeId: fc.oneof(fc.integer(), fc.string()),
  placeId: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
  // Names include mixed case, whitespace, digits and unicode to exercise
  // case-insensitive substring matching realistically.
  name: fc.oneof(
    fc.string(),
    fc.stringMatching(/^[A-Za-z0-9 !?'-]{0,12}$/),
    fc.constantFrom('Adopt Me!', 'BROOKHAVEN 🏠 RP', 'Blox Fruits', 'tower defense', ''),
  ),
  playerCount: fc.oneof(fc.nat(), fc.constant(null)),
  thumbUrl: fc.string(),
});

const gamesArb: fc.Arbitrary<Game[]> = fc.array(gameArb, { maxLength: 30 });

/** Query arbitrary that mixes surrounding whitespace and mixed case. */
const queryArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  // Whitespace-only queries (normalize to empty).
  fc.stringMatching(/^[ \t\n]{0,5}$/),
  // Padded queries to exercise trimming.
  fc.string().map((s) => `  ${s}  `),
);

describe('searchGames (Property 35: Búsqueda de juegos en Charts)', () => {
  // Feature: react-frontend-migration, Property 35: Búsqueda de juegos en Charts
  it('returns exactly the games whose lower-cased name contains the normalized query, and no others', () => {
    fc.assert(
      fc.property(gamesArb, queryArb, (games, query) => {
        const normalized = query.trim().toLowerCase();
        const result = searchGames(games, query);

        // Every result matches the normalized query.
        for (const game of result) {
          expect((game.name ?? '').toLowerCase().includes(normalized)).toBe(true);
        }

        // Every input that matches is present in the result, and no other.
        const expected = games.filter((g) =>
          (g.name ?? '').toLowerCase().includes(normalized),
        );
        expect(result).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 35: Búsqueda de juegos en Charts
  it('returns all games (order preserved) for an empty or whitespace-only query', () => {
    fc.assert(
      fc.property(
        gamesArb,
        fc.stringMatching(/^[ \t\n\r]{0,6}$/),
        (games, blankQuery) => {
          const result = searchGames(games, blankQuery);
          expect(result).toEqual(games);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 35: Búsqueda de juegos en Charts
  it('preserves the input order of matching games', () => {
    fc.assert(
      fc.property(gamesArb, queryArb, (games, query) => {
        const result = searchGames(games, query);
        // The result is a subsequence of the input in the same relative order.
        let inputIdx = 0;
        for (const game of result) {
          const found = games.indexOf(game, inputIdx);
          expect(found).toBeGreaterThanOrEqual(inputIdx);
          inputIdx = found + 1;
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: react-frontend-migration, Property 35: Búsqueda de juegos en Charts
  it('does not mutate the input array', () => {
    fc.assert(
      fc.property(gamesArb, queryArb, (games, query) => {
        const snapshot = [...games];
        searchGames(games, query);
        expect(games).toEqual(snapshot);
        expect(games.length).toBe(snapshot.length);
      }),
      { numRuns: 100 },
    );
  });
});
