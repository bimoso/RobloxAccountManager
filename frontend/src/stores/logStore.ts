// stores/logStore.ts
//
// Log_Store (Requirement 23 — Registro de sesión / Logs).
//
// Owns the in-memory, chronological session log shown on the Logs page. It is
// fed by the `log://entry` IPC_Event: every time the Tauri_Backend emits a log
// record, the subscription normalizes the payload and appends it to the buffer
// (Requirement 23.1). The buffer is bounded to the most recent
// {@link MAX_LOG_ENTRIES} entries; older entries are dropped once that limit is
// exceeded (Requirement 23.2).
//
// The append logic itself lives in the PURE reducer `appendLogEntry` below.
// Keeping it pure and side-effect free is what lets Property 41 exercise it
// directly (property-tested in task 26.2): applying `appendLogEntry` repeatedly
// over N inputs must yield a list of length `min(N, MAX_LOG_ENTRIES)` that, when
// `N > MAX_LOG_ENTRIES`, equals exactly the last `MAX_LOG_ENTRIES` inputs in
// arrival order.
//
// The Ctrl+F search bar / `findMatches` UI over the visible log is a separate
// concern (task 26.3) and is deliberately NOT implemented here.

import { create } from 'zustand';
import { ipc } from '../lib/ipc';
import type { UnlistenFn } from '../types/window';

/**
 * Maximum number of session-log lines retained in memory. The buffer keeps only
 * the most recent {@link MAX_LOG_ENTRIES} entries, discarding the oldest when
 * this limit is exceeded (Requirement 23.2).
 */
export const MAX_LOG_ENTRIES = 2000;

/**
 * The known session-log categories, mirroring the legacy renderer's `LOG_CATS`
 * (`src/renderer.js`) and the Requirement 23 timeline categories: launch
 * (lanzamiento), crash (caída), kill, close (cierre), cookie, afk, enc
 * (cifrado), system (sistema) and browser (navegador).
 */
export type LogCategory =
  | 'launch'
  | 'crash'
  | 'kill'
  | 'close'
  | 'cookie'
  | 'afk'
  | 'enc'
  | 'system'
  | 'browser';

/**
 * A single session-log record.
 *
 * Field names and shape mirror the `log://entry` payload emitted by the
 * Tauri_Backend (`src-tauri/src/logging.rs` `LogEntry`) and consumed by the
 * legacy renderer (`src/renderer.js`:
 * `api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta))`).
 *
 * `category` is typed as a wide `string` (not the {@link LogCategory} union) so
 * an unrecognized backend category is preserved verbatim rather than dropped.
 */
export interface LogEntry {
  /** Emission timestamp in epoch milliseconds (backend: `Date.now()`). */
  ts: number;
  /** Severity level (e.g. `ok`, `info`, `warn`, `err`), carried through unchanged. */
  level: string;
  /** Log category (see {@link LogCategory}), carried through unchanged. */
  category: string;
  /** Human-readable message text. */
  message: string;
  /** Structured metadata; defaults to an empty object when none was supplied. */
  meta: Record<string, unknown>;
}

/**
 * PURE bounded-buffer reducer: append `entry` to `buffer` and truncate the
 * result to at most `maxSize` entries, dropping the OLDEST (front) entries when
 * the limit is exceeded.
 *
 * Neither `buffer` nor `entry` is mutated; a new array is always returned.
 *
 * Follows Property 41's exact semantics: applying this reducer repeatedly over a
 * sequence of N entries yields a list of length `min(N, maxSize)`, and when
 * `N > maxSize` that list equals exactly the last `maxSize` entries of the input
 * sequence, in the order they arrived. A non-positive `maxSize` yields an empty
 * buffer.
 *
 * @param buffer - The current (already-bounded) log buffer.
 * @param entry - The newly received log entry to append at the end.
 * @param maxSize - The maximum retained length (defaults to {@link MAX_LOG_ENTRIES}).
 * @returns A new bounded buffer with `entry` appended.
 */
export function appendLogEntry(
  buffer: LogEntry[],
  entry: LogEntry,
  maxSize: number = MAX_LOG_ENTRIES,
): LogEntry[] {
  if (maxSize <= 0) {
    return [];
  }
  const next = [...buffer, entry];
  if (next.length > maxSize) {
    // Keep the most-recent tail: drop from the front (oldest) so the returned
    // list is exactly the last `maxSize` entries in arrival order.
    return next.slice(next.length - maxSize);
  }
  return next;
}

/**
 * Normalize an untyped `log://entry` payload into a {@link LogEntry}.
 *
 * The IPC surface types the payload as `unknown`, so each field is read
 * defensively and coerced to the expected type, with the same defaulting the
 * backend/legacy renderer use (`meta || {}`). This keeps a malformed or partial
 * payload from corrupting the typed buffer.
 *
 * @param payload - The raw `log://entry` event payload.
 * @returns A well-formed {@link LogEntry}.
 */
export function toLogEntry(payload: unknown): LogEntry {
  const p = (payload ?? {}) as Record<string, unknown>;
  const meta =
    typeof p.meta === 'object' && p.meta !== null
      ? (p.meta as Record<string, unknown>)
      : {};
  return {
    ts: typeof p.ts === 'number' ? p.ts : Date.now(),
    level: typeof p.level === 'string' ? p.level : '',
    category: typeof p.category === 'string' ? p.category : '',
    message: typeof p.message === 'string' ? p.message : '',
    meta,
  };
}

/** Public shape of the Log_Store. */
export interface LogState {
  /** The bounded, chronological session log (oldest first, newest last). */
  entries: LogEntry[];

  /**
   * Append a single log entry through the pure {@link appendLogEntry} reducer,
   * keeping the buffer bounded to {@link MAX_LOG_ENTRIES} (Requirements 23.1,
   * 23.2).
   *
   * @param entry - The log entry to append.
   */
  append: (entry: LogEntry) => void;

  /**
   * Subscribe to the `log://entry` IPC_Event and append every received record
   * to the buffer (Requirement 23.1). The raw payload is normalized via
   * {@link toLogEntry} before being appended.
   *
   * Registered once during app setup; the returned {@link UnlistenFn} tears the
   * subscription down (App wiring, task 29.6).
   *
   * @returns A promise resolving to the unlisten handle.
   */
  subscribe: () => Promise<UnlistenFn>;
}

export const useLogStore = create<LogState>((set) => ({
  entries: [],

  append: (entry) => {
    set((state) => ({ entries: appendLogEntry(state.entries, entry) }));
  },

  subscribe: async () => {
    const unlisten = await ipc.onLogEntry((payload) => {
      set((state) => ({
        entries: appendLogEntry(state.entries, toLogEntry(payload)),
      }));
    });
    return unlisten;
  },
}));
