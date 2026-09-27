import { create } from 'zustand';
import { getPersisted, PERSISTENCE_KEYS, setPersisted } from '@/lib/persistence';
import { normalizePrivateServerLink, parsePrivateServerLink } from '@/lib/privateServers';

/**
 * A saved private server belonging to one library Place. The link is stored in
 * the canonical form the launcher accepts (see `lib/privateServers.ts`), so a
 * saved entry can be handed to `launchRoblox` verbatim.
 */
export interface PrivateServerEntry {
  id: string;
  /** User-facing label ("Farm server", "VIP - EU"). */
  name: string;
  /** Canonical private-server URL. */
  link: string;
  createdAt: number;
  lastLaunchedAt: number | null;
  launchCount: number;
}

export interface PlaceLibraryEntry {
  placeId: string;
  name: string;
  iconUrl?: string;
  creator?: string;
  favorite: boolean;
  lastLaunchedAt: number | null;
  launchCount: number;
  /** Private servers saved for this Place; keeps the entry out of the recent cap. */
  privateServers: PrivateServerEntry[];
  /** Accounts used on the most recent launch, so the picker can pre-select them. */
  lastAccountIds: string[];
}

export interface PlaceSeed {
  placeId: string;
  name?: string;
  iconUrl?: string;
  creator?: string;
}

/** Fields a private server can be created or edited with. */
export interface PrivateServerInput {
  name?: string;
  link: string;
}

/** Why a private-server write was refused. */
export type PrivateServerRejection = 'invalid-link' | 'duplicate' | 'missing';

export type PrivateServerResult =
  | { ok: true; server: PrivateServerEntry }
  | { ok: false; reason: PrivateServerRejection };

const RECENT_LIMIT = 24;
const LAST_ACCOUNTS_LIMIT = 64;

function normalizePlaceId(value: unknown): string {
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? value.trim() : '';
}

function newServerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw === 'string' && raw.trim()) seen.add(raw.trim());
    if (seen.size >= LAST_ACCOUNTS_LIMIT) break;
  }
  return [...seen];
}

/** Drop malformed servers, canonicalize links and deduplicate by link. */
export function sanitizePrivateServers(value: unknown): PrivateServerEntry[] {
  if (!Array.isArray(value)) return [];
  const seenLinks = new Set<string>();
  const seenIds = new Set<string>();
  const result: PrivateServerEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<PrivateServerEntry>;
    const parsed = typeof item.link === 'string' ? parsePrivateServerLink(item.link) : null;
    if (!parsed || seenLinks.has(parsed.url)) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : newServerId();
    while (seenIds.has(id)) id = newServerId();
    seenLinks.add(parsed.url);
    seenIds.add(id);
    result.push({
      id,
      name:
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : `Server ${result.length + 1}`,
      link: parsed.url,
      createdAt:
        typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      lastLaunchedAt:
        typeof item.lastLaunchedAt === 'number' && Number.isFinite(item.lastLaunchedAt)
          ? item.lastLaunchedAt
          : null,
      launchCount:
        typeof item.launchCount === 'number' && Number.isFinite(item.launchCount)
          ? Math.max(0, Math.floor(item.launchCount))
          : 0,
    });
  }
  return result;
}

