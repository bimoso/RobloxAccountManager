import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Account } from '@/types/models';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
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

beforeEach(() => {
  usePlaceLibraryStore.setState({ entries: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LaunchModal exact Place flow', () => {
  it('shows Job ID only inside Place and keeps it optional', async () => {
    const user = userEvent.setup();
    renderModal();

    expect(screen.queryByLabelText(/Job ID/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Place/i }));

    expect(await screen.findByLabelText(/Job ID/i)).toBeInTheDocument();
    expect(screen.getByText('Empty joins any available server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Launch now/i })).toBeDisabled();
  });

  it('sends a canonical gameId target when the optional Job ID is filled', async () => {
    const user = userEvent.setup();
    const { launch, onClose, onLaunched } = renderModal();
    await user.click(screen.getByRole('tab', { name: /Place/i }));
    await user.type(await screen.findByLabelText(/Place ID or link/i), '920587237');
    await user.type(await screen.findByLabelText(/Job ID/i), 'job-abc-123');
    await user.click(screen.getByRole('button', { name: /Launch now/i }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(
        account,
        'https://www.roblox.com/games/920587237?gameId=job-abc-123',
      );
    });
    expect(onLaunched).toHaveBeenCalledWith(account.id);
    expect(onClose).toHaveBeenCalledOnce();
    expect(usePlaceLibraryStore.getState().entries).toEqual([
      expect.objectContaining({
        placeId: '920587237',
        launchCount: 1,
        lastLaunchedAt: expect.any(Number),
      }),
    ]);
  });

  it('keeps the modal open and shows the backend error for success:false', async () => {
    const user = userEvent.setup();
    const launch = vi.fn().mockResolvedValue({
      success: false,
      error: 'La instancia solicitada ya no está disponible.',
    });
    const { onClose, onLaunched } = renderModal({ launch });
    await user.click(screen.getByRole('tab', { name: /Place/i }));
    await user.type(await screen.findByLabelText(/Place ID or link/i), '920587237');
    await user.click(screen.getByRole('button', { name: /Launch now/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La instancia solicitada ya no está disponible.',
    );
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(usePlaceLibraryStore.getState().entries).toEqual([]);
  });

  it('selects a recent Place without recycling the previous Job ID', async () => {
    usePlaceLibraryStore.setState({
      entries: [
        {
          placeId: '456789',
          name: 'History Place',
          favorite: false,
          lastLaunchedAt: 123,
          launchCount: 2,
          privateServers: [],
          lastAccountIds: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('tab', { name: /Place/i }));

    const placeInput = await screen.findByLabelText(/Place ID or link/i);
    const jobInput = await screen.findByLabelText(/Job ID/i);
    await user.type(placeInput, '111111');
    await user.type(jobInput, 'job-from-another-server');
    await user.click(screen.getByRole('button', { name: /Recent/i }));
    await user.click(screen.getByTitle('Use History Place'));

    expect(placeInput).toHaveValue('456789');
    expect(jobInput).toHaveValue('');
  });
});

describe('LaunchModal saved private servers', () => {
  const PRIVATE_LINK = 'https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ';

  function seedLibrary(): void {
    usePlaceLibraryStore.setState({
      entries: [
        {
          placeId: '606849621',
          name: 'Signal Peak',
          favorite: true,
          lastLaunchedAt: null,
          launchCount: 0,
          privateServers: [
            {
              id: 'srv-1',
              name: 'VIP EU',
              link: PRIVATE_LINK,
              createdAt: 1,
              lastLaunchedAt: null,
              launchCount: 0,
            },
          ],
          lastAccountIds: [],
        },
      ],
    });
  }

  it('opens the Private tab prefilled when the seed carries a private server', async () => {
    seedLibrary();
    renderModal({
      seed: {
        placeId: '606849621',
        name: 'Signal Peak',
        privateServer: { id: 'srv-1', name: 'VIP EU', link: PRIVATE_LINK },
      },
    });

    expect(screen.getByRole('tab', { name: /Privado/i })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText(/Private link/i)).toHaveValue(PRIVATE_LINK);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('VIP EU · Signal Peak')).toBeInTheDocument();
  });

  it('launches a saved server, records its use and remembers the roster', async () => {
    seedLibrary();
    const user = userEvent.setup();
    const { launch, onClose } = renderModal({
      seed: {
        placeId: '606849621',
        privateServer: { id: 'srv-1', name: 'VIP EU', link: PRIVATE_LINK },
      },
    });

    await user.click(screen.getByRole('button', { name: /Launch now/i }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(account, PRIVATE_LINK);
    });
    expect(onClose).toHaveBeenCalledOnce();
    const entry = usePlaceLibraryStore.getState().entries[0];
    expect(entry).toMatchObject({ launchCount: 1, lastAccountIds: ['acc-1'] });
    expect(entry.privateServers[0]).toMatchObject({ launchCount: 1, lastLaunchedAt: expect.any(Number) });
  });

  it('fills the link from the saved list and saves a new private link under its game', async () => {
    seedLibrary();
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('tab', { name: /Privado/i }));

    await user.click(await screen.findByTitle('Use VIP EU'));
    const linkInput = screen.getByLabelText(/Private link/i);
    expect(linkInput).toHaveValue(PRIVATE_LINK);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await user.clear(linkInput);
    await user.type(linkInput, 'https://www.roblox.com/games/606849621?privateServerLinkCode=second');
    const saveButton = screen.getByRole('button', { name: /Save link/i });
    expect(saveButton).toBeEnabled();
    await user.type(screen.getByLabelText(/Name \(optional\)/i), 'Farm');
    await user.click(saveButton);

    const servers = usePlaceLibraryStore.getState().entries[0].privateServers;
    expect(servers.map((server) => server.name)).toEqual(['VIP EU', 'Farm']);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('does not offer to save a share link from the launcher', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('tab', { name: /Privado/i }));
    await user.type(
      await screen.findByLabelText(/Private link/i),
      'https://www.roblox.com/share?code=deadbeef&type=Server',
    );

    expect(screen.getByRole('button', { name: /Save link/i })).toBeDisabled();
    expect(screen.getByText(/cannot be filed under a game from here/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Launch now/i })).toBeEnabled();
  });
});
