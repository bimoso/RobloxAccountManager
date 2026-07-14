// pages/Charts/index.tsx
//
// Live Roblox discovery board. The API/cache behaviour remains deliberately
// page-local; this component only adds a clearer operational hierarchy around
// the same three chart feeds and the existing local name search.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from 'framer-motion';
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Filter,
  ExternalLink,
  Gamepad2,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  Star,
  TrendingUp,
  Trophy,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { fetchChartGames } from './chartsApi';
import { searchGames } from './searchGames';
import { CHART_TABS, type ChartSortId, type Game } from './types';
import { ipc } from '@/lib/ipc';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
import { useToastStore } from '@/stores/toastStore';
import './Charts.css';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
type ReachFilter = 'all' | 'established' | 'massive';

interface TabPresentation {
  icon: LucideIcon;
  code: string;
  description: string;
}

interface RankedGame {
  game: Game;
  rank: number;
}

const TAB_PRESENTATION: Record<ChartSortId, TabPresentation> = {
  'top-playing-now': {
    icon: Activity,
    code: 'LIVE',
    description: 'Ordered by concurrent player activity',
  },
  'top-rated': {
    icon: Star,
    code: 'SCORE',
    description: 'Community-rated discovery signal',
  },
  'top-earning': {
    icon: CircleDollarSign,
    code: 'VALUE',
    description: 'Commercial momentum across Roblox',
  },
};

const REACH_FILTERS: ReadonlyArray<{
  id: ReachFilter;
  label: string;
  minimum: number;
}> = [
  { id: 'all', label: 'All reach', minimum: 0 },
  { id: 'established', label: '10K+', minimum: 10_000 },
  { id: 'massive', label: '100K+', minimum: 100_000 },
];

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const EMPTY_GAMES: Game[] = [];

function formatPlayers(value: number | null): string {
  return typeof value === 'number' ? compactNumber.format(value) : '—';
}

