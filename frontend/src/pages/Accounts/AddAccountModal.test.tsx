import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateCookie: vi.fn(),
  onChromeProgress: vi.fn(),
  cancelLogin: vi.fn(),
  openLogin: vi.fn(),
  loginCredentials: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({ ipc: mocks }));

import { AddAccountModal } from './AddAccountModal';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onChromeProgress.mockResolvedValue(() => undefined);
  mocks.validateCookie.mockImplementation(async (cookie: string) => ({
    ok: true,
    username: `user-${cookie}`,
    userId: `id-${cookie}`,
  }));
});

describe('AddAccountModal unified cookie flow', () => {
  it('uses one Cookie(s) method for a single cookie and closes on success', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<AddAccountModal open onClose={onClose} onAdd={onAdd} />);

    expect(screen.queryByRole('tab', { name: 'Una cookie' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Varias cookies' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Cookie(s)' }));
    await user.type(screen.getByLabelText('Cookie(s) de Roblox'), 'cookie-one');
    await user.click(screen.getByRole('button', { name: 'Añadir cuenta' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(mocks.validateCookie).toHaveBeenCalledWith('cookie-one');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('processes every non-empty line through the same control', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<AddAccountModal open onClose={vi.fn()} onAdd={onAdd} />);

    await user.click(screen.getByRole('tab', { name: 'Cookie(s)' }));
    await user.type(screen.getByLabelText('Cookie(s) de Roblox'), 'cookie-a\n\ncookie-b');
    expect(screen.getByText(/cookies detectadas/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Añadir cuentas' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(mocks.validateCookie.mock.calls.map(([cookie]) => cookie)).toEqual([
      'cookie-a',
      'cookie-b',
    ]);
    expect(screen.getByText('Se añadieron 2 de 2 cuentas.')).toBeInTheDocument();
  });
});
