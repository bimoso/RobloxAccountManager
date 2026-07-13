// pages/Settings/donutTokenStatus.ts
//
// Pure derivation of the Donut Browser token status shown in the Settings
// General tab (design.md → Requirement 21.4, Property 40 "Enmascaramiento del
// token de Donut Browser").
//
// The Settings_Store persists the token as `settings.donutApiTokenEnc` (an
// encrypted string, or `null` when unset). Requirement 21.4 mandates the UI
// reveal ONLY whether a token is configured or not — never its value in plain
// text. This module reduces the settings to that binary status and nothing
// else: it returns one of two constant string literals and, by construction,
// can never return or embed the raw token. Property 40 (property-tested in
// task 25.3) asserts exactly this masking guarantee across all token values.
//
// Keeping this logic pure and separate from the React component lets task 25.3
// property-test it directly, and keeps the page free of any code path that
// could accidentally surface the token value.

import type { Settings } from '@/types/models';

/**
 * The two states the Donut token can be shown in. Deliberately a closed union
 * of constants — never the token value — so the rendered status is always safe
 * to display (Requirement 21.4, Property 40).
 */
export type DonutTokenStatus = 'configured' | 'not-configured';

/**
 * Derive the Donut Browser token status from the persisted settings.
 *
 * The token is considered **configured** iff `settings.donutApiTokenEnc` is a
 * non-empty string (after trimming surrounding whitespace); otherwise it is
 * **not-configured**. `null`, `undefined`, the empty string, and
 * whitespace-only strings all map to `'not-configured'`.
 *
 * This function is pure and side-effect free. It never returns, logs, or embeds
 * the raw token value — its entire output space is the two constants of
 * {@link DonutTokenStatus} (Requirement 21.4, Property 40).
 *
 * @param settings - The loaded application settings (or a partial subset that
 *   carries `donutApiTokenEnc`).
 * @returns `'configured'` when a non-empty token is stored, otherwise
 *   `'not-configured'`.
 */
export function donutTokenStatus(
  settings: Pick<Settings, 'donutApiTokenEnc'> | null | undefined,
): DonutTokenStatus {
  const token = settings?.donutApiTokenEnc;
  if (typeof token === 'string' && token.trim().length > 0) {
    return 'configured';
  }
  return 'not-configured';
}

/**
 * Human-readable label for a {@link DonutTokenStatus}, suitable for direct
 * rendering. Like {@link donutTokenStatus}, the output is drawn from a fixed
 * set of strings and never contains the token value (Requirement 21.4).
 *
 * @param status - The derived token status.
 * @returns `'Configured'` or `'Not configured'`.
 */
export function donutTokenStatusLabel(status: DonutTokenStatus): string {
  return status === 'configured' ? 'Configured' : 'Not configured';
}
