import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Account } from '@/types/models';
import { LaunchModal } from './LaunchModal';

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

function renderModal(overrides: Partial<ComponentProps<typeof LaunchModal>> = {}) {
  const onClose = vi.fn();
  const onLaunched = vi.fn();
  const launch = vi.fn().mockResolvedValue({ success: true });
  const fetchGameDetails = vi.fn().mockResolvedValue({ ok: false });
  render(
    <LaunchModal
      open
      accounts={[account]}
      onClose={onClose}
      onLaunched={onLaunched}
      launch={launch}
      fetchGameDetails={fetchGameDetails}
      {...overrides}
    />,
  );
  return { onClose, onLaunched, launch, fetchGameDetails };
}

describe('LaunchModal exact Place flow', () => {
  it('shows Job ID only inside Place and keeps it optional', async () => {
    const user = userEvent.setup();
    renderModal();

    expect(screen.queryByLabelText(/Job ID/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Place/i }));

    expect(await screen.findByLabelText(/Job ID/i)).toBeInTheDocument();
    expect(screen.getByText('Vacío entra a cualquier servidor disponible.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lanzar ahora/i })).toBeDisabled();
  });

  it('sends a canonical gameId target when the optional Job ID is filled', async () => {
    const user = userEvent.setup();
    const { launch, onClose, onLaunched } = renderModal();
    await user.click(screen.getByRole('tab', { name: /Place/i }));
    await user.type(await screen.findByLabelText(/Place ID o enlace/i), '920587237');
    await user.type(await screen.findByLabelText(/Job ID/i), 'job-abc-123');
    await user.click(screen.getByRole('button', { name: /Lanzar ahora/i }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(
        account,
        'https://www.roblox.com/games/920587237?gameId=job-abc-123',
      );
    });
    expect(onLaunched).toHaveBeenCalledWith(account.id);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the modal open and shows the backend error for success:false', async () => {
    const user = userEvent.setup();
    const launch = vi.fn().mockResolvedValue({
      success: false,
      error: 'La instancia solicitada ya no está disponible.',
    });
    const { onClose, onLaunched } = renderModal({ launch });
    await user.click(screen.getByRole('button', { name: /Lanzar ahora/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La instancia solicitada ya no está disponible.',
    );
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
