import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  aggregateVerdict,
  clientVerdict,
  collectInstalledGuids,
  executorTargetsInstalled,
  guidsMatch,
  normalizeGuid,
  rbxVersionShape,
  type ClientVerdict,
} from './clientStatus';

/**
 * Property-based tests for the WEAO client-status logic.
 *
 * Two invariants carry the whole module and are the reason these tests exist:
 *
 * 1. `clientVerdict` is **total** — arbitrary strings, blanks and nulls (which
 *    the backend really sends: a detected Fishstrap reports `versionGuid: null`)
 *    must all produce a verdict instead of throwing or returning `undefined`.
 * 2. Guids are **opaque hashes**, so the answer may depend on equality only.
 *    Every ordering-sensitive property below is asserted symmetrically, which a
 *    `<`/`>` comparison could not satisfy.
 *
 * `executorTargetsInstalled` is additionally exercised against **both** shapes
 * of `rbxversion` confirmed live: the Windows guid `version-145f189a6a974303`
 * and the mobile store string `2.729.838`.
 */

/** A well-formed Windows deployment guid. */
const guidArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[0-9a-f]{16}$/)
  .map((hex) => `version-${hex}`);

/** A mobile store version, the shape Android/iOS entries report. */
const mobileVersionArb: fc.Arbitrary<string> = fc
  .tuple(fc.nat({ max: 9 }), fc.nat({ max: 999 }), fc.nat({ max: 999 }))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Anything a guid slot may realistically hold, including junk and null. */
const looseGuidArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  fc.string(),
  guidArb,
  guidArb.map((guid) => guid.toUpperCase()),
  guidArb.map((guid) => `  ${guid}\t`),
  mobileVersionArb,
);

const VERDICTS: readonly ClientVerdict[] = [
  'up-to-date',
  'outdated',
  'update-incoming',
  'unknown',
];

/** Two guids guaranteed to differ, for the "neither side matches" cases. */
const distinctGuidsArb: fc.Arbitrary<[string, string]> = fc
  .tuple(guidArb, guidArb)
  .filter(([left, right]) => left !== right);

