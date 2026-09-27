// lib/privateServers.ts
//
// Private-server link parsing shared by the Games library and the session
// launcher. Kept free of React so it can be unit-tested and reused by stores.
//
// The Tauri backend (`roblox_process::parse_launch_target`) already accepts two
// private-server shapes and this module only mirrors that classification on the
// renderer side, so a link the UI accepts is exactly a link the launcher can
// open:
//
//   1. `https://www.roblox.com/games/<placeId>?privateServerLinkCode=<code>`
//      → `RequestPrivateGame` (the place id is carried by the path).
//   2. `https://www.roblox.com/share?code=<code>&type=Server`
//      → `ShareLink` (the place id is resolved by the backend at launch time,
//      so the renderer cannot know which game it belongs to).

/** A private-server link the launcher understands. */
export type PrivateServerLink =
  | {
      kind: 'private';
      /** The canonical URL handed to the launcher. */
      url: string;
      /** The experience the link belongs to. */
      placeId: string;
      /** The `privateServerLinkCode` query value. */
      code: string;
    }
  | {
      kind: 'share';
      /** The canonical URL handed to the launcher. */
      url: string;
      /** The share `code` query value. */
      code: string;
    };

/**
 * Extract a Place ID from a bare numeric id or any URL whose path carries
 * `/games/<id>`. Returns `undefined` when neither shape is present.
 */
export function placeIdFromInput(value: string): string | undefined {
  const input = value.trim();
  if (/^\d+$/.test(input)) return input;
  return input.match(/(?:^|\/)games\/(\d+)(?:[/?#]|$)/i)?.[1];
}

function parseUrl(value: string): URL | null {
  const input = value.trim();
  if (!input) return null;
  try {
    return new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
}

/**
 * Classify `value` as one of the private-server link shapes the backend can
 * launch, or `null` when it is a plain game link, a public-server link or noise.
 */
export function parsePrivateServerLink(value: string): PrivateServerLink | null {
  const url = parseUrl(value);
  if (!url) return null;

  const privateCode = url.searchParams.get('privateServerLinkCode')?.trim() ?? '';
  const placeId = placeIdFromInput(url.pathname);
  if (privateCode && placeId) {
    return {
      kind: 'private',
      url: `https://www.roblox.com/games/${placeId}?privateServerLinkCode=${encodeURIComponent(privateCode)}`,
      placeId,
      code: privateCode,
    };
  }

  const shareCode = url.searchParams.get('code')?.trim() ?? '';
  const shareType = url.searchParams.get('type')?.trim() ?? '';
  if (shareCode && (url.pathname === '/share' || shareType)) {
    const type = shareType || 'Server';
    return {
      kind: 'share',
      url: `https://www.roblox.com/share?code=${encodeURIComponent(shareCode)}&type=${encodeURIComponent(type)}`,
      code: shareCode,
    };
  }

  return null;
}

/** True when `value` is a link the private-server launcher accepts. */
export function isPrivateServerLink(value: string): boolean {
  return parsePrivateServerLink(value) !== null;
}

/**
 * Canonical form used to deduplicate saved servers: the same code pasted with
 * or without `www.`, with extra tracking params, or as a bare host still maps
 * to one entry. Falls back to the trimmed input for links that do not parse.
 */
export function normalizePrivateServerLink(value: string): string {
  return parsePrivateServerLink(value)?.url ?? value.trim();
}

/** A short, recognisable rendering of a private-server code for row metadata. */
export function shortenPrivateCode(value: string): string {
  const code = value.trim();
  if (code.length <= 14) return code;
  return `${code.slice(0, 6)}…${code.slice(-5)}`;
}
