// lib/fuzzy.ts
//
// Subsequence matching for the Command_Palette.
//
// Deliberately small: a palette over a few hundred entries does not need a
// ranking library, and adding one would mean a dependency in an app that ships
// offline. What it does need is for "gnr" to find "Generator" and for "farm" to
// rank the account named "Farm A" above one merely noted "farming", which plain
// `includes()` cannot do.

/** A scored match. Higher `score` is a better match. */
export interface FuzzyMatch {
  /** True when every character of the query appears in order. */
  readonly hit: boolean;
  /** Relative quality; only meaningful between results for the SAME query. */
  readonly score: number;
}

/** Characters after which the next character counts as starting a word. */
const BOUNDARY = /[\s\-_/.:@]/;

/**
 * Scores `query` against `text` as an in-order subsequence.
 *
 * Scoring, in descending weight:
 * - a run of consecutive matched characters (so "farm" beats a scattered f-a-r-m),
 * - a character matching at a word boundary (so "fa" ranks "Farm A" over "Alfa"),
 * - a match at the very start of the text,
 * - a shorter haystack, as a tie-break, so exact-ish names win over long notes.
 *
 * An empty query matches everything with score 0, which is what the palette
 * wants: it shows the full catalog until you start typing.
 *
 * @param query - What the user typed. Case-insensitive.
 * @param text - The candidate label to score against.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { hit: true, score: 0 };

  const haystack = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let run = 0;

  for (const char of q) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) {
      return { hit: false, score: 0 };
    }

    if (found === cursor && cursor > 0) {
      // Consecutive with the previous match: the strongest signal, and it
      // compounds so a long contiguous run dominates a scattered one.
      run += 1;
      score += 8 + run * 4;
    } else {
      run = 0;
      score += 1;
    }

    if (found === 0) {
      score += 12;
    } else if (BOUNDARY.test(haystack[found - 1] ?? '')) {
      score += 7;
    }

    cursor = found + 1;
  }

  // Tie-break toward shorter labels: "Logs" should beat "Open logs folder" for
  // the query "logs". Capped so a long label with a genuinely better match is
  // not overtaken by a short one with a poor match.
  score += Math.max(0, 12 - Math.floor(haystack.length / 4));

  return { hit: true, score };
}
