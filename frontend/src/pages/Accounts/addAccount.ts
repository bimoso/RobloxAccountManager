// pages/Accounts/addAccount.ts
//
// Pure, dependency-injected orchestration for the "Añadir cuenta" flow
// (Requirement 13). Kept free of React and of `window.api` so it can be
// property-tested in isolation (Property 25) by injecting `validate`/`add`
// effects whose success/failure pattern the test controls.
//
// The `AddAccountModal` component wires the real effects here:
//   - `validate` → `ipc.validateCookie` (normalized via `normalizeValidation`)
//   - `add`      → build an account payload and hand it to `accountStore.add`
//
// Nothing in this module touches the DOM, timers, or IPC directly.

import type { Account } from '../../types/models';

/**
 * Normalized result of validating a single cookie.
 *
 * Mirrors the shape the backend's cookie-validation command already returns
 * (`{ ok, reason?, username?, userId? }`, from the retired renderer), narrowed from
 * the untyped `ipc.validateCookie` response by {@link normalizeValidation}.
 */
export interface CookieValidation {
  /** Whether the cookie authenticated successfully. */
  ok: boolean;
  /** Backend-provided failure reason, when the cookie is invalid. */
  reason?: string;
  /** Roblox username resolved from the cookie, when valid. */
  username?: string;
  /** Roblox user id resolved from the cookie, when valid. */
  userId?: string;
  /**
   * `true` when the cookie authenticated but the account is under moderation
   * (a valid cookie, not a rejected one). Callers may accept these when the
   * "accept moderated accounts" toggle is on.
   */
  moderated?: boolean;
}

/**
 * A single failed cookie in a batch run, identifying WHICH cookie failed
 * (Requirement 13.5). Both the zero-based `index` (position in the input list)
 * and the raw `cookie` string are carried so the UI can point at the exact
 * entry the user pasted.
 */
export interface BatchFailure {
  /** Zero-based position of the cookie in the input list. */
  index: number;
  /** The exact cookie string that failed, identifying which one. */
  cookie: string;
  /** Human-readable reason, already identifying the cookie by its number. */
  reason: string;
}

/**
 * Summary of a completed batch run over pasted cookies (Property 25).
 *
 * `added` equals the number of valid cookies that were added successfully, and
 * `failures` holds one entry per cookie that could not be added, each
 * identifying the offending cookie.
 */
export interface BatchSummary {
  /** Total number of cookies processed (the length of the input list). */
  total: number;
  /** Number of cookies that validated and were added successfully. */
  added: number;
  /** One entry per failed cookie, in input order. */
  failures: BatchFailure[];
}

/** The stage of processing a single cookie, reported to `onProgress`. */
export type BatchPhase = 'validating' | 'adding';

/**
 * Progress event emitted before each per-cookie step so the UI can show the
 * progress of each cookie before moving on to the next (Requirement 13.4).
 */
export interface BatchProgressEvent {
  /** Zero-based index of the cookie currently being processed. */
  index: number;
  /** Total number of cookies in the run. */
  total: number;
  /** The cookie currently being processed. */
  cookie: string;
  /** Which step is starting for this cookie. */
  phase: BatchPhase;
}

/**
 * Effects injected into {@link processBatchCookies}. The modal wires the real
 * IPC/store effects; a property test injects controlled mocks.
 */
export interface ProcessBatchDeps {
  /**
   * Validate a single cookie. Invoked exactly once per cookie, awaited before
   * the next cookie is touched (sequential, no overlap — Requirement 13.4).
   */
  validate: (cookie: string) => Promise<CookieValidation> | CookieValidation;
  /**
   * Add a validated account. Invoked only for cookies that validated
   * successfully, awaited before continuing.
   */
  add: (
    validation: CookieValidation,
    cookie: string,
    index: number,
  ) => Promise<void> | void;
  /** Optional progress callback, invoked before each per-cookie step. */
  onProgress?: (event: BatchProgressEvent) => void;
  /**
   * When `true`, a cookie that is valid but MODERATED is added instead of being
   * counted as a failure (the account resolves no username of its own, so `add`
   * receives a validation whose `username` may be absent but `moderated` is set).
   */
  acceptModerated?: boolean;
}

