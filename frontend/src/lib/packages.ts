/**
 * Packages page — pure presentation logic for account groups.
 *
 * This module holds the side-effect-free display derivation for a saved group
 * of accounts (a {@link Package}), so the Packages page components consume it
 * without holding the logic themselves. {@link displayPackage} is the unit
 * exercised by the package-representation property-based test.
 *
 * Requirement references:
 * - 17.1 — the Packages page renders one element per group returned by
 *          `packages_load`, showing its name and the accounts it contains.
 */

import type { Package } from '../types/models';

/**
 * The display representation of a saved account group.
 *
 * This is the projection the Packages page renders for a single group: the
 * group's `name`, the exact set of member account ids it contains, and the
 * derived `accountCount` (the size of that set) shown alongside the name.
 */
export interface PackageDisplay {
  /** The group's stable id (carried through so the list can key on it). */
  id: string;
  /** The group's name, shown as the card title. */
  name: string;
  /** The exact account ids the group contains, in their stored order. */
  accountIds: string[];
  /** The number of accounts in the group (`accountIds.length`). */
  accountCount: number;
}

/**
 * Derives the display representation of a group of accounts.
 *
 * The result carries the group's name unchanged and exactly the set of account
 * ids the group contains — none added, none omitted — regardless of how many
 * ids there are (including the empty list). The member ids are copied into a
 * fresh array so mutating the result never affects the source package, and
 * `accountCount` is derived as the length of that list (Requirement 17.1,
 * Property 33).
 *
 * @param pkg - The saved group to represent.
 * @returns The {@link PackageDisplay} projection for the group.
 */
export function displayPackage(pkg: Package): PackageDisplay {
  const accountIds = [...pkg.accountIds];
  return {
    id: pkg.id,
    name: pkg.name,
    accountIds,
    accountCount: accountIds.length,
  };
}

/**
 * Merges a created or edited group into the full list of groups.
 *
 * Given the full loaded list and a single created/edited {@link Package}, this
 * returns a NEW list in which the group sharing `pkg.id` is replaced in place
 * with `pkg` (its updated values), or — when no group has that id — `pkg` is
 * appended at the end. Every other group is carried through unchanged and in
 * its original position, and the input `list` is never mutated. This is the
 * merge invoked before `packages_save`, guaranteeing that saving one group
 * preserves the rest of the list (Requirement 17.3, Property 34):
 *
 * - Editing an existing group keeps the list length identical.
 * - Creating a new group grows the list by exactly one entry.
 *
 * @param list - The full list of currently saved groups.
 * @param pkg - The group that was just created or edited.
 * @returns A new list with `pkg` upserted, preserving all other groups.
 */
export function upsertPackage(list: Package[], pkg: Package): Package[] {
  const index = list.findIndex((existing) => existing.id === pkg.id);
  if (index === -1) {
    // New group: preserve the existing list in order, append the created group.
    return [...list, pkg];
  }
  // Edited group: replace in place, leaving every other group untouched.
  return list.map((existing, i) => (i === index ? pkg : existing));
}
