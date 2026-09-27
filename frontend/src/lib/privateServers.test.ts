import { describe, expect, it } from 'vitest';
import {
  isPrivateServerLink,
  normalizePrivateServerLink,
  parsePrivateServerLink,
  placeIdFromInput,
  shortenPrivateCode,
} from './privateServers';

describe('placeIdFromInput', () => {
  it('accepts bare ids and /games/<id> paths, rejects everything else', () => {
    expect(placeIdFromInput(' 920587237 ')).toBe('920587237');
    expect(placeIdFromInput('https://www.roblox.com/games/920587237/Adopt-Me')).toBe('920587237');
    expect(placeIdFromInput('/games/12?x=1')).toBe('12');
    expect(placeIdFromInput('roblox.com/home')).toBeUndefined();
    expect(placeIdFromInput('abc')).toBeUndefined();
  });
});

describe('parsePrivateServerLink', () => {
  it('canonicalizes a privateServerLinkCode link and keeps its Place', () => {
    expect(
      parsePrivateServerLink('roblox.com/games/606849621/Name?privateServerLinkCode=abc123XYZ&foo=bar'),
    ).toEqual({
      kind: 'private',
      url: 'https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ',
      placeId: '606849621',
      code: 'abc123XYZ',
    });
  });

  it('canonicalizes share links, defaulting the type to Server', () => {
    expect(parsePrivateServerLink('https://www.roblox.com/share?code=deadbeef&type=Server')).toEqual({
      kind: 'share',
      url: 'https://www.roblox.com/share?code=deadbeef&type=Server',
      code: 'deadbeef',
    });
    expect(parsePrivateServerLink('https://www.roblox.com/share?code=only')).toMatchObject({
      kind: 'share',
      url: 'https://www.roblox.com/share?code=only&type=Server',
    });
    // The (code && type) branch fires off the /share path too, as in the backend.
    expect(parsePrivateServerLink('https://www.roblox.com/games/5?code=x&type=Server')).toMatchObject({
      kind: 'share',
      code: 'x',
    });
  });

  it('returns null for public links, job links, bare ids and noise', () => {
    expect(parsePrivateServerLink('https://www.roblox.com/games/606849621')).toBeNull();
    expect(parsePrivateServerLink('https://www.roblox.com/games/1?gameId=job-1')).toBeNull();
    expect(parsePrivateServerLink('https://www.roblox.com/home?privateServerLinkCode=abc')).toBeNull();
    expect(parsePrivateServerLink('https://www.roblox.com/share?code=')).toBeNull();
    expect(parsePrivateServerLink('606849621')).toBeNull();
    expect(parsePrivateServerLink('')).toBeNull();
    expect(parsePrivateServerLink('not a url at all ::')).toBeNull();
  });

  it('exposes the boolean and normalizing helpers on top of the parser', () => {
    expect(isPrivateServerLink('https://www.roblox.com/share?code=zz&type=Server')).toBe(true);
    expect(isPrivateServerLink('https://www.roblox.com/games/1')).toBe(false);
    expect(normalizePrivateServerLink('roblox.com/games/1?privateServerLinkCode=q')).toBe(
      'https://www.roblox.com/games/1?privateServerLinkCode=q',
    );
    expect(normalizePrivateServerLink('  plain  ')).toBe('plain');
  });
});

describe('shortenPrivateCode', () => {
  it('keeps short codes and abbreviates long ones', () => {
    expect(shortenPrivateCode('abc123')).toBe('abc123');
    expect(shortenPrivateCode('0123456789abcdefghij')).toBe('012345…fghij');
  });
});
