import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PageRouter } from './index';
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
 * active page from the store, swaps to the destination page on navigation, and
 * never leaves more than the destination page mounted once a transition
 * settles (Requirement 4.6). Direction and duration are delegated to the pure,
 * separately-tested `navDirection` / `motionDuration` helpers.
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

  it('keeps only the destination page after several rapid navigations settle', async () => {
    render(<PageRouter pages={stubPages} />);
    act(() => {
      useNavigationStore.getState().navigate('charts');
      useNavigationStore.getState().navigate('settings');
      useNavigationStore.getState().navigate('credits');
    });
    // Let any in-flight exit animations resolve.
    act(() => {
      // no-op flush; RTL wraps effects, this settles pending state updates
    });
    expect(screen.getByTestId('page-credits')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('page-accounts')).not.toBeInTheDocument();
      expect(screen.queryByTestId('page-charts')).not.toBeInTheDocument();
      expect(screen.queryByTestId('page-settings')).not.toBeInTheDocument();
    });
  });
});
