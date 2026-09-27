import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PageRouter } from './index';
import { usePageActive } from './pageActivity';
import {
  DEFAULT_PAGE,
  NAV_PAGES,
  pageOrdinal,
  useNavigationStore,
  type PageId,
} from '../../stores/navigationStore';

/**
 * Behavioural tests for the PageRouter (task 29.3). framer-motion animations
 * are time/DOM based and not meaningfully observable in jsdom, so these tests
 * focus on what the router guarantees regardless of animation: it renders the
 * active page from the store, swaps to the destination page on navigation,
 * keeps every page it has shown mounted but parked (inert, hidden, inactive) so
 * a round trip restores exactly what the user left, and never shows more than
 * the destination page once a transition settles (Requirement 4.6). Direction
 * and duration are delegated to the pure, separately-tested `navDirection` /
 * `motionDuration` helpers.
 *
 * The lightweight `pages` seam is used so the router can be exercised without
 * mounting the real (store/IPC-backed) page components.
 */

/** A distinct, easily-queried stub for every navigation page. */
const stubPages: Record<PageId, JSX.Element> = NAV_PAGES.reduce(
  (acc, page) => {
    acc[page.id] = <div data-testid={`page-${page.id}`}>{page.label} body</div>;
    return acc;
  },
  {} as Record<PageId, JSX.Element>,
);

afterEach(() => {
  useNavigationStore.setState({
    activePage: DEFAULT_PAGE,
    activeIndex: pageOrdinal(DEFAULT_PAGE),
  });
});

describe('PageRouter', () => {
  it('renders the active page from the navigation store', () => {
    render(<PageRouter pages={stubPages} />);
    expect(screen.getByTestId(`page-${DEFAULT_PAGE}`)).toBeInTheDocument();
  });

  it('renders the destination page and makes the outgoing layer inert', async () => {
    render(<PageRouter pages={stubPages} />);
    const outgoing = screen.getByTestId('page-accounts').closest('[role="main"]');
    act(() => {
      useNavigationStore.getState().navigate('settings');
    });
    expect(screen.getByTestId('page-settings')).toBeInTheDocument();
    await waitFor(() => {
      expect(outgoing).toHaveAttribute('aria-hidden', 'true');
      expect(outgoing).toHaveAttribute('inert');
    });
  });

  it('renders the destination page after navigating backward', () => {
    act(() => {
      useNavigationStore.getState().navigate('logs');
    });
    render(<PageRouter pages={stubPages} />);
    act(() => {
      useNavigationStore.getState().navigate('accounts');
    });
    expect(screen.getByTestId('page-accounts')).toBeInTheDocument();
  });

  it('shows only the destination page after several rapid navigations settle', async () => {
    render(<PageRouter pages={stubPages} />);
    // Each hop renders (a page never rendered is never mounted at all), but
    // none of them is given time to finish its transition.
    for (const id of ['charts', 'settings', 'credits'] as const) {
      act(() => {
        useNavigationStore.getState().navigate(id);
      });
    }
    expect(screen.getByTestId('page-credits')).toBeInTheDocument();
    expect(screen.getByTestId('page-credits').closest('[role="main"]')).not.toHaveAttribute('aria-hidden');
    // Visited pages stay mounted (keep-alive) but are parked out of the way.
    for (const id of ['accounts', 'charts', 'settings']) {
      const layer = screen.getByTestId(`page-${id}`).closest('[role="main"]');
      expect(layer).toHaveAttribute('aria-hidden', 'true');
    }
    await waitFor(() => {
      expect(screen.getByTestId('page-accounts')).not.toBeVisible();
      expect(screen.getByTestId('page-charts')).not.toBeVisible();
      expect(screen.getByTestId('page-settings')).not.toBeVisible();
    });
    expect(screen.getByTestId('page-credits')).toBeVisible();
    // Never-visited pages are never mounted.
    expect(screen.queryByTestId('page-logs')).not.toBeInTheDocument();
  });

  it('restores a page exactly as the user left it after a round trip', async () => {
    const user = userEvent.setup();
    const mounts = vi.fn();
    function Counter(): JSX.Element {
      const [count, setCount] = useState(0);
      const active = usePageActive();
      useState(() => {
        mounts();
        return null;
      });
      return (
        <button type="button" data-active={active} onClick={() => setCount((n) => n + 1)}>
          clicks:{count}
        </button>
      );
    }
    render(<PageRouter pages={{ ...stubPages, accounts: <Counter /> }} />);

    await user.click(screen.getByRole('button', { name: 'clicks:0' }));
    expect(screen.getByRole('button', { name: 'clicks:1' })).toHaveAttribute('data-active', 'true');

    act(() => {
      useNavigationStore.getState().navigate('charts');
    });
    expect(screen.getByTestId('page-charts')).toBeInTheDocument();
    // Parked: still mounted, told it is inactive, hidden from assistive tech.
    const parked = screen.getByRole('button', { name: 'clicks:1', hidden: true });
    expect(parked).toHaveAttribute('data-active', 'false');

    act(() => {
      useNavigationStore.getState().navigate('accounts');
    });
    const restored = screen.getByRole('button', { name: 'clicks:1' });
    expect(restored).toHaveAttribute('data-active', 'true');
    await waitFor(() => expect(restored).toBeVisible());
    expect(mounts).toHaveBeenCalledTimes(1);
  });
});
