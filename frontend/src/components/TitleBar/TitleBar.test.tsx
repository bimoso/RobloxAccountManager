import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behavioural tests for the TitleBar (task 29.1): it wires the window controls
 * to the IPC surface, toggles the theme per Requirements 3.7/3.8, shows the
 * detected Roblox version, and reflects the running-instance count from the
 * `roblox://count` event.
 */

// Mock the typed IPC surface so no real `window.api` is needed. `onRobloxCount`
// captures the pushed callback so a test can simulate a `roblox://count` event.
let countCallback: ((count: number) => void) | undefined;
const unlisten = vi.fn();

vi.mock('../../lib/ipc', () => ({
  ipc: {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getRobloxVersion: vi.fn().mockResolvedValue('version-abc123'),
    getRunningCount: vi.fn().mockResolvedValue(0),
    onRobloxCount: vi.fn(async (cb: (count: number) => void) => {
      countCallback = cb;
      return unlisten;
    }),
  },
}));

import { TitleBar } from './index';
import { ipc } from '../../lib/ipc';
import { DEFAULT_THEME, useThemeStore } from '../../stores/themeStore';

beforeEach(() => {
  countCallback = undefined;
  unlisten.mockClear();
  useThemeStore.setState({ theme: DEFAULT_THEME });
});

afterEach(() => {
  vi.clearAllMocks();
  useThemeStore.setState({ theme: DEFAULT_THEME });
});

describe('TitleBar', () => {
  it('wires minimize/maximize/close to the IPC surface', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    await user.click(screen.getByRole('button', { name: /minimize/i }));
    await user.click(screen.getByRole('button', { name: /maximize/i }));
    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(ipc.minimize).toHaveBeenCalledTimes(1);
    expect(ipc.maximize).toHaveBeenCalledTimes(1);
    expect(ipc.close).toHaveBeenCalledTimes(1);
  });

  it('toggles from dark to light and back (Requirements 3.7, 3.8)', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    const toggle = screen.getByRole('button', { name: /toggle light\/dark theme/i });

    // From the default "dark" theme, toggling switches to "light" (Req 3.8).
    await user.click(toggle);
    expect(useThemeStore.getState().theme).toBe('light');

    // From "light", toggling switches back to "dark" (Req 3.7).
    await user.click(toggle);
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('toggling from an accent theme switches to light without touching it (Req 3.8)', async () => {
    const user = userEvent.setup();
    useThemeStore.setState({ theme: 'ocean' });
    render(<TitleBar />);

    await user.click(screen.getByRole('button', { name: /toggle light\/dark theme/i }));
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('shows the detected Roblox version from roblox_get_version', async () => {
    render(<TitleBar />);
    expect(await screen.findByText('version-abc123')).toBeInTheDocument();
  });

  it('shows the running count only when the roblox://count event reports > 0', async () => {
    render(<TitleBar />);

    // Wait until the subscription is registered.
    await waitFor(() => expect(countCallback).toBeDefined());

    // No badge while the count is 0.
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();

    act(() => countCallback?.(3));
    expect(await screen.findByText('3 running')).toBeInTheDocument();

    // Back to 0 hides the badge again.
    act(() => countCallback?.(0));
    await waitFor(() =>
      expect(screen.queryByText(/running/i)).not.toBeInTheDocument(),
    );
  });

  it('unsubscribes from the count event on unmount', async () => {
    const { unmount } = render(<TitleBar />);
    await waitFor(() => expect(countCallback).toBeDefined());
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
