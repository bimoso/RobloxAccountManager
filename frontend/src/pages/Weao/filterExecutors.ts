// pages/Weao/filterExecutors.ts
//
// Pure search, filtering and ordering for the executor grid. No React, no IPC,
// no knowledge of the local machine — installation-aware narrowing stays in the
// page so this module can be property-tested against arbitrary catalogues.

import type {
  Executor,
  ExecutorFilters,
  ExecutorStatusFilter,
  PlatformFilter,
} from './types';

/**
 * Filters a catalogue by a free-text query, matching on the title only.
 *
 * The query is trimmed and lower-cased; an entry matches when its lower-cased
 * title contains it as a substring. A query that normalizes to the empty string
 * therefore matches every entry. Input order is preserved and the input array is
 * never mutated — a new array is always returned.
 *
 * @param executors - The catalogue to search.
 * @param query - The raw search text as typed.
 * @returns A new array of matching entries, in their original order.
 */
export function searchExecutors(
  executors: readonly Executor[],
  query: string,
): Executor[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...executors];
  return executors.filter((executor) =>
    executor.title.toLowerCase().includes(normalized),
  );
}

/**
 * Platform predicate. An entry whose platform could not be resolved from either
 * `platform` or `extype` only survives the `'all'` selection — silently folding
 * it into one of the four buckets would be an invented claim.
 */
function matchesPlatform(executor: Executor, filter: PlatformFilter): boolean {
  return filter === 'all' || executor.platform === filter;
}

/** Status predicate; `'flagged'` unions both risk signals. */
function matchesStatus(executor: Executor, filter: ExecutorStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'updated':
      return executor.updateStatus;
    case 'outdated':
      return !executor.updateStatus;
    case 'undetected':
      return !executor.detected && !executor.possibleBanwave;
    case 'flagged':
      return executor.detected || executor.possibleBanwave;
  }
}

/**
 * Applies the whole filter state: title search plus the platform, pricing and
 * status predicates. Order-preserving and non-mutating, like
 * {@link searchExecutors} — ordering is {@link sortExecutors}'s job.
 *
 * @param executors - The catalogue to narrow.
 * @param filters - The current selector state.
 * @returns A new array of surviving entries, in their original order.
 */
export function filterExecutors(
  executors: readonly Executor[],
  filters: ExecutorFilters,
): Executor[] {
  return searchExecutors(executors, filters.query).filter((executor) => {
    if (!matchesPlatform(executor, filters.platform)) return false;
    if (filters.cost === 'free' && !executor.free) return false;
    if (filters.cost === 'paid' && executor.free) return false;
    return matchesStatus(executor, filters.status);
  });
}

/** Risk tier: a suspected banwave outranks a plain detection. */
function riskRank(executor: Executor): number {
  if (executor.possibleBanwave) return 0;
  if (executor.detected) return 1;
  return 2;
}

/**
 * Ordering comparator: risk first, then update status, then title.
 *
 * Every key runs severity-descending, so the entries that need attention sit at
 * the top of the grid — a banwave suspicion above a detection, and an outdated
 * build above a current one. This board exists to warn, not to rank favourites.
 */
function compareExecutors(left: Executor, right: Executor): number {
  const risk = riskRank(left) - riskRank(right);
  if (risk !== 0) return risk;
  if (left.updateStatus !== right.updateStatus) {
    return left.updateStatus ? 1 : -1;
  }
  return left.title.toLowerCase().localeCompare(right.title.toLowerCase(), 'en');
}

/**
 * Orders a catalogue for display without mutating the input.
 *
 * @param executors - The entries to order.
 * @returns A new array sorted risk-first, then outdated-first, then by title.
 */
export function sortExecutors(executors: readonly Executor[]): Executor[] {
  return [...executors].sort(compareExecutors);
}

/**
 * The grid's derivation in one call: narrow, then order.
 *
 * @param executors - The full catalogue.
 * @param filters - The current selector state.
 * @returns The entries to render, already ordered.
 */
export function visibleExecutors(
  executors: readonly Executor[],
  filters: ExecutorFilters,
): Executor[] {
  return sortExecutors(filterExecutors(executors, filters));
}
