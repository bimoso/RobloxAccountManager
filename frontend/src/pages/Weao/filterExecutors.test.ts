import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  filterExecutors,
  searchExecutors,
  sortExecutors,
  visibleExecutors,
} from './filterExecutors';
import {
  DEFAULT_EXECUTOR_FILTERS,
  WEAO_PLATFORMS,
  type Executor,
  type ExecutorFilters,
  type WeaoPlatform,
} from './types';

/**
 * Property-based tests for the executor grid derivation.
 *
 * The search half mirrors the Charts local-search properties (exact match set,
 * order preserved, input untouched); the filter half checks each predicate in
 * isolation; the ordering half pins the severity contract — risk first, then
 * outdated builds, then title — and that ordering never loses or invents an
 * entry.
 */

/** Builds a complete executor from the handful of fields a test cares about. */
function makeExecutor(overrides: Partial<Executor> & { title: string }): Executor {
  return {
    trackerId: overrides.title,
    version: '1.0.0',
    updatedDate: null,
    updateStatus: true,
    detected: false,
    detectionReason: null,
    possibleBanwave: false,
    free: true,
    cost: null,
    platform: 'windows',
    platformLabel: 'Windows',
    extype: 'wexecutor',
    rbxversion: null,
    uncStatus: false,
    uncPercentage: null,
    suncPercentage: null,
    decompiler: false,
    multiInject: false,
    raknet: false,
    clientmods: false,
    websitelink: null,
    discordlink: null,
    purchaselink: null,
    hasIssues: false,
    beta: false,
    slug: { logo: null, screenshots: [] },
    ...overrides,
  };
}

const platformArb: fc.Arbitrary<WeaoPlatform | null> = fc.oneof(
  fc.constantFrom(...WEAO_PLATFORMS),
  fc.constant(null),
);

const executorArb: fc.Arbitrary<Executor> = fc
  .record({
    id: fc.nat(),
    title: fc.oneof(
      fc.string(),
      fc.stringMatching(/^[A-Za-z0-9 .!-]{0,14}$/),
      fc.constantFrom('Wave', 'Solara', 'Xeno', 'Delta', 'MacSploit', 'Codex', ''),
    ),
    platform: platformArb,
    free: fc.boolean(),
    updateStatus: fc.boolean(),
    detected: fc.boolean(),
    possibleBanwave: fc.boolean(),
  })
  .map(({ id, ...seed }) =>
    makeExecutor({ ...seed, trackerId: `tracker-${id}-${seed.title}` }),
  );

const executorsArb: fc.Arbitrary<Executor[]> = fc.array(executorArb, { maxLength: 30 });

const queryArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.stringMatching(/^[ \t\n]{0,5}$/),
  fc.string().map((text) => `  ${text}  `),
);

const filtersArb: fc.Arbitrary<ExecutorFilters> = fc.record({
  query: queryArb,
  platform: fc.constantFrom('all' as const, ...WEAO_PLATFORMS),
  cost: fc.constantFrom('all' as const, 'free' as const, 'paid' as const),
  status: fc.constantFrom(
    'all' as const,
    'updated' as const,
    'outdated' as const,
    'undetected' as const,
    'flagged' as const,
  ),
});

/** Risk tier mirrored from the module, used to assert the ordering contract. */
function riskRank(executor: Executor): number {
  if (executor.possibleBanwave) return 0;
  if (executor.detected) return 1;
  return 2;
}

/** Order-independent identity multiset, for the permutation property. */
function identities(executors: readonly Executor[]): string[] {
  return executors.map((executor) => executor.trackerId).sort();
}

