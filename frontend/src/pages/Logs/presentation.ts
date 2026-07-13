import type { LogEntry } from '@/stores/logStore';

/** Message shown when there are no session-log entries. */
export const EMPTY_LOG_MESSAGE = 'No log entries yet.';

/** Format one log entry into the searchable console line. */
export function formatLogLine(entry: LogEntry): string {
  const t = new Date(entry.ts);
  const ts =
    t.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' +
    String(t.getMilliseconds()).padStart(3, '0');
  const cat = String(entry.category ?? '').toUpperCase().padEnd(7);
  const meta = entry.meta ?? {};
  const keys = Object.keys(meta).filter(
    (key) => meta[key] !== null && meta[key] !== undefined,
  );
  const metaText = keys.length
    ? '  ' + keys.map((key) => `${key}=${String(meta[key])}`).join(' ')
    : '';
  return `${ts}  ${cat} ${entry.message}${metaText}`;
}
