import { describe, expect, it, vi } from 'vitest';
import {
  extractBloxGenAccount,
  isValidBloxGenApiKey,
  runGeneratorPipeline,
} from './generatorPipeline';

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
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
    const fetcher = vi.fn().mockResolvedValue(
      response({
        success: true,
        data: { username: 'RejectedUser', password: 'pass', cookie: 'bad-cookie' },
      }),
    );
    const validate = vi.fn().mockResolvedValue({ ok: false, reason: 'expired' });
    const add = vi.fn();

    const outcome = await runGeneratorPipeline('BLOX-test', {
      fetcher,
      validate,
      add,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://core.bloxgen.net/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ apiKey: 'BLOX-test', type: 'alt' }),
      }),
    );
    expect(validate).toHaveBeenCalledWith('bad-cookie');
    expect(add).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, failedAt: 'validate' });
    expect(outcome.historyEntry).not.toHaveProperty('cookie');
    expect(JSON.stringify(outcome.historyEntry)).not.toContain('bad-cookie');
  });

  it('adds the normalized account automatically only after validation succeeds', async () => {
    const order: string[] = [];
    const fetcher = vi.fn().mockImplementation(async () => {
      order.push('generate');
      return response({
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
      fetcher,
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

  it('redacts an echoed API key before an API failure reaches history', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(
        { success: false, message: 'Invalid key BLOX-ultra-secret' },
        false,
        401,
      ),
    );

    const outcome = await runGeneratorPipeline('BLOX-ultra-secret', {
      fetcher,
      validate: vi.fn(),
      add: vi.fn(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.historyEntry.message).toContain('[credencial oculta]');
    expect(JSON.stringify(outcome.historyEntry)).not.toContain('BLOX-ultra-secret');
  });
});
