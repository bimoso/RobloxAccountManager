import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartsPage from './index';
import { fetchChartGames } from './chartsApi';
import type { Game } from './types';

// The Charts page owns the impure load through `fetchChartGames`; mock that
// boundary so we can drive a failure-then-success sequence without touching the
// Roblox APIs or the Tauri bridge.
vi.mock('./chartsApi', () => ({
  fetchChartGames: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchChartGames);

/** A minimal, deterministic listing returned on the successful (retry) load. */
const GAMES: Game[] = [
  {
    universeId: 111,
    placeId: 222,
    name: 'Retry Success Game',
    playerCount: 1234,
    thumbUrl: '',
  },
];

const DISCOVERY_GAMES: Game[] = [
  {
    universeId: 1,
    placeId: 11,
    name: 'Signal Peak',
    playerCount: 210_000,
    thumbUrl: '',
  },
  {
    universeId: 2,
    placeId: 22,
    name: 'Orbit Arena',
    playerCount: 58_000,
    thumbUrl: '',
  },
  {
    universeId: 3,
    placeId: 33,
    name: 'Quiet Quest',
    playerCount: 1_200,
    thumbUrl: '',
  },
  {
    universeId: 4,
    placeId: 44,
    name: 'Null Sector',
    playerCount: null,
    thumbUrl: '',
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Requirement 18.4: a chart load failure surfaces an error state whose "Retry"
 * action re-invokes the load. Here the first load rejects, so the error state
 * with a "Retry" button must appear; clicking it must call `fetchChartGames`
 * again and, on the second (resolving) call, render the loaded games.
 */
describe('ChartsPage load-failure retry (Requirement 18.4)', () => {
  it('shows a Retry action on load failure and re-invokes the load when clicked', async () => {
    // First load rejects (failure), second resolves with a listing (retry).
    mockedFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(GAMES);

    const user = userEvent.setup();
    render(<ChartsPage />);

    // The initial load failed -> the error state's "Retry" button appears.
    const retryButton = await screen.findByRole('button', { name: /retry/i });
    expect(retryButton).toBeInTheDocument();
    expect(screen.getByText('Signal offline')).toBeInTheDocument();
    // Only the initial (failed) load has happened so far.
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Clicking "Retry" must re-invoke the load for the active tab.
    await user.click(retryButton);

    // The load was invoked a second time (proves retry re-invokes the load)...
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    // ...and the resolved games render, so the error state has cleared.
    expect(
      await screen.findByRole('article', { name: /rank 1: retry success game/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });
  });
});

describe('ChartsPage discovery controls', () => {
  it('renders a ranked leader board and useful reach telemetry', async () => {
    mockedFetch.mockResolvedValueOnce(DISCOVERY_GAMES);
    render(<ChartsPage />);

    expect(
      await screen.findByRole('article', { name: /rank 1: signal peak/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /rank 4: null sector/i })).toBeInTheDocument();
    expect(screen.getByText('269.2K')).toBeInTheDocument();
    expect(screen.getByText('Live leaderboard')).toBeInTheDocument();
  });

  it('searches locally, reports the result count, and restores the chart on clear', async () => {
    mockedFetch.mockResolvedValueOnce(DISCOVERY_GAMES);
    const user = userEvent.setup();
    render(<ChartsPage />);

    await screen.findByRole('article', { name: /rank 1: signal peak/i });
    const search = screen.getByRole('searchbox', { name: /search games/i });
    await user.type(search, 'quiet');

    expect(
      await screen.findByRole('article', { name: /rank 3: quiet quest/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: /signal peak/i })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /clear search/i }));
    expect(
      await screen.findByRole('article', { name: /rank 1: signal peak/i }),
    ).toBeInTheDocument();
    expect(search).toHaveValue('');
  });

  it('filters by player reach and resets local controls when the ranking changes', async () => {
    mockedFetch.mockResolvedValue(DISCOVERY_GAMES);
    const user = userEvent.setup();
    render(<ChartsPage />);

    await screen.findByRole('article', { name: /rank 1: signal peak/i });
    await user.click(screen.getByRole('button', { name: '100K+' }));
    expect(screen.getByRole('article', { name: /rank 1: signal peak/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: /orbit arena/i })).not.toBeInTheDocument();
    });

    await user.type(screen.getByRole('searchbox', { name: /search games/i }), 'signal');
    await user.click(screen.getByRole('tab', { name: /top rated/i }));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('top-rated');
    });
    expect(screen.getByRole('searchbox', { name: /search games/i })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All reach' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('uses roving keyboard focus and labels the shared tab panel', async () => {
    mockedFetch.mockResolvedValue(DISCOVERY_GAMES);
    const user = userEvent.setup();
    render(<ChartsPage />);

    await screen.findByRole('article', { name: /rank 1: signal peak/i });
    const playing = screen.getByRole('tab', { name: /top playing now/i });
    const rated = screen.getByRole('tab', { name: /top rated/i });
    playing.focus();
    await user.keyboard('{ArrowRight}');

    expect(rated).toHaveFocus();
    expect(rated).toHaveAttribute('aria-selected', 'true');
    expect(rated).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', rated.id);
  });
});
