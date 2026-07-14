// pages/Accounts/launch.ts
//
// Pure, dependency-injected orchestration + target-building for the Roblox
// launch flow (Requirement 15). Kept free of React and of `window.api` so it
// can be property-tested in isolation:
//
//   - Property 28 "Invocación de lanzamiento por cuenta objetivo" exercises
//     {@link launchAccounts}: it must invoke the injected `launch` effect
//     exactly once per target account, always with the same destination.
//
// The `LaunchModal` component wires the real effect here:
//   - `launch` → `ipc.launchRoblox(account.id, account.cookie, target)`
//
// The target-building helpers mirror the legacy renderer's `_buildLaunchTarget`
// (retired legacy renderer): the destination string is derived from the active tab
// and its inputs, matching the exact formats the backend already understands.

import type { Account } from '../../types/models';

/**
 * The four launch destination tabs offered by the modal (Requirement 15.1).
 *
 * - `'home'`    — launch straight to the Roblox home (no place).
 * - `'place'`   — launch into a specific game by place id / game url.
 * - `'player'`  — follow another user into whatever they are playing.
 * - `'private'` — join via a private-server link.
 */
export type LaunchTab = 'home' | 'place' | 'player' | 'private';

/**
 * The raw inputs the modal collects for the non-Home tabs. All are plain,
 * always-present strings so target building never has to reason about
 * `undefined`; empty means "not entered yet".
 */
export interface LaunchInputs {
  /** Place tab: a numeric place id or a game url (`/games/<id>/...`). */
  place: string;
  /** Private tab: a private-server link (`...?privateServerLinkCode=...`). */
  privateLink: string;
  /** Player tab: the user id of the player to follow. */
  followUserId: string;
}

/** Empty launch inputs, used to seed/reset the modal form. */
export const EMPTY_LAUNCH_INPUTS: LaunchInputs = {
  place: '',
  privateLink: '',
  followUserId: '',
};

/**
 * Build the launch target string for the active destination tab and its inputs
 * (Requirement 15.2), mirroring the legacy renderer's `_buildLaunchTarget`.
 *
 * Return contract:
 *   - `'home'`    → `''` — the empty target the backend treats as "Roblox home".
 *   - `'place'`   → the trimmed place input (a place id or game url); `''` when
 *                   nothing has been entered yet.
 *   - `'private'` → the trimmed private-server link; `''` when empty.
 *   - `'player'`  → a `home?followUserId=<id>` url when a user id is present, or
 *                   `undefined` when no player has been picked yet.
 *
 * A returned `undefined` means "the current selection is not launchable yet"
 * (the modal disables the confirm button); any string (including `''`) is a
 * valid, launchable destination. Pure: depends only on its inputs.
 *
 * @param tab - The active destination tab.
 * @param inputs - The raw inputs collected by the modal.
 * @returns The destination string, or `undefined` when not launchable yet.
 */
export function buildLaunchTarget(
  tab: LaunchTab,
  inputs: LaunchInputs,
): string | undefined {
  switch (tab) {
    case 'home':
      return '';
    case 'place':
      return inputs.place.trim();
    case 'private':
      return inputs.privateLink.trim();
    case 'player': {
      const followUserId = inputs.followUserId.trim();
      if (!followUserId) return undefined;
      return `https://www.roblox.com/home?followUserId=${followUserId}`;
    }
    default:
      return undefined;
  }
}

/**
 * Effect injected into {@link launchAccounts}. The modal wires the real IPC
 * effect (`ipc.launchRoblox`); a property test injects a controlled spy.
 *
 * @typeParam R - The value the launch effect resolves to (opaque to the
 *   orchestration; the real IPC call resolves to `void`).
 */
export interface LaunchDeps<R> {
  /**
   * Launch a single account at the given destination. Invoked exactly once per
   * target account, always with the SAME `target` value (Property 28).
   */
  launch: (account: Account, target: string) => Promise<R> | R;
}

/**
 * The outcome of launching one account, preserving input order.
 *
 * Exactly one of `result` / `error` is set: `result` on a resolved launch,
 * `error` when the injected `launch` effect threw/rejected for that account.
 */
export interface LaunchOutcome<R> {
  /** The account this outcome belongs to. */
  account: Account;
  /** Whether the launch effect resolved for this account. */
  ok: boolean;
  /** The resolved value, present when `ok` is `true`. */
  result?: R;
  /** The thrown/rejected value, present when `ok` is `false`. */
  error?: unknown;
}

/**
 * Launch every target account at a single shared destination (Requirement 15.2;
 * Property 28).
 *
 * Invokes the injected `launch` effect EXACTLY ONCE for each account in
 * `accounts`, always passing the SAME `target` string, and never invokes it for
 * an account that is not in the list. A failure launching one account is
 * captured as that account's {@link LaunchOutcome} and never prevents the other
 * accounts from being launched. The returned outcomes are in the same order as
 * `accounts` (one per account, so the count always matches). Works for any
 * number of target accounts, including zero (no launches, empty result).
 *
 * Pure with respect to its inputs — all side effects flow through the injected
 * `launch` effect — so it can be property-tested by injecting a spy.
 *
 * @param accounts - The target accounts to launch, in order.
 * @param target - The shared destination string (from {@link buildLaunchTarget}).
 * @param deps - The injected `launch` effect.
 * @returns One {@link LaunchOutcome} per account, in input order.
 */
export async function launchAccounts<R>(
  accounts: readonly Account[],
  target: string,
  deps: LaunchDeps<R>,
): Promise<LaunchOutcome<R>[]> {
  const { launch } = deps;
  return Promise.all(
    accounts.map(async (account): Promise<LaunchOutcome<R>> => {
      try {
        const result = await launch(account, target);
        return { account, ok: true, result };
      } catch (error) {
        return { account, ok: false, error };
      }
    }),
  );
}
