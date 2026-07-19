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
import { createKeyedSessionCache } from '@/lib/sessionCache';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Translator } from '@/i18n';
import './Charts.css';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
type ReachFilter = 'all' | 'established' | 'massive';

interface TabPresentation {
  icon: LucideIcon;
  code: string;
}

interface RankedGame {
  game: Game;
  rank: number;
}

const TAB_PRESENTATION: Record<ChartSortId, TabPresentation> = {
  'top-playing-now': {
    icon: Activity,
    code: 'LIVE',
  },
  'top-rated': {
    icon: Star,
    code: 'SCORE',
  },
  'top-earning': {
    icon: CircleDollarSign,
    code: 'VALUE',
  },
};

const REACH_FILTERS: ReadonlyArray<{
  id: ReachFilter;
  minimum: number;
}> = [
  { id: 'all', minimum: 0 },
  { id: 'established', minimum: 10_000 },
  { id: 'massive', minimum: 100_000 },
];

/** Visible label for a reach filter ('All reach' is the only translated one). */
function reachFilterLabel(id: ReachFilter, t: Translator): string {
  if (id === 'all') return t('charts.reachAll');
  return id === 'established' ? '10K+' : '100K+';
}

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const EMPTY_GAMES: Game[] = [];

/**
 * Per-tab games cache that survives page unmounts, so re-entering Charts (or
 * returning to a tab) paints the last listing instantly instead of showing the
 * skeleton and re-hitting the Roblox APIs on every visit.
 */
const gamesCache = createKeyedSessionCache<ChartSortId, Game[]>();

/**
 * How long a cached tab listing is served without revalidating. Within this
 * window re-entering the page costs zero network calls; past it the cached
 * listing still paints instantly and a silent background reload refreshes the
 * ranking (the skeleton only ever shows when there is no cached data at all).
 */
const GAMES_CACHE_TTL_MS = 5 * 60_000;

/** Builds the initial per-tab games state from whatever the cache holds. */
function cachedGamesByTab(): Partial<Record<ChartSortId, Game[]>> {
  const cached: Partial<Record<ChartSortId, Game[]>> = {};
  for (const tab of CHART_TABS) {
    const games = gamesCache.get(tab.id);
    if (games) cached[tab.id] = games;
  }
  return cached;
}

function formatPlayers(value: number | null): string {
  return typeof value === 'number' ? compactNumber.format(value) : '—';
}

