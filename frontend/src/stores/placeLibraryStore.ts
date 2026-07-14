import { create } from 'zustand';
import { getPersisted, PERSISTENCE_KEYS, setPersisted } from '@/lib/persistence';

export interface PlaceLibraryEntry {
  placeId: string;
  name: string;
  iconUrl?: string;
  creator?: string;
  favorite: boolean;
  lastLaunchedAt: number | null;
  launchCount: number;
}

export interface PlaceSeed {
  placeId: string;
  name?: string;
  iconUrl?: string;
  creator?: string;
}

const RECENT_LIMIT = 24;

function normalizePlaceId(value: unknown): string {
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? value.trim() : '';
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
    });
  }
  return capPlaceLibrary(result);
}

export function capPlaceLibrary(entries: readonly PlaceLibraryEntry[]): PlaceLibraryEntry[] {
  const favorites = entries.filter((entry) => entry.favorite);
  const recent = entries
    .filter((entry) => !entry.favorite)
    .sort((a, b) => (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0))
    .slice(0, RECENT_LIMIT);
  return [...favorites, ...recent];
}

export function upsertPlace(
  entries: readonly PlaceLibraryEntry[],
  seed: PlaceSeed,
  mode: 'favorite' | 'launched',
  now = Date.now(),
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
  };
  return capPlaceLibrary([next, ...entries.filter((entry) => entry.placeId !== placeId)]);
}

interface PlaceLibraryState {
  entries: PlaceLibraryEntry[];
  favorite: (seed: PlaceSeed) => void;
  toggleFavorite: (seed: PlaceSeed) => void;
  recordLaunch: (seed: PlaceSeed) => void;
  remove: (placeId: string) => void;
}

function persist(entries: PlaceLibraryEntry[]): void {
  setPersisted(PERSISTENCE_KEYS.placeLibrary, entries);
}

const initialEntries = sanitizePlaceLibrary(
  getPersisted<unknown>(PERSISTENCE_KEYS.placeLibrary),
);

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
  recordLaunch: (seed) => {
    const entries = upsertPlace(get().entries, seed, 'launched');
    persist(entries);
    set({ entries });
  },
  remove: (placeId) => {
    const entries = get().entries.filter((entry) => entry.placeId !== placeId);
    persist(entries);
    set({ entries });
  },
}));

export const PLACE_RECENT_LIMIT = RECENT_LIMIT;
