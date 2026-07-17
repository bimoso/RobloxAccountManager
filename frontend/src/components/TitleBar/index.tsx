// components/TitleBar/index.tsx
//
// Custom application title bar (task 29.1).
//
// Reproduces the retired Legacy_Frontend `#titlebar`: window controls
// (minimize / maximize / close), a
// light/dark theme toggle, the detected Roblox version badge, and a
// running-instance counter — plus the EN/ES interface-language switcher.
//
// - Window controls delegate to `window.api` through `lib/ipc.ts`
//   (`minimize` / `maximize` / `close`), the same IPC_Commands the
//   Legacy_Frontend wires to its titlebar buttons.
// - The theme toggle calls `themeStore.toggleTheme`, which flips between the
//   active theme and light/dark exactly as specified (Requirements 3.7, 3.8):
//   from `"light"` it goes to `"dark"`, from any other theme it goes to
//   `"light"`, without touching the persisted value of the other 10 themes.
// - The language switcher is a compact segmented control bound to the shared
//   `languageStore`; the active option carries a sliding gradient thumb
//   (framer-motion `layoutId`) and switching cross-fades the whole UI through
//   a view transition (see `stores/languageStore.ts`).
// - The Roblox version is read once on mount via `roblox_get_version`
//   (`ipc.getRobloxVersion`), mirroring `detectRobloxVersion()`.
// - The running-instance count subscribes to the `roblox://count` IPC_Event
//   (`ipc.onRobloxCount`) for live pushes and seeds an initial value with
//   `getRunningCount`. The badge is hidden at 0 and turns "live" (green dot)
//   when > 0, matching `setRunningBadges()`.

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Maximize2, Minus, Moon, Orbit, Sun, X } from 'lucide-react';
import { ipc } from '../../lib/ipc';
import { useThemeStore } from '../../stores/themeStore';
import { LANGUAGES } from '../../i18n';
import { useTranslation } from '../../i18n/useTranslation';
import './TitleBar.css';

/** Placeholder shown before the Roblox version resolves / when undetected. */
const VERSION_PLACEHOLDER = '-';

/**
 * The custom window title bar rendered at the top of the app shell.
 *
 * Renders the brand, the detected Roblox version, the running-instance
 * counter, the language switcher, the theme toggle, and the minimize /
 * maximize / close controls. It owns only presentational, title-bar-local
 * state (version string and running count); the theme and language live in
 * their shared stores.
 */
export function TitleBar(): JSX.Element {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const { t, language, setLanguage } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;

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
          <span className="ram-titlebar__name">RobloxAccountManager</span>
          <span className="ram-titlebar__kicker">{t('titlebar.brandKicker')}</span>
        </span>
      </div>

      <div className="ram-titlebar__telemetry" aria-label={t('titlebar.clientStatus')}>
        <span className="ram-titlebar__version" title={t('titlebar.versionTitle')}>
          <span>{t('titlebar.client')}</span>
          <code>{version}</code>
        </span>
        {isLive ? (
          <span
            className="ram-titlebar__running is-live"
            title={t('titlebar.runningTitle')}
          >
            {t('titlebar.running', { count: runningCount })}
          </span>
        ) : null}
      </div>

      <div className="ram-titlebar__drag" aria-hidden="true" />

      <div
        className="ram-titlebar__lang"
        role="group"
        aria-label={t('lang.switcherAria')}
      >
        {LANGUAGES.map((lang) => {
          const active = lang === language;
          const label = t(`lang.${lang}`);
          return (
            <button
              key={lang}
              type="button"
              className={`ram-titlebar__lang-opt${active ? ' active' : ''}`}
              aria-pressed={active}
              aria-label={label}
              title={label}
              onClick={() => setLanguage(lang)}
            >
              {active ? (
                <motion.span
                  className="ram-titlebar__lang-thumb"
                  layoutId="titlebar-lang-thumb"
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 520, damping: 40, mass: 0.6 }
                  }
                  aria-hidden="true"
                />
              ) : null}
              <span className="ram-titlebar__lang-code">{lang.toUpperCase()}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="ram-titlebar__btn"
        onClick={toggleTheme}
        title={t('titlebar.toggleTheme')}
        aria-label={t('titlebar.toggleThemeAria')}
      >
        <ThemeIcon aria-hidden="true" size={16} strokeWidth={1.9} />
      </button>

      <div className="ram-titlebar__controls">
        <button
          type="button"
          className="ram-titlebar__btn"
          onClick={() => void ipc.minimize()}
          title={t('titlebar.minimize')}
          aria-label={t('titlebar.minimize')}
        >
          <Minus aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ram-titlebar__btn"
          onClick={() => void ipc.maximize()}
          title={t('titlebar.maximize')}
          aria-label={t('titlebar.maximize')}
        >
          <Maximize2 aria-hidden="true" size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ram-titlebar__btn is-close"
          onClick={() => void ipc.close()}
          title={t('titlebar.close')}
          aria-label={t('titlebar.close')}
        >
          <X aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
