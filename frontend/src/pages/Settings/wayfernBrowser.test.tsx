import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Account browsers run exclusively on the app-managed standalone Wayfern, so
 * the General tab no longer offers a provider choice. These tests pin that:
 * the Wayfern card is always present, no provider radiogroup is rendered, and
 * downloading the ~1 GB build stays an explicit user action that mounting the
 * tab never triggers on its own.
 */

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  getRobloxVersion: vi.fn(),
  multiInstanceStatus: vi.fn(),
  getWayfernStatus: vi.fn(),
  installWayfern: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadSettings: mocks.loadSettings,
    saveSettings: mocks.saveSettings,
    getRobloxVersion: mocks.getRobloxVersion,
    multiInstanceStatus: mocks.multiInstanceStatus,
    getWayfernStatus: mocks.getWayfernStatus,
    installWayfern: mocks.installWayfern,
    onWayfernProgress: vi.fn().mockResolvedValue(() => undefined),
    // Consumed by the SessionAutomationCard mounted in the General tab.
    getWindowCount: vi.fn().mockResolvedValue(0),
    arrangeWindows: vi.fn().mockResolvedValue({ found: 0, placed: 0 }),
  },
}));

import { Settings } from './index';

const BASE_SETTINGS = {
  multiInstance: false,
  antiAfk: false,
  antiAfkInterval: null,
  keyVerifier: null,
};

afterEach(() => vi.clearAllMocks());

describe('Settings account browser (Wayfern only)', () => {
  it('renders no browser-provider choice', async () => {
    mocks.loadSettings.mockResolvedValue(BASE_SETTINGS);
    mocks.getRobloxVersion.mockResolvedValue('1.0.0');
    mocks.multiInstanceStatus.mockResolvedValue(true);
    mocks.getWayfernStatus.mockResolvedValue({
      installed: true,
      version: '149.0.1',
      latestVersion: '149.0.1',
      updateAvailable: false,
    });

    render(<Settings />);

    await screen.findByText('Wayfern 149.0.1 installed');
    // The provider radiogroup is gone; other radios (e.g. language) may remain.
    expect(screen.queryByRole('radio', { name: /Donut Browser/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Wayfern portable/i })).toBeNull();
    // Nothing about the account browser is persisted on mount any more.
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('downloads Wayfern only when the user asks', async () => {
    const user = userEvent.setup();
    mocks.loadSettings.mockResolvedValue(BASE_SETTINGS);
    mocks.getRobloxVersion.mockResolvedValue('1.0.0');
    mocks.multiInstanceStatus.mockResolvedValue(true);
    mocks.getWayfernStatus.mockResolvedValue({
      installed: false,
      version: null,
      latestVersion: '149.0.1',
      updateAvailable: false,
    });
    mocks.installWayfern.mockResolvedValue({
      installed: true,
      version: '149.0.1',
      latestVersion: '149.0.1',
      updateAvailable: false,
    });

    render(<Settings />);
    await screen.findByText('Wayfern is not installed');
    expect(mocks.installWayfern).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(mocks.installWayfern).toHaveBeenCalledTimes(1));
  });
});
