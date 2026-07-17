import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/types/models';
import { AccountCardMenu } from './AccountCardMenu';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    killOneRoblox: vi.fn(() => Promise.resolve()),
    openAccountBrowser: vi.fn(() => Promise.resolve()),
    copyAccountCookie: vi.fn(() => Promise.resolve()),
  },
}));

const ACCOUNT: Account = {
  id: 'account-1',
  username: 'pointer-user',
  userId: '1001',
  nickname: '',
  cookie: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastUsed: null,
  donutProfileId: null,
  donutProfilePendingDelete: false,
};

describe('AccountCardMenu viewport anchor', () => {
  it('passes right-click client coordinates through without page/local offsets', () => {
    render(<AccountCardMenu account={ACCOUNT} />);

    const card = screen.getByRole('heading', { level: 3, name: 'pointer-user' }).closest('.acc-card');
    expect(card).not.toBeNull();
    fireEvent.contextMenu(card as HTMLElement, { clientX: 321, clientY: 187 });

    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ left: '321px', top: '187px' });
    expect(menu).toHaveAttribute('aria-label', 'Actions for pointer-user');
    expect(within(menu).getByText('@pointer-user')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(10);
    expect(screen.getByRole('menuitem', { name: 'Launch' })).toHaveClass('is-primary');
    expect(screen.getByRole('menuitem', { name: 'Copy cookie' })).toHaveClass(
      'command-menu__item--compact',
    );
  });

  it('keeps the exiting portal inert until its close animation completes', async () => {
    const onLaunch = vi.fn();
    render(<AccountCardMenu account={ACCOUNT} onLaunch={onLaunch} />);

    const card = screen.getByRole('heading', { level: 3, name: 'pointer-user' }).closest('.acc-card');
    fireEvent.contextMenu(card as HTMLElement, { clientX: 220, clientY: 160 });
    const menu = screen.getByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Launch' }));

    expect(onLaunch).toHaveBeenCalledWith(ACCOUNT);
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-hidden', 'true');
    expect(menu).toHaveAttribute('inert');
    expect(menu).toHaveStyle({ pointerEvents: 'none' });

    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
  });
});
