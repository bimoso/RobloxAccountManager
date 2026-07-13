import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Accounts } from './index';
import { ipc } from '@/lib/ipc';
import { useAccountStore } from '@/stores/accountStore';
import type { Account } from '@/types/models';

/**
 * Drag reorder is pointer-based: the grabbed card follows the cursor while the
 * others live-reorder around it, and the new order is persisted on release.
 *
 * jsdom has no layout engine, so the positive reorder path installs explicit
 * card geometry and a deterministic `elementFromPoint` result. This lets the
 * suite cover both halves of the contract: small presses never reorder, while
 * a real lift exposes the placeholder and persists the live-reordered ids.
 */

vi.mock('@/lib/ipc', () => ({
  ipc: {
    reorderAccounts: vi.fn(() => Promise.resolve()),
    loadAccounts: vi.fn(() => Promise.resolve([])),
    killOneRoblox: vi.fn(() => Promise.resolve()),
    openAccountBrowser: vi.fn(() => Promise.resolve()),
    copyAccountCookie: vi.fn(() => Promise.resolve()),
  },
}));

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

/** The order the cards are rendered in, read from each card's label heading. */
function renderedOrder(): (string | null)[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
}

/** The draggable card wrappers, in DOM (visible) order. */
function cardWrappers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-selkey]'));
}

