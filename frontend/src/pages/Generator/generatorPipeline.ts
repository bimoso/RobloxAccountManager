import type { Account } from '@/types/models';
import type { GenerationStep, SafeGenHistoryEntry } from '@/lib/genHistory';
import type { BloxGenAccountType } from '@/lib/bloxgen';

export { isValidBloxGenApiKey, maskBloxGenApiKey } from '@/lib/bloxgen';

// NOTE: the BloxGen endpoint URL deliberately lives ONLY in the Rust backend
// (`src-tauri/src/bloxgen.rs`). The request must not be made from this page —
// the webview enforces CORS and `core.bloxgen.net` sends no
// `Access-Control-Allow-Origin`, so an in-page `fetch` fails with
// "Failed to fetch". The pipeline receives a `generate` effect instead.

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
  /** `true` when the cookie is valid but the account is under moderation. */
  moderated?: boolean;
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
  /** `true` when the account was accepted despite being under moderation. */
  moderated: boolean;
  /**
   * `true` when the generated cookie was rejected and the account was instead
   * added by signing in with BloxGen's `user:pass` (the credential fallback).
   */
  usedCredentials?: boolean;
  historyEntry: SafeGenHistoryEntry;
}

/**
 * Normalized result of a humanized credential login (the backend
 * `roblox_login_credentials` command).
 */
export interface CredentialLoginOutcome {
  success: boolean;
  cookie?: string;
  username?: string;
  userId?: string;
  error?: string;
}

/** Narrow the untyped `ipc.loginCredentials` response into a {@link CredentialLoginOutcome}. */
export function normalizeCredentialLoginOutcome(raw: unknown): CredentialLoginOutcome {
  if (!raw || typeof raw !== 'object') return { success: false };
  const record = raw as Record<string, unknown>;
  const username = typeof record.username === 'string' ? record.username : undefined;
  const userId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.userId === 'number'
        ? String(record.userId)
        : undefined;
  const cookie = typeof record.cookie === 'string' ? record.cookie : undefined;
  return {
    success: record.success === true && !!cookie && username !== undefined,
    cookie,
    username,
    userId,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
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
  /**
   * Performs the BloxGen request. Supplied by the page (wired to the backend
   * `bloxgen_generate` command) so the call is never made from the webview,
   * where CORS blocks it.
   */
  generate: BloxGenGenerate;
  /**
   * Which account type to request. The page resolves the picker's selection
   * (including `'random'`, which the API has no equivalent for) to a concrete
   * type before calling. Defaults to `alt`, the type every role can generate.
   */
  accountType?: BloxGenAccountType;
  validate: (cookie: string) => Promise<unknown>;
  add: (account: Account) => Promise<void>;
  onPhase?: (phase: Exclude<GeneratorPhase, 'idle' | 'success' | 'error'>) => void;
  now?: () => Date;
  /**
   * When `true`, a generated cookie that is valid but MODERATED is accepted and
   * added (using the generated username), instead of failing validation. The
   * BloxGen-provided username is used since a moderated account resolves no
   * username of its own.
   */
  acceptModerated?: boolean;
  /**
   * When `true`, if the generated cookie is REJECTED by validation, fall back to
   * signing in with BloxGen's `username` / `password` (via
   * {@link GeneratorPipelineDeps.loginWithCredentials}) to obtain a fresh, valid
   * cookie instead of failing.
   */
  retryWithCredentials?: boolean;
  /**
   * Performs the humanized credential login (wired to `roblox_login_credentials`)
   * used by the {@link GeneratorPipelineDeps.retryWithCredentials} fallback.
   */
  loginWithCredentials?: (
    username: string,
    password: string,
  ) => Promise<CredentialLoginOutcome>;
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
    moderated: record.moderated === true,
  };
}

/** Build the backend-compatible account payload only after validation. */
export function buildGeneratedAccountPayload(
  validation: CookieValidation & { ok: true; username: string },
  generated: BloxGenGeneratedAccount,
  moderated = false,
): Account {
  return {
    id: '',
    username: validation.username,
    userId: validation.userId ?? '',
    nickname: '',
    cookie: generated.cookie,
    // BloxGen credentials belong to the generated login, even when Roblox
    // normalizes the display username during cookie validation. Keeping the
    // explicit login identifier makes the existing re-login flow deterministic.
    loginUsername: generated.username,
    password: generated.password,
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
    gameTarget: '',
    ...(moderated ? { moderated: true } : {}),
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

/**
 * Performs the BloxGen generation request and returns the HTTP status plus the
 * parsed body. This is injected (rather than calling `fetch` here) because the
 * request MUST run in the Rust backend: the webview enforces CORS and
 * `core.bloxgen.net` sends no `Access-Control-Allow-Origin`, so a direct
 * in-page `fetch` fails with "Failed to fetch".
 */
export type BloxGenGenerate = (
  apiKey: string,
  accountType: string,
) => Promise<{ status: number; body: unknown }>;

/** Narrow the untyped `ipc.bloxgenGenerate` response into `{ status, body }`. */
export function normalizeBloxGenResponse(raw: unknown): { status: number; body: unknown } {
  if (!raw || typeof raw !== 'object') return { status: 0, body: null };
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === 'number' ? record.status : 0;
  return { status, body: record.body ?? null };
}

/**
 * Whether `body` is a genuine BloxGen API response. Every documented response —
 * success or failure — carries a top-level `success` boolean. An error body
 * WITHOUT it did not come from the API itself but from the infrastructure in
 * front of it (e.g. Railway's `{"status":"error","code":404,"message":
 * "Application not found"}` when no app is deployed at the host), which must be
 * reported as an outage rather than as a rejected request.
 */
function isBloxGenApiBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && 'success' in (body as Record<string, unknown>);
}

/**
 * Build the failure message for a rejected generation, preferring the API's own
 * `message` and enriching the 429 cooldown case with the remaining seconds
 * (the API returns `timeRemaining` in milliseconds). A response that did not
 * come from the API at all is reported as a service outage.
 */
function generationFailureMessage(status: number, body: unknown, apiMessage: string): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  // The host answered, but not with a BloxGen payload: their service is down.
  if (!isBloxGenApiBody(body)) {
    return 'BloxGen no está disponible ahora mismo (su servidor no responde). Inténtalo más tarde.';
  }

  if (status === 429 && typeof record.timeRemaining === 'number' && record.timeRemaining > 0) {
    const seconds = Math.ceil(record.timeRemaining / 1000);
    return apiMessage
      ? `${apiMessage} (espera ${seconds}s)`
      : `Espera ${seconds}s antes de generar otra cuenta.`;
  }
  if (apiMessage) return apiMessage;
  return status >= 500
    ? 'BloxGen tuvo un error interno. Inténtalo más tarde.'
    : `BloxGen respondió con estado ${status}.`;
}

