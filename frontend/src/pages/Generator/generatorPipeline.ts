import type { Account } from '@/types/models';
import type { GenerationStep, SafeGenHistoryEntry } from '@/lib/genHistory';

export { isValidBloxGenApiKey, maskBloxGenApiKey } from '@/lib/bloxgen';

export const BLOXGEN_ENDPOINT = 'https://core.bloxgen.net/api/generate';

/** Account material returned by BloxGen before Roblox validates the cookie. */
export interface BloxGenGeneratedAccount {
  cookie: string;
  username: string;
  password: string;
}

/** Narrowed shape returned by the Roblox cookie validation command. */
export interface CookieValidation {
  ok: boolean;
  reason?: string;
  username?: string;
  userId?: string;
}

export type GeneratorPhase =
  | 'idle'
  | 'generating'
  | 'validating'
  | 'adding'
  | 'success'
  | 'error';

export interface GeneratorPipelineSuccess {
  ok: true;
  generated: BloxGenGeneratedAccount;
  validation: CookieValidation & { ok: true; username: string };
  historyEntry: SafeGenHistoryEntry;
}

export interface GeneratorPipelineFailure {
  ok: false;
  failedAt: GenerationStep;
  message: string;
  generated?: BloxGenGeneratedAccount;
  historyEntry: SafeGenHistoryEntry;
}

export type GeneratorPipelineOutcome =
  | GeneratorPipelineSuccess
  | GeneratorPipelineFailure;

export interface GeneratorPipelineDeps {
  fetcher?: typeof fetch;
  validate: (cookie: string) => Promise<unknown>;
  add: (account: Account) => Promise<void>;
  onPhase?: (phase: Exclude<GeneratorPhase, 'idle' | 'success' | 'error'>) => void;
  now?: () => Date;
}

/** Treat malformed validation responses as invalid instead of guessing. */
export function normalizeGeneratorValidation(raw: unknown): CookieValidation {
  if (!raw || typeof raw !== 'object') return { ok: false };
  const record = raw as Record<string, unknown>;
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  const userId = typeof record.userId === 'number'
    ? String(record.userId)
    : typeof record.userId === 'string'
      ? record.userId
      : undefined;
  return {
    ok: record.ok === true && username.length > 0,
    username: username || undefined,
    userId,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

/** Build the backend-compatible account payload only after validation. */
export function buildGeneratedAccountPayload(
  validation: CookieValidation & { ok: true; username: string },
  cookie: string,
): Account {
  return {
    id: '',
    username: validation.username,
    userId: validation.userId ?? '',
    nickname: '',
    cookie,
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
    gameTarget: '',
  };
}

function recordsBreadthFirst(root: unknown): Record<string, unknown>[] {
  if (!root || typeof root !== 'object') return [];
  const records: Record<string, unknown>[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !current.value || typeof current.value !== 'object') continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.depth < 4) {
        current.value.forEach((value) => queue.push({ value, depth: current.depth + 1 }));
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    records.push(record);
    if (current.depth < 4) {
      Object.values(record).forEach((value) => {
        if (value && typeof value === 'object') {
          queue.push({ value, depth: current.depth + 1 });
        }
      });
    }
  }
  return records;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/gu, '');
}

function findKnownString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string {
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === 'string' &&
        value.trim() &&
        keys.includes(normalizedKey(key))
      ) {
        return value.trim();
      }
    }
  }
  return '';
}

/**
 * Extracts generated credentials from the current and legacy BloxGen response
 * envelopes. Only known credential keys are considered; arbitrary response
 * text is never mistaken for a cookie.
 */
export function extractBloxGenAccount(raw: unknown): BloxGenGeneratedAccount | null {
  const records = recordsBreadthFirst(raw);
  const cookie = findKnownString(records, [
    'cookie',
    'robloxcookie',
    'roblosecurity',
    'securitycookie',
  ]);
  if (!cookie) return null;

  return {
    cookie,
    username: findKnownString(records, ['username', 'user', 'login']),
    password: findKnownString(records, ['password', 'pass']),
  };
}

