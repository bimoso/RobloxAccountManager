import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/types/models';
import { FriendRequestModal } from './FriendRequestModal';

const ACCOUNTS: Account[] = [
  {
    id: 'acc-1',
    username: 'NebulaRunner',
    userId: '9100',
    nickname: 'Nebula',
    cookie: 'cookie-1',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
  {
    id: 'acc-2',
    username: 'OrbitPilot',
    userId: '9200',
    nickname: 'Orbit',
    cookie: 'cookie-2',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  },
];

describe('FriendRequestModal', () => {
  it('rejects arbitrary text containing digits before invoking IPC', async () => {
    const user = userEvent.setup();
    const sendRequest = vi.fn();
    const { container } = render(
      <FriendRequestModal
        open
        accounts={[ACCOUNTS[0]]}
        onClose={vi.fn()}
        sendRequest={sendRequest}
      />,
    );

    expect(container.querySelector('.friend-request-modal')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/User ID o enlace de perfil/i), 'usuario123');
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Escribe un User ID o pega un perfil oficial de Roblox.',
    );
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('shows each resolved backend rejection instead of claiming the whole batch succeeded', async () => {
    const user = userEvent.setup();
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Friend request is pending.' })
      .mockResolvedValueOnce({ ok: true });

    render(
      <FriendRequestModal
        open
        accounts={ACCOUNTS}
        onClose={vi.fn()}
        sendRequest={sendRequest}
      />,
    );

    await user.type(
      screen.getByLabelText(/User ID o enlace de perfil/i),
      'https://www.roblox.com/users/123456/profile',
    );
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(await screen.findByText('Lote completado con alertas')).toBeInTheDocument();
    expect(screen.getByText('1 de 2 aceptadas')).toBeInTheDocument();
    expect(screen.getByText('Friend request is pending.')).toBeInTheDocument();
    expect(screen.getByText('Enviada')).toBeInTheDocument();
    expect(sendRequest.mock.calls).toEqual([
      ['cookie-1', '123456'],
      ['cookie-2', '123456'],
    ]);
  });

  it('keeps the modal locked while the current account is being processed', async () => {
    const user = userEvent.setup();
    let resolveRequest: ((value: unknown) => void) | undefined;
    const sendRequest = vi.fn(
      () => new Promise<unknown>((resolve) => { resolveRequest = resolve; }),
    );

    render(
      <FriendRequestModal
        open
        accounts={[ACCOUNTS[0]]}
        onClose={vi.fn()}
        sendRequest={sendRequest}
      />,
    );

    await user.type(screen.getByLabelText(/User ID o enlace de perfil/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(await screen.findByText(/Enviando desde/i)).toHaveTextContent('Nebula');
    expect(screen.getByRole('progressbar', { name: /Progreso del envío/i })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.getByRole('button', { name: 'Cerrar' })).toBeDisabled();

    await act(async () => {
      resolveRequest?.({ ok: true });
    });

    await waitFor(() => {
      expect(screen.getByText('Solicitudes enviadas')).toBeInTheDocument();
    });
  });
});
