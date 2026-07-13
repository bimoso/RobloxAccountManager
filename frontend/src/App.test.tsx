import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

/**
 * Behavioural tests for the wired application shell (task 29.6).
 *
 * `lib/ipc` is mocked so the whole shell (Encryption_Gate startup, TitleBar,
 * Sidebar, PageRouter and every store subscription) can mount without a real
 * `window.api` bridge. The mock lets us drive the two things the App wiring
 * owns:
 *   - the startup gate: `enc_status` runs BEFORE `accounts_load` (Req 7.1), and
 *     an "unlocked" status grants access so the page content renders (Req 7.4);
 *   - the event-driven store subscriptions are registered at startup and their
 *     unlisten handles are invoked on unmount.
 */

const {
  encStatus,
  loadAccounts,
  encSetKey,
  encUnlock,
  getRobloxVersion,
  getRunningCount,
  onRobloxCount,
  onRobloxClosed,
  onAllRobloxClosed,
  onLogEntry,
  getPresence,
  unlistenLog,
  unlistenCount,
  unlistenClosed,
  unlistenAllClosed,
} = vi.hoisted(() => ({
  encStatus: vi.fn<() => Promise<{ mode: 'setup' | 'locked' | 'unlocked' }>>(),
  loadAccounts: vi.fn<() => Promise<unknown>>(),
  encSetKey: vi.fn<(k: string) => Promise<boolean>>(),
  encUnlock: vi.fn<(k: string) => Promise<boolean>>(),
  getRobloxVersion: vi.fn<() => Promise<string>>(),
  getRunningCount: vi.fn<() => Promise<number>>(),
  onRobloxCount: vi.fn(),
  onRobloxClosed: vi.fn(),
  onAllRobloxClosed: vi.fn(),
  onLogEntry: vi.fn(),
  getPresence: vi.fn(),
  unlistenLog: vi.fn(),
  unlistenCount: vi.fn(),
  unlistenClosed: vi.fn(),
  unlistenAllClosed: vi.fn(),
}));

vi.mock('./lib/ipc', () => ({
  ipc: {
    encStatus: () => encStatus(),
    loadAccounts: () => loadAccounts(),
    encSetKey: (k: string) => encSetKey(k),
    encUnlock: (k: string) => encUnlock(k),
    getRobloxVersion: () => getRobloxVersion(),
    getRunningCount: () => getRunningCount(),
    onRobloxCount: (cb: (n: number) => void) => onRobloxCount(cb),
    onRobloxClosed: (cb: (id: string) => void) => onRobloxClosed(cb),
    onAllRobloxClosed: (cb: () => void) => onAllRobloxClosed(cb),
    onLogEntry: (cb: (p: unknown) => void) => onLogEntry(cb),
    getPresence: (ids: Array<string | number>, cookie: string) =>
      getPresence(ids, cookie),
  },
}));

import App from './App';
import { useEncryptionGateStore } from './stores/encryptionGateStore';
import { useAccountStore } from './stores/accountStore';

beforeEach(() => {
  vi.clearAllMocks();
  // Default startup: encrypted gate reports "unlocked" so access is granted and
  // the page content renders; account/version/count reads resolve empty.
  encStatus.mockResolvedValue({ mode: 'unlocked' });
  loadAccounts.mockResolvedValue([]);
  getRobloxVersion.mockResolvedValue('1.0.0');
  getRunningCount.mockResolvedValue(0);
  onRobloxCount.mockResolvedValue(unlistenCount);
  onRobloxClosed.mockResolvedValue(unlistenClosed);
  onAllRobloxClosed.mockResolvedValue(unlistenAllClosed);
  onLogEntry.mockResolvedValue(unlistenLog);
  getPresence.mockResolvedValue({ userPresences: [] });

  // Reset the stores the shell reads/writes so each test starts clean.
  useEncryptionGateStore.setState({
    mode: 'checking',
    accessGranted: false,
    errorMessage: null,
    setupModalOpen: false,
    unlockModalOpen: false,
  });
  useAccountStore.setState({ accounts: [], loading: false, error: null });
});

afterEach(() => {
  useEncryptionGateStore.setState({
    mode: 'checking',
    accessGranted: false,
    errorMessage: null,
    setupModalOpen: false,
    unlockModalOpen: false,
  });
});

describe('App shell wiring (task 29.6)', () => {
  it('renders the title bar and sidebar navigation', async () => {
    render(<App />);
    expect(screen.getByText('RobloxAccountManager')).toBeInTheDocument();
    // Sidebar nav entries (from navigationStore) are present.
    expect(
      screen.getByRole('button', { name: /accounts/i }),
    ).toBeInTheDocument();
    // Let startup async settle so the act() warnings don't leak.
    await waitFor(() => expect(encStatus).toHaveBeenCalledTimes(1));
  });

  it('invokes enc_status before accounts_load on startup (Req 7.1)', async () => {
    render(<App />);
    await waitFor(() => {
      expect(encStatus).toHaveBeenCalled();
      expect(loadAccounts).toHaveBeenCalled();
    });
    const statusOrder = encStatus.mock.invocationCallOrder[0];
    const loadOrder = loadAccounts.mock.invocationCallOrder[0];
    expect(statusOrder).toBeLessThan(loadOrder);
  });

  it('grants access and renders the default page when the gate is unlocked (Req 7.4)', async () => {
    render(<App />);
    // The Accounts page renders its heading once access is granted.
    expect(
      await screen.findByRole('heading', { name: /cuentas/i }),
    ).toBeInTheDocument();
  });

  it('blocks page content and shows the unlock modal while locked (Req 7.3)', async () => {
    encStatus.mockResolvedValue({ mode: 'locked' });
    render(<App />);
    // The unlock modal is shown and the default page heading is NOT rendered.
    expect(
      await screen.findByRole('heading', { name: /unlock your accounts/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /cuentas/i }),
    ).not.toBeInTheDocument();
  });

  it('subscribes to log and close events and tears them down on unmount', async () => {
    const { unmount } = render(<App />);
    await waitFor(() => {
      expect(onLogEntry).toHaveBeenCalledTimes(1);
      expect(onRobloxClosed).toHaveBeenCalledTimes(1);
      expect(onAllRobloxClosed).toHaveBeenCalledTimes(1);
    });
    act(() => {
      unmount();
    });
    await waitFor(() => {
      expect(unlistenLog).toHaveBeenCalled();
      expect(unlistenClosed).toHaveBeenCalled();
      expect(unlistenAllClosed).toHaveBeenCalled();
    });
  });
});
