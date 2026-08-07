import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  RobloxDeployment,
  RobloxInstallation,
  RobloxProtocolState,
  RobloxRelease,
  Settings,
} from '@/types/models';

const mocks = vi.hoisted(() => ({
  getRobloxClientsSnapshot: vi.fn(),
  scanRobloxInstallations: vi.fn(),
  addRobloxCustomPreset: vi.fn(),
  removeRobloxCustomPreset: vi.fn(),
  getRobloxProtocolState: vi.fn(),
  getLatestRobloxRelease: vi.fn(),
  listRobloxDeployments: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  activateRobloxProtocol: vi.fn(),
  restoreRobloxProtocol: vi.fn(),
  installRobloxDeployment: vi.fn(),
  cancelRobloxDeployment: vi.fn(),
  onRobloxDeploymentProgress: vi.fn(),
  onRobloxProtocolChanged: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({ ipc: mocks }));

import { ClientsTab } from './ClientsTab';

const OFFICIAL: RobloxInstallation = {
  id: 'official:live',
  kind: 'official',
  displayName: 'Roblox Player',
  executable: 'C:\\Roblox\\RobloxPlayerBeta.exe',
  installLocation: 'C:\\Roblox',
  displayVersion: null,
  versionGuid: 'version-live',
  channel: 'LIVE',
  detectedBy: 'uninstall_registry',
  protocolCapable: true,
  activeSchemes: ['roblox', 'roblox-player'],
  handlerCommand: '"C:\\Roblox\\RobloxPlayerBeta.exe" "%1"',
};

const FISHSTRAP: RobloxInstallation = {
  id: 'fishstrap:main',
  kind: 'fishstrap',
  displayName: 'Fishstrap client',
  executable: 'C:\\Fishstrap\\Fishstrap.exe',
  installLocation: 'C:\\Fishstrap',
  displayVersion: '3.0.1',
  versionGuid: null,
  channel: null,
  detectedBy: 'uninstall_registry',
  protocolCapable: true,
  activeSchemes: [],
  handlerCommand: '"C:\\Fishstrap\\Fishstrap.exe" -player "%1"',
};

const USER_PRESET: RobloxInstallation = {
  id: 'user:qa-client',
  kind: 'custom',
  displayName: 'QA client',
  executable: 'C:\\QA\\version-custom\\RobloxPlayerBeta.exe',
  installLocation: 'C:\\QA\\version-custom',
  displayVersion: null,
  versionGuid: 'version-custom',
  channel: null,
  detectedBy: 'user_preset',
  protocolCapable: true,
  activeSchemes: [],
  handlerCommand: '"C:\\QA\\version-custom\\RobloxPlayerBeta.exe" "%1"',
};

const PROTOCOL: RobloxProtocolState = {
  roblox: {
    scheme: 'roblox',
    command: OFFICIAL.handlerCommand,
    executable: OFFICIAL.executable,
    arguments: ['%1'],
    installationId: OFFICIAL.id,
  },
  robloxPlayer: {
    scheme: 'roblox-player',
    command: OFFICIAL.handlerCommand,
    executable: OFFICIAL.executable,
    arguments: ['%1'],
    installationId: OFFICIAL.id,
  },
  snapshotAvailable: false,
};

const RELEASE: RobloxRelease = {
  channel: 'LIVE',
  versionGuid: 'version-live',
  clientVersion: '0.729.24',
  bootstrapperVersion: null,
  checkedAt: 1,
};

const SETTINGS = {
  multiInstance: true,
  antiAfk: false,
  antiAfkInterval: null,
  keyVerifier: null,
  donutApiTokenEnc: null,
  donutApiPort: 10108,
  pendingDonutDeletions: [],
  multiRobloxGroupId: null,
  masterVolume: null,
  encSetupDone: true,
  robloxLaunchMode: 'direct',
  robloxLaunchPresetId: OFFICIAL.id,
} satisfies Settings;

beforeEach(() => {
  vi.clearAllMocks();
  // The deck's own refresh reads installations, protocol handlers and
  // deployments from one command; `scanRobloxInstallations` remains for the
  // rescans that follow a preset or deployment mutation.
  mocks.getRobloxClientsSnapshot.mockResolvedValue({
    installations: [OFFICIAL, FISHSTRAP],
    protocol: PROTOCOL,
    deployments: [],
  });
  mocks.scanRobloxInstallations.mockResolvedValue([OFFICIAL, FISHSTRAP]);
  mocks.addRobloxCustomPreset.mockResolvedValue(USER_PRESET);
  mocks.removeRobloxCustomPreset.mockResolvedValue(true);
  mocks.getRobloxProtocolState.mockResolvedValue(PROTOCOL);
  mocks.getLatestRobloxRelease.mockResolvedValue(RELEASE);
  mocks.listRobloxDeployments.mockResolvedValue([]);
  mocks.loadSettings.mockResolvedValue(SETTINGS);
  mocks.saveSettings.mockResolvedValue(true);
  mocks.activateRobloxProtocol.mockResolvedValue({
    ...PROTOCOL,
    roblox: { ...PROTOCOL.roblox, installationId: FISHSTRAP.id },
    robloxPlayer: { ...PROTOCOL.robloxPlayer, installationId: FISHSTRAP.id },
    snapshotAvailable: true,
  });
  mocks.restoreRobloxProtocol.mockResolvedValue(PROTOCOL);
  mocks.onRobloxDeploymentProgress.mockResolvedValue(() => undefined);
  mocks.onRobloxProtocolChanged.mockResolvedValue(() => undefined);
  mocks.cancelRobloxDeployment.mockResolvedValue(true);
});

describe('ClientsTab', () => {
  it('reuses a fresh client scan when the tab is reopened', async () => {
    const first = render(<ClientsTab />);
    expect(await screen.findByText('Fishstrap client')).toBeInTheDocument();
    expect(mocks.getRobloxClientsSnapshot).toHaveBeenCalledTimes(1);

    first.unmount();
    render(<ClientsTab />);
    expect(screen.getByText('Fishstrap client')).toBeInTheDocument();
    await waitFor(() => expect(mocks.getRobloxClientsSnapshot).toHaveBeenCalledTimes(1));
  });

  it('separates detected installations from the active Windows handler', async () => {
    render(<ClientsTab />);
    expect(await screen.findByText('Fishstrap client')).toBeInTheDocument();
    expect(screen.getAllByText('Roblox Player').length).toBeGreaterThan(0);
    expect(screen.getByText('Direct executable')).toBeInTheDocument();
    expect(screen.getByText('2 found')).toBeInTheDocument();
  });

  it('can select Fishstrap for direct launches without changing protocols', async () => {
    const user = userEvent.setup();
    render(<ClientsTab />);
    const fishstrap = (await screen.findByText('Fishstrap client')).closest('article');
    expect(fishstrap).not.toBeNull();
    await user.click(within(fishstrap as HTMLElement).getByRole('button', { name: /use in manager/i }));
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      robloxLaunchMode: 'direct',
      robloxLaunchPresetId: FISHSTRAP.id,
    });
    expect(mocks.activateRobloxProtocol).not.toHaveBeenCalled();
  });

  it('adds an explicit executable path as a reusable launch preset', async () => {
    const user = userEvent.setup();
    render(<ClientsTab />);

    await screen.findByText('Fishstrap client');
    await user.type(
      screen.getByRole('textbox', { name: /version or bootstrapper path/i }),
      USER_PRESET.executable!,
    );
    await user.type(screen.getByRole('textbox', { name: /preset label optional/i }), 'QA client');
    await user.click(screen.getByRole('button', { name: /add preset/i }));

    await waitFor(() => {
      expect(mocks.addRobloxCustomPreset).toHaveBeenCalledWith(USER_PRESET.executable!, 'QA client');
    });
    // The mount refresh goes through the snapshot command; only the post-add
    // rescan hits `scanRobloxInstallations`.
    expect(mocks.scanRobloxInstallations).toHaveBeenCalledTimes(1);
  });

  it('activates both Windows schemes atomically in the native command', async () => {
    const user = userEvent.setup();
    render(<ClientsTab />);
    const fishstrap = (await screen.findByText('Fishstrap client')).closest('article');
    await user.click(within(fishstrap as HTMLElement).getByRole('button', { name: /own roblox/i }));
    expect(mocks.activateRobloxProtocol).toHaveBeenCalledWith(FISHSTRAP.id);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(await screen.findByText(/previous protocol binding/i)).toBeInTheDocument();
  });

  it('installs the latest deployment when the GUID field is blank', async () => {
    const deployment: RobloxDeployment = {
      id: 'deployment:live',
      channel: 'LIVE',
      versionGuid: RELEASE.versionGuid,
      clientVersion: RELEASE.clientVersion,
      installedAt: 1,
      installLocation: 'C:\\Deployments\\version-live',
      executable: 'C:\\Deployments\\version-live\\RobloxPlayerBeta.exe',
      sizeBytes: 512 * 1024 * 1024,
      source: 'setup-aws.rbxcdn.com',
    };
    mocks.installRobloxDeployment.mockResolvedValue(deployment);
    const user = userEvent.setup();
    render(<ClientsTab />);
    await user.click(await screen.findByRole('button', { name: /download deployment/i }));

    await waitFor(() => expect(mocks.installRobloxDeployment).toHaveBeenCalled());
    const [operationId, channel, versionGuid] = mocks.installRobloxDeployment.mock.calls[0];
    expect(operationId).toEqual(expect.any(String));
    expect(channel).toBe('LIVE');
    expect(versionGuid).toBeNull();
    expect((await screen.findAllByText(RELEASE.versionGuid)).length).toBeGreaterThan(0);
  });
});
