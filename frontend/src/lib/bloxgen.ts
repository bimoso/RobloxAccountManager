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
