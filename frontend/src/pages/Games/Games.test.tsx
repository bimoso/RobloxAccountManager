import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ipc } from '@/lib/ipc';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { usePlaceLibraryStore, type PlaceLibraryEntry } from '@/stores/placeLibraryStore';
import { useToastStore } from '@/stores/toastStore';
import type { Account } from '@/types/models';
import { GamesPage } from './index';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadAccounts: vi.fn(() => Promise.resolve([])),
    getGameDetails: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve()),
  },
}));

const ACCOUNT: Account = {
  id: 'account-1',
  username: 'alpha',
  userId: '1',
  nickname: 'Main',
  cookie: 'cookie-a',
  createdAt: '2026-07-12T00:00:00.000Z',
  lastUsed: null,
  donutProfileId: null,
  donutProfilePendingDelete: false,
};

const PRIVATE_LINK = 'https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ';

function savedGame(overrides: Partial<PlaceLibraryEntry> = {}): PlaceLibraryEntry {
  return {
    placeId: '606849621',
    name: 'Signal Peak',
    creator: 'Roblox',
    favorite: true,
    lastLaunchedAt: null,
    launchCount: 3,
    privateServers: [
      {
        id: 'srv-1',
        name: 'VIP EU',
        link: PRIVATE_LINK,
        createdAt: 1,
        lastLaunchedAt: null,
        launchCount: 2,
      },
    ],
    lastAccountIds: [ACCOUNT.id, 'ghost'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlaceLibraryStore.setState({ entries: [] });
  useLaunchIntentStore.setState({ intent: null });
  useAccountStore.setState({ accounts: [ACCOUNT], loading: false, error: null });
  useToastStore.getState().hideToast();
});

afterEach(() => {
  useToastStore.getState().hideToast();
});

describe('GamesPage', () => {
  it('adds a game and its private server from one pasted private link', async () => {
    vi.mocked(ipc.getGameDetails).mockResolvedValue({
      ok: true,
      name: 'Signal Peak',
      creator: 'Roblox',
      iconUrl: '',
      playing: 10,
    });
    const user = userEvent.setup();
    render(<GamesPage />);

    expect(screen.getByText('No saved games yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Add game' })[0]);
    await user.type(screen.getByLabelText('Place ID or link'), PRIVATE_LINK);

    expect(await screen.findByText('Experience detected')).toBeInTheDocument();
    expect(ipc.getGameDetails).toHaveBeenCalledWith('606849621', 'cookie-a');
    await user.type(screen.getByLabelText(/Server name/i), 'Farm');
    await user.click(screen.getByRole('button', { name: 'Save game and server' }));

    const entry = usePlaceLibraryStore.getState().entries[0];
    expect(entry).toMatchObject({ placeId: '606849621', name: 'Signal Peak', favorite: true });
    expect(entry.privateServers).toEqual([
      expect.objectContaining({ name: 'Farm', link: PRIVATE_LINK }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Signal Peak' })).toBeInTheDocument();
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'success' });
  });

  it('hands a game or one of its private servers to the launch picker', async () => {
    usePlaceLibraryStore.setState({ entries: [savedGame()] });
    const user = userEvent.setup();
    render(<GamesPage />);

    expect(screen.getByText('Last used with 1 accounts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Launch private server VIP EU' }));
    expect(useLaunchIntentStore.getState().intent).toEqual({
      accountIds: [],
      seed: {
        placeId: '606849621',
        name: 'Signal Peak',
        iconUrl: undefined,
        creator: 'Roblox',
        privateServer: { id: 'srv-1', name: 'VIP EU', link: PRIVATE_LINK },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Launch Signal Peak' }));
    expect(useLaunchIntentStore.getState().intent?.seed).toEqual({
      placeId: '606849621',
      name: 'Signal Peak',
      iconUrl: undefined,
      creator: 'Roblox',
    });
  });

  it('adds, edits and deletes private servers of a saved game', async () => {
    usePlaceLibraryStore.setState({ entries: [savedGame()] });
    const user = userEvent.setup();
    render(<GamesPage />);

    await user.click(screen.getByRole('button', { name: 'Add private server' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Share EU');
    await user.type(
      within(dialog).getByLabelText('Private link'),
      'https://www.roblox.com/share?code=deadbeef&type=Server',
    );
    expect(within(dialog).getByText('Link recognised')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(usePlaceLibraryStore.getState().entries[0].privateServers).toHaveLength(2);
    });
    expect(screen.getByText('2 private servers')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit server: VIP EU' }));
    const editDialog = screen.getByRole('dialog');
    const nameInput = within(editDialog).getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'VIP renamed');
    await user.click(within(editDialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(usePlaceLibraryStore.getState().entries[0].privateServers[0].name).toBe('VIP renamed');
    });

    await user.click(screen.getByRole('button', { name: 'Delete server: Share EU' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(usePlaceLibraryStore.getState().entries[0].privateServers).toHaveLength(1);
    });
  });

  it('rejects a private link that belongs to another game', async () => {
    usePlaceLibraryStore.setState({ entries: [savedGame()] });
    const user = userEvent.setup();
    render(<GamesPage />);

    await user.click(screen.getByRole('button', { name: 'Add private server' }));
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Private link'),
      'https://www.roblox.com/games/999?privateServerLinkCode=other',
    );
    expect(within(dialog).getByText('This link belongs to Place 999, not to this game.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('filters by server name and promotes a recent launch into the library', async () => {
    usePlaceLibraryStore.setState({
      entries: [
        savedGame(),
        savedGame({
          placeId: '42',
          name: 'Orbit Arena',
          favorite: false,
          lastLaunchedAt: 1000,
          privateServers: [],
          lastAccountIds: [],
        }),
      ],
    });
    const user = userEvent.setup();
    render(<GamesPage />);

    expect(screen.getByRole('heading', { name: 'Signal Peak' })).toBeInTheDocument();
    expect(screen.queryByText('Orbit Arena')).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'vip');
    expect(screen.getByRole('heading', { name: 'Signal Peak' })).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Clear search' }));

    await user.click(screen.getByRole('button', { name: /^Recent/ }));
    expect(screen.getByText('Orbit Arena')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save game: Orbit Arena' }));
    expect(usePlaceLibraryStore.getState().entries.find((entry) => entry.placeId === '42')?.favorite).toBe(true);
    expect(screen.getByText('No recent launches')).toBeInTheDocument();
  });

  it('removes a game together with its servers after confirmation', async () => {
    usePlaceLibraryStore.setState({ entries: [savedGame()] });
    const user = userEvent.setup();
    render(<GamesPage />);

    await user.click(screen.getByRole('button', { name: 'Remove from library' }));
    expect(
      screen.getByText('Remove "Signal Peak" and its 1 private servers from the library?'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(usePlaceLibraryStore.getState().entries).toEqual([]);
    });
    expect(screen.getByText('No saved games yet')).toBeInTheDocument();
  });
});