/** Ranked Roblox discovery surface backed by the existing Charts API. */
export default function ChartsPage(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ChartSortId>(CHART_TABS[0].id);
  const [query, setQuery] = useState('');
  const [reachFilter, setReachFilter] = useState<ReachFilter>('all');
  const [searchFocused, setSearchFocused] = useState(false);
  const [gamesByTab, setGamesByTab] = useState<
    Partial<Record<ChartSortId, Game[]>>
  >(cachedGamesByTab);
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
      gamesCache.set(tab, games);
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
      // Cached listing already on screen: revalidate silently once it has
      // gone stale. The load-status flags only drive UI when there is no
      // data for the tab, so this refresh never surfaces a skeleton.
      if (!gamesCache.isFresh(activeTab, GAMES_CACHE_TTL_MS)) {
        void loadTab(activeTab);
      }
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
    ? t('charts.syncing')
    : isError
      ? t('charts.offline')
      : t('charts.live');
  const filtersActive = trimmedQuery.length > 0 || reachFilter !== 'all';
  const showPodium = !filtersActive && visibleGames.length > 0;
  const podiumGames = showPodium ? visibleGames.slice(0, 3) : [];
  const streamGames = showPodium ? visibleGames.slice(3) : visibleGames;

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
    showSuccess(wasFavorite ? t('charts.favRemoved') : t('charts.favSaved'));
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
          <span className="charts-eyebrow">{t('charts.eyebrow')}</span>
          <h1 id="charts-title">{t('charts.title')}</h1>
          <p>{t('charts.subtitle')}</p>
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

      <div className="charts-vitals" aria-label={t('charts.summaryAria')}>
        <div className="charts-vital">
          <span className="charts-vital__icon"><BarChart3 size={16} /></span>
          <span className="charts-vital__copy">
            <small>{t('charts.indexed')}</small>
            <strong>{isLoading ? '—' : sourceGames.length}</strong>
          </span>
          <span className="charts-vital__unit">{t('charts.experiences')}</span>
        </div>
        <div className="charts-vital">
          <span className="charts-vital__icon"><Users size={16} /></span>
          <span className="charts-vital__copy">
            <small>{t('charts.concurrentReach')}</small>
            <strong>{isLoading ? '—' : formatPlayers(totalConcurrent)}</strong>
          </span>
          <span className="charts-vital__unit">{t('charts.players')}</span>
        </div>
        <div className="charts-vital charts-vital--leader">
          <span className="charts-vital__icon"><Trophy size={16} /></span>
          <span className="charts-vital__copy">
            <small>{t('charts.currentLeader')}</small>
            <strong title={sourceGames[0]?.name || undefined}>
              {isLoading ? t('charts.readingSignal') : sourceGames[0]?.name || t('charts.noSignal')}
            </strong>
          </span>
          <TrendingUp size={15} className="charts-vital__trend" />
        </div>
      </div>

      <div className="charts-command">
        <div className="charts-command__ranking">
          <LayoutGroup id="charts-ranking-tabs">
            <div className="charts-tab-bar" role="tablist" aria-label={t('charts.tablistAria')}>
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
                    <span>{t(`charts.tab.${tab.id}`)}</span>
                    <small>{presentation.code}</small>
                  </motion.button>
                );
              })}
            </div>
          </LayoutGroup>
          <div className="charts-mode-note">
            <Radio size={13} aria-hidden="true" />
            <span>{t(`charts.tabDesc.${activeTab}`)}</span>
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
              aria-label={t('charts.searchAria')}
              placeholder={t('charts.searchPlaceholder')}
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
                  aria-label={t('charts.clearSearch')}
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

          <div className="charts-reach" aria-label={t('charts.reachAria')}>
            <span className="charts-reach__label">
              <Filter size={14} aria-hidden="true" /> {t('charts.reach')}
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
                {reachFilterLabel(filter.id, t)}
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
              eyebrow={t('charts.errorEyebrow')}
              title={t('charts.errorTitle')}
              copy={t('charts.errorCopy')}
              action={t('charts.retry')}
              onAction={() => void loadTab(activeTab)}
              reducedMotion={reducedMotion}
            />
          ) : visibleGames.length === 0 ? (
            <ChartMessage
              key={`empty-${activeTab}-${filtersActive ? 'filtered' : 'feed'}`}
              tone="quiet"
              icon={filtersActive ? Search : Gamepad2}
              eyebrow={filtersActive ? t('charts.noMatchEyebrow') : t('charts.standbyEyebrow')}
              title={
                filtersActive
                  ? t('charts.noMatchTitle')
                  : t('charts.standbyTitle')
              }
              copy={
                filtersActive
                  ? t('charts.noMatchCopy')
                  : t('charts.standbyCopy')
              }
              action={filtersActive ? t('charts.clearFilters') : t('charts.refresh')}
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
                  <span>{t('charts.rankingStream')}</span>
                  <strong>
                    {filtersActive ? t('charts.filteredDiscovery') : t('charts.liveLeaderboard')}
                  </strong>
                </div>
                <span className="charts-stream-head__rule" aria-hidden="true" />
                <small>{t('charts.visibleCount', { count: visibleGames.length })}</small>
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
  const { t } = useTranslation();
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
      aria-label={t('charts.rankAria', { rank, name: game.name || t('charts.unknownGame') })}
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
            <Trophy size={12} aria-hidden="true" /> {t('charts.networkLeader')}
          </span>
        ) : null}
      </div>

      <div className="chart-card__body">
        <div className="chart-card__heading">
          <span>{variant === 'row' ? t('charts.chartPosition', { rank }) : t('charts.discoverySignal')}</span>
          <h2 title={game.name || t('charts.unknownGame')}>{game.name || t('charts.unknownGame')}</h2>
        </div>
        <div className="chart-card__reach">
          <Users size={14} aria-hidden="true" />
          <strong>{formatPlayers(game.playerCount)}</strong>
          <span>{t('charts.active')}</span>
        </div>
        <div className="chart-card__meter" aria-hidden="true">
          <span />
        </div>
        <div className="chart-card__actions" aria-label={t('charts.actionsAria', { name: game.name || t('charts.gameFallback') })}>
          <button
            type="button"
            data-active={favorite || undefined}
            disabled={!game.placeId}
            aria-label={favorite ? t('charts.removeFavorite') : t('charts.saveFavorite')}
            title={favorite ? t('charts.removeFavorite') : t('charts.saveToLauncher')}
            onClick={onFavorite}
          >
            <Star size={13} fill={favorite ? 'currentColor' : 'none'} />
            <span>{favorite ? t('charts.saved') : t('charts.save')}</span>
          </button>
          <button
            type="button"
            disabled={!game.placeId}
            title={t('charts.openPage')}
            onClick={onOpen}
          >
            <ExternalLink size={13} /><span>{t('charts.open')}</span>
          </button>
          <button
            type="button"
            className="chart-card__launch"
            disabled={!game.placeId}
            title={t('charts.chooseLaunch')}
            onClick={onLaunch}
          >
            <Rocket size={13} /><span>{t('charts.launch')}</span>
          </button>
        </div>
      </div>
    </motion.article>
  );
}

function ChartsSkeleton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <motion.div
      className="charts-skeleton"
      role="status"
      aria-label={t('charts.loadingAria')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <span className="sr-only">{t('charts.loading')}</span>
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