describe('Accounts drag reorder — no accidental reorder (Req 11.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({ accounts: ACCOUNTS, loading: false, error: null });
  });

  afterEach(() => {
    // Individual drag tests may install a jsdom hit-test shim.
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
  });

  it('a press with no movement does not reorder and never calls accounts_reorder', () => {
    render(<Accounts />);
    expect(renderedOrder()).toEqual(['alpha', 'bravo', 'charlie']);

    const wrappers = cardWrappers();
    expect(wrappers).toHaveLength(ACCOUNTS.length);

    // Press and release the first card without moving the pointer.
    fireEvent.pointerDown(wrappers[0], { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(wrappers[0], { pointerId: 1, clientX: 10, clientY: 10 });

    expect(renderedOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(ipc.reorderAccounts).not.toHaveBeenCalled();
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual(['1', '2', '3']);
  });

  it('a tiny jitter below the drag threshold does not reorder', () => {
    render(<Accounts />);
    const wrappers = cardWrappers();

    fireEvent.pointerDown(wrappers[0], { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    // Move only 2px — below the 5px activation threshold.
    fireEvent.pointerMove(wrappers[0], { pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(wrappers[0], { pointerId: 1, clientX: 12, clientY: 11 });

    expect(renderedOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(ipc.reorderAccounts).not.toHaveBeenCalled();
  });

  it('a right-click press never starts a drag', () => {
    render(<Accounts />);
    const wrappers = cardWrappers();

    // button !== 0 is ignored by the drag start handler.
    fireEvent.pointerDown(wrappers[0], { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(wrappers[0], { pointerId: 1, clientX: 10, clientY: 10 });

    expect(renderedOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(ipc.reorderAccounts).not.toHaveBeenCalled();
  });

  it('disables manual reorder while a validity sort filter is active', () => {
    render(<Accounts />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Filtrar cuentas' }));
    fireEvent.click(screen.getByRole('option', { name: 'Válidas primero' }));

    const wrappers = cardWrappers();
    expect(wrappers[0]).toHaveAttribute(
      'aria-roledescription',
      'Cuenta con orden automático por estado',
    );
    expect(wrappers[0]).toHaveClass('sort-locked');

    fireEvent.pointerDown(wrappers[0], {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      buttons: 1,
      clientX: 300,
      clientY: 100,
    });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 100 });

    expect(document.querySelector('.acc-drag-clone')).not.toBeInTheDocument();
    expect(ipc.reorderAccounts).not.toHaveBeenCalled();
  });

  it('lifts a floating card, exposes its slot and persists the live-reordered ids', async () => {
    render(<Accounts />);
    const wrappers = cardWrappers();

    Object.defineProperty(wrappers[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 100,
        y: 100,
        top: 100,
        left: 100,
        right: 400,
        bottom: 324,
        width: 300,
        height: 224,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => wrappers[2]),
    });

    // jsdom does not ship PointerEvent; pointer-named MouseEvents exercise the
    // same native listeners while preserving button/client coordinates.
    fireEvent(
      wrappers[0],
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 150,
        clientY: 122,
      }),
    );
    fireEvent(
      window,
      new MouseEvent('pointermove', { bubbles: true, clientX: 460, clientY: 132 }),
    );

    const clone = document.querySelector<HTMLElement>('.acc-drag-clone');
    expect(clone).toBeInTheDocument();
    // The overlay must not inherit the PageRouter/layout transforms. Its fixed
    // viewport coordinates are only correct when it is portaled to body.
    expect(clone?.parentElement).toBe(document.body);
    expect(clone?.style.transform).toContain('translateX(310px)');
    expect(clone?.style.transform).toContain('translateY(108px)');
    expect(document.querySelector('.acc-drop-slot')).toHaveTextContent('Nueva posición');
    expect(document.body).toHaveClass('acc-dragging');

    fireEvent(
      window,
      new MouseEvent('pointerup', { bubbles: true, clientX: 460, clientY: 132 }),
    );

    await waitFor(() => {
      expect(ipc.reorderAccounts).toHaveBeenCalledWith(['2', '3', '1']);
    });
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([
      '2',
      '3',
      '1',
    ]);
    expect(document.body).not.toHaveClass('acc-dragging');
  });

  it('preserves distinct duplicate-id records when a duplicate is reordered', async () => {
    const duplicateAccounts = [
      makeAccount('same-id', 'first-duplicate'),
      makeAccount('other-id', 'middle-account'),
      makeAccount('same-id', 'second-duplicate'),
    ];
    useAccountStore.setState({ accounts: duplicateAccounts, loading: false, error: null });
    render(<Accounts />);
    const wrappers = cardWrappers();

    Object.defineProperty(wrappers[2], 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 100,
        y: 100,
        top: 100,
        left: 100,
        right: 400,
        bottom: 324,
        width: 300,
        height: 224,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => wrappers[1]),
    });

    fireEvent(
      wrappers[2],
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 150,
        clientY: 122,
      }),
    );
    fireEvent(
      window,
      new MouseEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        clientX: 460,
        clientY: 132,
      }),
    );
    fireEvent(
      window,
      new MouseEvent('pointerup', { bubbles: true, clientX: 460, clientY: 132 }),
    );

    await waitFor(() => {
      expect(ipc.reorderAccounts).toHaveBeenCalledWith(['same-id', 'same-id', 'other-id']);
    });
    expect(useAccountStore.getState().accounts.map((account) => account.username)).toEqual([
      'first-duplicate',
      'second-duplicate',
      'middle-account',
    ]);
    expect(useAccountStore.getState().accounts).toHaveLength(3);
  });

  it('measures the final slot when move and release arrive in the same frame', async () => {
    render(<Accounts />);
    const wrappers = cardWrappers();
    const grid = wrappers[0].parentElement as HTMLElement;

    Object.defineProperty(grid, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 20,
        y: 40,
        top: 40,
        left: 20,
        right: 1000,
        bottom: 400,
        width: 980,
        height: 360,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(wrappers[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const left = 20 + Array.from(grid.children).indexOf(wrappers[0]) * 320;
        return {
        x: left,
        y: 40,
        top: 40,
        left,
        right: left + 300,
        bottom: 264,
        width: 300,
        height: 224,
        toJSON: () => ({}),
        };
      },
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => wrappers[2]),
    });

    fireEvent(
      wrappers[0],
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 150,
        clientY: 64,
      }),
    );
    // No frame is yielded between this move and release. The release path must
    // synchronously commit the live order before reading final geometry.
    fireEvent(
      window,
      new MouseEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        clientX: 460,
        clientY: 72,
      }),
    );
    fireEvent(
      window,
      new MouseEvent('pointerup', { bubbles: true, clientX: 460, clientY: 72 }),
    );

    const clone = document.querySelector<HTMLElement>('.acc-drag-clone');
    expect(clone).toBeInTheDocument();
    await waitFor(() => {
      const x = Number(/translateX\(([-\d.]+)px\)/.exec(clone?.style.transform ?? '')?.[1]);
      expect(x).toBeGreaterThan(620);
    });
    await waitFor(() => {
      expect(ipc.reorderAccounts).toHaveBeenCalledWith(['2', '3', '1']);
    });
  });

  it('cancels instead of committing when the pointer stream is cancelled', async () => {
    render(<Accounts />);
    const wrappers = cardWrappers();

    Object.defineProperty(wrappers[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 100,
        y: 100,
        top: 100,
        left: 100,
        right: 400,
        bottom: 324,
        width: 300,
        height: 224,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => wrappers[2]),
    });

    fireEvent(
      wrappers[0],
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 150,
        clientY: 122,
      }),
    );
    fireEvent(
      window,
      new MouseEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        clientX: 460,
        clientY: 132,
      }),
    );

    expect(document.body).toHaveClass('acc-dragging');
    fireEvent(window, new MouseEvent('pointercancel', { bubbles: true }));

    await waitFor(() => {
      expect(document.querySelector('.acc-drag-clone')).not.toBeInTheDocument();
    });
    expect(renderedOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(ipc.reorderAccounts).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass('acc-dragging');
  });
});
