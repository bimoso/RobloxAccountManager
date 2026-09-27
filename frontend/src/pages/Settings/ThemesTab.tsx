// pages/Settings/ThemesTab.tsx
//
// Themes tab of the Settings page (Requirement 3.2). Lists the 12 selectable
// themes — dark, light, midnight, aurora, sunset, crimson, ocean, grape,
// forest, amber, rose, graphite — each drawn as a miniature of the interface
// that theme actually produces.
//
// Selecting a theme calls the shared `themeStore`'s `setTheme`, which swaps the
// `<body>` class synchronously (well within the 300ms budget of Requirement
// 3.2) and persists the choice. This component owns no theme logic of its own:
// the source of truth for the valid theme list is `THEME_NAMES` and the applied
// theme is `useThemeStore`'s `theme`. It imports nothing from other pages
// (Requirement 1.1).

import { Check, Palette } from 'lucide-react';
import { useThemeStore, THEME_NAMES } from '@/stores/themeStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { ThemeName } from '@/types/models';
import './Settings.css';

/**
 * The six primitives a theme block in `styles/theme.css` is allowed to set that
 * are visible at swatch size: the page ground, the panel surface, the hairline
 * ramp, the two text ramps and both accents. A swatch composed from these is a
 * real reduction of the theme rather than an approximation of it — which is why
 * the previous three-colour preview had drifted so far from the palettes it
 * claimed to show (it still advertised a teal accent for `dark`, which has been
 * violet for a long time).
 */
interface ThemeSwatch {
  /** Page ground — `--bg`. */
  readonly bg: string;
  /** Panel surface — `--s1`. */
  readonly s1: string;
  /** Hairline / raised surface — `--s3`. */
  readonly s3: string;
  /** Primary text — `--t1`. */
  readonly t1: string;
  /** Tertiary text — `--t3`. */
  readonly t3: string;
  /** Primary accent — `--ac`. */
  readonly ac: string;
  /** Secondary accent — `--acB`. */
  readonly acB: string;
}

/**
 * Swatch primitives for the 12 themes, copied verbatim from the theme blocks in
 * `styles/theme.css`. They are cosmetic only — the authoritative palette is
 * still applied by the `<body>` class when the theme is selected — but they are
 * the same numbers, so a swatch cannot misrepresent its theme.
 */
const THEME_SWATCHES: Readonly<Record<ThemeName, ThemeSwatch>> = {
  dark: { bg: '#0a0c11', s1: '#101319', s3: '#1e232d', t1: '#f2f5fa', t3: '#6e778a', ac: '#7c7cff', acB: '#3fd2e0' },
  light: { bg: '#eef0f6', s1: '#ffffff', s3: '#eaecf4', t1: '#10141f', t3: '#7b849c', ac: '#5b4fd6', acB: '#0b7f9e' },
  midnight: { bg: '#080a0f', s1: '#0f1218', s3: '#1e242f', t1: '#eef3fb', t3: '#66748c', ac: '#58c9e8', acB: '#f0c987' },
  aurora: { bg: '#05100d', s1: '#0b1714', s3: '#182b24', t1: '#ecfbf5', t3: '#5f7f75', ac: '#2fd8a0', acB: '#7fcdf5' },
  sunset: { bg: '#120a0c', s1: '#1b1114', s3: '#2f2124', t1: '#fdeee9', t3: '#8d7570', ac: '#ff8664', acB: '#f5c95f' },
  crimson: { bg: '#10080b', s1: '#1a0f14', s3: '#2f1e26', t1: '#fdecf0', t3: '#8d707c', ac: '#ff5878', acB: '#efbe55' },
  ocean: { bg: '#060f12', s1: '#0d171b', s3: '#1b2c34', t1: '#e8f7fd', t3: '#637984', ac: '#40cff8', acB: '#2fdb9f' },
  grape: { bg: '#0f0a15', s1: '#17111f', s3: '#2a2136', t1: '#f5eefd', t3: '#7e708f', ac: '#b97cf5', acB: '#55e3ca' },
  forest: { bg: '#060f0a', s1: '#0e1711', s3: '#1c2c21', t1: '#eafaee', t3: '#6a8272', ac: '#74e07d', acB: '#55e0c8' },
  amber: { bg: '#100f09', s1: '#19170f', s3: '#2d2a1c', t1: '#fdf6e6', t3: '#8a8065', ac: '#f2bf51', acB: '#3ccf9e' },
  rose: { bg: '#110a0f', s1: '#1b1118', s3: '#30212b', t1: '#fdedf4', t3: '#8e7181', ac: '#ff73a3', acB: '#f0cd61' },
  graphite: { bg: '#08090b', s1: '#101216', s3: '#21252c', t1: '#eef1f6', t3: '#6f7889', ac: '#cdd5e0', acB: '#3ccf9e' },
};

/**
 * The Themes tab body. Renders one selectable swatch per theme; the active
 * theme is marked with a fill and a check (never a glow — a glow reads as focus
 * in a rack), and selecting a swatch applies the theme through `setTheme`
 * (Requirement 3.2).
 */
export function ThemesTab(): JSX.Element {
  const activeTheme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { t } = useTranslation();

  return (
    <div className="set-stack settings-themes">
      <section className="rk-panel set-panel">
        <div className="rk-panel__head">
          <span className="set-icon" aria-hidden="true"><Palette size={15} /></span>
          <div className="set-head__text">
            <span className="rk-eyebrow">{t('settings.tab.themes')}</span>
            <h2 className="rk-panel__title">{t('settings.themes.groupAria')}</h2>
          </div>
        </div>

        <p className="set-hint">{t('settings.themes.hint')}</p>

        <div
          className="set-theme-grid"
          role="radiogroup"
          aria-label={t('settings.themes.groupAria')}
        >
          {THEME_NAMES.map((name) => {
            const swatch = THEME_SWATCHES[name];
            const selected = name === activeTheme;
            const label = t(`theme.${name}`);
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                className="set-theme"
                onClick={() => setTheme(name)}
              >
                <span
                  className="set-theme__tile"
                  style={{ background: swatch.bg }}
                  aria-hidden="true"
                >
                  <span className="set-theme__accents">
                    <i style={{ background: swatch.ac }} />
                    <i style={{ background: swatch.acB }} />
                  </span>
                  <span
                    className="set-theme__panel"
                    style={{ background: swatch.s1, borderColor: swatch.s3 }}
                  >
                    <span className="set-theme__line" style={{ background: swatch.t1, width: '58%' }} />
                    <span className="set-theme__line" style={{ background: swatch.t3, width: '84%' }} />
                  </span>
                </span>
                <span className="set-theme__label">
                  <span>{label}</span>
                  {selected ? (
                    <span className="set-theme__check">
                      <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default ThemesTab;
