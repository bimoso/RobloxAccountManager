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
 * (`{ ok, reason?, username?, userId? }`, see `src/renderer.js`), narrowed from
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
 * Extract a message from a thrown value, falling back to a cookie-identifying
 * default so a rejected `validate`/`add` still names the offending cookie.
 */
function describeError(err: unknown, index: number): string {
  if (err instanceof Error && err.message.trim()) {
    return `${cookieLabel(index)}: ${err.message.trim()}`;
  }
  if (typeof err === 'string' && err.trim()) {
    return `${cookieLabel(index)}: ${err.trim()}`;
  }
  return invalidCookieMessage(index);
}

/**
 * Normalize the untyped `ipc.validateCookie` response into a
 * {@link CookieValidation}.
 *
 * The backend returns `{ ok, reason?, username?, userId? }` (see
 * `src/renderer.js`); this narrows the `unknown` typed response defensively so
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
  // A cookie is considered valid when the backend says `ok` AND a username was
  // resolved (the field the add payload requires).
  const ok = record.ok === true && username !== undefined;
  return { ok, reason, username, userId };
}

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
): Account {
  return {
    id: '',
    username: validation.username ?? '',
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
  const { validate, add, onProgress } = deps;
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

    if (!validation.ok || !validation.username) {
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
