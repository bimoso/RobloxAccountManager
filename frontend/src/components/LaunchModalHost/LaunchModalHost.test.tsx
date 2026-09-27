import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
import type { Account } from '@/types/models';
import { LaunchModalHost } from './index';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadAccounts: vi.fn(() => Promise.resolve([])),
    getGameDetails: vi.fn(() => Promise.resolve({ ok: false })),
    launchRoblox: vi.fn(() => Promise.resolve({ success: true })),
  },
}));

function account(id: string, username: string): Account {
  return {
    id,
    username,
    userId: id.replace(/\D/g, '') || '1',
    nickname: '',
    cookie: 'cookie',
    createdAt: '2026-07-12T00:00:00.000Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  };
}

const ACCOUNTS = [account('acc-1', 'alpha'), account('acc-2', 'bravo'), account('acc-3', 'charlie')];
const PRIVATE_LINK = 'https://www.roblox.com/games/606849621?privateServerLinkCode=abc123XYZ';

beforeEach(() => {
  useAccountStore.setState({ accounts: ACCOUNTS, loading: false, error: null });
  useLaunchIntentStore.setState({ intent: null });
  usePlaceLibraryStore.setState({ entries: [] });
});

describe('LaunchModalHost picker', () => {
  it('pre-selects the roster used on the last launch of the seeded game', async () => {
    usePlaceLibraryStore.setState({
      entries: [
        {
          placeId: '606849621',
          name: 'Signal Peak',
          favorite: true,
          lastLaunchedAt: 10,
          launchCount: 1,
          privateServers: [],
          lastAccountIds: ['acc-2', 'acc-3', 'gone'],
        },
      ],
    });
    useLaunchIntentStore.getState().open({
      accountIds: [],
      seed: {
        placeId: '606849621',
        name: 'Signal Peak',
        privateServer: { id: 'srv', name: 'VIP EU', link: PRIVATE_LINK },
      },
    });
    render(<LaunchModalHost />);

    expect(await screen.findByRole('option', { name: /bravo/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /charlie/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /alpha/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText(/accounts from the last launch/i)).toBeInTheDocument();
    expect(screen.getByText(/VIP EU/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });

  it('selects every account in one click and clears them again', async () => {
    const user = userEvent.setup();
    useLaunchIntentStore.getState().open({ accountIds: [], seed: { placeId: '1', name: 'Any' } });
    render(<LaunchModalHost />);

    expect(await screen.findByRole('button', { name: /Continue/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(ACCOUNTS.length);
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('hands the picked accounts and the private-server seed to the launcher', async () => {
    const user = userEvent.setup();
    useLaunchIntentStore.getState().open({
      accountIds: [],
      seed: { placeId: '606849621', privateServer: { id: 'srv', name: 'VIP EU', link: PRIVATE_LINK } },
    });
    render(<LaunchModalHost />);

    await user.click(await screen.findByRole('option', { name: /alpha/ }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(useLaunchIntentStore.getState().intent?.accountIds).toEqual(['acc-1']);
    expect(screen.getByRole('tab', { name: /Privado/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText(/Private link/i)).toHaveValue(PRIVATE_LINK);
  });
});
