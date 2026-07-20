// lib/moderation.ts
//
// Shared helpers for the "accept moderated accounts" feature, used by both the
// Accounts add flows and the Generator (kept in lib/ so neither page imports the
// other — the cross-page import rule forbids that).

/** Normalized `ipc.moderationInfo` result: the account's ban classification. */
export interface ModerationInfo {
  /** Whether the username resolved to an account. */
  found: boolean;
  /** The resolved user id, when found. */
  userId?: string;
  /** The resolved display name, when found. */
  displayName?: string;
  /** `true` for a permanently terminated account; `false` means temporary. */
  terminated: boolean;
}

/** Narrow the untyped `ipc.moderationInfo` response into a {@link ModerationInfo}. */
export function normalizeModerationInfo(raw: unknown): ModerationInfo {
  if (typeof raw !== 'object' || raw === null) {
    return { found: false, terminated: false };
  }
  const record = raw as Record<string, unknown>;
  const userId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.userId === 'number'
        ? String(record.userId)
        : undefined;
  return {
    found: record.found === true,
    userId,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    terminated: record.terminated === true,
  };
}

/**
 * The human-readable moderation classification (Spanish): permanent
 * (terminated) vs temporary, or unknown when the account could not be resolved.
 */
export function moderationLabel(info: ModerationInfo): string {
  if (!info.found) return 'moderada (tipo desconocido)';
  return info.terminated ? 'baneo permanente' : 'moderación temporal';
}