describe('searchExecutors', () => {
  it('returns exactly the entries whose lower-cased title contains the normalized query', () => {
    fc.assert(
      fc.property(executorsArb, queryArb, (executors, query) => {
        const normalized = query.trim().toLowerCase();
        const expected = executors.filter((executor) =>
          executor.title.toLowerCase().includes(normalized),
        );
        expect(searchExecutors(executors, query)).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });

  it('returns every entry, in order, for a blank query', () => {
    fc.assert(
      fc.property(executorsArb, fc.stringMatching(/^[ \t\n\r]{0,6}$/), (executors, blank) => {
        expect(searchExecutors(executors, blank)).toEqual(executors);
      }),
      { numRuns: 100 },
    );
  });

  it('never mutates the input array', () => {
    fc.assert(
      fc.property(executorsArb, queryArb, (executors, query) => {
        const snapshot = [...executors];
        searchExecutors(executors, query);
        filterExecutors(executors, { ...DEFAULT_EXECUTOR_FILTERS, query });
        sortExecutors(executors);
        expect(executors).toEqual(snapshot);
      }),
      { numRuns: 150 },
    );
  });
});

describe('filterExecutors', () => {
  it('keeps every survivor in its original relative order', () => {
    fc.assert(
      fc.property(executorsArb, filtersArb, (executors, filters) => {
        const result = filterExecutors(executors, filters);
        let cursor = 0;
        for (const executor of result) {
          const found = executors.indexOf(executor, cursor);
          expect(found).toBeGreaterThanOrEqual(cursor);
          cursor = found + 1;
        }
      }),
      { numRuns: 150 },
    );
  });

  it('applies every predicate to each survivor', () => {
    fc.assert(
      fc.property(executorsArb, filtersArb, (executors, filters) => {
        for (const executor of filterExecutors(executors, filters)) {
          expect(
            executor.title.toLowerCase().includes(filters.query.trim().toLowerCase()),
          ).toBe(true);
          if (filters.platform !== 'all') expect(executor.platform).toBe(filters.platform);
          if (filters.cost === 'free') expect(executor.free).toBe(true);
          if (filters.cost === 'paid') expect(executor.free).toBe(false);
          if (filters.status === 'updated') expect(executor.updateStatus).toBe(true);
          if (filters.status === 'outdated') expect(executor.updateStatus).toBe(false);
          if (filters.status === 'undetected') {
            expect(executor.detected || executor.possibleBanwave).toBe(false);
          }
          if (filters.status === 'flagged') {
            expect(executor.detected || executor.possibleBanwave).toBe(true);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('drops nothing when every predicate is disabled', () => {
    fc.assert(
      fc.property(executorsArb, (executors) => {
        expect(filterExecutors(executors, DEFAULT_EXECUTOR_FILTERS)).toEqual(executors);
      }),
      { numRuns: 100 },
    );
  });

  it('never matches a specific platform for an entry whose platform is unresolved', () => {
    const orphan = makeExecutor({ title: 'Orphan', platform: null, platformLabel: '' });
    for (const platform of WEAO_PLATFORMS) {
      expect(
        filterExecutors([orphan], { ...DEFAULT_EXECUTOR_FILTERS, platform }),
      ).toEqual([]);
    }
    expect(filterExecutors([orphan], DEFAULT_EXECUTOR_FILTERS)).toEqual([orphan]);
  });
});

describe('sortExecutors', () => {
  it('is a permutation of its input', () => {
    fc.assert(
      fc.property(executorsArb, (executors) => {
        const sorted = sortExecutors(executors);
        expect(sorted).toHaveLength(executors.length);
        expect(identities(sorted)).toEqual(identities(executors));
      }),
      { numRuns: 150 },
    );
  });

  it('orders risk first, then outdated builds, then title', () => {
    fc.assert(
      fc.property(executorsArb, (executors) => {
        const sorted = sortExecutors(executors);
        for (let index = 1; index < sorted.length; index += 1) {
          const previous = sorted[index - 1];
          const current = sorted[index];
          expect(riskRank(previous)).toBeLessThanOrEqual(riskRank(current));
          if (riskRank(previous) === riskRank(current) && previous.updateStatus !== current.updateStatus) {
            // Within a risk tier the outdated build is the one that needs
            // attention, so it never sits below a current one.
            expect(previous.updateStatus).toBe(false);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('puts a suspected banwave above a plain detection above a clean entry', () => {
    const banwave = makeExecutor({ title: 'Zulu', possibleBanwave: true });
    const detected = makeExecutor({ title: 'Alpha', detected: true });
    const clean = makeExecutor({ title: 'Bravo' });
    expect(sortExecutors([clean, detected, banwave])).toEqual([banwave, detected, clean]);
  });

  it('falls back to a case-insensitive title order inside a tier', () => {
    const alpha = makeExecutor({ title: 'alpha' });
    const bravo = makeExecutor({ title: 'Bravo' });
    expect(sortExecutors([bravo, alpha])).toEqual([alpha, bravo]);
  });
});

describe('visibleExecutors', () => {
  it('equals sorting whatever survives filtering', () => {
    fc.assert(
      fc.property(executorsArb, filtersArb, (executors, filters) => {
        expect(visibleExecutors(executors, filters)).toEqual(
          sortExecutors(filterExecutors(executors, filters)),
        );
      }),
      { numRuns: 150 },
    );
  });
});
