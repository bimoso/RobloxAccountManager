// pages/Accounts/editAccount.ts
//
// Pure helpers backing the Edit-account flow (Requirement 14).
//
// These functions hold the only non-trivial logic of the EditAccountModal —
// preloading the form (Requirement 14.1) and deriving the changed subset to
// persist (Requirement 14.2) — and are kept PURE and side-effect-free so they
// can be property-tested in isolation:
//
//   - Property 26 "Precarga del formulario de edición" exercises
//     {@link editFormInitialValues}.
//   - Property 27 "Cálculo de campos modificados al guardar la edición"
//     exercises {@link computeChangedFields}.
//
// The three editable fields match the retired legacy edit form
// (`openEdit`/`saveEdit`), which maps its inputs onto the Account fields
// `nickname`, `gameTarget` (the launch destination — a game id or a private
// server link) and `notes`.

import type { Account } from '@/types/models';

/**
 * The exact set of user-editable fields exposed by the Edit-account modal
 * (Requirement 14.1): the nickname, the launch destination (`gameTarget` — a
 * game id or a private-server link), and free-form notes.
 *
 * All three are plain, always-present strings so the form and the change
 * computation never have to reason about `undefined`.
 */
export interface EditFormValues {
  /** The account nickname (Account.nickname). */
  nickname: string;
  /** The launch destination: a game id or a private-server link (Account.gameTarget). */
  gameTarget: string;
  /** Free-form notes attached to the account (Account.notes). */
  notes: string;
  /** The login identifier used for re-login, may be a username or email (Account.loginUsername). */
  loginUsername: string;
  /** The saved login password, encrypted at rest by the backend (Account.password). */
  password: string;
}

/**
 * Coerce a possibly-absent Account field to the string the edit form shows,
 * yielding `""` when the value is absent (`null`/`undefined`) — Requirement
 * 14.1's "empty string when absent". Non-string primitives are stringified so
 * legacy/round-tripped values never leak a non-string into a text input.
 */
function toFieldString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Build the initial edit-form values for an account (Requirement 14.1,
 * Property 26).
 *
 * Returns exactly the three editable values — `nickname`, `gameTarget` and
 * `notes` — read from the account, each defaulting to the empty string when the
 * account does not carry that field (e.g. legacy accounts saved before the
 * field existed). Pure: it never mutates the account and depends only on its
 * input.
 *
 * @param account - The account being edited.
 * @returns The nickname, launch destination and notes to preload into the form.
 */
export function editFormInitialValues(account: Account): EditFormValues {
  return {
    nickname: toFieldString(account.nickname),
    // `gameTarget` and `notes` are not first-class fields on the Account
    // interface (they live in the round-trip catch-all), so read them through
    // the index signature and coerce to the form's string shape.
    gameTarget: toFieldString(account.gameTarget),
    notes: toFieldString(account.notes),
    // Login credentials for re-login: preloaded so an untouched field diffs as
    // "unchanged" and the stored value is preserved on save. Accounts added by
    // cookie paste or browser login carry no explicit `loginUsername`, so fall
    // back to the Roblox `username` — the identifier `reLoginIdentifier` already
    // re-logins with — instead of showing a blank field the user must retype.
    loginUsername: toFieldString(account.loginUsername) || toFieldString(account.username),
    password: toFieldString(account.password),
  };
}

/**
 * Compute the fields that changed between the preloaded form values and the
 * values on save (Requirement 14.2, Property 27).
 *
 * Returns an object containing, for each editable field, the FINAL value IF AND
 * ONLY IF it differs from the corresponding INITIAL value; unchanged fields are
 * omitted entirely. When nothing changed the result is an empty object. Pure:
 * it derives its result solely from its two inputs and mutates neither.
 *
 * The returned partial is shaped for `accounts_update`, which the store invokes
 * as `update(account.id, changedFields)`.
 *
 * @param initial - The values the form was preloaded with (from
 *   {@link editFormInitialValues}).
 * @param final - The values present when the user saved.
 * @returns A partial containing only the changed fields (empty when none
 *   changed).
 */
export function computeChangedFields(
  initial: EditFormValues,
  final: EditFormValues,
): Partial<EditFormValues> {
  const changed: Partial<EditFormValues> = {};
  (Object.keys(final) as (keyof EditFormValues)[]).forEach((field) => {
    if (final[field] !== initial[field]) {
      changed[field] = final[field];
    }
  });
  return changed;
}
