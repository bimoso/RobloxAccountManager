// pages/Settings/ThemesTab.tsx
//
// Themes tab of the Settings page (Requirement 3.2). Lists the 12 selectable
// themes — dark, light, midnight, aurora, sunset, crimson, ocean, grape,
// forest, amber, rose, graphite — each with a small palette preview.
//
// Selecting a theme calls the shared `themeStore`'s `setTheme`, which swaps the
// `<body>` class synchronously (well within the 300ms budget of Requirement
// 3.2) and persists the choice. This component owns no theme logic of its own:
// the source of truth for the valid theme list is `THEME_NAMES` and the applied
// theme is `useThemeStore`'s `theme`. It imports nothing from other pages
// (Requirement 1.1).

import { useThemeStore, THEME_NAMES } from '@/stores/themeStore';
import type { ThemeName } from '@/types/models';
import './Settings.css';

/**
 * Preview metadata for a theme: a human-readable label plus three
 * representative palette colors (background, surface, accent) used to draw the
 * swatch. The colors mirror the final computed palette of each theme in
 * `styles/theme.css`; they are cosmetic only — the authoritative palette is
 * still applied by the `<body>` class when the theme is selected.
 */
interface ThemePreview {
  /** The theme name — the value passed to `setTheme`. */
  readonly name: ThemeName;
  /** Human-readable label shown under the swatch. */
  readonly label: string;
  /** Page background color of the theme. */
  readonly bg: string;
  /** Surface/card color of the theme. */
  readonly surface: string;
  /** Accent color of the theme. */
  readonly accent: string;
}

/**
 * Preview swatches for the 12 themes, keyed by theme name. Colors are taken
 * from the final (liquid-glass) layer of `styles/theme.css` so each swatch
 * resembles what the theme actually renders.
 */
const THEME_PREVIEWS: Readonly<Record<ThemeName, ThemePreview>> = {
  dark: { name: 'dark', label: 'Dark', bg: '#090a0c', surface: '#171a20', accent: '#31d0aa' },
  light: { name: 'light', label: 'Light', bg: '#f3f5f8', surface: '#edf0f5', accent: '#007aff' },
  midnight: { name: 'midnight', label: 'Midnight', bg: '#08090e', surface: '#171b22', accent: '#6ee7f9' },
  aurora: { name: 'aurora', label: 'Aurora', bg: '#06100d', surface: '#14211c', accent: '#35e0a1' },
  sunset: { name: 'sunset', label: 'Sunset', bg: '#120b0d', surface: '#251a1b', accent: '#ff8f70' },
  crimson: { name: 'crimson', label: 'Crimson', bg: '#11090d', surface: '#24171d', accent: '#ff5f7e' },
  ocean: { name: 'ocean', label: 'Ocean', bg: '#071012', surface: '#142126', accent: '#49d6ff' },
  grape: { name: 'grape', label: 'Grape', bg: '#100b16', surface: '#21192a', accent: '#c084fc' },
  forest: { name: 'forest', label: 'Forest', bg: '#07100b', surface: '#17221b', accent: '#7ee787' },
  amber: { name: 'amber', label: 'Amber', bg: '#11100a', surface: '#232116', accent: '#f6c65b' },
  rose: { name: 'rose', label: 'Rose', bg: '#120b10', surface: '#261a22', accent: '#ff7aa8' },
  graphite: { name: 'graphite', label: 'Graphite', bg: '#090a0c', surface: '#181b21', accent: '#d7dde6' },
};

/**
 * The Themes tab body. Renders one selectable card per theme; the active theme
 * is marked and selecting a card applies it through `setTheme` (Requirement
 * 3.2).
 */
export function ThemesTab(): JSX.Element {
  const activeTheme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="settings-themes">
      <p className="settings-hint">
        Choose a color theme. Your selection applies instantly across the whole
        app and is remembered next time.
      </p>
      <div
        className="settings-theme-grid"
        role="radiogroup"
        aria-label="Application theme"
      >
        {THEME_NAMES.map((name) => {
          const preview = THEME_PREVIEWS[name];
          const selected = name === activeTheme;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preview.label}
              className={`settings-theme-card${selected ? ' selected' : ''}`}
              onClick={() => setTheme(name)}
            >
              <span
                className="settings-theme-swatch"
                style={{ background: preview.bg }}
                aria-hidden="true"
              >
                <span
                  className="settings-theme-swatch-surface"
                  style={{ background: preview.surface }}
                />
                <span
                  className="settings-theme-swatch-accent"
                  style={{ background: preview.accent }}
                />
              </span>
              <span className="settings-theme-label">{preview.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ThemesTab;