/**
 * Build the human-readable label identifying a cookie by its position.
 *
 * Pure and deterministic so the batch summary and the property test agree on
 * how an invalid cookie is identified.
 *
 * @param index - Zero-based index of the cookie in the input list.
 * @returns A 1-based label such as `"Cookie #3"`.
 */
export function cookieLabel(index: number): string {
  return `Cookie #${index + 1}`;
}

/**
 * Build the error message for an invalid/failed cookie, always identifying the
 * cookie by its number (Requirement 13.5) and appending the backend reason when
 * one is available.
 *
 * @param index - Zero-based index of the failing cookie.
 * @param reason - Optional backend-provided reason.
 * @returns The composed error message.
 */
export function invalidCookieMessage(index: number, reason?: string): string {
  const label = cookieLabel(index);
  const trimmed = reason?.trim();
  return trimmed ? `${label}: ${trimmed}` : `${label}: cookie no válida.`;
}

/**
 * Extract a message from a thrown value, falling back to an entry-identifying
 * default so a rejected effect still names the offending entry. `label`
 * defaults to the cookie label so existing callers keep their wording; the combo
 * flow passes {@link comboLabel} to say "Cuenta #N" instead.
 */
function describeError(
  err: unknown,
  index: number,
  label: (index: number) => string = cookieLabel,
): string {
  if (err instanceof Error && err.message.trim()) {
    return `${label(index)}: ${err.message.trim()}`;
  }
  if (typeof err === 'string' && err.trim()) {
    return `${label(index)}: ${err.trim()}`;
  }
  return `${label(index)}: error desconocido.`;
}

/**
 * Normalize the untyped `ipc.validateCookie` response into a
 * {@link CookieValidation}.
 *
 * The backend returns `{ ok, reason?, username?, userId? }` (see
 * the retired renderer); this narrows the `unknown` typed response defensively so
 * a malformed/empty response is treated as an invalid cookie rather than
 * throwing.
 *
 * @param raw - The raw response from `ipc.validateCookie`.
 * @returns The normalized validation result.
 */
export function normalizeValidation(raw: unknown): CookieValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false };
  }
  const record = raw as Record<string, unknown>;
  const username =
    typeof record.username === 'string' ? record.username : undefined;
  const userId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.userId === 'number'
        ? String(record.userId)
        : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const moderated = record.moderated === true;
  // A cookie is considered valid when the backend says `ok` AND a username was
  // resolved (the field the add payload requires).
  const ok = record.ok === true && username !== undefined;
  return { ok, reason, username, userId, moderated };
}

// Moderation helpers live in `@/lib/moderation` so the Generator can share them
// without a cross-page import; re-exported here for the Accounts add flows.
export {
  moderationLabel,
  normalizeModerationInfo,
  type ModerationInfo,
} from '@/lib/moderation';

/**
 * Build the account payload sent to `accounts_add` from a validated cookie.
 *
 * Mirrors the legacy renderer's payload (`{ username, userId, cookie,
 * gameTarget: '', nickname: '' }`): the backend mints the authoritative `id`,
 * `createdAt`, etc. and returns the full account, so the client-side fields
 * here are placeholders overridden by the backend response.
 *
 * @param validation - A successful cookie validation (username present).
 * @param cookie - The raw cookie string being added.
 * @returns The account payload to hand to the Account_Store `add` action.
 */
export function buildAccountToAdd(
  validation: CookieValidation,
  cookie: string,
  options?: { loginUsername?: string; password?: string; moderated?: boolean },
): Account {
  return {
    id: '',
    username: validation.username ?? '',
    userId: validation.userId ?? '',
    nickname: '',
    cookie,
    // Attach saved login credentials when provided (from a user:pass[:cookie]
    // add); omitted for the plain cookie flows, which leave them blank.
    password: options?.password ?? '',
    loginUsername: options?.loginUsername,
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
    gameTarget: '',
    // Flag accounts added despite Roblox moderation so the UI can mark them.
    ...(options?.moderated ? { moderated: true } : {}),
  };
}

