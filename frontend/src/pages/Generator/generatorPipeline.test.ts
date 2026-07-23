import { describe, expect, it, vi } from 'vitest';
import {
  extractBloxGenAccount,
  isValidBloxGenApiKey,
  runGeneratorPipeline,
} from './generatorPipeline';

/** A `{ status, body }` result as the backend `bloxgen_generate` command returns. */
function generated(body: unknown, status = 200): { status: number; body: unknown } {
  return { status, body };
}

describe('BloxGen generation pipeline', () => {
  it('extracts a cookie from nested and legacy response envelopes', () => {
    expect(
      extractBloxGenAccount({
        success: true,
        result: {
          account: {
            username: 'NestedUser',
            password: 'secret-pass',
            '.ROBLOSECURITY': 'ROBLOX_COOKIE',
          },
        },
      }),
    ).toEqual({
      username: 'NestedUser',
      password: 'secret-pass',
      cookie: 'ROBLOX_COOKIE',
    });
  });

  it('accepts only non-empty BLOX- keys without whitespace', () => {
    expect(isValidBloxGenApiKey('BLOX-demo-key')).toBe(true);
    expect(isValidBloxGenApiKey(' BLOX-demo-key ')).toBe(true);
    expect(isValidBloxGenApiKey('BLOX-')).toBe(false);
    expect(isValidBloxGenApiKey('blox-demo')).toBe(false);
    expect(isValidBloxGenApiKey('BLOX-key with spaces')).toBe(false);
  });

  it('never calls the account store when Roblox rejects the generated cookie', async () => {
    const generate = vi.fn().mockResolvedValue(
      generated({
        success: true,
        data: { username: 'RejectedUser', password: 'pass', cookie: 'bad-cookie' },
      }),
    );
    const validate = vi.fn().mockResolvedValue({ ok: false, reason: 'expired' });
    const add = vi.fn();

    const outcome = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate,
      add,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(generate).toHaveBeenCalledWith('BLOX-test', 'alt');
    expect(validate).toHaveBeenCalledWith('bad-cookie');
    expect(add).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, failedAt: 'validate' });
    expect(outcome.historyEntry).not.toHaveProperty('cookie');
    expect(JSON.stringify(outcome.historyEntry)).not.toContain('bad-cookie');
  });

  it('adds the normalized account automatically only after validation succeeds', async () => {
    const order: string[] = [];
    const generate = vi.fn().mockImplementation(async () => {
      order.push('generate');
      return generated({
        success: true,
        data: { username: 'ApiName', password: 'generated-pass', cookie: 'valid-cookie' },
      });
    });
    const validate = vi.fn().mockImplementation(async () => {
      order.push('validate');
      return { ok: true, username: 'RobloxName', userId: 1234 };
    });
    const add = vi.fn().mockImplementation(async () => {
      order.push('add');
    });

    const outcome = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate,
      add,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(order).toEqual(['generate', 'validate', 'add']);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'RobloxName',
        userId: '1234',
        cookie: 'valid-cookie',
        loginUsername: 'ApiName',
        password: 'generated-pass',
      }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      historyEntry: {
        username: 'RobloxName',
        password: 'generated-pass',
        result: 'added',
      },
    });
    expect(outcome.historyEntry).not.toHaveProperty('cookie');
  });

  it('rejects a moderated cookie by default but accepts it when the toggle is on', async () => {
    const moderatedBody = JSON.stringify({ errors: [{ code: 0, message: 'User is moderated' }] });
    const makeGenerate = () =>
      vi.fn().mockResolvedValue(
        generated({
          success: true,
          data: { username: 'ModUser', password: 'p', cookie: 'mod-cookie' },
        }),
      );
    // Backend flags a moderated cookie: ok:false, moderated:true, no username.
    const validate = vi.fn().mockResolvedValue({ ok: false, moderated: true, reason: moderatedBody });

    // Toggle OFF → validation failure, nothing added.
    const addOff = vi.fn();
    const off = await runGeneratorPipeline('BLOX-test', {
      generate: makeGenerate(),
      validate,
      add: addOff,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(off).toMatchObject({ ok: false, failedAt: 'validate' });
    expect(addOff).not.toHaveBeenCalled();

    // Toggle ON → accepted, added with the BloxGen username and moderated flag.
    const addOn = vi.fn();
    const on = await runGeneratorPipeline('BLOX-test', {
      generate: makeGenerate(),
      validate,
      add: addOn,
      acceptModerated: true,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(on).toMatchObject({ ok: true, moderated: true });
    expect(addOn).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'ModUser', cookie: 'mod-cookie', moderated: true }),
    );
  });

  it('redacts an echoed API key before an API failure reaches history', async () => {
    const generate = vi.fn().mockResolvedValue(
      generated({ success: false, message: 'Invalid key BLOX-ultra-secret' }, 401),
    );

    const outcome = await runGeneratorPipeline('BLOX-ultra-secret', {
      generate,
      validate: vi.fn(),
      add: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.historyEntry.message).toContain('[credencial oculta]');
    expect(JSON.stringify(outcome.historyEntry)).not.toContain('BLOX-ultra-secret');
  });

  it('surfaces the API message and the cooldown wait on a 429', async () => {
    const generate = vi.fn().mockResolvedValue(
      generated(
        { success: false, message: 'Please wait before generating another account', timeRemaining: 4500 },
        429,
      ),
    );

    const outcome = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate: vi.fn(),
      add: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.historyEntry.message).toContain('Please wait before generating another account');
    // 4500 ms of cooldown is reported to the user as 5s.
    expect(outcome.historyEntry.message).toContain('5s');
  });

  it('falls back to user:pass login when the cookie is rejected and the toggle is on', async () => {
    const generate = vi.fn().mockResolvedValue(
      generated({
        success: true,
        data: { username: 'GenUser', password: 'gen-pass', cookie: 'dead-cookie' },
      }),
    );
    // Roblox rejects the generated cookie.
    const validate = vi.fn().mockResolvedValue({ ok: false, reason: 'expired' });
    const add = vi.fn().mockResolvedValue(undefined);
    const loginWithCredentials = vi.fn().mockResolvedValue({
      success: true,
      cookie: 'fresh-cookie',
      username: 'RobloxUser',
      userId: '77',
    });

    // OFF → no fallback, validate failure.
    const off = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate,
      add,
      loginWithCredentials,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(off).toMatchObject({ ok: false, failedAt: 'validate' });
    expect(loginWithCredentials).not.toHaveBeenCalled();

    // ON → logs in with the generated user:pass and adds the fresh cookie.
    const on = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate,
      add,
      retryWithCredentials: true,
      loginWithCredentials,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(loginWithCredentials).toHaveBeenCalledWith('GenUser', 'gen-pass');
    expect(on).toMatchObject({ ok: true, usedCredentials: true });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'RobloxUser',
        cookie: 'fresh-cookie',
        loginUsername: 'GenUser',
        password: 'gen-pass',
      }),
    );
  });

  it('reports a service outage when the host answers with a non-BloxGen body', async () => {
    // Railway's edge fallback when no app is deployed at core.bloxgen.net: a 404
    // whose body has no `success` field, so it never came from the API itself.
    const generate = vi.fn().mockResolvedValue(
      generated(
        { status: 'error', code: 404, message: 'Application not found', request_id: 'abc' },
        404,
      ),
    );

    const outcome = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate: vi.fn(),
      add: vi.fn(),
    });

    expect(outcome).toMatchObject({ ok: false, failedAt: 'generate' });
    expect(outcome.historyEntry.message).toContain('no está disponible');
    // The cryptic infrastructure wording is never shown to the user.
    expect(outcome.historyEntry.message).not.toContain('Application not found');
  });

  it('reports a transport failure instead of a blank error', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const outcome = await runGeneratorPipeline('BLOX-test', {
      generate,
      validate: vi.fn(),
      add: vi.fn(),
    });

    expect(outcome).toMatchObject({ ok: false, failedAt: 'generate' });
    expect(outcome.historyEntry.message).toContain('Failed to fetch');
  });
});
