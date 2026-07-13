/**
 * Accounts page — pure filtering, search, and presentation logic.
 *
 * This module concentrates every decision behind the Accounts page listing as
 * pure, side-effect-free functions (plus thin persistence wrappers around
 * {@link ./persistence}), so the Accounts page components and the account store
 * consume them without holding the logic themselves. The pure functions here
 * are the units exercised by the account-listing property-based tests.
 *
 * Requirement references:
 * - 8.1  — a card shows the nickname if defined, otherwise the username.
 * - 8.4  — the selected view is persisted to local storage.
 * - 8.5  — an expired-cookie account shows an indication distinct from the
 *          launched indicator.
 * - 8.6  — no saved accounts shows an empty state.
 * - 8.8  — on startup the saved view is restored, or grid if none is saved.
 * - 9.1  — search matches nickname, username, or userId, trimmed and
 *          case-insensitive.
 * - 9.2  — filter definitions (all / running / idle / valid-first /
 *          invalid-first).
 * - 9.3  — a non-"all" filter is persisted to local storage.
 * - 9.4  — on startup the saved filter is restored if it is one of the 5 valid
 *          filters, otherwise "all".
 * - 9.5  — selecting "all" removes any previously saved filter.
 * - 9.6  — accounts exist but none match filter+search shows a "no results"
 *          state distinct from the empty state (8.6).
 */

import type { Account, AccountFilter, AccountsView } from '../types/models';
import {
  PERSISTENCE_KEYS,
  getPersisted,
  removePersisted,
  setPersisted,
} from './persistence';

/** The two valid account layout views (Requirement 8.2, 8.3, 8.8). */
const ACCOUNT_VIEWS: readonly AccountsView[] = ['grid', 'list'];

/** The five valid account filters (Requirement 9.2, 9.4). */
const ACCOUNT_FILTERS: readonly AccountFilter[] = [
  'all',
  'running',
  'idle',
  'valid-first',
  'invalid-first',
];

/**
 * Whether an account currently has at least one launched Roblox instance.
 *
 * "Launched" is derived from {@link Account.launchedInstanceCount}: an account
 * is launched iff its launched-instance count is greater than zero. The count
 * is client-derived state (not persisted by the backend) and may be absent on
 * accounts that have never been launched this session, so a missing count is
 * treated as zero (not launched). This single helper is the authoritative
 * definition of "launched" and is reused everywhere (badges, filtering) so the
 * derivation stays consistent (Requirement 8.5, 9.2, and Requirement 15).
 *
 * @param account - The account to inspect.
 * @returns `true` iff the account has one or more launched instances.
 */
export function isLaunched(account: Account): boolean {
  return (account.launchedInstanceCount ?? 0) > 0;
}

/**
 * The label shown for an account on its card.
 *
 * Returns the trimmed nickname when it is non-empty after trimming, otherwise
 * the username. Legacy accounts saved before nicknames existed omit the field
 * (treated as `""`), and whitespace-only nicknames are treated as absent so
 * they never render as a blank label (Requirement 8.1).
 *
 * @param account - The account to label.
 * @returns The nickname (trimmed) if present, otherwise the username.
 */
export function displayName(account: Account): string {
  const nickname = (account.nickname ?? '').trim();
  return nickname.length > 0 ? nickname : account.username;
}

/** The status badges an account card displays, each independently derived. */
export interface AccountBadges {
  /** True iff the account's cookie is marked expired (Requirement 8.5). */
  expired: boolean;
  /** True iff the account has a launched instance (Requirement 8.5, 15). */
  launched: boolean;
}

/**
 * The set of status badges shown on an account card.
 *
 * The two badges are independent and distinguishable: `expired` reflects the
 * client-side expired-cookie flag, while `launched` reflects whether the
 * account has a launched instance (via {@link isLaunched}). Both may be true at
 * once, and they are never conflated (Requirement 8.5).
 *
 * @param account - The account to inspect.
 * @returns An {@link AccountBadges} with the two independent badge flags.
 */
export function accountBadges(account: Account): AccountBadges {
  return {
    expired: account.cookieExpired === true,
    launched: isLaunched(account),
  };
}

/**
 * The rendering state of the accounts listing, from the total and post-filter
 * counts.
 *
 * - `'empty'`      — no accounts are saved at all (Requirement 8.6).
 * - `'no-results'` — accounts exist but none match the active filter+search
 *                    (Requirement 9.6); distinct from `'empty'`.
 * - `'has-items'`  — at least one account matches and is shown.
 *
 * @param totalCount - Number of saved accounts, before filter/search.
 * @param filteredCount - Number of accounts remaining after filter+search.
 * @returns The list state discriminator.
 */
