import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './index';
import {
  DEFAULT_PAGE,
  NAV_PAGES,
  pageOrdinal,
  useNavigationStore,
} from '../../stores/navigationStore';

/**
 * Behavioural tests for the Sidebar (task 29.2): it renders every nav item,
 * highlights the active page, routes clicks through `navigate`, and only
 * renders the Anti-AFK seam when its props are supplied.
 */

afterEach(() => {
  useNavigationStore.setState({
    activePage: DEFAULT_PAGE,
    activeIndex: pageOrdinal(DEFAULT_PAGE),
  });
});

describe('Sidebar', () => {
  it('renders one nav button per page, in order', () => {
    render(<Sidebar />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(
      NAV_PAGES.map((p) => `${p.icon}${p.label}`),
    );
  });

  it('marks the active page with aria-current="page"', () => {
    useNavigationStore.getState().navigate('charts');
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: /charts/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('button', { name: /accounts/i }),
    ).not.toHaveAttribute('aria-current');
  });

  it('navigates on click', async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(screen.getByRole('button', { name: /settings/i }));
    expect(useNavigationStore.getState().activePage).toBe('settings');
    expect(useNavigationStore.getState().activeIndex).toBe(
      pageOrdinal('settings'),
    );
  });

  it('does not render the Anti-AFK seam without its props', () => {
    render(<Sidebar />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('renders and wires the Anti-AFK seam when props are provided', async () => {
    const user = userEvent.setup();
    const onAntiAfkChange = vi.fn();
    render(
      <Sidebar antiAfkEnabled={false} onAntiAfkChange={onAntiAfkChange} />,
    );
    const toggle = screen.getByRole('switch', { name: /anti-afk/i });
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(onAntiAfkChange).toHaveBeenCalledWith(true);
  });
});
