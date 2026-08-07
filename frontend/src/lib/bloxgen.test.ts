import { describe, expect, it } from 'vitest';
import {
  BLOXGEN_ACCOUNT_TYPES,
  defaultAccountType,
  isSelectionOutOfStock,
  normalizeBloxGenStock,
  resolveAccountType,
  type BloxGenStockEntry,
} from './bloxgen';

/**
 * Tests for the BloxGen stock helpers backing the Generator's account-type
 * picker.
 *
 * The shapes here mirror the documented `/api/stock` response
 * (<https://docs.bloxgen.net/api-reference/stock>) wrapped in the backend's
 * `{ status, body }` envelope, including the literal type keys with their
 * spaces and plus signs.
 */

/** A successful stock envelope, as `ipc.bloxgenStock` resolves it. */
function envelope(data: unknown, success = true): unknown {
  return { status: 200, body: { success, data } };
}

const FULL_STOCK = {
  'alt': { available: true, regions: ['GB', 'US'] },
  '+30 days old': { available: true, regions: ['US'] },
  '+1 year old': { available: false, regions: [] },
  '5+ years old': { available: false, regions: [] },
  'dump': { available: true, regions: ['DE', 'GB', 'US'] },
};

describe('normalizeBloxGenStock', () => {
  it('maps the documented response into entries in canonical order', () => {
    const entries = normalizeBloxGenStock(envelope(FULL_STOCK));
    expect(entries?.map((entry) => entry.type)).toEqual([...BLOXGEN_ACCOUNT_TYPES]);
    expect(entries?.find((entry) => entry.type === 'alt')).toEqual({
      type: 'alt',
      available: true,
      regions: ['GB', 'US'],
    });
    expect(entries?.find((entry) => entry.type === '+1 year old')?.available).toBe(false);
  });

  it('omits types the role cannot generate rather than reporting them out of stock', () => {
    // A Free plan typically only receives `alt`.
    const entries = normalizeBloxGenStock(envelope({ alt: { available: true, regions: [] } }));
    expect(entries).toEqual([{ type: 'alt', available: true, regions: [] }]);
  });

  it('returns null when the lookup did not produce a usable stock map', () => {
    expect(normalizeBloxGenStock(envelope(FULL_STOCK, false))).toBeNull();
    expect(normalizeBloxGenStock({ status: 401, body: { message: 'Invalid API key' } })).toBeNull();
    expect(normalizeBloxGenStock(undefined)).toBeNull();
    expect(normalizeBloxGenStock({ status: 200, body: { success: true } })).toBeNull();
  });

  it('tolerates a malformed regions field', () => {
    const entries = normalizeBloxGenStock(
      envelope({ alt: { available: true, regions: ['GB', 7, null] } }),
    );
    expect(entries?.[0].regions).toEqual(['GB']);
  });
});

describe('defaultAccountType', () => {
  it('preselects the first type that is actually in stock', () => {
    const stock = normalizeBloxGenStock(
      envelope({
        'alt': { available: false, regions: [] },
        '+30 days old': { available: true, regions: [] },
      }),
    );
    expect(defaultAccountType(stock)).toBe('+30 days old');
  });

  it('falls back to the first offered type when nothing is in stock', () => {
    const stock = normalizeBloxGenStock(envelope({ dump: { available: false, regions: [] } }));
    expect(defaultAccountType(stock)).toBe('dump');
  });

  it('falls back to alt when stock is unknown', () => {
    expect(defaultAccountType(null)).toBe('alt');
  });
});

describe('resolveAccountType', () => {
  const stock = normalizeBloxGenStock(envelope(FULL_STOCK)) as BloxGenStockEntry[];

  it('passes a concrete selection through untouched', () => {
    expect(resolveAccountType('+1 year old', stock)).toBe('+1 year old');
  });

  it('resolves random to an in-stock type only', () => {
    const available = ['alt', '+30 days old', 'dump'];
    // Every index the chooser can return must land on an available type.
    for (let index = 0; index < available.length; index += 1) {
      expect(available).toContain(resolveAccountType('random', stock, () => index));
    }
  });

  it('clamps an out-of-range index from the chooser', () => {
    expect(resolveAccountType('random', stock, () => 99)).toBe('dump');
    expect(resolveAccountType('random', stock, () => -5)).toBe('alt');
  });

  it('degrades to the default when nothing is in stock', () => {
    const empty = normalizeBloxGenStock(envelope({ alt: { available: false, regions: [] } }));
    expect(resolveAccountType('random', empty)).toBe('alt');
  });

  it('never returns a type that is out of stock when random is used', () => {
    const depleted = normalizeBloxGenStock(
      envelope({
        'alt': { available: false, regions: [] },
        '5+ years old': { available: true, regions: [] },
      }),
    );
    expect(resolveAccountType('random', depleted, () => 0)).toBe('5+ years old');
  });
});

describe('isSelectionOutOfStock', () => {
  const stock = normalizeBloxGenStock(envelope(FULL_STOCK)) as BloxGenStockEntry[];

  it('flags a concrete selection that is depleted', () => {
    expect(isSelectionOutOfStock('+1 year old', stock)).toBe(true);
    expect(isSelectionOutOfStock('alt', stock)).toBe(false);
  });

  it('never flags random, which resolves to an available type by construction', () => {
    expect(isSelectionOutOfStock('random', stock)).toBe(false);
  });

  it('never flags anything while stock is unknown', () => {
    expect(isSelectionOutOfStock('+1 year old', null)).toBe(false);
  });
});
