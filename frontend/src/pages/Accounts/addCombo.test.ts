import { describe, expect, it, vi } from 'vitest';
import {
  findAccountByUsername,
  moderationLabel,
  normalizeCredentialLogin,
  normalizeModerationInfo,
  normalizeValidation,
  parseCredentialLines,
  processBatchCookies,
  processCredentials,
  type CredentialEntry,
  type CredentialOutcome,
} from './addAccount';
import type { Account } from '../../types/models';

const COOKIE = '_|WARNING:-DO-NOT-SHARE-THIS.--long.ROBLOSECURITY-value-abcdef0123456789';

function account(username: string): Account {
  return {
    id: `id-${username}`,
    username,
    userId: `uid-${username}`,
    nickname: '',
    cookie: `cookie-${username}`,
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  };
}

describe('parseCredentialLines', () => {
  it('parses username:password pairs, splitting on the first colon only', () => {
    const entries = parseCredentialLines('alice:hunter2\nbob:a:b:c');
    expect(entries).toEqual([
      { username: 'alice', password: 'hunter2' },
      { username: 'bob', password: 'a:b:c' },
    ]);
  });

  it('extracts an inline cookie by its signature, not by counting colons', () => {
    // The cookie itself contains a `WARNING:` colon; parsing must not mis-split.
    const entries = parseCredentialLines(`alice:hunter2:${COOKIE}`);
    expect(entries).toEqual([{ username: 'alice', password: 'hunter2', cookie: COOKIE }]);
  });

  it('keeps a colon-bearing password when no cookie is present', () => {
    const entries = parseCredentialLines('carol:pa:ss:word');
    expect(entries).toEqual([{ username: 'carol', password: 'pa:ss:word' }]);
  });

  it('drops blank lines and entries with no colon, empty username, or empty password', () => {
    const entries = parseCredentialLines(
      ['', 'nopassword', ':leadingcolon', 'trailing:', '   ', 'dave:pw'].join('\n'),
    );
    expect(entries).toEqual([{ username: 'dave', password: 'pw' }]);
  });
});

describe('findAccountByUsername', () => {
  const accounts = [account('Alice'), account('Bob')];

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(findAccountByUsername(accounts, '  aLIce ')?.id).toBe('id-Alice');
  });

  it('returns undefined for no match or a blank needle', () => {
    expect(findAccountByUsername(accounts, 'carol')).toBeUndefined();
    expect(findAccountByUsername(accounts, '   ')).toBeUndefined();
  });
});

describe('normalizeCredentialLogin', () => {
  it('marks success only when success, cookie, and username are all present', () => {
    expect(
      normalizeCredentialLogin({ success: true, cookie: 'ck', username: 'u', userId: 5 }),
    ).toEqual({ success: true, cookie: 'ck', username: 'u', userId: '5', error: undefined });
  });

  it('treats a missing cookie or malformed payload as a failure', () => {
    expect(normalizeCredentialLogin({ success: true, username: 'u' }).success).toBe(false);
    expect(normalizeCredentialLogin(null).success).toBe(false);
    expect(normalizeCredentialLogin('nope').success).toBe(false);
  });
});