/**
 * Calls the BloxGen endpoint and returns only the fields the pipeline needs.
 *
 * @param accountType - The wire value for the API's required `type` field. The
 *   caller resolves this from the picker (including `'random'`), so by the time
 *   it arrives here it is always one concrete type.
 */
export async function requestBloxGenAccount(
  apiKey: string,
  generate: BloxGenGenerate,
  accountType: BloxGenAccountType = 'alt',
): Promise<BloxGenGeneratedAccount> {
  let status: number;
  let raw: unknown;
  try {
    ({ status, body: raw } = await generate(apiKey, accountType));
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : '';
    throw new Error(detail || 'No se pudo contactar con BloxGen.');
  }

  const generatedForRedaction = extractBloxGenAccount(raw);
  const apiMessage = redactSecrets(responseMessage(raw), [
    apiKey,
    generatedForRedaction?.cookie ?? '',
  ]);

  const httpOk = status >= 200 && status < 300;
  if (!httpOk) {
    throw new Error(generationFailureMessage(status, raw, apiMessage));
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
    generated = await requestBloxGenAccount(apiKey, deps.generate, deps.accountType);
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

  // Accept a valid-but-moderated cookie when the toggle is on: a moderated
  // account resolves no username of its own, so reuse BloxGen's generated
  // username. Otherwise a non-ok validation is a genuine rejection.
  const acceptedModerated =
    !validation.ok &&
    validation.moderated === true &&
    deps.acceptModerated === true &&
    generated.username.length > 0;

  const effective: (CookieValidation & { ok: true; username: string }) | null =
    validation.ok && validation.username
      ? (validation as CookieValidation & { ok: true; username: string })
      : acceptedModerated
        ? { ok: true, username: generated.username, userId: validation.userId }
        : null;

  if (!effective) {
    // Credential fallback: the generated cookie was rejected, but BloxGen also
    // returned a username + password. If enabled, sign in with those to obtain a
    // fresh, valid cookie (and store the credentials for future re-login).
    if (
      deps.retryWithCredentials &&
      deps.loginWithCredentials &&
      generated.username.length > 0 &&
      generated.password.length > 0
    ) {
      const login = await deps
        .loginWithCredentials(generated.username, generated.password)
        .catch(() => null);
      if (login && login.success && login.cookie && login.username) {
        const credValid: CookieValidation & { ok: true; username: string } = {
          ok: true,
          username: login.username,
          userId: login.userId,
        };
        const credGenerated: BloxGenGeneratedAccount = { ...generated, cookie: login.cookie };
        deps.onPhase?.('adding');
        try {
          await deps.add(buildGeneratedAccountPayload(credValid, credGenerated, false));
        } catch {
          const message = 'Se inició sesión con user/contraseña, pero no se pudo guardar. Reintenta.';
          return {
            ok: false,
            failedAt: 'add',
            message,
            generated,
            historyEntry: safeFailureEntry('add', message, createdAt, generated),
          };
        }
        return {
          ok: true,
          generated: credGenerated,
          validation: credValid,
          moderated: false,
          usedCredentials: true,
          historyEntry: {
            username: login.username,
            password: generated.password,
            createdAt,
            result: 'added',
            step: 'add',
            message: 'Cookie rechazada; se inició sesión con user/contraseña y se añadió.',
            userId: login.userId,
          },
        };
      }
    }

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
    await deps.add(buildGeneratedAccountPayload(effective, generated, acceptedModerated));
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

  const valid = effective;
  return {
    ok: true,
    generated,
    validation: valid,
    moderated: acceptedModerated,
    historyEntry: {
      username: valid.username,
      password: generated.password,
      createdAt,
      result: 'added',
      step: 'add',
      message: acceptedModerated
        ? 'Cuenta moderada aceptada y añadida automáticamente.'
        : 'Cookie validada y cuenta añadida automáticamente.',
      userId: valid.userId,
    },
  };
}
