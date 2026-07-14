/**
 * Application root — the top-level composition that ties the app shell together
 * (task 29.6).
 *
 * Responsibilities:
 *
 * 1. Startup sequence (runs once on mount):
 *    - Apply the resolved startup theme to `<body>` via {@link initTheme}
 *      (Requirement 27.2 — restore the persisted UI preference before paint).
 *    - Run the Encryption_Gate init ({@link useEncryptionGateStore.init}), which
 *      invokes `enc_status` BEFORE `accounts_load` (Requirement 7.1) and routes
 *      to the setup / unlock / bypass transition.
 *    - Subscribe the event-driven stores: the session-log feed
 *      ({@link useLogStore.subscribe} → `log://entry`) and the Roblox
 *      close-instance events ({@link useAccountStore.subscribeToCloseEvents} →
 *      `roblox://closed` / `roblox://all-closed`). Both are torn down on unmount.
 *
 * 2. Encryption_Gate gating: while the gate withholds access (`accessGranted`
 *    is false — modes "checking" / "setup" / "locked") the page content is not
 *    rendered and the {@link EncryptionGate} modal blocks the rest of the app
 *    (Requirements 7.2, 7.3). When the gate grants access — "unlocked" or the
 *    "bypassed" path (Requirements 7.4, 7.7) — the account list is loaded into
 *    the Account_Store and the pages become accessible.
 *
 * 3. Shell layout: the custom {@link TitleBar}, the {@link Sidebar}, and the
 *    {@link PageRouter} (the animated page host), plus the singleton
 *    {@link Toast} container so IPC error toasts render (Requirements 2.5–2.7).
 *
 * 4. Real-time presence polling ({@link usePresencePolling}) over the loaded
 *    accounts, feeding the Presence_Store (Requirement 26).
 *
 * Launch-metadata / localStorage parity (Requirements 27.2, 28.1) is owned by
 * the individual stores and `lib/persistence.ts`; this component only ensures
 * those stores are mounted and their startup hooks fire.
 */
import { useEffect } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { PageRouter } from './components/PageRouter';
import { LaunchModalHost } from './components/LaunchModalHost';
import { EncryptionGate } from './components/EncryptionGate';
import { Toast } from './components/Toast';
import { useEncryptionGateStore } from './stores/encryptionGateStore';
import { useAccountStore } from './stores/accountStore';
import { useLogStore } from './stores/logStore';
import { initTheme } from './stores/themeStore';
import { usePresencePolling } from './hooks/usePresencePolling';
import './App.css';
import './styles/liquid-glass.css';

/**
 * The composed application shell. See the module docblock for the full startup
 * sequence and gating contract.
 */
export default function App(): JSX.Element {
  const accessGranted = useEncryptionGateStore((state) => state.accessGranted);
  const accounts = useAccountStore((state) => state.accounts);

  // ── Startup sequence (once) ──
  // Apply the persisted theme, run the Encryption_Gate init (enc_status before
  // accounts_load — Req 7.1), and subscribe the event-driven stores. The store
  // subscriptions each resolve to an unlisten handle that is torn down on
  // unmount; `cancelled` guards against a subscription resolving after unmount
  // (e.g. React 18 StrictMode's mount/unmount/remount in development).
  useEffect(() => {
    initTheme();
    void useEncryptionGateStore.getState().init();

    let cancelled = false;
    let unlistenLog: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;

    void useLogStore
      .getState()
      .subscribe()
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenLog = unlisten;
        }
      })
      .catch(() => {
        // Subscribing to `log://entry` is best-effort; a failure just means the
        // Logs page shows no live entries this session.
      });

    void useAccountStore
      .getState()
      .subscribeToCloseEvents()
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenClose = unlisten;
        }
      })
      .catch(() => {
        // Best-effort: without the close-event subscription the launched
        // indicators simply will not clear on instance close this session.
      });

    return () => {
      cancelled = true;
      unlistenLog?.();
      unlistenClose?.();
    };
  }, []);

  // ── Load accounts once access is granted (Req 7.4 / 7.7) ──
  // The Encryption_Gate already invokes `accounts_load` on the access-granting
  // transition to satisfy the startup ordering; loading here populates the
  // Account_Store that the pages render from.
  useEffect(() => {
    if (accessGranted) {
      void useAccountStore.getState().load();
    }
  }, [accessGranted]);

  // ── Real-time presence polling (Req 26) ──
  // Poll presence for every loaded account, authenticating with the first
  // account's cookie. `usePresencePolling` no-ops on an empty id list, so
  // polling only starts once accounts are loaded and access is granted.
  const userIds = accounts.map((account) => account.userId);
  const cookie = accounts[0]?.cookie ?? '';
  const pollUserIds = accessGranted && cookie ? userIds : [];
  usePresencePolling(pollUserIds, cookie);

  return (
    <div className="app-shell">
      <div className="ambient-backdrop" aria-hidden="true">
        <span className="ambient-backdrop__orb ambient-backdrop__orb--violet" />
        <span className="ambient-backdrop__orb ambient-backdrop__orb--cyan" />
        <span className="ambient-backdrop__orb ambient-backdrop__orb--blue" />
        <span className="ambient-backdrop__mesh" />
        <span className="ambient-backdrop__constellation" />
      </div>
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="app-content">
          {/* Page content is gated on access: nothing behind the gate is
              rendered until the Encryption_Gate grants access (Req 7.2, 7.3). */}
          {accessGranted ? <PageRouter /> : null}
        </main>
      </div>

      {accessGranted ? <LaunchModalHost /> : null}

      {/* The Encryption_Gate modal overlays and blocks the entire app while it
          is open; it renders nothing once access is granted (Req 7.2–7.4). */}
      <EncryptionGate />

      {/* Singleton toast host for IPC success/error notifications (Req 2.5–2.7). */}
      <Toast />
    </div>
  );
}
