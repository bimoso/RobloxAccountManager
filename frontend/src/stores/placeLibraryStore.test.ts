import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSISTENCE_KEYS } from '@/lib/persistence';
import {
  PLACE_RECENT_LIMIT,
  capPlaceLibrary,
  sanitizePlaceLibrary,
  usePlaceLibraryStore,
  type PlaceLibraryEntry,
} from './placeLibraryStore';

function place(
  placeId: string,
  overrides: Partial<PlaceLibraryEntry> = {},
): PlaceLibraryEntry {
  return {
    placeId,
    name: `Place ${placeId}`,
    favorite: false,
    lastLaunchedAt: null,
    launchCount: 0,
    ...overrides,
  };
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() { return values.size; },
  } as Storage;
}

describe('placeLibraryStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock());
    usePlaceLibraryStore.setState({ entries: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sanitizes malformed records and deduplicates normalized Place IDs', () => {
    const entries = sanitizePlaceLibrary([
      null,
      { placeId: 42, name: 'numeric ids are not accepted' },
      {
        placeId: ' 123 ',
        name: '  First name wins  ',
        favorite: true,
        lastLaunchedAt: Number.NaN,
        launchCount: 3.9,
      },
      { placeId: '123', name: 'duplicate', favorite: false },
      { placeId: 'not-a-place', name: 'invalid' },
      { placeId: '456', name: '   ', launchCount: -10 },
    ]);

    expect(entries).toEqual([
      {
        placeId: '123',
        name: 'First name wins',
        iconUrl: undefined,
        creator: undefined,
        favorite: true,
        lastLaunchedAt: null,
        launchCount: 3,
      },
      {
        placeId: '456',
        name: 'Place 456',
        iconUrl: undefined,
        creator: undefined,
        favorite: false,
        lastLaunchedAt: null,
        launchCount: 0,
      },
    ]);
  });

  it('keeps every favorite while capping and sorting non-favorite recents', () => {
    const favorites = [
      place('9001', { favorite: true }),
      place('9002', { favorite: true }),
    ];
    const recents = Array.from({ length: PLACE_RECENT_LIMIT + 4 }, (_, index) =>
      place(String(index + 1), { lastLaunchedAt: index + 1 }),
    );

    const capped = capPlaceLibrary([...recents, ...favorites]);

    expect(capped.slice(0, 2).map((entry) => entry.placeId)).toEqual(['9001', '9002']);
    expect(capped).toHaveLength(PLACE_RECENT_LIMIT + favorites.length);
    expect(capped.slice(2).map((entry) => entry.lastLaunchedAt)).toEqual(
      Array.from({ length: PLACE_RECENT_LIMIT }, (_, index) => recents.length - index),
    );
    expect(capped.some((entry) => entry.placeId === '1')).toBe(false);
  });

  it('favorites a normalized Place once and persists the library', () => {
    usePlaceLibraryStore.getState().favorite({
      placeId: ' 777 ',
      name: '  Signal Peak  ',
      creator: 'Roblox',
    });
    usePlaceLibraryStore.getState().favorite({
      placeId: '777',
      name: 'Updated Signal Peak',
    });

    const entries = usePlaceLibraryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      placeId: '777',
      name: 'Updated Signal Peak',
      creator: 'Roblox',
      favorite: true,
      lastLaunchedAt: null,
      launchCount: 0,
    });
    expect(JSON.parse(localStorage.getItem(PERSISTENCE_KEYS.placeLibrary) ?? 'null')).toEqual(entries);
  });

  it('records successful launches, preserves favorite metadata, and increments usage', () => {
    usePlaceLibraryStore.setState({
      entries: [
        place('888', {
          name: 'Saved place',
          creator: 'Original creator',
          favorite: true,
          launchCount: 2,
          lastLaunchedAt: 50,
        }),
      ],
    });
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(250);

    usePlaceLibraryStore.getState().recordLaunch({ placeId: '888' });
    usePlaceLibraryStore.getState().recordLaunch({
      placeId: '888',
      name: 'Fresh title',
    });

    expect(usePlaceLibraryStore.getState().entries).toEqual([
      expect.objectContaining({
        placeId: '888',
        name: 'Fresh title',
        creator: 'Original creator',
        favorite: true,
        lastLaunchedAt: 250,
        launchCount: 4,
      }),
    ]);
  });
});
