import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Accounts } from './index';
import { useAccountStore } from '@/stores/accountStore';
import type { Account } from '@/types/models';

/**
 * Task 16.2 — selection mode + bulk action bar (Requirements 10.1, 10.2, 10.3,
 * 10.5), wired to the pure helpers in `lib/selection.ts`.
 *
 * These tests drive the real Accounts page against a seeded `accountStore`
 * (seeding a non-empty list so the page's mount-time load is skipped and no
 * `window.api` bridge is required). They assert the observable UI contract:
 *
 *   - entering selection mode exposes each card's `.card-check` control (10.1);
 *   - toggling a control reflects the selected/unselected state (10.1);
 *   - a non-empty selection shows the bulk bar with the exact count and the
 *     clear / select-all / delete-selected controls (10.2);
 *   - "Seleccionar todo" marks every visible account under the active filter
 *     and search (10.3);
 *   - emptying the selection hides the bulk bar and exits selection mode (10.5).
 */

function makeAccount(id: string, username: string): Account {
  return {
    id,
    username,
    userId: id,
    nickname: '',
    cookie: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  };
}

const ACCOUNTS: Account[] = [
  makeAccount('1', 'alpha'),
  makeAccount('2', 'bravo'),
  makeAccount('3', 'charlie'),
];

/** The per-card selection controls are the `role="checkbox"` toggles rendered
 * only in selection mode. */
function cardChecks(): HTMLElement[] {
  return screen.getAllByRole('checkbox');
}

function bulkBar(): HTMLElement | null {
  return screen.queryByRole('toolbar', { name: 'Acciones en lote' });
}

describe('Accounts selection mode + bulk action bar (Req 10.1, 10.2, 10.3, 10.5)', () => {
  beforeEach(() => {
    // Seed a non-empty account list so the page skips its mount-time load()
    // (no window.api bridge needed) and renders the cards directly.
    useAccountStore.setState({ accounts: ACCOUNTS, loading: false, error: null });
  });

  it('enters selection mode, toggling a card reflects its selected state (10.1)', async () => {
    const user = userEvent.setup();
    render(<Accounts />);

    // No selection controls until selection mode is entered.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Seleccionar' }));

    const checks = cardChecks();
    expect(checks).toHaveLength(ACCOUNTS.length);
    checks.forEach((check) => expect(check).toHaveAttribute('aria-checked', 'false'));

    await user.click(checks[0]);
    expect(cardChecks()[0]).toHaveAttribute('aria-checked', 'true');

    // Toggling the same control again clears it.
    await user.click(cardChecks()[0]);
    // Selection empty => bar hidden and selection mode exited (10.5).
    expect(bulkBar()).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shows the bulk bar with count and controls while a selection exists (10.2)', async () => {
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(screen.getByRole('button', { name: 'Seleccionar' }));

    expect(bulkBar()).toBeNull();

    await user.click(cardChecks()[0]);
    const bar = bulkBar();
    expect(bar).not.toBeNull();
    const withinBar = within(bar as HTMLElement);
    expect(withinBar.getByText('1 cuenta seleccionada')).toBeInTheDocument();
    expect(withinBar.getByRole('button', { name: 'Limpiar selección' })).toBeInTheDocument();
    expect(withinBar.getByRole('button', { name: 'Seleccionar todo' })).toBeInTheDocument();
    expect(withinBar.getByRole('button', { name: 'Eliminar seleccionadas' })).toBeInTheDocument();

    await user.click(cardChecks()[1]);
    expect(within(bulkBar() as HTMLElement).getByText('2 cuentas seleccionadas')).toBeInTheDocument();
  });

  it('"Seleccionar todo" marks every visible account under the current search (10.3)', async () => {
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(screen.getByRole('button', { name: 'Seleccionar' }));
    await user.click(cardChecks()[0]);

    await user.click(screen.getByRole('button', { name: 'Seleccionar todo' }));
    expect(within(bulkBar() as HTMLElement).getByText('3 cuentas seleccionadas')).toBeInTheDocument();
    cardChecks().forEach((check) => expect(check).toHaveAttribute('aria-checked', 'true'));

    // Narrow the visible list via search, then select-all only marks the match.
    await user.type(screen.getByRole('searchbox', { name: 'Buscar cuentas' }), 'alpha');
    // One card visible now.
    expect(cardChecks()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Seleccionar todo' }));
    expect(within(bulkBar() as HTMLElement).getByText('1 cuenta seleccionada')).toBeInTheDocument();
  });

  it('clearing the selection hides the bulk bar and exits selection mode (10.5)', async () => {
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(screen.getByRole('button', { name: 'Seleccionar' }));
    await user.click(cardChecks()[0]);
    expect(bulkBar()).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Limpiar selección' }));
    expect(bulkBar()).toBeNull();
    // Selection mode exited: no per-card controls remain.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // Re-entering selection mode starts fresh (no lingering selection).
    await user.click(screen.getByRole('button', { name: 'Seleccionar' }));
    cardChecks().forEach((check) => expect(check).toHaveAttribute('aria-checked', 'false'));
  });
});
