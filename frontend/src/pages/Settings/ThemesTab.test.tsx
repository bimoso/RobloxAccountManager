import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemesTab } from './ThemesTab';
import { DEFAULT_THEME, THEME_NAMES, useThemeStore } from '../../stores/themeStore';

/**
 * Behavioural tests for the Themes tab (task 25.6, Requirement 3.2): it lists
 * the 12 selectable themes, marks the active one, and routes a selection
 * through `themeStore`'s `setTheme` so the palette applies and persists.
 */

afterEach(() => {
  // Reset the shared theme store and DOM between tests. (The test environment's
  // localStorage is read/write only, so persisted values are left as-is; every
  // test sets the store state it needs explicitly.)
  useThemeStore.setState({ theme: DEFAULT_THEME });
  document.body.className = '';
});

describe('ThemesTab', () => {
  it('renders one selectable option per valid theme', () => {
    render(<ThemesTab />);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(THEME_NAMES.length);
    expect(THEME_NAMES).toHaveLength(12);
  });

  it('marks the active theme as checked', () => {
    useThemeStore.setState({ theme: 'ocean' });
    render(<ThemesTab />);
    expect(screen.getByRole('radio', { name: /ocean/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('selecting a theme calls setTheme and applies the body class', async () => {
    const user = userEvent.setup();
    render(<ThemesTab />);

    await user.click(screen.getByRole('radio', { name: /sunset/i }));

    // setTheme updates the shared store and swaps the body class synchronously
    // (well within the 300ms budget of Requirement 3.2). Persistence itself is
    // the store's responsibility and is covered by the store-level tests.
    expect(useThemeStore.getState().theme).toBe('sunset');
    expect(document.body.classList.contains('theme-sunset')).toBe(true);
  });

  it('switching to light applies the light body class', async () => {
    const user = userEvent.setup();
    render(<ThemesTab />);

    await user.click(screen.getByRole('radio', { name: /^light$/i }));

    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.body.classList.contains('light')).toBe(true);
  });
});