function responseMessage(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return '';
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets.reduce((safe, secret) => {
    const trimmed = secret.trim();
    return trimmed ? safe.split(trimmed).join('[credencial oculta]') : safe;
  }, message);
}

/** Calls the BloxGen endpoint and returns only the fields the pipeline needs. */
export async function requestBloxGenAccount(
  apiKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<BloxGenGeneratedAccount> {
  const response = await fetcher(BLOXGEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: apiKey.trim(), type: 'alt' }),
  });

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error('BloxGen devolvió una respuesta que no se pudo leer.');
  }

  const generatedForRedaction = extractBloxGenAccount(raw);
  const apiMessage = redactSecrets(responseMessage(raw), [
    apiKey,
    generatedForRedaction?.cookie ?? '',
  ]);

  if (!response.ok) {
    throw new Error(apiMessage || `BloxGen respondió con estado ${response.status}.`);
  }
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).success === false) {
    throw new Error(apiMessage || 'BloxGen rechazó la generación.');
  }

  const generated = generatedForRedaction;
  if (!generated) {
    throw new Error('BloxGen no devolvió una cookie para validar.');
  }
  return generated;
}

function safeFailureEntry(
  step: GenerationStep,
  message: string,
  createdAt: string,
  generated?: BloxGenGeneratedAccount,
): SafeGenHistoryEntry {
  return {
    username: generated?.username ?? '',
    password: generated?.password ?? '',
    createdAt,
    result: step === 'validate' ? 'rejected' : 'failed',
    step,
    message,
  };
}

/**
 * Executes Generate → Validate → Add in strict order.
 *
 * `add` is unreachable until `validate` resolves with a normalized, valid
 * username. That invariant is kept here, outside React, so UI refactors cannot
 * accidentally save an unverified cookie.
 */
export async function runGeneratorPipeline(
  apiKey: string,
  deps: GeneratorPipelineDeps,
): Promise<GeneratorPipelineOutcome> {
  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  let generated: BloxGenGeneratedAccount;

  deps.onPhase?.('generating');
  try {
    generated = await requestBloxGenAccount(apiKey, deps.fetcher);
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'No se pudo generar la cuenta.';
    return {
      ok: false,
      failedAt: 'generate',
      message,
      historyEntry: safeFailureEntry('generate', message, createdAt),
    };
  }

  deps.onPhase?.('validating');
  let validation: CookieValidation;
  try {
    validation = normalizeGeneratorValidation(await deps.validate(generated.cookie));
  } catch {
    const message = 'Roblox no pudo validar la cookie generada. Intenta de nuevo.';
    return {
      ok: false,
      failedAt: 'validate',
      message,
      generated,
      historyEntry: safeFailureEntry('validate', message, createdAt, generated),
    };
  }

  if (!validation.ok || !validation.username) {
    const message = 'Roblox rechazó la cookie generada; no se añadió ninguna cuenta.';
    return {
      ok: false,
      failedAt: 'validate',
      message,
      generated,
      historyEntry: safeFailureEntry('validate', message, createdAt, generated),
    };
  }

  deps.onPhase?.('adding');
  try {
    await deps.add(
      buildGeneratedAccountPayload(
        validation as CookieValidation & { ok: true; username: string },
        generated.cookie,
      ),
    );
  } catch {
    const message = 'La cookie era válida, pero no se pudo guardar la cuenta. Reintenta.';
    return {
      ok: false,
      failedAt: 'add',
      message,
      generated,
      historyEntry: safeFailureEntry('add', message, createdAt, generated),
    };
  }

  const valid = validation as CookieValidation & { ok: true; username: string };
  return {
    ok: true,
    generated,
    validation: valid,
    historyEntry: {
      username: valid.username,
      password: generated.password,
      createdAt,
      result: 'added',
      step: 'add',
      message: 'Cookie validada y cuenta añadida automáticamente.',
      userId: valid.userId,
    },
  };
}
