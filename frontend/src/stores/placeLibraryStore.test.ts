import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSISTENCE_KEYS } from '@/lib/persistence';
import {
  PLACE_RECENT_LIMIT,
  capPlaceLibrary,
  findPrivateServerByLink,
  listPrivateServers,
  sanitizePlaceLibrary,
  sanitizePrivateServers,
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
    privateServers: [],
    lastAccountIds: [],
    ...overrides,
  };
}

const PRIVATE_LINK = 'https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ';
const SHARE_LINK = 'https://www.roblox.com/share?code=deadbeef&type=Server';

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
        privateServers: [],
        lastAccountIds: [],
      },
      {
        placeId: '456',
        name: 'Place 456',
        iconUrl: undefined,
        creator: undefined,
        favorite: false,
        lastLaunchedAt: null,
        launchCount: 0,
        privateServers: [],
        lastAccountIds: [],
      },
    ]);
  });

  it('sanitizes private servers: canonical links, deduplication and fallback names', () => {
    const servers = sanitizePrivateServers([
      null,
      { id: 'a', name: 'VIP', link: 'roblox.com/games/606849621?privateServerLinkCode=abc123XYZ&utm=x' },
      { id: 'b', name: 'dup', link: PRIVATE_LINK },
      { id: 'c', name: '', link: SHARE_LINK, launchCount: 2.7, lastLaunchedAt: 10 },
      { id: 'd', name: 'plain game link is not a private server', link: 'https://www.roblox.com/games/1' },
      { name: 'no id gets one', link: 'https://www.roblox.com/share?code=zz&type=Server' },
    ]);

    expect(servers.map((server) => server.link)).toEqual([
      PRIVATE_LINK,
      SHARE_LINK,
      'https://www.roblox.com/share?code=zz&type=Server',
    ]);
    expect(servers[0]).toMatchObject({ id: 'a', name: 'VIP', launchCount: 0, lastLaunchedAt: null });
    expect(servers[1]).toMatchObject({ id: 'c', name: 'Server 2', launchCount: 2, lastLaunchedAt: 10 });
    expect(servers[2].id).toBeTruthy();
  });

  it('keeps a non-favorite Place that owns private servers out of the recent cap', () => {
    const withServers = place('7', {
      favorite: false,
      lastLaunchedAt: 0,
      privateServers: sanitizePrivateServers([{ id: 's', name: 'S', link: SHARE_LINK }]),
    });
    const recents = Array.from({ length: PLACE_RECENT_LIMIT + 2 }, (_, index) =>
      place(String(index + 100), { lastLaunchedAt: index + 1 }),
    );

    const capped = capPlaceLibrary([...recents, withServers]);

    expect(capped[0].placeId).toBe('7');
    expect(capped).toHaveLength(PLACE_RECENT_LIMIT + 1);
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

  it('remembers the roster of the latest launch and keeps it when none is given', () => {
    usePlaceLibraryStore.getState().recordLaunch({ placeId: '1' }, ['acc-a', 'acc-b', 'acc-a']);
    expect(usePlaceLibraryStore.getState().entries[0].lastAccountIds).toEqual(['acc-a', 'acc-b']);

    usePlaceLibraryStore.getState().recordLaunch({ placeId: '1' });
    expect(usePlaceLibraryStore.getState().entries[0].lastAccountIds).toEqual(['acc-a', 'acc-b']);

    usePlaceLibraryStore.getState().recordLaunch({ placeId: '1' }, ['acc-c']);
    expect(usePlaceLibraryStore.getState().entries[0].lastAccountIds).toEqual(['acc-c']);
  });

  describe('private servers', () => {
    it('files a private link under its game, marks the game saved and rejects duplicates', () => {
      const store = usePlaceLibraryStore.getState();
      const added = store.addPrivateServer(
        { placeId: '606849621', name: 'Signal Peak' },
        { name: '  VIP  ', link: 'roblox.com/games/606849621?privateServerLinkCode=abc123XYZ' },
      );
      expect(added).toMatchObject({ ok: true, server: { name: 'VIP', link: PRIVATE_LINK } });

      const entry = usePlaceLibraryStore.getState().entries[0];
      expect(entry).toMatchObject({ placeId: '606849621', name: 'Signal Peak', favorite: true });
      expect(entry.privateServers).toHaveLength(1);

      expect(
        usePlaceLibraryStore.getState().addPrivateServer(
          { placeId: '606849621' },
          { name: 'again', link: PRIVATE_LINK },
        ),
      ).toEqual({ ok: false, reason: 'duplicate' });
      expect(JSON.parse(localStorage.getItem(PERSISTENCE_KEYS.placeLibrary) ?? 'null')).toEqual(
        usePlaceLibraryStore.getState().entries,
      );
    });

    it('refuses a private link that names a different Place and any non-private link', () => {
      const store = usePlaceLibraryStore.getState();
      expect(store.addPrivateServer({ placeId: '1' }, { link: PRIVATE_LINK })).toEqual({
        ok: false,
        reason: 'invalid-link',
      });
      expect(store.addPrivateServer({ placeId: '1' }, { link: 'https://www.roblox.com/games/1' })).toEqual({
        ok: false,
        reason: 'invalid-link',
      });
      expect(usePlaceLibraryStore.getState().entries).toEqual([]);
    });

    it('accepts a share link under any game with a generated name', () => {
      const result = usePlaceLibraryStore.getState().addPrivateServer({ placeId: '42' }, { link: SHARE_LINK });
      expect(result).toMatchObject({ ok: true, server: { name: 'Server 1', link: SHARE_LINK } });
    });

    it('updates, records launches for and removes a saved server', () => {
      const store = usePlaceLibraryStore.getState();
      const added = store.addPrivateServer({ placeId: '606849621' }, { name: 'VIP', link: PRIVATE_LINK });
      if (!added.ok) throw new Error('expected the server to be saved');
      const id = added.server.id;

      expect(
        usePlaceLibraryStore.getState().updatePrivateServer('606849621', id, { name: 'EU VIP' }),
      ).toMatchObject({ ok: true, server: { id, name: 'EU VIP', link: PRIVATE_LINK } });
      expect(
        usePlaceLibraryStore.getState().updatePrivateServer('606849621', id, {
          link: 'https://www.roblox.com/games/999?privateServerLinkCode=other',
        }),
      ).toEqual({ ok: false, reason: 'invalid-link' });
      expect(usePlaceLibraryStore.getState().updatePrivateServer('606849621', 'nope', { name: 'x' })).toEqual({
        ok: false,
        reason: 'missing',
      });

      vi.spyOn(Date, 'now').mockReturnValue(5000);
      usePlaceLibraryStore.getState().recordPrivateServerLaunch('606849621', id, ['acc-1']);
      const entry = usePlaceLibraryStore.getState().entries[0];
      expect(entry).toMatchObject({ launchCount: 1, lastLaunchedAt: 5000, lastAccountIds: ['acc-1'] });
      expect(entry.privateServers[0]).toMatchObject({ launchCount: 1, lastLaunchedAt: 5000 });

      expect(findPrivateServerByLink(usePlaceLibraryStore.getState().entries, PRIVATE_LINK)?.server.id).toBe(id);
      expect(listPrivateServers(usePlaceLibraryStore.getState().entries).map((item) => item.server.id)).toEqual([id]);

      usePlaceLibraryStore.getState().removePrivateServer('606849621', id);
      expect(usePlaceLibraryStore.getState().entries[0].privateServers).toEqual([]);
      expect(findPrivateServerByLink(usePlaceLibraryStore.getState().entries, PRIVATE_LINK)).toBeUndefined();
    });
  });
});
