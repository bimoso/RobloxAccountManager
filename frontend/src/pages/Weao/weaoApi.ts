// pages/Weao/weaoApi.ts
//
// WEAO data source. weao.xyz demands a `User-Agent: WEAO-3PService` header —
// a forbidden header in the webview's `fetch` — and its host is not in the
// page CSP's `connect-src`, so every request goes through the narrow backend
// commands `ipc.weaoVersions` / `ipc.weaoExploits`. Those return the upstream
// JSON untouched, which puts the whole burden of schema drift here: this module
// owns the impure fetching plus a field-by-field defensive normalizer. The pure
// verdict/filter logic lives in `./clientStatus` and `./filterExecutors`.

import { ipc } from '@/lib/ipc';
import {
  EXECUTOR_KINDS,
  WEAO_PLATFORMS,
  type Executor,
  type ExecutorKind,
  type ExecutorMedia,
  type PlatformVersionMap,
  type WeaoPlatform,
  type WeaoVersions,
} from './types';

/**
 * The backend envelope around a WEAO response. The backend serves its cached
 * copy with a `staleReason` rather than failing whenever it has something to
 * show, so a populated `data` with a non-null `staleReason` is the normal
 * degraded path, not an error.
 */
export interface WeaoSnapshot<T> {
  /** The normalized payload. Always present — never null on a resolved call. */
  data: T;
  /** Epoch milliseconds the backend stamped on this copy. */
  fetchedAt: number;
  /** `true` when the backend served its cache instead of a fresh request. */
  fromCache: boolean;
  /** Why the copy is stale (network failure, rate limit), or `null`. */
  staleReason: string | null;
  /** Milliseconds to wait before retrying, when the backend reported one. */
  retryAfterMs: number | null;
}

type JsonRecord = Record<string, unknown>;

/** Narrows to a plain JSON object; arrays and scalars yield `null`. */
function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** A non-empty trimmed string, or `null`. Numbers are accepted and stringified. */
function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/**
 * Coerces the many shapes WEAO uses for a flag. `"true"`/`1` appear alongside
 * real booleans across entries, and an absent flag reads as `false` so a card
 * never claims a capability the API did not state.
 */
function asFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1';
  }
  return false;
}

/** A finite percentage, tolerating `"92%"` and `"92"`, else `null`. */
function asPercentage(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Indexes an object by a flattened key (lower-cased, separators stripped), so
 * `updatedDate`, `UpdatedDate` and `updated_date` all resolve to one lookup.
 * Neither the upstream casing nor the Rust envelope's serde renaming is this
 * module's to assume, and guessing wrong would silently blank a whole column.
 */
function flatIndex(record: JsonRecord): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    index.set(key.toLowerCase().replace(/[_-]/g, ''), value);
  }
  return index;
}

/** Reads a flattened key from an already-built index. */
function pick(index: Map<string, unknown>, key: string): unknown {
  return index.get(key);
}

/**
 * Projects one `versions/*` document into a per-platform map. WEAO spells the
 * value either flat (`Windows`) or nested (`WindowsResponse.version`), and the
 * iOS key alone breaks the capitalization pattern (`iOS`), which is exactly why
 * the lookup is case-folded.
 */
function normalizeVersionMap(raw: unknown): PlatformVersionMap {
  const record = asRecord(raw);
  if (!record) return {};
  const index = flatIndex(record);
  const map: PlatformVersionMap = {};
  for (const platform of WEAO_PLATFORMS) {
    const nested = asRecord(pick(index, `${platform}response`));
    const version = asText(pick(index, platform)) ?? asText(nested?.version);
    if (version === null) continue;
    map[platform] = {
      platform,
      version,
      updatedAt: asText(pick(index, `${platform}date`)),
    };
  }
  return map;
}

/**
 * Splits the joined `current` + `future` document. A payload that carries
 * neither key is treated as `current` alone: that is what a backend serving a
 * single endpoint would produce, and it degrades to a page missing the
 * "update incoming" hint rather than to an empty versions panel.
 */
function normalizeVersions(raw: unknown): WeaoVersions {
  const record = asRecord(raw);
  if (!record) return { current: {}, future: {} };
  const index = flatIndex(record);
  const split = index.has('current') || index.has('future');
  return {
    current: normalizeVersionMap(split ? pick(index, 'current') : record),
    future: normalizeVersionMap(pick(index, 'future')),
  };
}

/** Maps an `extype` to the platform it implies, used when `platform` is absent. */
const PLATFORM_BY_KIND: Partial<Record<ExecutorKind, WeaoPlatform>> = {
  wexecutor: 'windows',
  wexternal: 'windows',
  mexecutor: 'mac',
  aexecutor: 'android',
  iexecutor: 'ios',
};

/** Narrows `extype` to a known kind; anything unrecognized becomes `'other'`. */
function normalizeKind(raw: unknown): ExecutorKind {
  const value = asText(raw)?.toLowerCase() ?? '';
  return (EXECUTOR_KINDS as readonly string[]).includes(value)
    ? (value as ExecutorKind)
    : 'other';
}

/** Resolves the platform from the `platform` label, falling back to `extype`. */
function normalizePlatform(raw: unknown, kind: ExecutorKind): WeaoPlatform | null {
  const label = asText(raw)?.toLowerCase();
  const matched = WEAO_PLATFORMS.find((platform) => platform === label);
  return matched ?? PLATFORM_BY_KIND[kind] ?? null;
}

/**
 * Projects `slug` into the artwork the grid needs. Only 18 of 29 entries ship a
 * logo, so a `null` here is the common case and every consumer must fall back.
 */
