/**
 * Selection & reorder — pure functions.
 *
 * These functions concentrate the non-trivial logic behind multi-selection of
 * accounts and drag-to-reorder as pure, side-effect-free operations. The UI
 * layer (selection mode, bulk action bar, drag-and-drop) consumes them without
 * holding decision logic itself. They are the units exercised by property-based
 * tests (design.md, Properties 18, 19, 20, 23).
 *
 * All functions are pure: they never mutate their inputs and always return a
 * fresh value.
 */

/**
 * Toggles the membership of a single id in a selection set.
 *
 * Returns a NEW set: `id` is added if it was absent, removed if it was present.
 * No other id's membership changes. The input set is never mutated.
 *
 * Requirements 10.1 — Property 18.
 *
 * @param selectedIds The current set of selected account ids.
 * @param id The id whose selection state is being toggled.
 * @returns A new set differing from `selectedIds` only in the membership of `id`.
 */
export function toggleSelection(selectedIds: Set<string>, id: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**
 * Determines whether the bulk action bar should be visible.
 *
 * Returns `true` if and only if at least one id is selected, and `false` when
 * the set is empty (including after shrinking back down to zero from a larger
 * size).
 *
 * Requirements 10.2, 10.5 — Property 19.
 *
 * @param selectedIds The current set of selected account ids.
 * @returns `true` when the selection is non-empty, otherwise `false`.
 */
export function bulkBarVisible(selectedIds: Set<string>): boolean {
  return selectedIds.size >= 1;
}

/**
 * Selects every currently visible account.
 *
 * Returns `new Set(visibleIds)` — a selection containing exactly the visible ids.
 * As a deliberate no-op guard, when `visibleIds` is empty the current selection
 * is returned unchanged (there is nothing to select, so selecting "all" of an
 * empty visible list must not clear an existing selection).
 *
 * Requirements 10.3, 10.6 — Property 20.
 *
 * @param visibleIds The ids of the accounts currently visible under the active
 * filter and search.
 * @param currentSelected The selection to preserve when `visibleIds` is empty.
 * Defaults to an empty set when omitted.
 * @returns `new Set(visibleIds)` when there are visible ids; otherwise
 * `currentSelected` returned as-is (unchanged).
 */
export function selectAll(
  visibleIds: string[],
  currentSelected: Set<string> = new Set<string>(),
): Set<string> {
  if (visibleIds.length === 0) {
    // Empty-visible case is a no-op: return the prior selection unchanged.
    return currentSelected;
  }
  return new Set(visibleIds);
}

/**
 * Moves the element originally at index `from` to index `to`, shifting the rest.
 *
 * Validity boundary: an index is valid when it is an integer in the range
 * `[0, ids.length - 1]`. If `to` is not a valid position, the list is returned
 * unchanged (drop outside a valid target). `from` is validated the same way: an
 * invalid `from` also returns the list unchanged, since there is no element to
 * move. When both indices are valid, the result is a permutation of `ids` with
 * the same length, no duplicates and no losses, and the element originally at
 * `from` located exactly at index `to`.
 *
 * The input array is never mutated; a new array is always returned (a shallow
 * copy even in the unchanged case is avoided — the original reference is
 * returned when no move applies).
 *
 * Requirements 11.2, 11.3 — Property 23.
 *
 * @param ids The ordered list of account ids.
 * @param from The index of the element to move.
 * @param to The destination index for that element.
 * @returns A reordered copy of `ids`, or `ids` unchanged when either index is
 * an invalid position.
 */
export function reorder(ids: string[], from: number, to: number): string[] {
  const isValidIndex = (index: number): boolean =>
    Number.isInteger(index) && index >= 0 && index < ids.length;

  if (!isValidIndex(from) || !isValidIndex(to)) {
    return ids;
  }
  if (from === to) {
    return ids;
  }

  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
