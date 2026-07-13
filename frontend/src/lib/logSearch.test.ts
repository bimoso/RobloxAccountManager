// lib/logSearch.test.ts
//
// Unit tests for `findMatches` (Requirement 23.3). The exhaustive Property 42
// property test lives in task 26.4; these cover concrete examples and the
// case-insensitive behavior ported from the Legacy_Frontend Ctrl+F.

import { describe, expect, it } from 'vitest';
import { findMatches } from './logSearch';

describe('findMatches', () => {
  it('returns [] for an empty query', () => {
    expect(findMatches('anything at all', '')).toEqual([]);
  });

  it('returns [] when there are no matches', () => {
    expect(findMatches('launch account online', 'crash')).toEqual([]);
  });

  it('finds a single occurrence with correct offsets', () => {
    const text = '12:00:00.000  LAUNCH account started';
    const [match, ...rest] = findMatches(text, 'account');
    expect(rest).toHaveLength(0);
    expect(match).toEqual({ start: 21, end: 28 });
    expect(text.slice(match.start, match.end)).toBe('account');
  });

  it('finds every non-overlapping occurrence, left to right', () => {
    const matches = findMatches('aaa', 'aa');
    // Non-overlapping: only the first "aa" matches, not the overlapping one.
    expect(matches).toEqual([{ start: 0, end: 2 }]);
  });

  it('finds repeated occurrences', () => {
    const matches = findMatches('ab ab ab', 'ab');
    expect(matches).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
  });

  it('matches case-insensitively (query casing differs from text)', () => {
    const text = 'CRASH Detected: Roblox closed';
    const matches = findMatches(text, 'crash');
    expect(matches).toEqual([{ start: 0, end: 5 }]);
    // The reported span covers the original (differently-cased) text.
    expect(text.slice(matches[0].start, matches[0].end)).toBe('CRASH');
  });

  it('matches case-insensitively (text casing differs from query)', () => {
    const matches = findMatches('launched roblox', 'ROBLOX');
    expect(matches).toEqual([{ start: 9, end: 15 }]);
  });

  it('reports no match when the query is absent under any casing', () => {
    expect(findMatches('online presence', 'offline')).toEqual([]);
  });
});
