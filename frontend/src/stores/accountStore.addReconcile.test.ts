import { describe, expect, it } from 'vitest';
import type { Account } from '../types/models';
import { reconcileAddedAccount, sameAccountIdentity } from './accountStore';

function account(id: string, username: string, userId: string): Account {
  return {
    id,
    username,
    userId,
    nickname: '',
    cookie: `cookie-${id}`,
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  };
}

describe('account add reconciliation', () => {
  it('treats equal populated userIds as the same account', () => {
    expect(sameAccountIdentity(account('a', 'OldName', '42'), account('b', 'NewName', '42')))
      .toBe(true);
  });

  it('does not collapse different populated userIds with the same username', () => {
    expect(sameAccountIdentity(account('a', 'Alice', '1'), account('b', 'Alice', '2')))
      .toBe(false);
  });

  it('replaces a backend-upserted account instead of appending a duplicate', () => {
    const current = account('canonical', 'Alice', '42');
    const saved = { ...current, cookie: 'fresh-cookie', password: 'pw' };

    expect(reconcileAddedAccount([current], saved)).toEqual([saved]);
  });

  it('collapses duplicate local cards for the returned Roblox identity', () => {
    const first = account('canonical', 'Alice', '42');
    const duplicate = account('duplicate', 'Alice', '42');
    const saved = { ...first, cookie: 'fresh-cookie' };

    const result = reconcileAddedAccount([first, duplicate], saved);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'canonical', cookie: 'fresh-cookie' });
  });
});