export function listState(
  totalCount: number,
  filteredCount: number,
): 'empty' | 'no-results' | 'has-items' {
  if (totalCount === 0) {
    return 'empty';
  }
  if (filteredCount === 0) {
    return 'no-results';
  }
  return 'has-items';
}

/**
 * Filters accounts by a free-text search query.
 *
 * The query is trimmed and lower-cased; an account matches when its nickname,
 * username, or userId (each lower-cased) contains the normalized query as a
 * substring. An empty (or whitespace-only) query matches every account and the
 * input order is preserved (Requirement 9.1).
 *
 * @param accounts - The accounts to search (typically already filtered).
 * @param query - The raw search text as typed by the user.
 * @returns A new array of the matching accounts, in their original order.
 */
export function searchAccounts(accounts: Account[], query: string): Account[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [...accounts];
  }
  return accounts.filter((account) => {
    const nickname = (account.nickname ?? '').toLowerCase();
    const username = (account.username ?? '').toLowerCase();
    const userId = (account.userId ?? '').toLowerCase();
    return (
      nickname.includes(normalized) ||
      username.includes(normalized) ||
      userId.includes(normalized)
    );
  });
}

/**
 * Applies an account filter to a list of accounts.
 *
 * Filter definitions (Requirement 9.2):
 * - `'all'`           — returns every account, order unchanged.
 * - `'running'`       — only accounts with a launched instance.
 * - `'idle'`          — only accounts without a launched instance.
 * - `'valid-first'`   — every account, with non-expired ones ordered before
 *                       expired ones (stable within each group).
 * - `'invalid-first'` — every account, with expired ones ordered before
 *                       non-expired ones (stable within each group).
 *
 * The `valid-first` / `invalid-first` orderings are a stable partition: the
 * relative order of accounts within the "valid" group and within the "expired"
 * group is preserved from the input. A new array is always returned; the input
 * array is never mutated.
 *
 * @param accounts - The accounts to filter.
 * @param filter - The active filter.
 * @returns A new array of accounts after applying the filter.
 */
export function filterAccounts(
  accounts: Account[],
  filter: AccountFilter,
): Account[] {
  switch (filter) {
    case 'running':
      return accounts.filter((account) => isLaunched(account));
    case 'idle':
      return accounts.filter((account) => !isLaunched(account));
    case 'valid-first': {
      const valid = accounts.filter((account) => account.cookieExpired !== true);
      const expired = accounts.filter((account) => account.cookieExpired === true);
      return [...valid, ...expired];
    }
    case 'invalid-first': {
      const expired = accounts.filter((account) => account.cookieExpired === true);
      const valid = accounts.filter((account) => account.cookieExpired !== true);
      return [...expired, ...valid];
    }
    case 'all':
    default:
      return [...accounts];
  }
}

/**
 * Type guard: whether a value is one of the two valid account views.
 */
function isAccountsView(value: unknown): value is AccountsView {
  return typeof value === 'string' && (ACCOUNT_VIEWS as readonly string[]).includes(value);
}

/**
 * Type guard: whether a value is one of the five valid account filters.
 */
function isAccountFilter(value: unknown): value is AccountFilter {
  return typeof value === 'string' && (ACCOUNT_FILTERS as readonly string[]).includes(value);
}

/**
 * Resolves the initial accounts view from local storage.
 *
 * Returns the persisted view when it is a valid {@link AccountsView}, otherwise
 * defaults to `'grid'` (when nothing is saved or the stored value is invalid)
 * (Requirement 8.8).
 *
 * @returns The view to apply on startup.
 */
export function resolveInitialView(): AccountsView {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.view);
  return isAccountsView(stored) ? stored : 'grid';
}

/**
 * Persists the selected accounts view to local storage (Requirement 8.4).
 *
 * @param view - The view the user selected.
 */
export function setView(view: AccountsView): void {
  setPersisted(PERSISTENCE_KEYS.view, view);
}

/**
 * Resolves the initial accounts filter from local storage.
 *
 * Returns the persisted filter when it is one of the 5 valid
 * {@link AccountFilter} values, otherwise defaults to `'all'` (when nothing is
 * saved or the stored value is invalid) (Requirement 9.4).
 *
 * @returns The filter to apply on startup.
 */
export function resolveInitialFilter(): AccountFilter {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.filter);
  return isAccountFilter(stored) ? stored : 'all';
}

/**
 * Persists the selected accounts filter to local storage.
 *
 * Selecting `'all'` removes any previously stored filter rather than storing
 * the value, so the absence of a stored filter and the `'all'` filter are
 * equivalent (Requirement 9.3, 9.5). Any other filter is stored.
 *
 * @param filter - The filter the user selected.
 */
export function setFilter(filter: AccountFilter): void {
  if (filter === 'all') {
    removePersisted(PERSISTENCE_KEYS.filter);
    return;
  }
  setPersisted(PERSISTENCE_KEYS.filter, filter);
}