/**
 * Process a batch of pasted cookies SEQUENTIALLY (Requirement 13.4, 13.5;
 * Property 25).
 *
 * For every cookie in `cookies`, in input order:
 *   1. Emits a `'validating'` progress event, then invokes `validate` exactly
 *      once and awaits it before touching the next cookie (no overlap between
 *      consecutive validations).
 *   2. If the cookie is invalid (or `validate` throws), records a
 *      {@link BatchFailure} identifying that cookie and CONTINUES with the rest
 *      — one cookie's failure never stops another from being processed.
 *   3. If the cookie is valid, emits an `'adding'` progress event and invokes
 *      `add`; a successful add increments `added`.
 *
 * On completion `added` equals the number of cookies that validated and were
 * added successfully, and `failures` contains one entry per cookie that could
 * not be added.
 *
 * @param cookies - The cookies to process, in the order the user pasted them.
 * @param deps - The injected `validate` / `add` / `onProgress` effects.
 * @returns A {@link BatchSummary} of the run.
 */
export async function processBatchCookies(
  cookies: readonly string[],
  deps: ProcessBatchDeps,
): Promise<BatchSummary> {
  const { validate, add, onProgress, acceptModerated } = deps;
  const total = cookies.length;
  const failures: BatchFailure[] = [];
  let added = 0;

  for (let index = 0; index < total; index += 1) {
    const cookie = cookies[index];

    onProgress?.({ index, total, cookie, phase: 'validating' });
    let validation: CookieValidation;
    try {
      validation = await validate(cookie);
    } catch (err) {
      failures.push({ index, cookie, reason: describeError(err, index) });
      continue;
    }

    // A moderated cookie is valid but resolves no username; accept it when the
    // toggle is on, otherwise it (and any genuinely invalid cookie) is a failure.
    const moderatedAccept = validation.moderated === true && acceptModerated === true;
    if ((!validation.ok || !validation.username) && !moderatedAccept) {
      failures.push({
        index,
        cookie,
        reason: invalidCookieMessage(index, validation.reason),
      });
      continue;
    }

    onProgress?.({ index, total, cookie, phase: 'adding' });
    try {
      await add(validation, cookie, index);
      added += 1;
    } catch (err) {
      failures.push({ index, cookie, reason: describeError(err, index) });
    }
  }

  return { total, added, failures };
}

/**
 * Split a pasted multi-line cookie blob into individual cookies.
 *
 * Trims each line and drops empty ones so blank lines the user leaves between
 * pasted cookies don't count as (failing) entries. Pure so the modal and any
 * test share the exact same parsing.
 *
 * @param raw - The raw textarea contents.
 * @returns The non-empty, trimmed cookies in their original order.
 */
export function parseCookieLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ── Credential flow (user:pass, user:pass:cookie, humanized auto-login) ──────
//
// The credential flow imports accounts from `username:password` credentials, and
// optionally an inline cookie (`username:password:cookie`). Per pasted entry the
// modal decides how to obtain a valid session and whether to add a new account
// or attach the credentials to an existing one (upsert by username):
//   - has an inline cookie → validate it directly;
//   - matches an existing account → no login, just attach the credentials;
//   - otherwise → drive a visible humanized auto-login to capture a fresh cookie.
// The orchestration here stays pure and dependency-injected (the modal wires the
// real IPC/store effects; tests inject controlled mocks), and passwords NEVER
// appear in progress events, failures, or the returned summary.

/** The canonical `.ROBLOSECURITY` value signature, used to locate an inline
 * cookie inside a `username:password:cookie` line without mis-splitting on the
 * colons the cookie itself contains (e.g. its `WARNING:` prefix). */
const ROBLOSECURITY_MARKER = /_\|WARNING/i;

/** A single parsed credential entry from the paste box. */
export interface CredentialEntry {
  /** The login identifier (username or email) — before the first colon. */
  username: string;
  /** The password — everything after the first colon (up to any inline cookie). */
  password: string;
  /** An inline `.ROBLOSECURITY` cookie, present only for `user:pass:cookie` lines. */
  cookie?: string;
}

/**
 * Normalized result of a humanized credential login (the backend
 * `roblox_login_credentials` command), mirroring the cookie-capture
 * `LoginResult` shape: `{ success, cookie?, username?, userId?, error? }`.
 */
