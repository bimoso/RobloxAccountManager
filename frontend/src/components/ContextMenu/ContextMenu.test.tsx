import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextMenu } from './index';
import type { ContextMenuItem } from './index';

/**
 * Unit tests for {@link ContextMenu} (task 7.5).
 *
 * - Requirement 12.2: selecting an item closes the menu BEFORE running the
 *   item's action.
 * - Requirement 12.3: an outside click closes the menu WITHOUT executing any
 *   item's action.
 */
describe('ContextMenu', () => {
  const anchor = { x: 10, y: 20 };

  it('closes before executing the selected action (Req 12.2)', async () => {
    const user = userEvent.setup();
    // Shared call-order log proves onClose runs before onSelect.
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const onSelect = vi.fn(() => order.push('select'));
    const items: ContextMenuItem[] = [{ label: 'Edit', onSelect }];

    render(<ContextMenu anchor={anchor} items={items} onClose={onClose} />);

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

    // Both ran.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Ordering: close happened before select (call-order log).
    expect(order).toEqual(['close', 'select']);
    // Ordering confirmed a second way via mock invocation order.
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onSelect.mock.invocationCallOrder[0],
    );
  });

  it('closes without executing any action on an outside click (Req 12.3)', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const items: ContextMenuItem[] = [{ label: 'Edit', onSelect }];

    render(
      <div>
        <button type="button">outside</button>
        <ContextMenu anchor={anchor} items={items} onClose={onClose} />
      </div>,
    );

    // Component listens on document 'mousedown'; dispatch outside the menu.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape without executing any action', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const items: ContextMenuItem[] = [{ label: 'Edit', onSelect }];

    render(<ContextMenu anchor={anchor} items={items} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing when a disabled item is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const items: ContextMenuItem[] = [
      { label: 'Kill', onSelect, disabled: true },
    ];

    render(<ContextMenu anchor={anchor} items={items} onClose={onClose} />);

    await user.click(screen.getByRole('menuitem', { name: 'Kill' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('portals to body so viewport coordinates are not offset by transformed cards', () => {
    const host = document.createElement('div');
    host.style.transform = 'translate3d(240px, 180px, 0)';
    document.body.appendChild(host);

    const { unmount } = render(
      <ContextMenu
        anchor={{ x: 64, y: 88 }}
        items={[{ label: 'Edit', onSelect: vi.fn() }]}
        onClose={vi.fn()}
      />,
      { container: host },
    );

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveAttribute('data-context-menu-portal', 'true');

    unmount();
    host.remove();
  });

  it('clamps its unscaled layout box inside the viewport', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
    const viewportWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    const viewportHeight = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);

    try {
      render(
        <ContextMenu
          anchor={{ x: 1000, y: 760 }}
          items={[{ label: 'Edit', onSelect: vi.fn() }]}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole('menu')).toHaveStyle({ left: '826px', top: '520px' });
      });
    } finally {
      width.mockRestore();
      height.mockRestore();
      viewportWidth.mockRestore();
      viewportHeight.mockRestore();
    }
  });

  it('re-resolves and clamps a moving anchor on scroll and resize', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
    const viewportWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    const viewportHeight = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    let liveAnchor = { x: 120, y: 140 };
    const resolveAnchor = vi.fn(() => liveAnchor);

    try {
      render(
        <ContextMenu
          anchor={liveAnchor}
          resolveAnchor={resolveAnchor}
          items={[{ label: 'Edit', onSelect: vi.fn() }]}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole('menu')).toHaveStyle({ left: '120px', top: '140px' });
      });

      liveAnchor = { x: 1000, y: 760 };
      fireEvent.scroll(window);
      await waitFor(() => {
        expect(screen.getByRole('menu')).toHaveStyle({ left: '826px', top: '520px' });
      });

      liveAnchor = { x: 400, y: 300 };
      viewportWidth.mockReturnValue(500);
      viewportHeight.mockReturnValue(400);
      fireEvent.resize(window);
      await waitFor(() => {
        expect(screen.getByRole('menu')).toHaveStyle({ left: '302px', top: '152px' });
      });
      expect(resolveAnchor).toHaveBeenCalled();
    } finally {
      width.mockRestore();
      height.mockRestore();
      viewportWidth.mockRestore();
      viewportHeight.mockRestore();
    }
  });

  it('takes focus, supports full arrow navigation, and restores focus on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <ContextMenu
        anchor={anchor}
        items={[
          { label: 'Launch', onSelect: vi.fn() },
          { label: 'Disabled', onSelect: vi.fn(), disabled: true },
          { label: 'Edit', onSelect: vi.fn() },
          { label: 'Copy', onSelect: vi.fn() },
        ]}
        onClose={vi.fn()}
      />,
    );

    const launch = screen.getByRole('menuitem', { name: 'Launch' });
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    const copy = screen.getByRole('menuitem', { name: 'Copy' });
    expect(launch).toHaveFocus();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(edit).toHaveFocus();
    fireEvent.keyDown(document, { key: 'End' });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(launch).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Home' });
    expect(launch).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(copy).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('renders compact utility commands with their full accessible labels', () => {
    render(
      <ContextMenu
        anchor={anchor}
        title="NebulaRunner"
        subtitle="@NebulaRunner"
        items={[
          {
            label: 'Copiar ID de usuario',
            shortLabel: 'UID',
            section: 'copy',
            compact: true,
            onSelect: vi.fn(),
          },
          {
            label: 'Copiar nombre de usuario',
            shortLabel: 'USER',
            section: 'copy',
            compact: true,
            onSelect: vi.fn(),
          },
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('menu', { name: 'Actions for NebulaRunner' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copiar ID de usuario' })).toHaveTextContent('UID');
    expect(screen.getByRole('menuitem', { name: 'Copiar nombre de usuario' })).toHaveTextContent('USER');
  });
});
