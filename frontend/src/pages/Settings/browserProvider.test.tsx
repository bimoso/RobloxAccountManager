import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  },
}));

import { Settings } from './index';

function settings(browserProvider: 'donut' | 'wayfern') {
  return {
    multiInstance: false,
    antiAfk: false,
    antiAfkInterval: null,
    keyVerifier: null,
    donutApiTokenEnc: null,
    browserProvider,
  };
}

afterEach(() => vi.clearAllMocks());

describe('Settings browser provider', () => {
  it('restores and persists the selected browser provider', async () => {
    const user = userEvent.setup();
    mocks.loadSettings.mockResolvedValue(settings('wayfern'));
    mocks.getRobloxVersion.mockResolvedValue('1.0.0');
    mocks.multiInstanceStatus.mockResolvedValue(true);
    mocks.getWayfernStatus.mockResolvedValue({
      installed: true,
      version: '149.0.1',
      latestVersion: '149.0.1',
      updateAvailable: false,
    });
    mocks.saveSettings.mockResolvedValue(true);

    render(<Settings />);

    const wayfern = screen.getByRole('radio', { name: /Wayfern portable/i });
    await waitFor(() => expect(wayfern).toHaveAttribute('aria-checked', 'true'));

    await user.click(screen.getByRole('radio', { name: /Donut Browser/i }));
    expect(mocks.saveSettings).toHaveBeenCalledWith({ browserProvider: 'donut' });
  });

  it('keeps provider selection separate from the explicit Wayfern download', async () => {
    const user = userEvent.setup();
    mocks.loadSettings.mockResolvedValue(settings('donut'));
    mocks.getRobloxVersion.mockResolvedValue('1.0.0');
    mocks.multiInstanceStatus.mockResolvedValue(true);
    mocks.getWayfernStatus.mockResolvedValue({
      installed: false,
      version: null,
      latestVersion: '149.0.1',
      updateAvailable: false,
    });
    mocks.saveSettings.mockResolvedValue(true);
    mocks.installWayfern.mockResolvedValue({
      installed: true,
      version: '149.0.1',
      latestVersion: '149.0.1',
      updateAvailable: false,
    });

    render(<Settings />);
    await screen.findByText('Wayfern is not installed');
    await user.click(screen.getByRole('radio', { name: /Wayfern portable/i }));

    expect(mocks.saveSettings).toHaveBeenCalledWith({ browserProvider: 'wayfern' });
    expect(mocks.installWayfern).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(mocks.installWayfern).toHaveBeenCalledTimes(1));
  });
});