export interface CredentialLoginResult {
  /** Whether a session cookie was captured AND verified. */
  success: boolean;
  /** The captured `.ROBLOSECURITY` cookie, present only on success. */
  cookie?: string;
  /** The verified username, present only on success. */
  username?: string;
  /** The verified user id, present only on success. */
  userId?: string;
  /** A user-facing failure reason, present only on failure. */
  error?: string;
}

/**
 * The outcome of resolving one credential entry to a usable session: a valid
 * cookie plus the verified identity, or a failure with a reason. The modal's
 * injected `resolve` produces this by branching (validate cookie / reuse an
 * existing account / auto-login); {@link processCredentials} stays agnostic to
 * which path was taken.
 */
export interface CredentialOutcome {
  /** Whether a valid session was obtained. */
  ok: boolean;
  /** The resolved `.ROBLOSECURITY` cookie, present only when `ok`. */
  cookie?: string;
  /** The resolved username, present only when `ok`. */
  username?: string;
  /** The resolved user id, present only when `ok`. */
  userId?: string;
  /** A user-facing failure reason, present only when not `ok`. */
  error?: string;
  /** `true` when the resolved account is under moderation but accepted anyway. */
  moderated?: boolean;
}

/** A single failed entry, identified by USERNAME only — never the password. */
export interface CredentialFailure {
  /** Zero-based position of the entry in the input list. */
  index: number;
  /** The entry's username, identifying which line failed. */
  username: string;
  /** Human-readable reason, already identifying the entry by its number. */
  reason: string;
}

/** Summary of a completed credential run, mirroring {@link BatchSummary}. */
export interface CredentialSummary {
  /** Total number of entries the run attempted. */
  total: number;
  /** Number of entries that resolved and were saved (added or updated). */
  saved: number;
  /** One entry per failure, in input order (no passwords). */
  failures: CredentialFailure[];
}

/** The stage of processing a single entry, reported to `onProgress`. */
export type CredentialPhase = 'resolving' | 'saving';

/** Progress event emitted before each per-entry step (password-free). */
export interface CredentialProgressEvent {
  /** Zero-based index of the entry currently being processed. */
  index: number;
  /** Total number of entries in the run. */
  total: number;
  /** The username currently being processed. */
  username: string;
  /** Which step is starting for this entry. */
  phase: CredentialPhase;
}

/** Effects injected into {@link processCredentials}. */
export interface ProcessCredentialsDeps {
  /**
   * Obtain a valid session for an entry: validate its inline cookie, reuse a
   * matching existing account, or drive the humanized auto-login. Invoked once
   * per entry and awaited before the next (sequential — one browser window at a
   * time when a login is needed).
   */
  resolve: (
    entry: CredentialEntry,
    index: number,
  ) => Promise<CredentialOutcome> | CredentialOutcome;
  /**
   * Persist the resolved account, carrying the entry's credentials.
   * Implementations decide whether to add a new account or update an existing
   * one (upsert by username).
   */
  save: (
    entry: CredentialEntry,
    outcome: CredentialOutcome,
    index: number,
  ) => Promise<void> | void;
  /** Optional progress callback, invoked before each per-entry step. */
  onProgress?: (event: CredentialProgressEvent) => void;
  /**
   * Optional cooperative-cancellation check, consulted BEFORE each entry. When
   * it returns `true`, processing stops and the remaining entries are left
   * untouched (the summary reflects only what was attempted).
   */
  shouldAbort?: () => boolean;
}

/**
 * Parse a pasted credential blob into entries. Each non-blank line is one of:
 *   - `username:password` — split on the FIRST colon, so a password may contain
 *     colons; or
 *   - `username:password:cookie` — where `cookie` is a `.ROBLOSECURITY` value.
 *
 * The inline cookie is located by its `_|WARNING` signature (not by counting
 * colons), so the colons inside the cookie never mis-split the credentials, and
 * a colon-bearing password still parses correctly in the no-cookie case. A line
 * with no colon, or an empty username or password, is skipped. Pure so the modal
 * and tests share the exact same parsing.
 *
 * @param raw - The raw textarea contents.
 * @returns The valid entries in their original order.
 */