describe('moderation handling', () => {
  it('normalizeValidation carries the moderated flag', () => {
    expect(normalizeValidation({ ok: false, moderated: true, reason: 'x' }).moderated).toBe(true);
    expect(normalizeValidation({ ok: true, username: 'u' }).moderated).toBe(false);
  });

  it('normalizeModerationInfo + moderationLabel classify permanent vs temporary', () => {
    expect(moderationLabel(normalizeModerationInfo({ found: true, terminated: true }))).toBe(
      'baneo permanente',
    );
    expect(moderationLabel(normalizeModerationInfo({ found: true, terminated: false }))).toBe(
      'moderación temporal',
    );
    expect(moderationLabel(normalizeModerationInfo({ found: false }))).toBe(
      'moderada (tipo desconocido)',
    );
  });

  it('processBatchCookies adds a moderated cookie only when acceptModerated is on', async () => {
    const validate = vi.fn(async () => ({ ok: false, moderated: true, reason: 'User is moderated' }));

    const off = await processBatchCookies(['ck'], { validate, add: vi.fn() });
    expect(off.added).toBe(0);
    expect(off.failures).toHaveLength(1);

    const add = vi.fn(async () => {});
    const on = await processBatchCookies(['ck'], { validate, add, acceptModerated: true });
    expect(on.added).toBe(1);
    expect(on.failures).toHaveLength(0);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('processCredentials', () => {
  const entries: CredentialEntry[] = [
    { username: 'alice', password: 'p1' },
    { username: 'bob', password: 'p2' },
    { username: 'carol', password: 'p3' },
  ];

  it('saves every entry that resolves, in order', async () => {
    const resolve = vi.fn(
      async (entry: CredentialEntry): Promise<CredentialOutcome> => ({
        ok: true,
        cookie: `cookie-${entry.username}`,
        username: entry.username,
        userId: `id-${entry.username}`,
      }),
    );
    const save = vi.fn<
      (entry: CredentialEntry, outcome: CredentialOutcome, index: number) => Promise<void>
    >();

    const summary = await processCredentials(entries, { resolve, save });

    expect(summary).toEqual({ total: 3, saved: 3, failures: [] });
    expect(save).toHaveBeenCalledTimes(3);
    // The entry (with its password) and the resolved outcome both reach `save`.
    expect(save.mock.calls[0][0]).toEqual({ username: 'alice', password: 'p1' });
    expect(save.mock.calls[0][1]).toMatchObject({ cookie: 'cookie-alice' });
  });

  it('records a failure identified by username and continues past a failed resolve', async () => {
    const resolve = vi.fn(async (entry: CredentialEntry): Promise<CredentialOutcome> => {
      if (entry.username === 'bob') return { ok: false, error: 'captcha not solved' };
      return { ok: true, cookie: 'ck', username: entry.username, userId: '1' };
    });
    const save = vi.fn(async () => {});

    const summary = await processCredentials(entries, { resolve, save });

    expect(summary.saved).toBe(2);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ index: 1, username: 'bob' });
    expect(summary.failures[0].reason).toContain('captcha not solved');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('never leaks the password into progress events or failures', async () => {
    const events: string[] = [];
    const resolve = vi.fn(async (): Promise<CredentialOutcome> => ({ ok: false, error: 'nope' }));
    const summary = await processCredentials([{ username: 'alice', password: 'SECRET-PW' }], {
      resolve,
      save: vi.fn(),
      onProgress: (event) => events.push(JSON.stringify(event)),
    });

    const serialized = JSON.stringify({ summary, events });
    expect(serialized).not.toContain('SECRET-PW');
  });

  it('stops cleanly between entries when shouldAbort turns true', async () => {
    const resolve = vi.fn(async (entry: CredentialEntry): Promise<CredentialOutcome> => ({
      ok: true,
      cookie: 'ck',
      username: entry.username,
      userId: '1',
    }));
    let processed = 0;
    const save = vi.fn(async () => {
      processed += 1;
    });
    const shouldAbort = () => processed >= 1;

    const summary = await processCredentials(entries, { resolve, save, shouldAbort });

    expect(summary.saved).toBe(1);
    expect(summary.failures).toHaveLength(0);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('reports a save failure without stopping the run', async () => {
    const resolve = vi.fn(async (entry: CredentialEntry): Promise<CredentialOutcome> => ({
      ok: true,
      cookie: 'ck',
      username: entry.username,
      userId: '1',
    }));
    let saveCalls = 0;
    const save = vi.fn(async () => {
      if (saveCalls++ === 0) throw new Error('disk full');
    });

    const summary = await processCredentials(entries.slice(0, 2), { resolve, save });

    expect(summary.saved).toBe(1);
    expect(summary.failures[0]).toMatchObject({ index: 0, username: 'alice' });
    expect(summary.failures[0].reason).toContain('disk full');
  });
});
