import type { GenHistoryEntry } from '../types/models';

/** Final, cookie-free result persisted for one BloxGen pipeline run. */
export type GenerationResult = 'added' | 'rejected' | 'failed';

/** Pipeline step that produced the final result. */
export type GenerationStep = 'generate' | 'validate' | 'add';

/**
 * History shape used by the Generator page.
 *
 * It deliberately extends the backend-compatible legacy shape instead of
 * persisting the BloxGen response. In particular, there is no `cookie` field:
 * history is an audit trail, not a second credential vault.
 */
export interface SafeGenHistoryEntry extends GenHistoryEntry {
  result?: GenerationResult;
  step?: GenerationStep;
  message?: string;
  userId?: string;
}

/** Maximum audit rows retained by the frontend/backend history file. */
export const MAX_GEN_HISTORY = 500;

/**
 * Appends a result without mutating the previous history.
 *
 * The function remains generic so the original `GenHistoryEntry` property
 * contract and the richer, safe Generator entries share the same primitive.
 */
export function appendGenHistory<T extends GenHistoryEntry>(
  history: readonly T[],
  entry: T,
): T[] {
  return [...history, entry];
}

/** Keep only the most recent history entries without mutating the input. */
export function capGenHistory<T extends GenHistoryEntry>(
  history: readonly T[],
  limit = MAX_GEN_HISTORY,
): T[] {
  if (limit <= 0) return [];
  return history.slice(-limit);
}

/** Produces a fresh empty generation history. */
export function clearGenHistory<T extends GenHistoryEntry = GenHistoryEntry>(): T[] {
  return [];
}

function readString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : '';
}

function isGenerationResult(value: unknown): value is GenerationResult {
  return value === 'added' || value === 'rejected' || value === 'failed';
}

function isGenerationStep(value: unknown): value is GenerationStep {
  return value === 'generate' || value === 'validate' || value === 'add';
}

/**
 * Narrows persisted/legacy history into the safe UI shape.
 *
 * Each row is rebuilt field-by-field. Unknown properties (most importantly a
 * legacy `cookie`) are dropped, so loading and later re-saving old history can
 * never carry a full cookie forward.
 */
export function sanitizeGenHistory(raw: unknown): SafeGenHistoryEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((candidate): SafeGenHistoryEntry[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const record = candidate as Record<string, unknown>;
    const createdAt = readString(record, 'createdAt');
    if (!createdAt) return [];

    const entry: SafeGenHistoryEntry = {
      username: readString(record, 'username'),
      password: readString(record, 'password'),
      createdAt,
    };

    if (isGenerationResult(record.result)) entry.result = record.result;
    if (isGenerationStep(record.step)) entry.step = record.step;
    if (typeof record.message === 'string' && record.message.trim()) {
      entry.message = record.message.trim().slice(0, 180);
    }
    if (typeof record.userId === 'string' && record.userId.trim()) {
      entry.userId = record.userId.trim();
    }
    return [entry];
  });
}