export function parseCredentialLines(raw: string): CredentialEntry[] {
  const entries: CredentialEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let creds = trimmed;
    let cookie: string | undefined;
    const marker = ROBLOSECURITY_MARKER.exec(trimmed);
    if (marker && marker.index > 0) {
      cookie = trimmed.slice(marker.index).trim();
      // Drop the trailing `:` that separated the password from the cookie.
      creds = trimmed.slice(0, marker.index).replace(/:\s*$/, '').trim();
    }

    const colon = creds.indexOf(':');
    if (colon <= 0) continue;
    const username = creds.slice(0, colon).trim();
    const password = creds.slice(colon + 1);
    if (!username || !password) continue;
    entries.push(cookie ? { username, password, cookie } : { username, password });
  }
  return entries;
}

/**
 * Build the label identifying an entry by its position (1-based).
 */
export function credentialLabel(index: number): string {
  return `Cuenta #${index + 1}`;
}

/**
 * Normalize the untyped `ipc.loginCredentials` response into a
 * {@link CredentialLoginResult}, treating a malformed response as a failure
 * rather than throwing.
 */
export function normalizeCredentialLogin(raw: unknown): CredentialLoginResult {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false };
  }
  const record = raw as Record<string, unknown>;
  const username =
    typeof record.username === 'string' ? record.username : undefined;
  const userId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.userId === 'number'
        ? String(record.userId)
        : undefined;
  const cookie = typeof record.cookie === 'string' ? record.cookie : undefined;
  const error = typeof record.error === 'string' ? record.error : undefined;
  const success = record.success === true && !!cookie && username !== undefined;
  return { success, cookie, username, userId, error };
}

/**
 * Find an existing account whose `username` matches `username`
 * case-insensitively — the upsert key for attaching credentials to an account
 * that was already added by cookie.
 *
 * @param accounts - The current accounts.
 * @param username - The username to match.
 * @returns The matching account, or `undefined`.
 */
export function findAccountByUsername(
  accounts: readonly Account[],
  username: string,
): Account | undefined {
  const needle = username.trim().toLowerCase();
  if (!needle) return undefined;
  return accounts.find((account) => account.username.trim().toLowerCase() === needle);
}

/**
 * Process a batch of credential entries SEQUENTIALLY, mirroring
 * {@link processBatchCookies}.
 *
 * For every entry, in input order:
 *   1. Emits a `'resolving'` progress event, then invokes `resolve` once and
 *      awaits it.
 *   2. If resolving failed (or threw), records a {@link CredentialFailure}
 *      identifying the entry by username and CONTINUES with the rest.
 *   3. On success, emits a `'saving'` event and invokes `save`; a successful
 *      save increments `saved`.
 *
 * Passwords never appear in progress events, failures, or the returned summary.
 *
 * @param entries - The entries to process, in input order.
 * @param deps - The injected `resolve` / `save` / `onProgress` effects.
 * @returns A {@link CredentialSummary} of the run.
 */
export async function processCredentials(
  entries: readonly CredentialEntry[],
  deps: ProcessCredentialsDeps,
): Promise<CredentialSummary> {
  const { resolve, save, onProgress, shouldAbort } = deps;
  const total = entries.length;
  const failures: CredentialFailure[] = [];
  let saved = 0;

  for (let index = 0; index < total; index += 1) {
    // Cooperative cancellation: stop cleanly between entries so a user who hits
    // "Cancelar" is not forced to sit through the whole list.
    if (shouldAbort?.()) break;
    const entry = entries[index];
    const { username } = entry;

    onProgress?.({ index, total, username, phase: 'resolving' });
    let outcome: CredentialOutcome;
    try {
      outcome = await resolve(entry, index);
    } catch (err) {
      failures.push({ index, username, reason: describeError(err, index, credentialLabel) });
      continue;
    }

    if (!outcome.ok || !outcome.cookie || !outcome.username) {
      const reason = outcome.error?.trim();
      failures.push({
        index,
        username,
        reason: reason
          ? `${credentialLabel(index)}: ${reason}`
          : `${credentialLabel(index)}: no se pudo iniciar sesión.`,
      });
      continue;
    }

    onProgress?.({ index, total, username, phase: 'saving' });
    try {
      await save(entry, outcome, index);
      saved += 1;
    } catch (err) {
      failures.push({ index, username, reason: describeError(err, index, credentialLabel) });
    }
  }

  return { total, saved, failures };
}
