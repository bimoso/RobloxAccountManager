// pages/Accounts/reLogin.ts
//
// Pure orchestration for the per-account "Iniciar sesión de nuevo" (re-login)
// action. When the cookie is still valid there is nothing to do but say so; when
// it has expired, the saved credentials drive a fresh humanized auto-login and
// the account's cookie is refreshed. Kept free of React and `window.api` so the
// decision logic is unit-testable with injected effects.

import type { Account } from '@/types/models';
import type { CookieValidation, CredentialLoginResult } from './addAccount';

/**
 * The outcome of a re-login attempt, which the caller turns into a toast.
 *
 * - `still-valid` — the cookie authenticated, so no login was performed.
 * - `refreshed` — the cookie had expired and a new one was captured and saved.
 * - `no-credentials` — the cookie was invalid and no saved password is available
 *   to re-login with.
 * - `failed` — a re-login was attempted but did not produce a valid session.
 */
export type ReLoginStatus = 'still-valid' | 'refreshed' | 'no-credentials' | 'failed';

/** The structured result of {@link reLoginAccount}. */
export interface ReLoginResult {
  /** Which branch the attempt took. */
  status: ReLoginStatus;
  /** A user-facing message describing the outcome (Spanish, ready to toast). */
  message: string;
  /** On `failed`, the underlying reason when the login flow provided one. */
  reason?: string;
}

/** Effects injected into {@link reLoginAccount}. */
export interface ReLoginDeps {
  /** Validate the account's current cookie (→ `ipc.validateCookie`, normalized). */
  validate: (cookie: string) => Promise<CookieValidation> | CookieValidation;
  /** Drive the humanized auto-login with saved credentials (→ `ipc.loginCredentials`). */
  login: (
    username: string,
    password: string,
  ) => Promise<CredentialLoginResult> | CredentialLoginResult;
  /** Persist the refreshed cookie/identity (→ `accountStore.update`). */
  update: (id: string, changed: Partial<Account>) => Promise<void> | void;
}

/**
 * The login identifier to re-login with: the explicit `loginUsername` when set,
 * otherwise the account's Roblox `username`.
 */
export function reLoginIdentifier(account: Account): string {
  const login = typeof account.loginUsername === 'string' ? account.loginUsername.trim() : '';
  return login || account.username;
}

/**
 * Re-login flow for a single account (Requirement: "botón de iniciar sesión de
 * nuevo").
 *
 * Steps:
 *   1. Validate the current cookie. If it is still valid, return `still-valid`
 *      WITHOUT touching the browser — nothing to do.
 *   2. Otherwise the cookie has expired: if no saved password exists, return
 *      `no-credentials` (there is nothing to log in with).
 *   3. With credentials, drive the humanized auto-login. On success, persist the
 *      new cookie (and refreshed user id) and return `refreshed`; on failure,
 *      return `failed` with the login reason.
 *
 * The password is never included in any returned message.
 *
 * @param account - The account to re-login.
 * @param deps - Injected validate / login / update effects.
 * @returns The structured outcome to surface as a toast.
 */
export async function reLoginAccount(
  account: Account,
  deps: ReLoginDeps,
): Promise<ReLoginResult> {
  // 1. Is the current cookie still good?
  if (account.cookie) {
    let validation: CookieValidation;
    try {
      validation = await deps.validate(account.cookie);
    } catch {
      validation = { ok: false };
    }
    if (validation.ok) {
      return {
        status: 'still-valid',
        message: 'La cookie sigue siendo válida.',
      };
    }
  }

  // 2. Cookie expired/absent — we need saved credentials to re-login.
  const password = typeof account.password === 'string' ? account.password : '';
  if (!password) {
    return {
      status: 'no-credentials',
      message: 'La cookie expiró y no hay credenciales guardadas para reingresar.',
    };
  }

  // 3. Re-login with the saved credentials.
  const identifier = reLoginIdentifier(account);
  let result: CredentialLoginResult;
  try {
    result = await deps.login(identifier, password);
  } catch {
    return { status: 'failed', message: 'No se pudo iniciar sesión de nuevo.' };
  }

  if (!result.success || !result.cookie || !result.username) {
    const reason = result.error?.trim();
    return {
      status: 'failed',
      message: reason
        ? `No se pudo iniciar sesión de nuevo: ${reason}`
        : 'No se pudo iniciar sesión de nuevo.',
      reason,
    };
  }

  await deps.update(account.id, {
    cookie: result.cookie,
    userId: result.userId ?? account.userId,
  });
  return {
    status: 'refreshed',
    message: 'La cookie expiró; se inició sesión de nuevo y se actualizó.',
  };
}
