// lib/logSearch.ts
//
// Session-log text search — pure function (Requirement 23.3).
//
// The Logs page exposes a Ctrl+F-style search bar over the visible session log
// text. The matching logic itself lives here as a pure, side-effect-free
// function so it can be exercised by property-based tests (task 26.4) without
// rendering React: given the visible log text and a query, `findMatches`
// returns the position of every occurrence of the query inside the text.
//
// This is the unit exercised by Property 42 ("Búsqueda de texto en el registro
// de sesión"): for any log text and any substring of that text used as a query,
// `findMatches(logText, query)` returns at least one match at a position where
// `logText` actually contains `query`; for any query that does NOT appear
// (case-insensitively) as a substring of `logText`, it returns zero matches.
//
// Matching is CASE-INSENSITIVE and literal (plain substring, no regex), mirroring
// the Legacy_Frontend's Ctrl+F, which calls `window.find(q, false, ...)` with the
// `aCaseSensitive` argument set to `false` (legacy behavior). "logText contains
// query" is therefore interpreted case-insensitively throughout: a query that is
// not a substring of `logText` under a case-insensitive comparison never produces
// a match — the invariant Property 42 checks on its negative branch.

/**
 * A single occurrence of the search query inside the searched text.
 *
 * `start` is the (0-based) index of the first character of the occurrence and
 * `end` is the index just past its last character, so `text.slice(start, end)`
 * is exactly the matched run and equals the query.
 */
export interface LogMatch {
  /** Index in the searched text where the match begins (inclusive). */
  readonly start: number;
  /** Index in the searched text where the match ends (exclusive). */
  readonly end: number;
}

/**
 * Find every occurrence of `query` inside `logText`.
 *
 * Returns the positions of all NON-overlapping, left-to-right occurrences of
 * `query` as a literal, case-insensitive substring of `logText`. The input is
 * never mutated; a fresh array is always returned.
 *
 * Semantics (Requirement 23.3 — Property 42, "Búsqueda de texto en el registro
 * de sesión"):
 *  - If `query` appears (case-insensitively) in `logText`, at least one match is
 *    returned and every returned match `m` satisfies
 *    `logText.slice(m.start, m.end).toLowerCase() === query.toLowerCase()`, so
 *    each match covers exactly `query.length` characters of `logText`.
 *  - If `query` does NOT appear (case-insensitively) in `logText`, zero matches
 *    are returned.
 *  - An empty `query` matches nothing (returns `[]`): an empty search box
 *    highlights nothing, which also avoids the degenerate "matches everywhere"
 *    result.
 *
 * The positions are computed on lowercased copies of both strings. For the
 * session-log text this is exact, because lowercasing is length-preserving for
 * every character the log renders (ASCII plus the accented Latin text used in
 * messages), so each returned offset maps back to the original `logText`
 * one-for-one.
 *
 * @param logText - The visible session-log text to search within.
 * @param query - The search text typed into the Ctrl+F search bar.
 * @returns The positions of each occurrence, in left-to-right order.
 */
export function findMatches(logText: string, query: string): LogMatch[] {
  if (query.length === 0) {
    return [];
  }

  // Case-insensitive search: compare on lowercased copies, but report offsets
  // that index straight back into the original `logText`.
  const haystack = logText.toLowerCase();
  const needle = query.toLowerCase();

  const matches: LogMatch[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    matches.push({ start: index, end: index + query.length });
    // Advance past this occurrence so matches never overlap.
    from = index + query.length;
  }
  return matches;
}
