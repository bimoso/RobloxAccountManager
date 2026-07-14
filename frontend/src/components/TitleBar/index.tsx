// components/TitleBar/index.tsx
//
// Custom application title bar (task 29.1).
//
// Reproduces the retired Legacy_Frontend `#titlebar`: window controls
// (minimize / maximize / close), a
// light/dark theme toggle, the detected Roblox version badge, and a
// running-instance counter.
//
// - Window controls delegate to `window.api` through `lib/ipc.ts`
//   (`minimize` / `maximize` / `close`), the same IPC_Commands the
//   Legacy_Frontend wires to its titlebar buttons.
// - The theme toggle calls `themeStore.toggleTheme`, which flips between the
//   active theme and light/dark exactly as specified (Requirements 3.7, 3.8):
//   from `"light"` it goes to `"dark"`, from any other theme it goes to
//   `"light"`, without touching the persisted value of the other 10 themes.
// - The Roblox version is read once on mount via `roblox_get_version`
//   (`ipc.getRobloxVersion`), mirroring `detectRobloxVersion()`.
// - The running-instance count subscribes to the `roblox://count` IPC_Event
//   (`ipc.onRobloxCount`) for live pushes and seeds an initial value with
//   `getRunningCount`. The badge is hidden at 0 and turns "live" (green dot)
//   when > 0, matching `setRunningBadges()`.

import { useEffect, useState } from 'react';
import { Maximize2, Minus, Moon, Orbit, Sun, X } from 'lucide-react';
import { ipc } from '../../lib/ipc';
import { useThemeStore } from '../../stores/themeStore';
import './TitleBar.css';

/** Placeholder shown before the Roblox version resolves / when undetected. */
const VERSION_PLACEHOLDER = '-';

/**
 * The custom window title bar rendered at the top of the app shell.
 *
 * Renders the brand, the detected Roblox version, the running-instance
 * counter, the theme toggle, and the minimize / maximize / close controls. It
 * owns only presentational, title-bar-local state (version string and running
 * count); the theme lives in the shared `themeStore`.
 */
export function TitleBar(): JSX.Element {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);

  const [version, setVersion] = useState<string>(VERSION_PLACEHOLDER);
  const [runningCount, setRunningCount] = useState<number>(0);

  // Detect the installed Roblox version once on mount (Legacy: detectRobloxVersion).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ver = await ipc.getRobloxVersion();
        if (!cancelled) {
          setVersion(ver && ver.length > 0 ? ver : VERSION_PLACEHOLDER);
        }
      } catch {
        // Version detection is best-effort; keep the placeholder on failure.
        if (!cancelled) {
          setVersion(VERSION_PLACEHOLDER);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the running-instance counter current: seed with getRunningCount, then
  // follow the roblox://count event for live pushes (Legacy: onRobloxCount).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const initial = await ipc.getRunningCount();
        if (!cancelled) {
          setRunningCount(initial);
        }
      } catch {
        // Background seed is best-effort; the event subscription below still
        // updates the count when the backend pushes it.
      }

      try {
        const handle = await ipc.onRobloxCount((count) => {
          setRunningCount(count);
        });
        if (cancelled) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch {
        // If the subscription fails the counter simply stays at its last value.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Legacy parity: from light the icon offers "dark_mode"; otherwise "light_mode".
  const ThemeIcon = theme === 'light' ? Moon : Sun;
  const isLive = runningCount > 0;

  return (
    <div id="titlebar" className="ram-titlebar">
      <div className="ram-titlebar__brand">
        <span className="ram-titlebar__logo" aria-hidden="true">
          <Orbit size={16} strokeWidth={2.2} />
        </span>
        <span className="ram-titlebar__brand-copy">
          <span className="ram-titlebar__name">MultiRoblox</span>
          <span className="ram-titlebar__kicker">Control deck</span>
          <span className="sr-only">RobloxAccountManager</span>
        </span>
      </div>

      <div className="ram-titlebar__telemetry" aria-label="Client status">
        <span className="ram-titlebar__version" title="Detected Roblox version">
          <span>CLIENT</span>
          <code>{version}</code>
        </span>
        {isLive ? (
          <span
            className="ram-titlebar__running is-live"
            title="Roblox instances currently running"
          >
            {runningCount} running
          </span>
        ) : null}
      </div>

      <div className="ram-titlebar__drag" aria-hidden="true" />

      <button
        type="button"
        className="ram-titlebar__btn"
        onClick={toggleTheme}
        title="Toggle light/dark"
        aria-label="Toggle light/dark theme"
      >
        <ThemeIcon aria-hidden="true" size={16} strokeWidth={1.9} />
      </button>

      <div className="ram-titlebar__controls">
        <button
          type="button"
          className="ram-titlebar__btn"
          onClick={() => void ipc.minimize()}
          title="Minimize"
          aria-label="Minimize"
        >
          <Minus aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ram-titlebar__btn"
          onClick={() => void ipc.maximize()}
          title="Maximize"
          aria-label="Maximize"
        >
          <Maximize2 aria-hidden="true" size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ram-titlebar__btn is-close"
          onClick={() => void ipc.close()}
          title="Close"
          aria-label="Close"
        >
          <X aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
