import { describe, expect, it, vi } from 'vitest';
import {
  parseTargetUserId,
  processBatchFriendRequests,
  type FriendRequestSender,
} from './friendRequest';

const SENDERS: FriendRequestSender[] = [
  { id: 'acc-1', label: 'Nebula', cookie: 'cookie-1' },
  { id: 'acc-2', label: 'Orbit', cookie: 'cookie-2' },
  { id: 'acc-3', label: 'Nova', cookie: 'cookie-3' },
];

describe('parseTargetUserId', () => {
  it('accepts a positive numeric id and official Roblox profile URLs', () => {
    expect(parseTargetUserId(' 649501821072834580 ')).toBe('649501821072834580');
    expect(parseTargetUserId('https://www.roblox.com/users/123456/profile')).toBe('123456');
    expect(parseTargetUserId('roblox.com/users/987654/profile?friendshipSourceType=PlayerSearch')).toBe(
      '987654',
    );
  });

  it('rejects incidental digits, unrelated Roblox routes and lookalike hosts', () => {
    expect(parseTargetUserId('usuario123')).toBe('');
    expect(parseTargetUserId('https://www.roblox.com/games/123456/Test')).toBe('');
    expect(parseTargetUserId('https://roblox.com.evil.test/users/123/profile')).toBe('');
    expect(parseTargetUserId('https://example.com/users/123/profile')).toBe('');
    expect(parseTargetUserId('0')).toBe('');
    expect(parseTargetUserId('-42')).toBe('');
  });
});

describe('processBatchFriendRequests', () => {
  it('treats a resolved { ok:false } response as rejection and continues the batch', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Friend request is pending.' })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('Cookie expired'));
    const onProgress = vi.fn();

    const summary = await processBatchFriendRequests('123456', SENDERS, {
      send,
      onProgress,
    });

    expect(send.mock.calls).toEqual([
      ['cookie-1', '123456'],
      ['cookie-2', '123456'],
      ['cookie-3', '123456'],
    ]);
    expect(onProgress.mock.calls.map(([event]) => [event.index, event.account.id])).toEqual([
      [0, 'acc-1'],
      [1, 'acc-2'],
      [2, 'acc-3'],
    ]);
    expect(summary).toEqual({
      total: 3,
      succeeded: 1,
      results: [
        { id: 'acc-1', label: 'Nebula', ok: false, reason: 'Friend request is pending.' },
        { id: 'acc-2', label: 'Orbit', ok: true },
        { id: 'acc-3', label: 'Nova', ok: false, reason: 'Cookie expired' },
      ],
    });
  });

  it('uses a useful fallback when Roblox rejects without an error message', async () => {
    const summary = await processBatchFriendRequests('123456', [SENDERS[0]], {
      send: () => ({ ok: false }),
    });

    expect(summary.succeeded).toBe(0);
    expect(summary.results[0]).toMatchObject({
      ok: false,
      reason: 'Roblox rechazó la solicitud de amistad.',
    });
  });
});
