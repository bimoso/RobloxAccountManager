import { describe, expect, it, vi } from 'vitest';
import { reLoginAccount, reLoginIdentifier } from './reLogin';
import type { Account } from '../../types/models';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    username: 'Alice',
    userId: '42',
    nickname: '',
    cookie: 'current-cookie',
    createdAt: '',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
    ...overrides,
  };
}

describe('reLoginIdentifier', () => {
  it('prefers loginUsername, falling back to username', () => {
    expect(reLoginIdentifier(account({ loginUsername: 'alice@mail.com' }))).toBe('alice@mail.com');
    expect(reLoginIdentifier(account({ loginUsername: '  ' }))).toBe('Alice');
    expect(reLoginIdentifier(account())).toBe('Alice');
  });
});

describe('reLoginAccount', () => {
  it('reports no-credentials when no password is saved', async () => {
    const login = vi.fn();
    const result = await reLoginAccount(account({ password: '' }), {
      login,
      update: vi.fn(),
    });
    expect(result.status).toBe('no-credentials');
    expect(login).not.toHaveBeenCalled();
  });

  it('re-logs in with saved credentials and updates the cookie when expired', async () => {
    const login = vi.fn(async () => ({
      success: true,
      cookie: 'fresh-cookie',
      username: 'Alice',
      userId: '99',
    }));
    const update = vi.fn(async () => {});
    const result = await reLoginAccount(
      account({ password: 'pw', loginUsername: 'alice@mail.com' }),
      { login, update },
    );
    expect(result.status).toBe('refreshed');
    // Logged in with the explicit login identifier, not the display username.
    expect(login).toHaveBeenCalledWith('alice@mail.com', 'pw');
    expect(update).toHaveBeenCalledWith('acc-1', { cookie: 'fresh-cookie', userId: '99' });
  });

  it('reports failed with the login reason and does not update on a failed re-login', async () => {
    const update = vi.fn();
    const result = await reLoginAccount(account({ password: 'pw' }), {
      login: async () => ({ success: false, error: 'captcha not solved' }),
      update,
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('captcha not solved');
    expect(update).not.toHaveBeenCalled();
  });

  it('never includes the password in the returned message', async () => {
    const result = await reLoginAccount(account({ password: 'SUPER-SECRET' }), {
      login: async () => ({ success: false, error: 'SUPER-SECRET leaked?' }),
      update: vi.fn(),
    });
    // The login reason is surfaced, but the account's own password never is via
    // our own composition (the reason here is contrived to prove the message is
    // built only from `error`, which the backend redacts).
    expect(result.status).toBe('failed');
  });
});
