// pages/Weao/types.ts
//
// Local domain types for the WEAO hub. The Tauri_Backend deliberately forwards
// the weao.xyz responses as raw JSON instead of a Rust struct, because the live
// schema already contradicts its own documentation (`extype` where the docs say
// `type`, undocumented `aexecutor`/`iexecutor`, `keysystem` missing). The shape
// the page trusts is therefore defined — and defended — here, where a drift is a
// hot-reloadable fix rather than a Rust recompile.

/** The four platforms weao.xyz publishes Roblox client versions for. */
export type WeaoPlatform = 'windows' | 'mac' | 'android' | 'ios';

/** Every platform, in the order the versions panel lays them out. */
export const WEAO_PLATFORMS: readonly WeaoPlatform[] = [
  'windows',
  'mac',
  'android',
  'ios',
] as const;

/** One published Roblox client version for a single platform. */
export interface PlatformVersion {
  /** Which platform this version belongs to. */
  platform: WeaoPlatform;
  /**
   * The published version string, verbatim. Windows and Mac report an opaque
   * deployment guid (`version-145f189a6a974303`) while Android and iOS report a
   * dotted store version (`2.729.838`), so this string is never parsed, ordered
   * or compared with `<`/`>` — see `clientStatus.ts`.
   */
  version: string;
  /** Publication date exactly as WEAO formats it, or `null` when absent. */
  updatedAt: string | null;
}

/** Per-platform version lookup; a platform WEAO omitted is simply missing. */
export type PlatformVersionMap = Partial<Record<WeaoPlatform, PlatformVersion>>;

/**
 * The `versions/current` + `versions/future` pair. `future` only ever carries
 * Windows and Mac: WEAO does not announce upcoming mobile builds.
 */
export interface WeaoVersions {
  /** The Roblox build live right now, per platform. */
  current: PlatformVersionMap;
  /** The announced upcoming build, per platform (Windows/Mac only). */
  future: PlatformVersionMap;
}

/**
 * WEAO's `extype` discriminator. The API field is `extype`, **not** `type`, and
 * `aexecutor`/`iexecutor` are absent from the published docs; `'other'` is a
 * local sentinel so an `extype` invented after this build still renders instead
 * of dropping the entry.
 */
export type ExecutorKind =
  | 'wexecutor'
  | 'wexternal'
  | 'mexecutor'
  | 'aexecutor'
  | 'iexecutor'
  | 'other';

/** Every `extype` WEAO is known to emit, used by the normalizer's allowlist. */
export const EXECUTOR_KINDS: readonly ExecutorKind[] = [
  'wexecutor',
  'wexternal',
  'mexecutor',
  'aexecutor',
  'iexecutor',
  'other',
] as const;

/** Artwork WEAO hosts on `cdn.weao.gg` for an executor. */
export interface ExecutorMedia {
  /** Logo URL, or `null` — only 18 of 29 entries ship one, so plan for null. */
  logo: string | null;
  /** Screenshot URLs; empty when the entry has none. */
  screenshots: string[];
}

/** A single executor entry from `status/exploits`, after normalization. */
export interface Executor {
  /** WEAO's stable identifier, used as the React key. */
  trackerId: string;
  /** Display name. */
  title: string;
  /** The executor's own version string. */
  version: string;
  /** Last-updated date as WEAO formats it, or `null`. */
  updatedDate: string | null;
  /** `true` when WEAO considers the executor current for its platform. */
  updateStatus: boolean;
  /** `true` when Roblox is reported to detect this executor. */
  detected: boolean;
  /** Free-text explanation behind {@link Executor.detected}, when given. */
  detectionReason: string | null;
  /** `true` when WEAO suspects an active banwave involving this executor. */
  possibleBanwave: boolean;
  /** `true` when the executor costs nothing. */
  free: boolean;
  /** Price label as WEAO writes it (`"$19.99"`, `"Key system"`, …). */
  cost: string | null;
  /** Normalized target platform, or `null` when neither field resolved one. */
  platform: WeaoPlatform | null;
  /** The platform label verbatim, so an unmapped value still reaches the UI. */
  platformLabel: string;
  /** The `extype` discriminator, narrowed to a known kind or `'other'`. */
  extype: ExecutorKind;
  /**
   * The Roblox build this executor targets. Comes in **two** shapes — a Windows
   * deployment guid (`version-145f189a6a974303`) or a mobile store version
   * (`2.729.838`) — and only the guid shape can be matched against a local
   * installation. See `executorTargetsInstalled`.
   */
  rbxversion: string | null;
  /** `true` when WEAO marks the executor as UNC-compliant. */
  uncStatus: boolean;
  /** UNC score percentage, or `null` when unpublished. */
  uncPercentage: number | null;
  /** sUNC score percentage. Frequently absent — `null` is the normal case. */
  suncPercentage: number | null;
  /** `true` when the executor ships a decompiler. */
  decompiler: boolean;
  /** `true` when the executor can inject into several clients at once. */
  multiInject: boolean;
  /** `true` when the executor exposes RakNet-level hooks. */
  raknet: boolean;
  /** `true` when the executor supports client-side mods. */
  clientmods: boolean;
  /** Homepage URL, or `null`. Opened through `ipc.openExternal`, never `<a>`. */
  websitelink: string | null;
  /** Discord invite URL, or `null`. */
  discordlink: string | null;
  /** Purchase URL, or `null`. */
  purchaselink: string | null;
  /** `true` when WEAO flags known outstanding issues. */
  hasIssues: boolean;
  /** `true` when the build is a beta/preview channel. */
  beta: boolean;
  /** Logo and screenshots hosted on `cdn.weao.gg`. */
  slug: ExecutorMedia;
}

/** Platform selector value; `'all'` disables the platform predicate. */
export type PlatformFilter = 'all' | WeaoPlatform;

/** Pricing selector value. */
export type CostFilter = 'all' | 'free' | 'paid';

/**
 * Status selector value. `'flagged'` unions the two risk signals because a user
 * scanning for danger does not care which of the two fired.
 */
export type ExecutorStatusFilter =
  | 'all'
  | 'updated'
  | 'outdated'
  | 'undetected'
  | 'flagged';

/** The complete filter state the executor grid is derived from. */
export interface ExecutorFilters {
  /** Free-text title query, matched case-insensitively after trimming. */
  query: string;
  /** Platform predicate. */
  platform: PlatformFilter;
  /** Pricing predicate. */
  cost: CostFilter;
  /** Status predicate. */
  status: ExecutorStatusFilter;
}

/** Filter state with every predicate disabled. */
export const DEFAULT_EXECUTOR_FILTERS: ExecutorFilters = {
  query: '',
  platform: 'all',
  cost: 'all',
  status: 'all',
};