describe('normalizeGuid / guidsMatch', () => {
  it('canonicalizes by trimming and lower-casing', () => {
    fc.assert(
      fc.property(guidArb, (guid) => {
        expect(normalizeGuid(`  ${guid.toUpperCase()}  `)).toBe(guid.toLowerCase());
      }),
      { numRuns: 100 },
    );
  });

  it('treats blank and absent values as nothing to compare', () => {
    for (const blank of [null, undefined, '', '   ', '\t\n']) {
      expect(normalizeGuid(blank)).toBeNull();
      // Two unknowns are not a match; that would read as "same version".
      expect(guidsMatch(blank, blank)).toBe(false);
    }
  });

  it('matches case-insensitively and is symmetric', () => {
    fc.assert(
      fc.property(guidArb, (guid) => {
        expect(guidsMatch(guid, guid.toUpperCase())).toBe(true);
        expect(guidsMatch(guid.toUpperCase(), ` ${guid} `)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('rbxVersionShape', () => {
  it('recognizes the Windows guid shape', () => {
    expect(rbxVersionShape('version-145f189a6a974303')).toBe('guid');
    fc.assert(
      fc.property(guidArb, (guid) => {
        expect(rbxVersionShape(guid)).toBe('guid');
        expect(rbxVersionShape(guid.toUpperCase())).toBe('guid');
      }),
      { numRuns: 100 },
    );
  });

  it('recognizes the mobile store shape', () => {
    expect(rbxVersionShape('2.729.838')).toBe('mobile');
    fc.assert(
      fc.property(mobileVersionArb, (version) => {
        expect(rbxVersionShape(version)).toBe('mobile');
      }),
      { numRuns: 100 },
    );
  });

  it('never throws and always answers one of the three shapes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.string()), (raw) => {
        expect(['guid', 'mobile', 'unknown']).toContain(rbxVersionShape(raw));
      }),
      { numRuns: 200 },
    );
  });
});

describe('clientVerdict', () => {
  it('is total for arbitrary strings and nulls', () => {
    fc.assert(
      fc.property(looseGuidArb, looseGuidArb, looseGuidArb, (installed, current, future) => {
        expect(VERDICTS).toContain(clientVerdict({ versionGuid: installed }, current, future));
      }),
      { numRuns: 300 },
    );
  });

  it('answers unknown for a missing installation or a missing installed guid', () => {
    fc.assert(
      fc.property(looseGuidArb, looseGuidArb, (current, future) => {
        expect(clientVerdict(null, current, future)).toBe('unknown');
        expect(clientVerdict(undefined, current, future)).toBe('unknown');
        expect(clientVerdict({ versionGuid: null }, current, future)).toBe('unknown');
        expect(clientVerdict({ versionGuid: '   ' }, current, future)).toBe('unknown');
      }),
      { numRuns: 100 },
    );
  });

  it('answers unknown when the live guid is absent and nothing else matches', () => {
    fc.assert(
      fc.property(distinctGuidsArb, ([installed, future]) => {
        expect(clientVerdict({ versionGuid: installed }, null, null)).toBe('unknown');
        expect(clientVerdict({ versionGuid: installed }, '', future)).toBe('unknown');
      }),
      { numRuns: 100 },
    );
  });

  it('answers up-to-date on the live build when no different future build is announced', () => {
    fc.assert(
      fc.property(guidArb, (guid) => {
        expect(clientVerdict({ versionGuid: guid }, guid, null)).toBe('up-to-date');
        expect(clientVerdict({ versionGuid: guid }, guid, guid)).toBe('up-to-date');
        // Casing and padding must not change the answer.
        expect(clientVerdict({ versionGuid: ` ${guid.toUpperCase()} ` }, guid, null)).toBe(
          'up-to-date',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('answers update-incoming on the live build once a different future build exists', () => {
    fc.assert(
      fc.property(distinctGuidsArb, ([current, future]) => {
        expect(clientVerdict({ versionGuid: current }, current, future)).toBe(
          'update-incoming',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('answers up-to-date when the client already runs the announced future build', () => {
    fc.assert(
      fc.property(distinctGuidsArb, ([current, future]) => {
        expect(clientVerdict({ versionGuid: future }, current, future)).toBe('up-to-date');
      }),
      { numRuns: 100 },
    );
  });

  it('answers outdated symmetrically, so no ordering comparison can be involved', () => {
    fc.assert(
      fc.property(distinctGuidsArb, ([left, right]) => {
        // Guids are opaque hashes: whichever way round the pair is, "different
        // from the live build" is the only fact available, and it must read the
        // same in both directions.
        expect(clientVerdict({ versionGuid: left }, right, null)).toBe('outdated');
        expect(clientVerdict({ versionGuid: right }, left, null)).toBe('outdated');
      }),
      { numRuns: 200 },
    );
  });
});

describe('aggregateVerdict / collectInstalledGuids', () => {
  it('reports unknown for an empty machine', () => {
    expect(aggregateVerdict([], 'version-145f189a6a974303', null)).toBe('unknown');
    expect(collectInstalledGuids([])).toEqual([]);
  });

  it('lets the worst verdict win', () => {
    const current = 'version-145f189a6a974303';
    const stale = 'version-0000000000000001';
    expect(
      aggregateVerdict(
        [{ versionGuid: current }, { versionGuid: null }, { versionGuid: stale }],
        current,
        null,
      ),
    ).toBe('outdated');
    expect(
      aggregateVerdict([{ versionGuid: current }, { versionGuid: null }], current, null),
    ).toBe('up-to-date');
  });

  it('collects canonical guids without duplicates and skips the null ones', () => {
    const guid = 'version-145F189A6A974303';
    expect(
      collectInstalledGuids([
        { versionGuid: guid },
        { versionGuid: ` ${guid.toLowerCase()} ` },
        { versionGuid: null },
      ]),
    ).toEqual(['version-145f189a6a974303']);
  });
});

describe('executorTargetsInstalled', () => {
  it('matches a guid target already on disk, ignoring case and padding', () => {
    fc.assert(
      fc.property(guidArb, (guid) => {
        expect(executorTargetsInstalled({ rbxversion: guid.toUpperCase() }, [guid])).toBe(
          true,
        );
        expect(executorTargetsInstalled({ rbxversion: ` ${guid} ` }, [null, guid])).toBe(
          true,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('never matches a mobile target, even against an identical string', () => {
    // `2.729.838` names a store build, not a `version-…` directory, so treating
    // it as installable would promise a downgrade that cannot happen.
    expect(executorTargetsInstalled({ rbxversion: '2.729.838' }, ['2.729.838'])).toBe(false);
    fc.assert(
      fc.property(mobileVersionArb, (version) => {
        expect(executorTargetsInstalled({ rbxversion: version }, [version])).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('is total: arbitrary targets and installed lists always answer a boolean', () => {
    fc.assert(
      fc.property(looseGuidArb, fc.array(looseGuidArb, { maxLength: 8 }), (target, installed) => {
        expect(typeof executorTargetsInstalled({ rbxversion: target }, installed)).toBe(
          'boolean',
        );
        expect(executorTargetsInstalled(null, installed)).toBe(false);
        expect(executorTargetsInstalled(undefined, installed)).toBe(false);
        expect(executorTargetsInstalled({ rbxversion: null }, installed)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('does not match when the guid is absent from the machine', () => {
    fc.assert(
      fc.property(distinctGuidsArb, ([target, other]) => {
        expect(executorTargetsInstalled({ rbxversion: target }, [other])).toBe(false);
        expect(executorTargetsInstalled({ rbxversion: target }, [])).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