export function sanitizePlaceLibrary(value: unknown): PlaceLibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PlaceLibraryEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<PlaceLibraryEntry>;
    const placeId = normalizePlaceId(item.placeId);
    if (!placeId || seen.has(placeId)) continue;
    seen.add(placeId);
    result.push({
      placeId,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Place ${placeId}`,
      iconUrl: typeof item.iconUrl === 'string' && item.iconUrl ? item.iconUrl : undefined,
      creator: typeof item.creator === 'string' && item.creator ? item.creator : undefined,
      favorite: item.favorite === true,
      lastLaunchedAt:
        typeof item.lastLaunchedAt === 'number' && Number.isFinite(item.lastLaunchedAt)
          ? item.lastLaunchedAt
          : null,
      launchCount:
        typeof item.launchCount === 'number' && Number.isFinite(item.launchCount)
          ? Math.max(0, Math.floor(item.launchCount))
          : 0,
      privateServers: sanitizePrivateServers(item.privateServers),
      lastAccountIds: sanitizeAccountIds(item.lastAccountIds),
    });
  }
  return capPlaceLibrary(result);
}

/** A Place stays in the library while it is a favorite or owns private servers. */
export function isRetainedPlace(entry: Pick<PlaceLibraryEntry, 'favorite' | 'privateServers'>): boolean {
  return entry.favorite || entry.privateServers.length > 0;
}

export function capPlaceLibrary(entries: readonly PlaceLibraryEntry[]): PlaceLibraryEntry[] {
  const favorites = entries.filter(isRetainedPlace);
  const recent = entries
    .filter((entry) => !isRetainedPlace(entry))
    .sort((a, b) => (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0))
    .slice(0, RECENT_LIMIT);
  return [...favorites, ...recent];
}

/** The roster remembered for a Place: the latest launch replaces the previous one. */
function nextAccountIds(current: readonly string[], launched: readonly string[] | undefined): string[] {
  if (!launched || launched.length === 0) return [...current];
  return sanitizeAccountIds(launched);
}

export function upsertPlace(
  entries: readonly PlaceLibraryEntry[],
  seed: PlaceSeed,
  mode: 'favorite' | 'launched',
  now = Date.now(),
  accountIds?: readonly string[],
): PlaceLibraryEntry[] {
  const placeId = normalizePlaceId(seed.placeId);
  if (!placeId) return [...entries];
  const current = entries.find((entry) => entry.placeId === placeId);
  const next: PlaceLibraryEntry = {
    placeId,
    name: seed.name?.trim() || current?.name || `Place ${placeId}`,
    iconUrl: seed.iconUrl || current?.iconUrl,
    creator: seed.creator || current?.creator,
    favorite: mode === 'favorite' ? true : current?.favorite ?? false,
    lastLaunchedAt: mode === 'launched' ? now : current?.lastLaunchedAt ?? null,
    launchCount: mode === 'launched' ? (current?.launchCount ?? 0) + 1 : current?.launchCount ?? 0,
    privateServers: current?.privateServers ?? [],
    lastAccountIds:
      mode === 'launched'
        ? nextAccountIds(current?.lastAccountIds ?? [], accountIds)
        : current?.lastAccountIds ?? [],
  };
  return capPlaceLibrary([next, ...entries.filter((entry) => entry.placeId !== placeId)]);
}

/** Locate the saved server whose canonical link matches `link`, if any. */
export function findPrivateServerByLink(
  entries: readonly PlaceLibraryEntry[],
  link: string,
): { entry: PlaceLibraryEntry; server: PrivateServerEntry } | undefined {
  const canonical = normalizePrivateServerLink(link);
  if (!canonical) return undefined;
  for (const entry of entries) {
    const server = entry.privateServers.find((candidate) => candidate.link === canonical);
    if (server) return { entry, server };
  }
  return undefined;
}

/** Every saved private server across the library, newest first, with its Place. */
export function listPrivateServers(
  entries: readonly PlaceLibraryEntry[],
): Array<{ entry: PlaceLibraryEntry; server: PrivateServerEntry }> {
  return entries
    .flatMap((entry) => entry.privateServers.map((server) => ({ entry, server })))
    .sort(
      (a, b) =>
        (b.server.lastLaunchedAt ?? 0) - (a.server.lastLaunchedAt ?? 0) ||
        b.server.createdAt - a.server.createdAt,
    );
}

interface PlaceLibraryState {
  entries: PlaceLibraryEntry[];
  favorite: (seed: PlaceSeed) => void;
  toggleFavorite: (seed: PlaceSeed) => void;
  /** Merge fresh API details (name, icon, creator) into an existing entry. */
  updateDetails: (seed: PlaceSeed) => void;
  recordLaunch: (seed: PlaceSeed, accountIds?: readonly string[]) => void;
  remove: (placeId: string) => void;
  /** Save a private server under `seed`; the Place becomes a favorite. */
  addPrivateServer: (seed: PlaceSeed, input: PrivateServerInput) => PrivateServerResult;
  updatePrivateServer: (
    placeId: string,
    serverId: string,
    input: Partial<PrivateServerInput>,
  ) => PrivateServerResult;
  removePrivateServer: (placeId: string, serverId: string) => void;
  recordPrivateServerLaunch: (
    placeId: string,
    serverId: string,
    accountIds?: readonly string[],
  ) => void;
}

function persist(entries: PlaceLibraryEntry[]): void {
  setPersisted(PERSISTENCE_KEYS.placeLibrary, entries);
}

const initialEntries = sanitizePlaceLibrary(
  getPersisted<unknown>(PERSISTENCE_KEYS.placeLibrary),
);

function patchEntry(
  entries: readonly PlaceLibraryEntry[],
  placeId: string,
  patch: (entry: PlaceLibraryEntry) => PlaceLibraryEntry,
): PlaceLibraryEntry[] {
  return capPlaceLibrary(
    entries.map((entry) => (entry.placeId === placeId ? patch(entry) : entry)),
  );
}

export const usePlaceLibraryStore = create<PlaceLibraryState>((set, get) => ({
  entries: initialEntries,
  favorite: (seed) => {
    const entries = upsertPlace(get().entries, seed, 'favorite');
    persist(entries);
    set({ entries });
  },
  toggleFavorite: (seed) => {
    const placeId = normalizePlaceId(seed.placeId);
    if (!placeId) return;
    const current = get().entries.find((entry) => entry.placeId === placeId);
    const entries = current
      ? capPlaceLibrary(
          get().entries.map((entry) =>
            entry.placeId === placeId
              ? {
                  ...entry,
                  name: seed.name?.trim() || entry.name,
                  iconUrl: seed.iconUrl || entry.iconUrl,
                  creator: seed.creator || entry.creator,
                  favorite: !entry.favorite,
                }
              : entry,
          ),
        )
      : upsertPlace(get().entries, seed, 'favorite');
    persist(entries);
    set({ entries });
  },
  updateDetails: (seed) => {
    const placeId = normalizePlaceId(seed.placeId);
    if (!placeId || !get().entries.some((entry) => entry.placeId === placeId)) return;
    const entries = patchEntry(get().entries, placeId, (entry) => ({
      ...entry,
      name: seed.name?.trim() || entry.name,
      iconUrl: seed.iconUrl || entry.iconUrl,
      creator: seed.creator || entry.creator,
    }));
    persist(entries);
    set({ entries });
  },
  recordLaunch: (seed, accountIds) => {
    const entries = upsertPlace(get().entries, seed, 'launched', Date.now(), accountIds);
    persist(entries);
    set({ entries });
  },
  remove: (placeId) => {
    const entries = get().entries.filter((entry) => entry.placeId !== placeId);
    persist(entries);
    set({ entries });
  },
  addPrivateServer: (seed, input) => {
    const placeId = normalizePlaceId(seed.placeId);
    const parsed = parsePrivateServerLink(input.link);
    if (!placeId || !parsed) return { ok: false, reason: 'invalid-link' };
    // A `/games/<id>?privateServerLinkCode=` link names its own Place; refuse
    // to file it under a different game than the one it opens.
    if (parsed.kind === 'private' && parsed.placeId !== placeId) {
      return { ok: false, reason: 'invalid-link' };
    }
    if (findPrivateServerByLink(get().entries, parsed.url)) {
      return { ok: false, reason: 'duplicate' };
    }
    const withPlace = upsertPlace(get().entries, seed, 'favorite');
    const owner = withPlace.find((entry) => entry.placeId === placeId);
    const server: PrivateServerEntry = {
      id: newServerId(),
      name: input.name?.trim() || `Server ${(owner?.privateServers.length ?? 0) + 1}`,
      link: parsed.url,
      createdAt: Date.now(),
      lastLaunchedAt: null,
      launchCount: 0,
    };
    const entries = patchEntry(withPlace, placeId, (entry) => ({
      ...entry,
      privateServers: [...entry.privateServers, server],
    }));
    persist(entries);
    set({ entries });
    return { ok: true, server };
  },
  updatePrivateServer: (placeId, serverId, input) => {
    const owner = get().entries.find((entry) => entry.placeId === placeId);
    const current = owner?.privateServers.find((server) => server.id === serverId);
    if (!owner || !current) return { ok: false, reason: 'missing' };

    let link = current.link;
    if (typeof input.link === 'string' && input.link.trim() !== current.link) {
      const parsed = parsePrivateServerLink(input.link);
      if (!parsed || (parsed.kind === 'private' && parsed.placeId !== placeId)) {
        return { ok: false, reason: 'invalid-link' };
      }
      const clash = findPrivateServerByLink(get().entries, parsed.url);
      if (clash && clash.server.id !== serverId) return { ok: false, reason: 'duplicate' };
      link = parsed.url;
    }

    const server: PrivateServerEntry = {
      ...current,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : current.name,
      link,
    };
    const entries = patchEntry(get().entries, placeId, (entry) => ({
      ...entry,
      privateServers: entry.privateServers.map((item) => (item.id === serverId ? server : item)),
    }));
    persist(entries);
    set({ entries });
    return { ok: true, server };
  },
  removePrivateServer: (placeId, serverId) => {
    const entries = patchEntry(get().entries, placeId, (entry) => ({
      ...entry,
      privateServers: entry.privateServers.filter((server) => server.id !== serverId),
    }));
    persist(entries);
    set({ entries });
  },
  recordPrivateServerLaunch: (placeId, serverId, accountIds) => {
    const owner = get().entries.find((entry) => entry.placeId === placeId);
    if (!owner) return;
    const now = Date.now();
    const bumped = upsertPlace(get().entries, { placeId }, 'launched', now, accountIds);
    const entries = patchEntry(bumped, placeId, (entry) => ({
      ...entry,
      privateServers: entry.privateServers.map((server) =>
        server.id === serverId
          ? { ...server, lastLaunchedAt: now, launchCount: server.launchCount + 1 }
          : server,
      ),
    }));
    persist(entries);
    set({ entries });
  },
}));

export const PLACE_RECENT_LIMIT = RECENT_LIMIT;