function normalizeMedia(raw: unknown): ExecutorMedia {
  const record = asRecord(raw);
  if (!record) return { logo: null, screenshots: [] };
  const screenshots = Array.isArray(record.screenshots) ? record.screenshots : [];
  return {
    logo: asText(record.logo),
    screenshots: screenshots
      .map(asText)
      .filter((url): url is string => url !== null),
  };
}

/**
 * Projects one catalogue entry. Returns `null` for anything that is not a
 * titled object — a `null` array slot, a scalar, or an entry with no name —
 * because a nameless card cannot be searched, filtered or labelled.
 */
function normalizeExecutor(raw: unknown): Executor | null {
  const record = asRecord(raw);
  if (!record) return null;
  const index = flatIndex(record);
  const title = asText(pick(index, 'title'));
  if (title === null) return null;

  const extype = normalizeKind(pick(index, 'extype'));
  const platformLabel = asText(pick(index, 'platform'));

  return {
    // `trackerId` is the React key; falling back to the title keeps the list
    // renderable if WEAO ever omits it, since titles are unique in practice.
    trackerId: asText(pick(index, 'trackerid')) ?? title,
    title,
    version: asText(pick(index, 'version')) ?? '',
    updatedDate: asText(pick(index, 'updateddate')),
    updateStatus: asFlag(pick(index, 'updatestatus')),
    detected: asFlag(pick(index, 'detected')),
    detectionReason: asText(pick(index, 'detectionreason')),
    possibleBanwave: asFlag(pick(index, 'possiblebanwave')),
    free: asFlag(pick(index, 'free')),
    cost: asText(pick(index, 'cost')),
    platform: normalizePlatform(platformLabel, extype),
    platformLabel: platformLabel ?? '',
    extype,
    rbxversion: asText(pick(index, 'rbxversion')),
    uncStatus: asFlag(pick(index, 'uncstatus')),
    uncPercentage: asPercentage(pick(index, 'uncpercentage')),
    // sUNC is frequently unpublished; `null` is a normal reading, not an error.
    suncPercentage: asPercentage(pick(index, 'suncpercentage')),
    decompiler: asFlag(pick(index, 'decompiler')),
    multiInject: asFlag(pick(index, 'multiinject')),
    raknet: asFlag(pick(index, 'raknet')),
    clientmods: asFlag(pick(index, 'clientmods')),
    websitelink: asText(pick(index, 'websitelink')),
    discordlink: asText(pick(index, 'discordlink')),
    purchaselink: asText(pick(index, 'purchaselink')),
    hasIssues: asFlag(pick(index, 'hasissues')),
    beta: asFlag(pick(index, 'beta')),
    slug: normalizeMedia(pick(index, 'slug')),
  };
}

/** Projects the catalogue. A non-array root collapses to an empty listing. */
function normalizeExecutors(raw: unknown): Executor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeExecutor)
    .filter((entry): entry is Executor => entry !== null);
}

/** Epoch milliseconds below this are far more plausibly epoch seconds. */
const SECONDS_EPOCH_CEILING = 1e12;

/** Reads the backend timestamp, tolerating a seconds-based stamp. */
function normalizeFetchedAt(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return Date.now();
  }
  return raw < SECONDS_EPOCH_CEILING ? raw * 1000 : raw;
}

/** A finite non-negative millisecond delay, or `null`. */
function normalizeDelay(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Peels the backend envelope off a response. A payload that carries no `data`
 * key is taken as the payload itself, so the page keeps working if the backend
 * ever returns the upstream document bare.
 */
function readEnvelope(raw: unknown): WeaoSnapshot<unknown> {
  const record = asRecord(raw);
  if (!record) {
    return {
      data: raw,
      fetchedAt: Date.now(),
      fromCache: false,
      staleReason: null,
      retryAfterMs: null,
    };
  }
  const index = flatIndex(record);
  return {
    data: index.has('data') ? pick(index, 'data') : raw,
    fetchedAt: normalizeFetchedAt(pick(index, 'fetchedat')),
    fromCache: asFlag(pick(index, 'fromcache')),
    staleReason: asText(pick(index, 'stalereason')),
    retryAfterMs: normalizeDelay(pick(index, 'retryafterms')),
  };
}

/**
 * Loads the current + future Roblox client versions.
 *
 * Rejections propagate untouched so the page's error branch can own the UI;
 * this module never renders anything. A backend that still had a cached copy
 * resolves instead of rejecting, with `staleReason` explaining the degradation.
 *
 * @param force - Bypass the backend's TTL (still floored by its refresh guard).
 * @returns The normalized versions plus the backend's freshness metadata.
 */
export async function fetchWeaoVersions(
  force = false,
): Promise<WeaoSnapshot<WeaoVersions>> {
  const envelope = readEnvelope((await ipc.weaoVersions(force)) as unknown);
  return {
    data: normalizeVersions(envelope.data),
    fetchedAt: envelope.fetchedAt,
    fromCache: envelope.fromCache,
    staleReason: envelope.staleReason,
    retryAfterMs: envelope.retryAfterMs,
  };
}

/**
 * Loads the executor catalogue.
 *
 * @param force - Bypass the backend's TTL (still floored by its refresh guard).
 * @returns The normalized catalogue plus the backend's freshness metadata.
 */
export async function fetchWeaoExecutors(
  force = false,
): Promise<WeaoSnapshot<Executor[]>> {
  const envelope = readEnvelope((await ipc.weaoExploits(force)) as unknown);
  return {
    data: normalizeExecutors(envelope.data),
    fetchedAt: envelope.fetchedAt,
    fromCache: envelope.fromCache,
    staleReason: envelope.staleReason,
    retryAfterMs: envelope.retryAfterMs,
  };
}
