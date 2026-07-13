// lib/mixer.ts
//
// Mixer — pure helpers and shared constants.
//
// The Mixer page (Requirement 19) controls graphics quality, the FPS limit and
// the master volume. Graphics quality and the FPS limit are persisted as global
// Roblox Fast Flags / cap values (one shared ClientAppSettings file → every
// instance reads them on next launch); the master volume is applied live to the
// running clients via the OS audio mixer.
//
// This module concentrates the non-trivial, side-effect-free decisions so they
// can be exercised by property-based tests without rendering React or touching
// `window.api` (design.md → "Correctness Properties"). The Mixer page imports
// these helpers and only owns the wiring to `lib/ipc.ts`.

import type { Account } from '../types/models';
import { isLaunched } from './filters';

/**
 * Fast Flag key that overrides Roblox's graphics quality level. Mirrors the key
 * used by the Legacy_Frontend (`src/renderer.js` → `FF_GFX`), so the React and
 * legacy frontends read and write the exact same flag.
 */
export const GRAPHICS_QUALITY_FLAG = 'DFIntDebugFRMQualityLevelOverride';

/** Lowest selectable manual graphics-quality level. */
export const GRAPHICS_QUALITY_MIN = 1;
/** Highest selectable manual graphics-quality level. */
export const GRAPHICS_QUALITY_MAX = 21;
/** Manual graphics-quality level assumed when no valid flag is stored. */
export const GRAPHICS_QUALITY_DEFAULT = 10;

/** FPS cap value meaning "unlimited" (matches `fps_read`/`fps_write`). */
export const FPS_CAP_UNLIMITED = 0;
/** Lowest selectable FPS cap on the slider. */
export const FPS_MIN = 30;
/** Highest selectable FPS cap on the slider. */
export const FPS_MAX = 240;
/** FPS cap assumed when none is stored / when leaving "unlimited". */
export const FPS_DEFAULT = 60;

/** Lowest master-volume percentage. */
export const VOLUME_MIN = 0;
/** Highest master-volume percentage. */
export const VOLUME_MAX = 100;
/** Master-volume percentage assumed when none is stored in settings. */
export const VOLUME_DEFAULT = 100;

/** A loosely-typed Fast Flag map, as returned by `fflag_read`. */
export type FlagMap = Record<string, unknown>;

/**
 * Whether the manual graphics-quality control is disabled, given the state of
 * the "Auto" toggle.
 *
 * The manual slider is disabled if and only if "Auto" is on, so the disabled
 * state is exactly the boolean value of the toggle.
 *
 * Requirement 19.2 — Property 36.
 *
 * @param auto - Whether the "Auto" graphics-quality toggle is on.
 * @returns `true` when the manual slider must be disabled, otherwise `false`.
 */
export function manualQualityDisabled(auto: boolean): boolean {
  return auto;
}

/**
 * Whether a stored graphics-quality Fast Flag value represents "Auto".
 *
 * Auto is represented by the absence of the flag: `undefined`, `null`, or an
 * empty string all mean "let Roblox decide" (parity with `src/renderer.js`).
 *
 * @param raw - The raw flag value read from `fflag_read`.
 * @returns `true` when the value means "Auto", otherwise `false`.
 */
export function isGraphicsAuto(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '';
}

/**
 * Parse an arbitrary value into an integer clamped to `[min, max]`, falling
 * back to `fallback` when it is not a finite number.
 *
 * @param value - The raw value (string or number) to parse.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @param fallback - Value returned when `value` is not parseable.
 * @returns The clamped integer, or `fallback`.
 */
export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Coerce the untyped result of `fflag_read` into a {@link FlagMap}. A missing
 * or non-object payload yields an empty map so callers can merge safely.
 *
 * @param raw - The value returned by `fflag_read`.
 * @returns A plain object mapping flag names to values (never `null`).
 */
export function toFlagMap(raw: unknown): FlagMap {
  return raw && typeof raw === 'object' ? { ...(raw as FlagMap) } : {};
}

/**
 * Resolve the manual graphics-quality level from a stored flag map, clamped to
 * the selectable range and defaulted when absent/invalid.
 *
 * @param flags - The current Fast Flag map.
 * @returns A graphics-quality level in `[GRAPHICS_QUALITY_MIN, GRAPHICS_QUALITY_MAX]`.
 */
export function graphicsQualityFromFlags(flags: FlagMap): number {
  return clampInt(
    flags[GRAPHICS_QUALITY_FLAG],
    GRAPHICS_QUALITY_MIN,
    GRAPHICS_QUALITY_MAX,
    GRAPHICS_QUALITY_DEFAULT,
  );
}

/**
 * Return a new flag map with the graphics-quality flag set to `value`, or with
 * the flag removed when `value` is `null` (i.e. "Auto"). The input map is not
 * mutated. Values are stored as strings, matching the Legacy_Frontend and the
 * on-disk ClientAppSettings format.
 *
 * @param flags - The current Fast Flag map.
 * @param value - The manual quality level, or `null` to clear it ("Auto").
 * @returns A new flag map reflecting the change.
 */
