import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  getRobloxVersion: vi.fn(),
  multiInstanceStatus: vi.fn(),
  getWayfernStatus: vi.fn(),
  readFFlags: vi.fn(),
  writeFFlags: vi.fn(),
  readFpsCap: vi.fn(),
  writeFpsCap: vi.fn(),
  setRobloxVolume: vi.fn(),
  killOneRoblox: vi.fn(),
  launchRoblox: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    loadSettings: mocks.loadSettings,
    saveSettings: mocks.saveSettings,
    getRobloxVersion: mocks.getRobloxVersion,
    multiInstanceStatus: mocks.multiInstanceStatus,
    getWayfernStatus: mocks.getWayfernStatus,
    readFFlags: mocks.readFFlags,
    writeFFlags: mocks.writeFFlags,
    readFpsCap: mocks.readFpsCap,
    writeFpsCap: mocks.writeFpsCap,
    setRobloxVolume: mocks.setRobloxVolume,
    killOneRoblox: mocks.killOneRoblox,
    launchRoblox: mocks.launchRoblox,
    onWayfernProgress: vi.fn().mockResolvedValue(() => undefined),
  },
}));

import { Settings } from './index';

function arrangeMixerSettings(): void {
  mocks.loadSettings.mockResolvedValue({
    antiAfk: false,
    browserProvider: 'donut',
    donutApiTokenEnc: null,
    masterVolume: 37,
  });
  mocks.getRobloxVersion.mockResolvedValue('1.0.0');
  mocks.multiInstanceStatus.mockResolvedValue(true);
  mocks.getWayfernStatus.mockResolvedValue({ installed: false });
  mocks.readFFlags.mockResolvedValue({ DFIntDebugFRMQualityLevelOverride: '12' });
  mocks.readFpsCap.mockResolvedValue(144);
  mocks.writeFFlags.mockResolvedValue(true);
  mocks.writeFpsCap.mockResolvedValue(true);
  mocks.saveSettings.mockResolvedValue(true);
  mocks.setRobloxVolume.mockResolvedValue(true);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Settings Mixer tab', () => {
  it('hosts the former Mixer controls and keeps their persisted values wired', async () => {
    const user = userEvent.setup();
    arrangeMixerSettings();

    render(<Settings />);

    await user.click(screen.getByRole('tab', { name: /mixer/i }));
    expect(await screen.findByRole('heading', { name: /runtime mixer/i })).toBeInTheDocument();

    const graphics = screen.getByRole('slider', { name: /graphics quality level/i });
    const fps = screen.getByRole('slider', { name: /fps limit value/i });
    const volume = screen.getByRole('slider', { name: /master volume percentage/i });
    await waitFor(() => {
      expect(graphics).toHaveValue('12');
      expect(fps).toHaveValue('144');
      expect(volume).toHaveValue('37');
    });

    await user.click(screen.getByRole('switch', { name: /unlimited fps/i }));
    expect(mocks.writeFpsCap).toHaveBeenCalledWith(0);
  });

  it('rolls optimistic graphics and FPS toggles back when persistence fails', async () => {
    arrangeMixerSettings();
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('tab', { name: /mixer/i }));
    const graphicsAuto = await screen.findByRole('switch', {
      name: /automatic graphics quality/i,
    });
    const fpsUnlimited = screen.getByRole('switch', { name: /unlimited fps/i });
    await waitFor(() => {
      expect(graphicsAuto).toHaveAttribute('aria-checked', 'false');
      expect(fpsUnlimited).toHaveAttribute('aria-checked', 'false');
    });

    mocks.writeFFlags.mockRejectedValueOnce(new Error('flags unavailable'));
    await user.click(graphicsAuto);
    await waitFor(() => {
      expect(graphicsAuto).toHaveAttribute('aria-checked', 'false');
      expect(graphicsAuto).not.toBeDisabled();
    });

    mocks.writeFpsCap.mockRejectedValueOnce(new Error('fps unavailable'));
    await user.click(fpsUnlimited);
    await waitFor(() => {
      expect(fpsUnlimited).toHaveAttribute('aria-checked', 'false');
      expect(fpsUnlimited).not.toBeDisabled();
    });
  });

  it('coalesces volume input and commits only the exact final value', async () => {
    arrangeMixerSettings();
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('tab', { name: /mixer/i }));
    const volume = await screen.findByRole('slider', {
      name: /master volume percentage/i,
    });
    await waitFor(() => expect(volume).toHaveValue('37'));
    mocks.saveSettings.mockClear();
    mocks.setRobloxVolume.mockClear();

    fireEvent.change(volume, { target: { value: '41' } });
    fireEvent.change(volume, { target: { value: '57' } });
    fireEvent.change(volume, { target: { value: '63' } });

    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.setRobloxVolume).not.toHaveBeenCalled();

    fireEvent.pointerUp(volume);
    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
      expect(mocks.saveSettings).toHaveBeenCalledWith({ masterVolume: 63 });
      expect(mocks.setRobloxVolume).toHaveBeenCalledTimes(1);
      expect(mocks.setRobloxVolume).toHaveBeenCalledWith(63);
      expect(volume).toHaveValue('63');
      expect(volume).not.toBeDisabled();
    });
  });

  it('restores the persisted volume when saving the final value fails', async () => {
    arrangeMixerSettings();
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('tab', { name: /mixer/i }));
    const volume = await screen.findByRole('slider', {
      name: /master volume percentage/i,
    });
    await waitFor(() => expect(volume).toHaveValue('37'));
    mocks.saveSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    mocks.setRobloxVolume.mockClear();

    fireEvent.change(volume, { target: { value: '82' } });
    fireEvent.pointerUp(volume);

    await waitFor(() => {
      expect(volume).toHaveValue('37');
      expect(volume).not.toBeDisabled();
    });
    expect(mocks.setRobloxVolume).not.toHaveBeenCalled();
  });
});
