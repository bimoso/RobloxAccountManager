/**
 * Persistence layer.
 *
 * All localStorage reads and writes in the React_Frontend pass through this
 * module. Every operation is wrapped in `try/catch` so a storage failure
 * (quota exceeded, disabled storage, corrupted value, serialization error)
 * never throws and never blocks or degrades the UI.
 *
 * Design references:
 * - Requirement 3.6: if a preference cannot be written, the selection is kept
 *   in memory for the session and the rest of the interface keeps working.
 * - Requirement 27.1: the selected theme, accounts view, active filter and
 *   BloxGen API key are persisted in the browser's local storage.
 * - Requirement 27.2: on startup each persisted preference is restored before
 *   the user interacts with its control (via {@link getPersisted}).
 *
 * Values are stored JSON-encoded so the helpers are generic and type-safe for
 * strings, booleans, numbers, and the structured launch-metadata objects.
 */

/**
 * Known localStorage schema keys used by the React_Frontend.
 *
 * `getPersisted` / `setPersisted` accept any `string` key so the helpers stay
 * reusable, but the documented UI-preference keys are collected here to keep
 * the schema discoverable in one place.
 */
export const PERSISTENCE_KEYS = {
  /** Active theme name (Requirement 3.3, 3.4, 27.1). */
  theme: 'ui-theme',
  /** Active interface language ('en' | 'es'). */
  language: 'ui-language',
  /** Accounts page layout: grid or list (Requirement 27.1). */
  view: 'ui-view',
  /** Active accounts filter (Requirement 27.1). */
  filter: 'ui-filter',
  /** BloxGen API key (Requirement 27.1). */
  bloxgenApiKey: 'bloxgen-api-key',
  /** Whether to accept moderated accounts when adding/generating (boolean). */
  acceptModerated: 'accept-moderated',
  /** Whether the generator retries with user:pass when the cookie is rejected (boolean). */
  generatorRetryCredentials: 'generator-retry-credentials',
  /** Generator account type to request: a BloxGen wire type, or 'random'. */
  generatorAccountType: 'generator-account-type',
  /** Selected click-sound profile id (Requirement 22.1, 22.2). */
  soundProfile: 'sound-profile',
  /** Click-sound volume, 0..1 (Requirement 22.3). */
  soundVolume: 'sound-volume',
  /** Shared favorites/recent Places used by Charts and the session launcher. */
  placeLibrary: 'roblox-place-library-v1',
} as const;

/** A documented UI-preference key. */
export type PersistenceKey =
  (typeof PERSISTENCE_KEYS)[keyof typeof PERSISTENCE_KEYS];

/**
 * Read a persisted value from local storage.
 *
 * Never throws. Returns `undefined` when the key is absent, when storage is
 * unavailable, or when the stored value cannot be parsed.
 *
 * @typeParam T - Expected shape of the stored value.
 * @param key - The storage key to read.
 * @returns The parsed value, or `undefined` on a miss or any failure.
 */
export function getPersisted<T = string>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return undefined;
    }
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write a value to local storage.
 *
 * Never throws. On any failure (storage unavailable, quota exceeded,
 * serialization error) the call is a silent no-op so the caller can keep the
 * value in memory for the current session (Requirement 3.6).
 *
 * @typeParam T - Shape of the value being stored.
 * @param key - The storage key to write.
 * @param value - The value to persist; serialized as JSON.
 */
export function setPersisted<T = string>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Intentionally ignored: persistence failures must never block the UI.
  }
}

/**
 * Remove a persisted value from local storage.
 *
 * Never throws. On any failure the call is a silent no-op.
 *
 * @param key - The storage key to remove.
 */
export function removePersisted(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Intentionally ignored: persistence failures must never block the UI.
  }
}
