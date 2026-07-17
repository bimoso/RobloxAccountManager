import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ipc } from '@/lib/ipc';
import { useAccountStore } from '@/stores/accountStore';
import type { Account, Package } from '@/types/models';
import { PackagesPage } from './index';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadPackages: vi.fn(),
    savePackages: vi.fn(() => Promise.resolve()),
    loadAccounts: vi.fn(() => Promise.resolve([])),
  },
}));

const ACCOUNT: Account = {
  id: 'account-1',
  username: 'alpha',
  userId: '1',
  nickname: 'Main',
  cookie: '',
  createdAt: '2026-07-12T00:00:00.000Z',
  lastUsed: null,
  donutProfileId: null,
  donutProfilePendingDelete: false,
};

const PACKAGE: Package = {
  id: 'group-1',
  name: 'Farm rotation',
  accountIds: [ACCOUNT.id],
  link: '',
};

describe('PackagesPage group workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({ accounts: [ACCOUNT], loading: false, error: null });
  });

  it('renders the composed empty workspace and preserves the create handler', async () => {
    vi.mocked(ipc.loadPackages).mockResolvedValue([]);
    const onCreatePackage = vi.fn();
    const user = userEvent.setup();
    render(<PackagesPage onCreatePackage={onCreatePackage} />);

    expect(await screen.findByText("You don't have any saved group yet.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    expect(onCreatePackage).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create group' })).toBeInTheDocument();
  });

  it('renders a modern group card and opens the existing edit flow', async () => {
    vi.mocked(ipc.loadPackages).mockResolvedValue([PACKAGE]);
    const onEditPackage = vi.fn();
    const user = userEvent.setup();
    render(<PackagesPage onEditPackage={onEditPackage} />);

    expect(await screen.findByRole('heading', { name: PACKAGE.name })).toBeInTheDocument();
    expect(screen.getByText('1 account')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Edit$/ }));

    expect(onEditPackage).toHaveBeenCalledWith(PACKAGE);
    expect(screen.getByRole('heading', { name: 'Edit group' })).toBeInTheDocument();
  });
});
