import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERSISTENCE_KEYS, setPersisted } from '@/lib/persistence';

const mocks = vi.hoisted(() => ({
  bloxgenGenerate: vi.fn(),
  bloxgenStock: vi.fn(),
  validateCookie: vi.fn(),
  readGenHistory: vi.fn(),
  writeGenHistory: vi.fn(),
  clearGenHistory: vi.fn(),
  add: vi.fn(),
  navigate: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    bloxgenGenerate: mocks.bloxgenGenerate,
    bloxgenStock: mocks.bloxgenStock,
    validateCookie: mocks.validateCookie,
    readGenHistory: mocks.readGenHistory,
    writeGenHistory: mocks.writeGenHistory,
    clearGenHistory: mocks.clearGenHistory,
  },
}));

vi.mock('@/stores/accountStore', () => ({
  useAccountStore: (selector: (state: { add: typeof mocks.add }) => unknown) =>
    selector({ add: mocks.add }),
}));

vi.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (selector: (state: { navigate: typeof mocks.navigate }) => unknown) =>
    selector({ navigate: mocks.navigate }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (
    selector: (state: {
      showSuccess: typeof mocks.showSuccess;
      showError: typeof mocks.showError;
    }) => unknown,
  ) => selector({ showSuccess: mocks.showSuccess, showError: mocks.showError }),
}));

import Generator from './index';

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() { return values.size; },
  } as Storage;
}

/** A `{ status, body }` result as the backend `bloxgen_generate` command returns. */
function response(body: unknown, status = 200): { status: number; body: unknown } {
  return { status, body };
}

describe('Generator secure automatic add flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createStorageMock());
    // Stock is advisory: the picker offers every type when the lookup yields
    // nothing usable, so an empty envelope keeps these cases key-focused.
    mocks.bloxgenStock.mockResolvedValue({ status: 200, body: { success: false } });
    mocks.readGenHistory.mockResolvedValue([]);
    mocks.writeGenHistory.mockResolvedValue(true);
    mocks.clearGenHistory.mockResolvedValue(true);
    mocks.add.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('routes to Settings instead of editing a missing key in Generator', async () => {
    const user = userEvent.setup();
    render(<Generator />);

    await user.click(screen.getByRole('button', { name: /configure BloxGen$/i }));

    expect(mocks.navigate).toHaveBeenCalledWith('settings');
    expect(mocks.bloxgenGenerate).not.toHaveBeenCalled();
  });

  it('validates the generated cookie and never adds it when Roblox rejects it', async () => {
    setPersisted(PERSISTENCE_KEYS.bloxgenApiKey, 'BLOX-integration-test');
    mocks.bloxgenGenerate.mockResolvedValue(
      response({
        success: true,
        data: { username: 'UnsafeResult', password: 'pass', cookie: 'invalid-cookie' },
      }),
    );
    mocks.validateCookie.mockResolvedValue({ ok: false, reason: 'expired' });
    const user = userEvent.setup();
    render(<Generator />);

    await user.click(screen.getByRole('button', { name: /generate and add/i }));

    await waitFor(() => expect(mocks.validateCookie).toHaveBeenCalledWith('invalid-cookie'));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(mocks.writeGenHistory).toHaveBeenCalledWith([
      expect.objectContaining({ result: 'rejected', step: 'validate' }),
    ]);
    const persisted = mocks.writeGenHistory.mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain('invalid-cookie');
  });

  it('calls the account store only after validateCookie succeeds', async () => {
    setPersisted(PERSISTENCE_KEYS.bloxgenApiKey, 'BLOX-integration-test');
    mocks.bloxgenGenerate.mockResolvedValue(
      response({
        success: true,
        data: { username: 'BloxName', password: 'generated-pass', cookie: 'valid-cookie' },
      }),
    );
    mocks.validateCookie.mockResolvedValue({
      ok: true,
      username: 'VerifiedRobloxName',
      userId: 9012,
    });
    const user = userEvent.setup();
    render(<Generator />);

    await user.click(screen.getByRole('button', { name: /generate and add/i }));

    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    expect(mocks.validateCookie.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.add.mock.invocationCallOrder[0],
    );
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'VerifiedRobloxName',
        userId: '9012',
        cookie: 'valid-cookie',
        loginUsername: 'BloxName',
        password: 'generated-pass',
      }),
    );
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(mocks.showSuccess).toHaveBeenCalledWith('VerifiedRobloxName was added to Accounts');
  });
});
