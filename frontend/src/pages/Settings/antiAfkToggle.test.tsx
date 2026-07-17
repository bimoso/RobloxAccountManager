import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behavioural tests for the Settings General tab's Anti-AFK toggle
 * (task 25.4, Requirement 21.5): toggling Anti-AFK must invoke the
 * `settings_save` IPC_Command (through `ipc.saveSettings`) with the new
 * `antiAfk` value, and the toggle must reflect the persisted setting on mount.
 *
 * `lib/ipc` is mocked so no real `window.api` bridge is needed; the spies let
 * us assert exactly what the toggle persists.
 */

// `vi.hoisted` runs before the hoisted `vi.mock` factory so these spies can be
// referenced inside it.
const { loadSettings, saveSettings, getRobloxVersion, multiInstanceStatus } =
  vi.hoisted(() => ({
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    getRobloxVersion: vi.fn(),
    multiInstanceStatus: vi.fn(),
  }));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadSettings: () => loadSettings(),
    saveSettings: (data: unknown) => saveSettings(data),
    getRobloxVersion: () => getRobloxVersion(),
    multiInstanceStatus: () => multiInstanceStatus(),
    // Consumed by the SessionAutomationCard mounted alongside the toggle.
    getRunningCount: () => Promise.resolve(0),
    onRobloxCount: () => Promise.resolve(() => undefined),
    arrangeWindows: () => Promise.resolve(0),
  },
}));

// Imported after vi.mock so the page binds to the mocked ipc.
import { Settings } from './index';

/** Build a Settings payload with the given Anti-AFK state. */
function settingsWith(antiAfk: boolean) {
  return {
    multiInstance: false,
    antiAfk,
    antiAfkInterval: null,
    keyVerifier: null,
    donutApiTokenEnc: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Settings Anti-AFK toggle (Requirement 21.5)', () => {
  it('reflects the persisted antiAfk value on mount', async () => {
    loadSettings.mockResolvedValue(settingsWith(true));
    getRobloxVersion.mockResolvedValue('1.0.0');
    multiInstanceStatus.mockResolvedValue(true);

    render(<Settings />);

    const toggle = screen.getByRole('switch', { name: /anti-afk/i });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('stays disabled until the current setting is loaded', () => {
    // Never-resolving mount-time calls keep the toggle in its "not yet loaded"
    // state (and avoid post-render state updates during the assertion).
    const pending = new Promise<never>(() => {});
    loadSettings.mockReturnValue(pending);
    getRobloxVersion.mockReturnValue(pending);
    multiInstanceStatus.mockReturnValue(pending);

    render(<Settings />);

    expect(screen.getByRole('switch', { name: /anti-afk/i })).toBeDisabled();
  });

  it('invokes settings_save with the new antiAfk value when toggled on', async () => {
    const user = userEvent.setup();
    loadSettings.mockResolvedValue(settingsWith(false));
    getRobloxVersion.mockResolvedValue('1.0.0');
    multiInstanceStatus.mockResolvedValue(false);
    saveSettings.mockResolvedValue(undefined);

    render(<Settings />);

    const toggle = screen.getByRole('switch', { name: /anti-afk/i });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    expect(saveSettings).toHaveBeenCalledWith({ antiAfk: true });
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('invokes settings_save with false when toggled off', async () => {
    const user = userEvent.setup();
    loadSettings.mockResolvedValue(settingsWith(true));
    getRobloxVersion.mockResolvedValue('1.0.0');
    multiInstanceStatus.mockResolvedValue(false);
    saveSettings.mockResolvedValue(undefined);

    render(<Settings />);

    const toggle = screen.getByRole('switch', { name: /anti-afk/i });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await user.click(toggle);

    expect(saveSettings).toHaveBeenCalledWith({ antiAfk: false });
  });

  it('rolls back the toggle when the persist fails', async () => {
    const user = userEvent.setup();
    loadSettings.mockResolvedValue(settingsWith(false));
    getRobloxVersion.mockResolvedValue('1.0.0');
    multiInstanceStatus.mockResolvedValue(false);
    saveSettings.mockRejectedValue(new Error('persist failed'));

    render(<Settings />);

    const toggle = screen.getByRole('switch', { name: /anti-afk/i });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    // Optimistic update reverts to the previous (false) value on failure.
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-checked', 'false'),
    );
    expect(saveSettings).toHaveBeenCalledWith({ antiAfk: true });
  });
});
