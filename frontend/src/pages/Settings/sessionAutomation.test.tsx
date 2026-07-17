import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behavioural tests for the Settings General tab's multi-instance session
 * automation card: each toggle must persist its own settings key through
 * `ipc.saveSettings`, the target-size field must persist a parsed
 * `windowTargetWidth`/`windowTargetHeight` pair, and "Arrange now" must invoke
 * the `roblox_arrange_windows` command (through `ipc.arrangeWindows`).
 */

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  arrangeWindows: vi.fn(),
  getWindowCount: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadSettings: mocks.loadSettings,
    saveSettings: mocks.saveSettings,
    arrangeWindows: mocks.arrangeWindows,
    getWindowCount: mocks.getWindowCount,
  },
}));

import { SessionAutomationCard, parseTargetSize } from './SessionAutomationCard';

function storedSettings(overrides: Record<string, unknown> = {}) {
  return {
    multiInstance: false,
    antiAfk: false,
    antiAfkInterval: null,
    keyVerifier: null,
    donutApiTokenEnc: null,
    ...overrides,
  };
}

function arrange(overrides: Record<string, unknown> = {}) {
  mocks.loadSettings.mockResolvedValue(storedSettings(overrides));
  mocks.saveSettings.mockResolvedValue(true);
  mocks.arrangeWindows.mockResolvedValue({ found: 2, placed: 2 });
  mocks.getWindowCount.mockResolvedValue(2);
}

afterEach(() => vi.clearAllMocks());

describe('parseTargetSize', () => {
  it('parses WxH pairs with x, X, or × separators and whitespace', () => {
    expect(parseTargetSize('350x350')).toEqual([350, 350]);
    expect(parseTargetSize(' 640 X 360 ')).toEqual([640, 360]);
    expect(parseTargetSize('800×600')).toEqual([800, 600]);
  });

  it('rejects malformed sizes', () => {
    expect(parseTargetSize('350')).toBeNull();
    expect(parseTargetSize('x350')).toBeNull();
    expect(parseTargetSize('350x')).toBeNull();
    expect(parseTargetSize('ax350')).toBeNull();
    expect(parseTargetSize('')).toBeNull();
  });
});

describe('Settings session automation card', () => {
  it('persists each toggle under its own settings key', async () => {
    const user = userEvent.setup();
    arrange({ windowLayoutEnabled: true });
    render(<SessionAutomationCard />);

    const autoRelaunch = await screen.findByRole('switch', {
      name: 'Auto-relaunch closed instances',
    });
    await waitFor(() => expect(autoRelaunch).toBeEnabled());

    await user.click(autoRelaunch);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith({ autoRelaunch: true }),
    );

    await user.click(screen.getByRole('switch', { name: 'Replace running instance' }));
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith({ replaceRunningInstance: true }),
    );

    // Window layout was stored as enabled, so toggling it turns it off.
    await user.click(screen.getByRole('switch', { name: 'Window layout' }));
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith({ windowLayoutEnabled: false }),
    );
  });

  it('persists the parsed target size and reverts invalid input', async () => {
    const user = userEvent.setup();
    arrange({ windowLayoutEnabled: true, windowTargetWidth: 350, windowTargetHeight: 350 });
    render(<SessionAutomationCard />);

    const size = await screen.findByLabelText(
      'Target window size, width by height in pixels',
    );
    await waitFor(() => expect(size).toBeEnabled());

    await user.clear(size);
    await user.type(size, '640x360');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith({
        windowTargetWidth: 640,
        windowTargetHeight: 360,
      }),
    );

    // Garbage input never persists: the field snaps back to the saved value.
    mocks.saveSettings.mockClear();
    await user.clear(size);
    await user.type(size, 'garbage');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(size).toHaveValue('640x360'));
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('disables the manual size controls until window layout is enabled', async () => {
    arrange({ windowLayoutEnabled: false });
    render(<SessionAutomationCard />);

    const size = await screen.findByLabelText(
      'Target window size, width by height in pixels',
    );
    const perRow = screen.getByLabelText('Windows per row');
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Window layout' })).toBeEnabled(),
    );
    expect(size).toBeDisabled();
    expect(perRow).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Auto layout' })).toBeDisabled();
  });

  it('invokes the arrange command from "Arrange now" and reports the count', async () => {
    const user = userEvent.setup();
    arrange({ windowLayoutEnabled: true });
    render(<SessionAutomationCard />);

    const arrangeButton = await screen.findByRole('button', {
      name: 'Arrange Roblox windows now',
    });
    await waitFor(() => expect(arrangeButton).toBeEnabled());
    await user.click(arrangeButton);
    await waitFor(() => expect(mocks.arrangeWindows).toHaveBeenCalledTimes(1));
  });
});