export function setGraphicsQualityFlag(
  flags: FlagMap,
  value: number | null,
): FlagMap {
  const next: FlagMap = { ...flags };
  if (value === null) {
    delete next[GRAPHICS_QUALITY_FLAG];
  } else {
    next[GRAPHICS_QUALITY_FLAG] = String(value);
  }
  return next;
}

// ── "Apply and relaunch" (Requirement 19.5 — Property 37) ──
//
// "Aplicar y relanzar" relaunches every account that is CURRENTLY RUNNING with
// the Mixer settings in effect, and leaves idle accounts untouched. The Mixer
// settings themselves (graphics quality, FPS cap) are already persisted as the
// shared global Fast Flags / cap, so a fresh launch of each running instance
// picks them up on next start — the orchestration below only has to select the
// running accounts and trigger exactly one relaunch per account.
//
// The two pieces are kept pure / dependency-injected so Property 37 can assert
// the selection and the "exactly once per running account, never for idle"
// invariant without rendering React or touching `window.api`:
//   - {@link accountsToRelaunch} is the pure SELECTION (running accounts only).
//   - {@link relaunchRunningAccounts} is the orchestration; the caller injects
//     the per-account relaunch effect (the Mixer page wires kill+launch via IPC;
//     a property test injects a spy that records how many times each account was
//     relaunched).

/**
 * Select exactly the accounts that must be relaunched by "Apply and relaunch":
 * the currently-running ones (Requirement 19.5, Property 37).
 *
 * An account is "currently running" per the single authoritative definition in
 * {@link isLaunched} (its launched-instance count is greater than zero). Idle
 * accounts are excluded, so they are never relaunched. Input order is preserved
 * and the input array is never mutated.
 *
 * @param accounts - All known accounts, with their client-derived launched state.
 * @returns A new array containing only the currently-running accounts, in order.
 */
export function accountsToRelaunch(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => isLaunched(account));
}

/**
 * Resolve the launch target string for an account, tolerating the legacy
 * `gameTarget` field being absent or non-string.
 *
 * The backend `launch_roblox` command takes a target string; an empty string
 * means "Roblox home" (parity with the Legacy_Frontend, which launches with
 * `a.gameTarget || null`). Because `gameTarget` is an untyped legacy field on
 * {@link Account} (preserved via the index signature), it is coerced here so
 * the relaunch effect always passes a well-typed string.
 *
 * @param account - The account being relaunched.
 * @returns The saved game target, or `''` when none is set (launch home).
 */
export function launchTargetOf(account: Account): string {
  const target = (account as { gameTarget?: unknown }).gameTarget;
  return typeof target === 'string' ? target : '';
}

/** Structured outcome of an "Apply and relaunch" run (Requirement 19.5). */
export interface RelaunchResult {
  /** Number of currently-running accounts a relaunch was attempted for. */
  total: number;
  /** Number of relaunch effects that resolved successfully. */
  succeeded: number;
  /** Number of relaunch effects that rejected. */
  failed: number;
}

/**
 * Orchestrate "Apply and relaunch" over a set of accounts (Requirement 19.5,
 * Property 37).
 *
 * Selects the currently-running accounts via {@link accountsToRelaunch} and
 * invokes `relaunch` EXACTLY ONCE for each of them, in order — and never for an
 * idle account. A failed relaunch is counted and the loop continues with the
 * remaining running accounts (a partial failure never aborts the run). The
 * `relaunch` effect is injected so the Mixer page can wire the real
 * kill-then-launch IPC sequence while a property test injects a spy that
 * verifies the exactly-once-per-running-account invariant.
 *
 * @param accounts - All known accounts, with their launched state.
 * @param relaunch - The per-account relaunch effect, invoked once per running
 *   account.
 * @returns The `{ total, succeeded, failed }` counts for the run.
 */
export async function relaunchRunningAccounts(
  accounts: readonly Account[],
  relaunch: (account: Account) => Promise<unknown>,
): Promise<RelaunchResult> {
  const running = accountsToRelaunch(accounts);
  let succeeded = 0;
  let failed = 0;
  for (const account of running) {
    try {
      await relaunch(account);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { total: running.length, succeeded, failed };
}

/**
 * Build the completion toast text summarising an "Apply and relaunch" run: how
 * many running accounts were relaunched out of the total attempted. Pure so it
 * can be asserted directly and stays consistent between success/partial-failure
 * paths.
 *
 * @param succeeded - Number of accounts relaunched successfully.
 * @param total - Total number of running accounts the relaunch was attempted for.
 * @returns A human-readable summary such as "Se relanzaron 3 de 5 cuentas.".
 */
export function relaunchResultMessage(succeeded: number, total: number): string {
  return `Se relanzaron ${succeeded} de ${total} cuentas.`;
}
