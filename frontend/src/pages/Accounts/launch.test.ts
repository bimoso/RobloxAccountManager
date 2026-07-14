import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/types/models';
import {
  EMPTY_LAUNCH_INPUTS,
  buildLaunchTarget,
  buildPlaceLaunchTarget,
  launchAccounts,
  placeIdFromLaunchInput,
} from './launch';

const account: Account = {
  id: 'acc-1',
  username: 'NebulaRunner',
  userId: '9100',
  nickname: 'Nebula',
  cookie: 'cookie',
  createdAt: '2026-07-14T00:00:00.000Z',
  lastUsed: null,
  donutProfileId: null,
  donutProfilePendingDelete: false,
};

describe('Place launch target with optional Job ID', () => {
  it('keeps the original Place target when Job ID is empty', () => {
    expect(buildPlaceLaunchTarget(' 920587237 ', '')).toBe('920587237');
    expect(buildPlaceLaunchTarget('https://www.roblox.com/games/920587237/Game', '  ')).toBe(
      'https://www.roblox.com/games/920587237/Game',
    );
  });

  it('builds the exact-server URL from either a Place ID or a game URL', () => {
    expect(buildPlaceLaunchTarget('920587237', 'job-abc-123')).toBe(
      'https://www.roblox.com/games/920587237?gameId=job-abc-123',
    );
    expect(
      buildPlaceLaunchTarget(
        'https://www.roblox.com/games/920587237/Game?gameId=stale&foo=bar',
        ' replacement-job ',
      ),
    ).toBe('https://www.roblox.com/games/920587237?gameId=replacement-job');
  });

  it('requires a usable Place and a safe Job ID for exact-server launch', () => {
    expect(buildPlaceLaunchTarget('', 'job-abc')).toBeUndefined();
    expect(buildPlaceLaunchTarget('https://ro.blox.com/short', 'job-abc')).toBeUndefined();
    expect(buildPlaceLaunchTarget('920587237', 'job id with spaces')).toBeUndefined();
  });

  it('extracts supported Place ID shapes and ignores unrelated URLs', () => {
    expect(placeIdFromLaunchInput('920587237')).toBe('920587237');
    expect(placeIdFromLaunchInput('roblox.com/games/920587237/Game')).toBe('920587237');
    expect(placeIdFromLaunchInput('https://ro.blox.com/short')).toBeUndefined();
  });

  it('never leaks Job ID into Home, Player or Private modes', () => {
    const inputs = {
      ...EMPTY_LAUNCH_INPUTS,
      jobId: 'job-abc',
      followUserId: '42',
      privateLink: 'https://www.roblox.com/games/1?privateServerLinkCode=private',
    };
    expect(buildLaunchTarget('home', inputs)).toBe('');
    expect(buildLaunchTarget('player', inputs)).toBe(
      'https://www.roblox.com/home?followUserId=42',
    );
    expect(buildLaunchTarget('private', inputs)).toBe(inputs.privateLink);
  });
});

describe('launch result handling', () => {
  it('treats a resolved backend success:false result as a failed launch', async () => {
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'Servidor no disponible.' });
    const [outcome] = await launchAccounts([account], '', { launch });

    expect(launch).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toEqual(new Error('Servidor no disponible.'));
  });
});
