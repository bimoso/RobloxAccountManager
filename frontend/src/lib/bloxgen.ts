/** Shared event emitted after the local BloxGen credential changes. */
export const BLOXGEN_KEY_CHANGED_EVENT = 'bloxgen-key-changed';

/** API keys are local credentials and must use BloxGen's `BLOX-` prefix. */
export function isValidBloxGenApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^BLOX-\S+$/u.test(value.trim());
}

/** A disclosure-safe label for a configured API key. */
export function maskBloxGenApiKey(value: string): string {
  const trimmed = value.trim();
  if (!isValidBloxGenApiKey(trimmed)) return 'No configurada';
  const secretPart = trimmed.slice('BLOX-'.length);
  const suffix = secretPart.slice(-4);
  return `BLOX-${'•'.repeat(Math.max(4, Math.min(8, secretPart.length - suffix.length)))}${suffix}`;
}

/**
 * The account types BloxGen accepts, as the LITERAL wire values its API uses.
 *
 * These strings are sent verbatim as `/api/generate`'s `type` field and are the
 * keys of the `/api/stock` map, spaces and plus signs included — see
 * <https://docs.bloxgen.net/api-reference/stock>. They are not display labels;
 * {@link BLOXGEN_TYPE_LABEL_KEYS} maps each to a translatable one. The order
 * here is the order the picker lists them in.
 */
export const BLOXGEN_ACCOUNT_TYPES = [
  'alt',
  '+30 days old',
  '+1 year old',
  '5+ years old',
  'dump',
] as const;

/** One of BloxGen's generatable account types. */
export type BloxGenAccountType = (typeof BLOXGEN_ACCOUNT_TYPES)[number];

/**
 * What the Generator's picker holds: a concrete type, or `'random'`, which is
 * resolved to a concrete in-stock type at generate time. The API has no "any
 * type" mode — `type` is required — so `'random'` must be resolved client-side.
 */
export type BloxGenTypeSelection = BloxGenAccountType | 'random';

/**
 * i18n key for each wire value, so the UI never shows the raw API string.
 *
 * `as const` keeps the values as string literals rather than widening them to
 * `string`, which is what lets them be passed straight to the translator.
 */
export const BLOXGEN_TYPE_LABEL_KEYS = {
  'alt': 'gen.type.alt',
  '+30 days old': 'gen.type.days30',
  '+1 year old': 'gen.type.year1',
  '5+ years old': 'gen.type.years5',
  'dump': 'gen.type.dump',
} as const satisfies Record<BloxGenAccountType, string>;

/** Availability for one account type, as reported by `/api/stock`. */
export interface BloxGenStockEntry {
  type: BloxGenAccountType;
  /** Whether BloxGen currently has stock of this type. */
  available: boolean;
  /**
   * In-stock region codes. The API populates this on the Ultra plan only; on
   * every lower plan it is always empty.
   */
  regions: string[];
}

/** Narrow an unknown value to a plain record, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalize the backend's `{ status, body }` stock envelope into the entries the
 * picker renders.
 *
 * Returns `null` when the lookup did not produce a usable stock map (transport
 * failure, non-2xx, or `success !== true`) so the caller can distinguish "not
 * known yet" from "known to be empty".
 *
 * Types absent from the map are omitted rather than reported out of stock: the
 * API only returns the types the key's role may generate, so an absent type is
 * one this account cannot request at all.
 *
 * @param response - The value `ipc.bloxgenStock` resolved with.
 * @returns One entry per offered type, in {@link BLOXGEN_ACCOUNT_TYPES} order.
 */
export function normalizeBloxGenStock(response: unknown): BloxGenStockEntry[] | null {
  const body = asRecord(asRecord(response)?.body);
  if (!body || body.success !== true) return null;
  const data = asRecord(body.data);
  if (!data) return null;

  const entries: BloxGenStockEntry[] = [];
  for (const type of BLOXGEN_ACCOUNT_TYPES) {
    const raw = asRecord(data[type]);
    if (!raw) continue;
    entries.push({
      type,
      available: raw.available === true,
      regions: Array.isArray(raw.regions)
        ? raw.regions.filter((region): region is string => typeof region === 'string')
        : [],
    });
  }
  return entries;
}

/**
 * The type to preselect: the first one actually in stock, so a fresh visit never
 * starts on an option that would immediately fail with "No accounts available".
 * Falls back to the first offered type, then to `alt`, when nothing is in stock
 * or stock is not known yet.
 */
export function defaultAccountType(stock: BloxGenStockEntry[] | null): BloxGenAccountType {
  return (
    stock?.find((entry) => entry.available)?.type ??
    stock?.[0]?.type ??
    'alt'
  );
}

/**
 * Resolve a picker selection to the concrete type to request.
 *
 * `'random'` picks among the IN-STOCK types only, so it can never pick something
 * guaranteed to fail. When nothing is in stock it degrades to
 * {@link defaultAccountType} and lets the API report the real reason.
 *
 * @param selection - What the picker currently holds.
 * @param stock - Known stock, or `null` when the lookup has not succeeded.
 * @param pickIndex - Index chooser, injected so the choice is testable.
 */
export function resolveAccountType(
  selection: BloxGenTypeSelection,
  stock: BloxGenStockEntry[] | null,
  pickIndex: (count: number) => number = (count) => Math.floor(Math.random() * count),
): BloxGenAccountType {
  if (selection !== 'random') return selection;
  const available = (stock ?? []).filter((entry) => entry.available);
  if (available.length === 0) return defaultAccountType(stock);
  const index = Math.min(Math.max(pickIndex(available.length), 0), available.length - 1);
  return available[index].type;
}

/**
 * Whether a selection is known to be out of stock right now, so the UI can warn
 * before the request is spent. Unknown stock and `'random'` are never reported
 * as out of stock — `'random'` resolves to an available type by construction.
 */
export function isSelectionOutOfStock(
  selection: BloxGenTypeSelection,
  stock: BloxGenStockEntry[] | null,
): boolean {
  if (!stock || selection === 'random') return false;
  const entry = stock.find((candidate) => candidate.type === selection);
  return entry !== undefined && !entry.available;
}
