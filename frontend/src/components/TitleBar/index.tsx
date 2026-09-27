// components/TitleBar/index.tsx
//
// The custom window title bar.
//
// Left: the RAM mark and wordmark, in a cell exactly as wide as the navigation
// rail below it (it follows the rail when it collapses). Centre: the command
// palette trigger, styled as the app's one search field. Right: the live
// instance counter, the detected Roblox version, the EN/ES switcher, the theme
// toggle and the Windows caption buttons.
//
// - Window controls delegate to window.api through lib/ipc.ts.
// - The theme toggle calls themeStore.toggleTheme (light <-> dark, the other ten
//   palettes keep their persisted value).
// - The language switcher is bound to languageStore; the active option carries
//   a sliding thumb (framer-motion layoutId).
// - The Roblox version is read once on mount; the running-instance count seeds
//   from getRunningCount and follows the roblox://count event.

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Minus, Moon, Search, Square, Sun, X } from 'lucide-react';
import { ipc } from '../../lib/ipc';
import { useThemeStore } from '../../stores/themeStore';
import { LANGUAGES } from '../../i18n';
import { useTranslation } from '../../i18n/useTranslation';
import { RamLogo, RamWordmark } from '../Brand';
import './TitleBar.css';

/** Placeholder shown before the Roblox version resolves / when undetected. */
const VERSION_PLACEHOLDER = '-';

/** Props for {@link TitleBar}. */
export interface TitleBarProps {
  /**
   * Opens the Command_Palette. When omitted the trigger is not rendered, so a
   * bare <TitleBar /> (as mounted in tests) shows no control that would do
   * nothing if pressed.
   */
  onOpenPalette?: () => void;
}

/** The custom window title bar rendered at the top of the app shell. */
export function TitleBar({ onOpenPalette }: TitleBarProps = {}): JSX.Element {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const { t, language, setLanguage } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;

  const [version, setVersion] = useState<string>(VERSION_PLACEHOLDER);
  const [runningCount, setRunningCount] = useState<number>(0);

  // Detect the installed Roblox version once on mount.
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
  // follow the roblox://count event for live pushes.
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
        // Best-effort seed; the event subscription below still updates it.
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

  const ThemeIcon = theme === 'light' ? Moon : Sun;
  const isLive = runningCount > 0;
  const hasVersion = version !== VERSION_PLACEHOLDER;

  return (
    <div id="titlebar" className="ram-titlebar" data-tauri-drag-region>
      <div className="ram-titlebar__brand" data-tauri-drag-region title={t('titlebar.brandTitle')}>
        <RamLogo size={28} />
        <RamWordmark className="ram-titlebar__wordmark" />
      </div>

      <div className="ram-titlebar__center" data-tauri-drag-region>
        {onOpenPalette ? (
          <button
            type="button"
            className="rk-cmdbar"
            onClick={onOpenPalette}
            aria-label={t('cmdk.openAria')}
            aria-keyshortcuts="Control+K"
          >
            <Search size={14} strokeWidth={2} aria-hidden="true" />
            <span className="rk-cmdbar__label">{t('cmdk.open')}</span>
            <span className="rk-cmdbar__keys" aria-hidden="true">
              <kbd className="rk-key">Ctrl</kbd>
              <kbd className="rk-key">K</kbd>
            </span>
          </button>
        ) : null}
      </div>

      <div className="ram-titlebar__tools">
        <div className="ram-titlebar__telemetry" aria-label={t('titlebar.clientStatus')}>
          {isLive ? (
            <span className="ram-titlebar__live" title={t('titlebar.runningTitle')}>
              <span className="rk-dot rk-dot--live" data-tone="ok" aria-hidden="true" />
              {t('titlebar.running', { count: runningCount })}
            </span>
          ) : null}
          <span
            className="ram-titlebar__version"
            data-known={hasVersion ? 'true' : undefined}
            title={t('titlebar.versionTitle')}
          >
            <span>{t('titlebar.client')}</span>
            <code className="u-num">{version}</code>
          </span>
        </div>

        <div className="ram-titlebar__lang" role="group" aria-label={t('lang.switcherAria')}>
          {LANGUAGES.map((lang) => {
            const active = lang === language;
            const label = t(lang === 'en' ? 'lang.en' : 'lang.es');
            return (
              <button
                key={lang}
                type="button"
                className={'ram-titlebar__lang-opt' + (active ? ' active' : '')}
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
            className="ram-titlebar__cap"
            onClick={() => void ipc.minimize()}
            title={t('titlebar.minimize')}
            aria-label={t('titlebar.minimize')}
          >
            <Minus aria-hidden="true" size={16} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="ram-titlebar__cap"
            onClick={() => void ipc.maximize()}
            title={t('titlebar.maximize')}
            aria-label={t('titlebar.maximize')}
          >
            <Square aria-hidden="true" size={12.5} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className="ram-titlebar__cap is-close"
            onClick={() => void ipc.close()}
            title={t('titlebar.close')}
            aria-label={t('titlebar.close')}
          >
            <X aria-hidden="true" size={17} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
