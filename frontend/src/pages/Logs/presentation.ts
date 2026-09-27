// pages/Logs/presentation.ts
//
// Pure presentation logic for the session console. The store stays the single
// source of truth; everything here derives display strings from one entry.
//
// RACKLINE: the stream is a table, so a line is no longer one flat string — it
// is three cells (timestamp | source | message). `logLineParts` is the shape
// the table renders and searches, and `formatLogLine` re-joins those exact
// parts into the single flat line used for "copy visible logs" (its output is
// byte-for-byte what it always was).

import type { LogEntry } from '@/stores/logStore';

/** Message shown when there are no session-log entries. */
export const EMPTY_LOG_MESSAGE = 'No log entries yet.';

/** Severity bucket a log entry falls into. */
export type LogTone = 'info' | 'success' | 'warning' | 'error';

/**
 * Short severity code rendered beside every message.
 *
 * Status is never encoded by colour alone: the gutter tick carries the tone and
 * this code carries the same information as text, so the stream stays readable
 * without colour vision (design spec §8).
 */
export const LOG_SEVERITY_CODE: Readonly<Record<LogTone, string>> = {
  info: 'INF',
  success: 'OK',
  warning: 'WRN',
  error: 'ERR',
};

/** Classify one entry into its severity bucket. */
export function logTone(entry: LogEntry): LogTone {
  const level = entry.level.toLowerCase();
  const category = entry.category.toLowerCase();
  if (
    level.includes('err') ||
    level.includes('fatal') ||
    category === 'crash' ||
    category === 'kill'
  ) {
    return 'error';
  }
  if (level.includes('warn')) return 'warning';
  if (level === 'ok' || level.includes('success') || category === 'launch') {
    return 'success';
  }
  return 'info';
}

/** One log entry split into the three cells of the stream table. */
export interface LogLineParts {
  /** `HH:MM:SS.mmm`, rendered mono + tabular. */
  readonly timestamp: string;
  /** Upper-cased originating category (`LAUNCH`, `CRASH`, `BROWSER`, …). */
  readonly source: string;
  /** The message plus its flattened `key=value` metadata. */
  readonly message: string;
}

/** Split one log entry into its timestamp / source / message cells. */
export function logLineParts(entry: LogEntry): LogLineParts {
  const at = new Date(entry.ts);
  const timestamp =
    at.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' +
    String(at.getMilliseconds()).padStart(3, '0');
  const source = String(entry.category ?? '').toUpperCase();
  const meta = entry.meta ?? {};
  const keys = Object.keys(meta).filter(
    (key) => meta[key] !== null && meta[key] !== undefined,
  );
  const metaText = keys.length
    ? '  ' + keys.map((key) => `${key}=${String(meta[key])}`).join(' ')
    : '';
  return { timestamp, source, message: `${entry.message}${metaText}` };
}

/** Format one log entry into a single flat console line (used for copying). */
export function formatLogLine(entry: LogEntry): string {
  const { timestamp, source, message } = logLineParts(entry);
  return `${timestamp}  ${source.padEnd(7)} ${message}`;
}
