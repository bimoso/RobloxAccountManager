// pages/Weao/clientStatus.ts
//
// Pure comparison logic behind the WEAO client-status band. Holds no React and
// no IPC so it can be property-tested in isolation, exactly as `searchGames` is
// separated from `chartsApi`.
//
// The one rule that governs every function here: **a Roblox version guid is an
// opaque hash, not a version number.** `version-145f189a6a974303` carries no
// ordering — a newer build can hash "lower" than an older one — so guids are
// only ever compared for equality (trimmed, case-insensitively) and never with
// `<` or `>`.

import type { Executor } from './types';

/** How a local Roblox client compares against what WEAO publishes. */
export type ClientVerdict =
  | 'up-to-date'
  | 'outdated'
  | 'update-incoming'
  | 'unknown';

/** The only field of a Roblox installation this module reads. */
export interface VersionedInstallation {
  /**
   * The deployment guid, or `null`. Null genuinely occurs — several detected
   * bootstrappers report no guid at all — so every path here must survive it.
   */
  versionGuid: string | null;
}

/** The only field of a catalogue entry {@link executorTargetsInstalled} reads. */
export type RbxVersionTarget = Pick<Executor, 'rbxversion'>;

/** Which of the two shapes a `rbxversion` string is written in. */
export type RbxVersionShape = 'guid' | 'mobile' | 'unknown';

/** A Windows/Mac deployment guid, e.g. `version-145f189a6a974303`. */
const GUID_PATTERN = /^version-[0-9a-z]+$/i;

/** A mobile store version, e.g. `2.729.838`. */
const MOBILE_PATTERN = /^\d+(?:\.\d+)+$/;

/**
 * Canonical form used for every equality test: trimmed and lower-cased.
 *
 * @param raw - Any guid-ish value, including the `null` the backend really sends.
 * @returns The canonical guid, or `null` when there is nothing to compare.
 */
export function normalizeGuid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/**
 * Exact, case-insensitive guid equality. Two blank/absent guids are **not**
 * considered equal: "we don't know either side" is not a match.
 *
 * @param left - First guid.
 * @param right - Second guid.
 * @returns `true` only when both sides are present and identical.
 */
export function guidsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalizeGuid(left);
  const b = normalizeGuid(right);
  return a !== null && a === b;
}

/**
 * Classifies a `rbxversion` string. WEAO writes it in two incompatible shapes —
 * a deployment guid for Windows/Mac entries and a dotted store version for
 * Android/iOS ones — and only the guid shape names something that can exist on
 * this machine.
 *
 * @param raw - The raw `rbxversion` value.
 * @returns `'guid'`, `'mobile'`, or `'unknown'` for anything else (including null).
 */
export function rbxVersionShape(raw: string | null | undefined): RbxVersionShape {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) return 'unknown';
  if (GUID_PATTERN.test(value)) return 'guid';
  if (MOBILE_PATTERN.test(value)) return 'mobile';
  return 'unknown';
}

/**
 * Decides how one installed Roblox client stands against the published builds.
 *
 * Total by construction: any argument may be `null`, `undefined` or an
 * arbitrary string, and a verdict always comes back.
 *
 * - Either side missing ⇒ `'unknown'`. There is no defensible guess to make
 *   from an absent guid, and claiming "outdated" would be a false alarm.
 * - Installed equals the announced future build ⇒ `'up-to-date'`; the machine
 *   is already ahead of what is live.
 * - Installed equals the live build ⇒ `'update-incoming'` when a *different*
 *   future build has been announced, otherwise `'up-to-date'`. That distinction
 *   is the whole point of the band: executors break on the day the forced
 *   update lands, not on the day it is announced.
 * - Anything else, with the live build known ⇒ `'outdated'`.
 *
 * @param installation - The local client, or `null` when none was detected.
 * @param currentWindowsGuid - `versions/current` Windows guid.
 * @param futureWindowsGuid - `versions/future` Windows guid, when announced.
 * @returns The verdict for this single installation.
 */
export function clientVerdict(
  installation: VersionedInstallation | null | undefined,
  currentWindowsGuid: string | null | undefined,
  futureWindowsGuid: string | null | undefined,
): ClientVerdict {
  const installed = normalizeGuid(installation?.versionGuid);
  if (installed === null) return 'unknown';

  const current = normalizeGuid(currentWindowsGuid);
  const future = normalizeGuid(futureWindowsGuid);

  if (future !== null && installed === future) return 'up-to-date';
  // Without the live guid, "not the future build" says nothing: the client
  // could be the current one. Reporting 'outdated' here would be a guess.
  if (current === null) return 'unknown';
  if (installed === current) {
    return future !== null && future !== current ? 'update-incoming' : 'up-to-date';
  }
  return 'outdated';
}

/** Severity order used to reduce many installations to one headline verdict. */
const VERDICT_SEVERITY: Record<ClientVerdict, number> = {
  outdated: 0,
  'update-incoming': 1,
  'up-to-date': 2,
  unknown: 3,
};

/**
 * Reduces every detected client to the single verdict the status band shows.
 * The worst verdict wins, because one outdated client is enough to break the
 * executor the user is about to launch.
 *
 * @param installations - Every detected client (may be empty).
 * @param currentWindowsGuid - `versions/current` Windows guid.
 * @param futureWindowsGuid - `versions/future` Windows guid, when announced.
 * @returns The most severe verdict across the list; `'unknown'` when empty.
 */
export function aggregateVerdict(
  installations: readonly VersionedInstallation[],
  currentWindowsGuid: string | null | undefined,
  futureWindowsGuid: string | null | undefined,
): ClientVerdict {
  let worst: ClientVerdict = 'unknown';
  for (const installation of installations) {
    const verdict = clientVerdict(installation, currentWindowsGuid, futureWindowsGuid);
    if (VERDICT_SEVERITY[verdict] < VERDICT_SEVERITY[worst]) worst = verdict;
  }
  return worst;
}

/**
 * Collects the distinct, canonical guids present on this machine.
 *
 * @param installations - Every detected client (guid-less ones are skipped).
 * @returns Unique canonical guids, in first-seen order.
 */
export function collectInstalledGuids(
  installations: readonly VersionedInstallation[],
): string[] {
  const seen = new Set<string>();
  for (const installation of installations) {
    const guid = normalizeGuid(installation?.versionGuid);
    if (guid !== null) seen.add(guid);
  }
  return [...seen];
}

/**
 * Whether the Roblox build an executor targets is already installed locally.
 *
 * Only the guid shape of `rbxversion` can ever match: a mobile entry reports
 * `2.729.838`, which names a store build and not a `version-…` directory, so
 * those always answer `false` rather than being coerced into a comparison that
 * cannot succeed.
 *
 * @param executor - The catalogue entry (only `rbxversion` is read).
 * @param installedGuids - Guids present on disk; raw or canonical, nulls fine.
 * @returns `true` only when the target is a guid and it is installed.
 */
export function executorTargetsInstalled(
  executor: RbxVersionTarget | null | undefined,
  installedGuids: readonly (string | null | undefined)[],
): boolean {
  const raw = executor?.rbxversion;
  if (rbxVersionShape(raw) !== 'guid') return false;
  const target = normalizeGuid(raw);
  return installedGuids.some((guid) => normalizeGuid(guid) === target);
}
