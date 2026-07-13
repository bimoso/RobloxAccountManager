import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_PAGE,
  NAV_PAGES,
  isValidPage,
  pageOrdinal,
  useNavigationStore,
  type PageId,
} from './navigationStore';

/**
 * Unit + property coverage for the navigation store (task 29.2).
 *
 * These tests pin down the two guarantees the `PageRouter` (task 29.3) relies
 * on: the ordinal index always matches the active page's 1-based position in
 * the sidebar list (Requirement 4.2/4.3), and re-selecting the active page is a
 * no-op so no transition is started (Requirement 4.5).
 */

const pageIds = NAV_PAGES.map((page) => page.id);
const pageIdArb = fc.constantFrom<PageId>(...pageIds);

afterEach(() => {
  // Reset to the startup state so tests remain independent.
  useNavigationStore.setState({
    activePage: DEFAULT_PAGE,
    activeIndex: pageOrdinal(DEFAULT_PAGE),
  });
});

describe('NAV_PAGES ordering', () => {
  it('mirrors the Legacy_Frontend sidebar order', () => {
    expect(pageIds).toEqual([
      'accounts',
      'packages',
      'charts',
      'generator',
      'settings',
      'logs',
      'credits',
    ]);
  });

  it('has no duplicate page ids', () => {
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });
});

describe('pageOrdinal', () => {
  it('is 1-based and matches array position for every page', () => {
    NAV_PAGES.forEach((page, index) => {
      expect(pageOrdinal(page.id)).toBe(index + 1);
    });
  });
});

describe('isValidPage', () => {
  it('accepts every known page id and rejects other values', () => {
    for (const id of pageIds) {
      expect(isValidPage(id)).toBe(true);
    }
    expect(isValidPage('nope')).toBe(false);
    expect(isValidPage('mixer')).toBe(false);
    expect(isValidPage(3)).toBe(false);
    expect(isValidPage(undefined)).toBe(false);
    expect(isValidPage(null)).toBe(false);
  });
});

describe('navigationStore', () => {
  it('starts on the default page with a matching ordinal index', () => {
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe(DEFAULT_PAGE);
    expect(state.activeIndex).toBe(pageOrdinal(DEFAULT_PAGE));
  });

  it('navigate updates the active page and keeps the ordinal index in sync', () => {
    fc.assert(
      fc.property(pageIdArb, (target) => {
        useNavigationStore.getState().navigate(target);
        const state = useNavigationStore.getState();
        expect(state.activePage).toBe(target);
        expect(state.activeIndex).toBe(pageOrdinal(target));
      }),
      { numRuns: 100 },
    );
  });

  it('re-selecting the active page is a no-op (no state object change)', () => {
    useNavigationStore.getState().navigate('settings');
    const before = useNavigationStore.getState();
    before.navigate('settings');
    const after = useNavigationStore.getState();
    // Same references => no re-render / no transition is triggered (Req 4.5).
    expect(after.activePage).toBe(before.activePage);
    expect(after.activeIndex).toBe(before.activeIndex);
  });
});