/** Ranked Roblox discovery surface backed by the existing Charts API. */
export default function ChartsPage(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const [activeTab, setActiveTab] = useState<ChartSortId>(CHART_TABS[0].id);
  const [query, setQuery] = useState('');
  const [reachFilter, setReachFilter] = useState<ReachFilter>('all');
  const [searchFocused, setSearchFocused] = useState(false);
  const [gamesByTab, setGamesByTab] = useState<
    Partial<Record<ChartSortId, Game[]>>
  >({});
  const [status, setStatus] = useState<LoadStatus>('idle');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const placeLibrary = usePlaceLibraryStore((state) => state.entries);
  const toggleFavorite = usePlaceLibraryStore((state) => state.toggleFavorite);
  const openLaunch = useLaunchIntentStore((state) => state.open);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const favoriteIds = useMemo(
    () => new Set(placeLibrary.filter((entry) => entry.favorite).map((entry) => entry.placeId)),
    [placeLibrary],
  );

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const loadTab = useCallback(async (tab: ChartSortId) => {
    setStatus('loading');
    try {
      const games = await fetchChartGames(tab);
      setGamesByTab((previous) => ({ ...previous, [tab]: games }));
      if (activeTabRef.current === tab) setStatus('loaded');
    } catch {
      if (activeTabRef.current === tab) setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (gamesByTab[activeTab] === undefined) {
      void loadTab(activeTab);
    } else {
      setStatus('loaded');
    }
  }, [activeTab, gamesByTab, loadTab]);

  const activeGames = gamesByTab[activeTab];
  const sourceGames = activeGames ?? EMPTY_GAMES;
  const trimmedQuery = query.trim();
  const selectedReach = REACH_FILTERS.find(
    (filter) => filter.id === reachFilter,
  ) ?? REACH_FILTERS[0];

  const visibleGames = useMemo<RankedGame[]>(() => {
    const matches = searchGames(sourceGames, query);
    return matches
      .map((game) => ({ game, rank: sourceGames.indexOf(game) + 1 }))
      .filter(
        ({ game }) =>
          selectedReach.minimum === 0 ||
          (typeof game.playerCount === 'number' &&
            game.playerCount >= selectedReach.minimum),
      );
  }, [query, selectedReach.minimum, sourceGames]);

  const totalConcurrent = useMemo(
    () =>
      sourceGames.reduce(
        (total, game) => total + (game.playerCount ?? 0),
        0,
      ),
    [sourceGames],
  );
  const peakPlayers = useMemo(
    () =>
      sourceGames.reduce(
        (peak, game) => Math.max(peak, game.playerCount ?? 0),
        0,
      ),
    [sourceGames],
  );

  // Treat an uncached tab as loading immediately. Waiting for the effect to
  // flip `status` would paint the empty state for one frame between tabs.
  const isLoading = activeGames === undefined && status !== 'error';
  const isError = activeGames === undefined && status === 'error';
  const liveState = isLoading ? 'syncing' : isError ? 'error' : 'live';
  const liveLabel = isLoading
    ? 'Syncing chart'
    : isError
      ? 'Signal offline'
      : 'Live discovery';
  const filtersActive = trimmedQuery.length > 0 || reachFilter !== 'all';
  const showPodium = !filtersActive && visibleGames.length > 0;
  const podiumGames = showPodium ? visibleGames.slice(0, 3) : [];
  const streamGames = showPodium ? visibleGames.slice(3) : visibleGames;
  const activePresentation = TAB_PRESENTATION[activeTab];

  const handleTabChange = (tab: ChartSortId): void => {
    if (tab === activeTab) return;
    setQuery('');
    setReachFilter('all');
    setStatus(gamesByTab[tab] === undefined ? 'loading' : 'loaded');
    setActiveTab(tab);
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % CHART_TABS.length;
    if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + CHART_TABS.length) % CHART_TABS.length;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = CHART_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    handleTabChange(CHART_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  const clearFilters = (): void => {
    setQuery('');
    setReachFilter('all');
  };

  const placeSeed = (game: Game) => ({
    placeId: game.placeId == null ? '' : String(game.placeId),
    name: game.name,
    iconUrl: game.thumbUrl || undefined,
  });

  const handleFavorite = (game: Game): void => {
    if (!game.placeId) return;
    const wasFavorite = favoriteIds.has(String(game.placeId));
    toggleFavorite(placeSeed(game));
    showSuccess(wasFavorite ? 'Experience removed from favorites.' : 'Experience saved to launcher favorites.');
  };

  const handleOpenGame = (game: Game): void => {
    if (!game.placeId) return;
    void ipc.openExternal(`https://www.roblox.com/games/${game.placeId}`);
  };

  const handleLaunchGame = (game: Game): void => {
    if (!game.placeId) return;
    openLaunch({ accountIds: [], seed: placeSeed(game) });
  };

  return (
    <section className="charts-page" aria-labelledby="charts-title">
      <motion.header
        className="charts-header"
        initial={{ opacity: 0, y: reducedMotion ? 0 : -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.28, ease: 'easeOut' }}
      >
        <div className="charts-heading">
          <span className="charts-eyebrow">Discovery / Roblox network</span>
          <h1 id="charts-title">Charts</h1>
          <p>Track the experiences pulling attention across the platform.</p>
        </div>
        <div
          className="charts-live"
          data-state={liveState}
          aria-live="polite"
        >
          <span className="charts-live__signal" aria-hidden="true" />
          {liveLabel}
        </div>
      </motion.header>

      <div className="charts-vitals" aria-label="Active chart summary">
        <div className="charts-vital">
          <span className="charts-vital__icon"><BarChart3 size={16} /></span>
          <span className="charts-vital__copy">
            <small>Indexed</small>
            <strong>{isLoading ? '—' : sourceGames.length}</strong>
          </span>
          <span className="charts-vital__unit">experiences</span>
        </div>
        <div className="charts-vital">
          <span className="charts-vital__icon"><Users size={16} /></span>
          <span className="charts-vital__copy">
            <small>Concurrent reach</small>
            <strong>{isLoading ? '—' : formatPlayers(totalConcurrent)}</strong>
          </span>
          <span className="charts-vital__unit">players</span>
        </div>
        <div className="charts-vital charts-vital--leader">
          <span className="charts-vital__icon"><Trophy size={16} /></span>
          <span className="charts-vital__copy">
            <small>Current leader</small>
            <strong title={sourceGames[0]?.name || undefined}>
              {isLoading ? 'Reading signal' : sourceGames[0]?.name || 'No signal'}
            </strong>
          </span>
          <TrendingUp size={15} className="charts-vital__trend" />
        </div>
      </div>

      <div className="charts-command">
        <div className="charts-command__ranking">
          <LayoutGroup id="charts-ranking-tabs">
            <div className="charts-tab-bar" role="tablist" aria-label="Game charts">
              {CHART_TABS.map((tab, index) => {
                const presentation = TAB_PRESENTATION[tab.id];
                const TabIcon = presentation.icon;
                const active = tab.id === activeTab;
                return (
                  <motion.button
                    key={tab.id}
                    ref={(node) => { tabRefs.current[index] = node; }}
                    id={`charts-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="charts-panel"
                    tabIndex={active ? 0 : -1}
                    className={`charts-tab-btn${active ? ' active' : ''}`}
                    onClick={() => handleTabChange(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    whileTap={reducedMotion ? undefined : { scale: 0.985 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 34 }}
                  >
                    {active ? (
                      <motion.span
                        className="charts-tab-btn__glide"
                        layoutId="charts-active-ranking"
                        transition={
                          reducedMotion
                            ? { duration: 0 }
                            : { type: 'spring', stiffness: 430, damping: 38 }
                        }
                      />
                    ) : null}
                    <TabIcon size={15} aria-hidden="true" />
                    <span>{tab.label}</span>
                    <small>{presentation.code}</small>
                  </motion.button>
                );
              })}
            </div>
          </LayoutGroup>
          <div className="charts-mode-note">
            <Radio size={13} aria-hidden="true" />
            <span>{activePresentation.description}</span>
          </div>
        </div>

        <div className="charts-toolbar">
          <motion.div
            className="charts-search"
            role="search"
            animate={{ scale: searchFocused && !reducedMotion ? 1.004 : 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 36 }}
          >
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search games"
              placeholder="Search the live ranking"
              value={query}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onChange={(event) => setQuery(event.target.value)}
            />
            <AnimatePresence initial={false}>
              {query.length > 0 ? (
                <motion.button
                  className="charts-search__clear"
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.8 }}
                >
                  <X size={14} />
                </motion.button>
              ) : null}
            </AnimatePresence>
            <span className="charts-search__count" aria-live="polite">
              {visibleGames.length}/{sourceGames.length}
            </span>
          </motion.div>

          <div className="charts-reach" aria-label="Filter by player reach">
            <span className="charts-reach__label">
              <Filter size={14} aria-hidden="true" /> Reach
            </span>
            {REACH_FILTERS.map((filter) => (
              <motion.button
                type="button"
                key={filter.id}
                className={filter.id === reachFilter ? 'active' : undefined}
                aria-pressed={filter.id === reachFilter}
                onClick={() => setReachFilter(filter.id)}
                whileTap={reducedMotion ? undefined : { scale: 0.97 }}
              >
                {filter.label}
              </motion.button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="charts-scroll"
        id="charts-panel"
        role="tabpanel"
        aria-labelledby={`charts-tab-${activeTab}`}
      >
        <AnimatePresence mode="sync" initial={false}>
          {isLoading ? (
            <ChartsSkeleton key={`loading-${activeTab}`} />
          ) : isError ? (
            <ChartMessage
              key={`error-${activeTab}`}
              tone="error"
              icon={RefreshCw}
              eyebrow="Signal interrupted"
              title="The Roblox chart could not be reached."
              copy="Check the connection and retry this ranking feed."
              action="Retry"
              onAction={() => void loadTab(activeTab)}
              reducedMotion={reducedMotion}
            />
          ) : visibleGames.length === 0 ? (
            <ChartMessage
              key={`empty-${activeTab}-${filtersActive ? 'filtered' : 'feed'}`}
              tone="quiet"
              icon={filtersActive ? Search : Gamepad2}
              eyebrow={filtersActive ? 'No matching signal' : 'Chart standing by'}
              title={
                filtersActive
                  ? 'No experiences match this view.'
                  : 'No chart signal is available yet.'
              }
              copy={
                filtersActive
                  ? 'Try a broader name or lower the player-reach threshold.'
                  : 'Refresh the feed to ask Roblox for a new discovery snapshot.'
              }
              action={filtersActive ? 'Clear search and filters' : 'Refresh chart'}
              onAction={filtersActive ? clearFilters : () => void loadTab(activeTab)}
              reducedMotion={reducedMotion}
            />
          ) : (
            <motion.div
              className="charts-board"
              key={`board-${activeTab}`}
              initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
              transition={{ duration: reducedMotion ? 0 : 0.22, ease: 'easeOut' }}
            >
              <div className="charts-stream-head">
                <div>
                  <span>Ranking stream</span>
                  <strong>
                    {filtersActive ? 'Filtered discovery' : 'Live leaderboard'}
                  </strong>
                </div>
                <span className="charts-stream-head__rule" aria-hidden="true" />
                <small>{visibleGames.length} visible</small>
              </div>

              {podiumGames.length > 0 ? (
                <div className="charts-podium" data-count={podiumGames.length}>
                  {podiumGames.map(({ game, rank }, index) => (
                    <ChartGameCard
                      key={`${game.universeId}-${rank}`}
                      game={game}
                      rank={rank}
                      peakPlayers={peakPlayers}
                      variant={rank === 1 ? 'leader' : 'contender'}
                      index={index}
                      reducedMotion={reducedMotion}
                      favorite={Boolean(game.placeId && favoriteIds.has(String(game.placeId)))}
                      onFavorite={() => handleFavorite(game)}
                      onOpen={() => handleOpenGame(game)}
                      onLaunch={() => handleLaunchGame(game)}
                    />
                  ))}
                </div>
              ) : null}

              {streamGames.length > 0 ? (
                <div className="charts-ranking-grid">
                  <AnimatePresence initial={false}>
                    {streamGames.map(({ game, rank }, index) => (
                      <ChartGameCard
                        key={`${game.universeId}-${rank}`}
                        game={game}
                        rank={rank}
                        peakPlayers={peakPlayers}
                        variant="row"
                        index={index}
                        reducedMotion={reducedMotion}
                        favorite={Boolean(game.placeId && favoriteIds.has(String(game.placeId)))}
                        onFavorite={() => handleFavorite(game)}
                        onOpen={() => handleOpenGame(game)}
                        onLaunch={() => handleLaunchGame(game)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

interface ChartGameCardProps {
  game: Game;
  rank: number;
  peakPlayers: number;
  variant: 'leader' | 'contender' | 'row';
  index: number;
  reducedMotion: boolean;
  favorite: boolean;
  onFavorite: () => void;
  onOpen: () => void;
  onLaunch: () => void;
}

function ChartGameCard({
  game,
  rank,
  peakPlayers,
  variant,
  index,
  reducedMotion,
  favorite,
  onFavorite,
  onOpen,
  onLaunch,
}: ChartGameCardProps): JSX.Element {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = Boolean(game.thumbUrl) && !thumbFailed;
  const strength =
    typeof game.playerCount === 'number' && peakPlayers > 0
      ? Math.max(4, (game.playerCount / peakPlayers) * 100)
      : 4;
  const style = {
    '--chart-strength': `${strength}%`,
  } as CSSProperties;

  return (
    <motion.article
      className={`chart-card chart-card--${variant}`}
      aria-label={`Rank ${rank}: ${game.name || 'Unknown game'}`}
      data-rank={rank}
      data-place-id={game.placeId ?? undefined}
      style={style}
      layout={reducedMotion ? false : 'position'}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.985 }}
      transition={{
        duration: reducedMotion ? 0 : 0.22,
        delay: reducedMotion ? 0 : Math.min(index, 8) * 0.025,
        ease: 'easeOut',
      }}
      whileHover={reducedMotion ? undefined : { y: -2 }}
    >
      <div className="chart-card__visual">
        {showThumb ? (
          <img
            src={game.thumbUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="chart-card__placeholder" aria-hidden="true">
            <Gamepad2 size={variant === 'leader' ? 38 : 24} />
          </div>
        )}
        <span className="chart-card__rank">
          <small>#</small>{String(rank).padStart(2, '0')}
        </span>
        {variant === 'leader' ? (
          <span className="chart-card__leader-tag">
            <Trophy size={12} aria-hidden="true" /> Network leader
          </span>
        ) : null}
      </div>

      <div className="chart-card__body">
        <div className="chart-card__heading">
          <span>{variant === 'row' ? `Chart position ${rank}` : 'Discovery signal'}</span>
          <h2 title={game.name || 'Unknown game'}>{game.name || 'Unknown game'}</h2>
        </div>
        <div className="chart-card__reach">
          <Users size={14} aria-hidden="true" />
          <strong>{formatPlayers(game.playerCount)}</strong>
          <span>active</span>
        </div>
        <div className="chart-card__meter" aria-hidden="true">
          <span />
        </div>
        <div className="chart-card__actions" aria-label={`Actions for ${game.name || 'game'}`}>
          <button
            type="button"
            data-active={favorite || undefined}
            disabled={!game.placeId}
            aria-label={favorite ? 'Remove from favorites' : 'Save to favorites'}
            title={favorite ? 'Remove from favorites' : 'Save to launcher'}
            onClick={onFavorite}
          >
            <Star size={13} fill={favorite ? 'currentColor' : 'none'} />
            <span>{favorite ? 'Saved' : 'Save'}</span>
          </button>
          <button
            type="button"
            disabled={!game.placeId}
            title="Open Roblox experience page"
            onClick={onOpen}
          >
            <ExternalLink size={13} /><span>Open</span>
          </button>
          <button
            type="button"
            className="chart-card__launch"
            disabled={!game.placeId}
            title="Choose accounts and launch"
            onClick={onLaunch}
          >
            <Rocket size={13} /><span>Launch</span>
          </button>
        </div>
      </div>
    </motion.article>
  );
}

function ChartsSkeleton(): JSX.Element {
  return (
    <motion.div
      className="charts-skeleton"
      role="status"
      aria-label="Loading games"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <span className="sr-only">Loading games…</span>
      <div className="charts-skeleton__head" aria-hidden="true">
        <span /><span />
      </div>
      <div className="charts-skeleton__podium" aria-hidden="true">
        <span /><span /><span />
      </div>
      <div className="charts-skeleton__rows" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
      </div>
    </motion.div>
  );
}

interface ChartMessageProps {
  tone: 'error' | 'quiet';
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  copy: string;
  action: string;
  onAction: () => void;
  reducedMotion: boolean;
}

function ChartMessage({
  tone,
  icon: Icon,
  eyebrow,
  title,
  copy,
  action,
  onAction,
  reducedMotion,
}: ChartMessageProps): JSX.Element {
  return (
    <motion.div
      className="charts-message"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.22 }}
    >
      <div className="charts-message__glyph" aria-hidden="true">
        <Icon size={25} />
        <span />
      </div>
      <span className="charts-message__eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <motion.button
        type="button"
        onClick={onAction}
        whileTap={reducedMotion ? undefined : { scale: 0.975 }}
      >
        <RefreshCw size={14} aria-hidden="true" /> {action}
      </motion.button>
    </motion.div>
  );
}
