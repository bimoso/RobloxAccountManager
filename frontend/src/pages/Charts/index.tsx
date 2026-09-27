// pages/Charts/index.tsx
//
// Live Roblox discovery board, rebuilt on the RACKLINE primitives: the page
// frame is `.rk-page`, the stat strip is `.rk-stats`, the filters live in
// `.rk-toolbar`, and the ranking itself is a `.rk-table` of 32px rows sharing
// one `--cols` declaration with its sticky header.
//
// The API/cache behaviour remains deliberately page-local; this component only
// changes how the same three chart feeds and the existing local name search are
// presented.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
import { Button } from '@/components/Button';
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
type LiveTone = 'ok' | 'accent' | 'danger';

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

/** How many hairline placeholder rows the loading state draws. */
const SKELETON_ROWS = 9;

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
  const liveTone: LiveTone = isLoading ? 'accent' : isError ? 'danger' : 'ok';
  const liveLabel = isLoading
    ? t('charts.syncing')
    : isError
      ? t('charts.offline')
      : t('charts.live');
  const filtersActive = trimmedQuery.length > 0 || reachFilter !== 'all';

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
    <section className="rk-page charts-page" aria-labelledby="charts-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="charts-title">{t('charts.title')}</h1>
          <span className="rk-page__sub">{t('charts.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <span className="rk-chip" data-tone={liveTone} aria-live="polite">
            <span
              className={isLoading ? 'rk-dot' : 'rk-dot rk-dot--live'}
              data-tone={liveTone}
              aria-hidden="true"
            />
            {liveLabel}
          </span>
        </div>
      </header>

      <div className="rk-stats" aria-label={t('charts.summaryAria')}>
        <div className="rk-stat">
          <span className="rk-stat__label">
            <BarChart3 size={11} aria-hidden="true" /> {t('charts.indexed')}
          </span>
          <span className="rk-stat__value">
            <strong className="u-num">{isLoading ? '—' : sourceGames.length}</strong>
            <small>{t('charts.experiences')}</small>
          </span>
        </div>
        <div className="rk-stat">
          <span className="rk-stat__label">
            <Users size={11} aria-hidden="true" /> {t('charts.concurrentReach')}
          </span>
          <span className="rk-stat__value">
            <strong className="u-num">{isLoading ? '—' : formatPlayers(totalConcurrent)}</strong>
            <small>{t('charts.players')}</small>
          </span>
        </div>
        <div className="rk-stat charts-stat--leader">
          <span className="rk-stat__label">
            <Trophy size={11} aria-hidden="true" /> {t('charts.currentLeader')}
          </span>
          <span className="rk-stat__value">
            <strong title={sourceGames[0]?.name || undefined}>
              {isLoading ? t('charts.readingSignal') : sourceGames[0]?.name || t('charts.noSignal')}
            </strong>
            <TrendingUp size={13} className="charts-stat__trend" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="rk-toolbar charts-toolbar">
        <div
          className="rk-seg charts-tabs"
          role="tablist"
          aria-label={t('charts.tablistAria')}
        >
          {CHART_TABS.map((tab, index) => {
            const presentation = TAB_PRESENTATION[tab.id];
            const TabIcon = presentation.icon;
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[index] = node; }}
                id={`charts-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="charts-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => handleTabChange(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <TabIcon size={13} aria-hidden="true" />
                <span>{t(`charts.tab.${tab.id}`)}</span>
              </button>
            );
          })}
        </div>
        <div className="charts-note">
          <Radio size={12} aria-hidden="true" />
          <span>{t(`charts.tabDesc.${activeTab}`)}</span>
        </div>
      </div>

      <div className="rk-toolbar charts-toolbar">
        <div className="rk-search charts-search" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={t('charts.searchAria')}
            placeholder={t('charts.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <AnimatePresence initial={false}>
            {query.length > 0 ? (
              <motion.button
                className="charts-search__clear"
                type="button"
                aria-label={t('charts.clearSearch')}
                onClick={() => setQuery('')}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.08 }}
              >
                <X size={13} />
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>

        <span className="charts-count u-num" aria-live="polite">
          {visibleGames.length}/{sourceGames.length}
        </span>

        <div className="rk-seg charts-reach" aria-label={t('charts.reachAria')}>
          <span className="charts-reach__label">
            <Filter size={12} aria-hidden="true" /> {t('charts.reach')}
          </span>
          {REACH_FILTERS.map((filter) => (
            <button
              type="button"
              key={filter.id}
              aria-pressed={filter.id === reachFilter}
              onClick={() => setReachFilter(filter.id)}
            >
              {reachFilterLabel(filter.id, t)}
            </button>
          ))}
        </div>
      </div>

      <div
        className="rk-page__body"
        id="charts-panel"
        role="tabpanel"
        aria-labelledby={`charts-tab-${activeTab}`}
      >
        {isLoading ? (
          <ChartsSkeleton />
        ) : isError ? (
          <ChartMessage
            tone="error"
            icon={RefreshCw}
            eyebrow={t('charts.errorEyebrow')}
            title={t('charts.errorTitle')}
            copy={t('charts.errorCopy')}
            action={t('charts.retry')}
            onAction={() => void loadTab(activeTab)}
          />
        ) : visibleGames.length === 0 ? (
          <ChartMessage
            tone="quiet"
            icon={filtersActive ? Search : Gamepad2}
            eyebrow={filtersActive ? t('charts.noMatchEyebrow') : t('charts.standbyEyebrow')}
            title={filtersActive ? t('charts.noMatchTitle') : t('charts.standbyTitle')}
            copy={filtersActive ? t('charts.noMatchCopy') : t('charts.standbyCopy')}
            action={filtersActive ? t('charts.clearFilters') : t('charts.refresh')}
            onAction={filtersActive ? clearFilters : () => void loadTab(activeTab)}
          />
        ) : (
          <div className="charts-table rk-table">
            <div className="charts-stream-head rk-section">
              <span>{t('charts.rankingStream')}</span>
              <strong>
                {filtersActive ? t('charts.filteredDiscovery') : t('charts.liveLeaderboard')}
              </strong>
              <span className="rk-toolbar__spacer" />
              <small className="u-num">
                {t('charts.visibleCount', { count: visibleGames.length })}
              </small>
            </div>

            <div className="rk-table__head" aria-hidden="true">
              <span />
              <span className="charts-col--rank">#</span>
              <span />
              <span>{t('charts.experiences')}</span>
              <span className="charts-col--num">{t('charts.active')}</span>
              <span>{t('charts.reach')}</span>
              <span />
            </div>

            {visibleGames.map(({ game, rank }, index) => (
              <ChartRow
                key={`${game.universeId}-${rank}`}
                game={game}
                rank={rank}
                peakPlayers={peakPlayers}
                index={index}
                animateIn={!filtersActive && !reducedMotion}
                favorite={Boolean(game.placeId && favoriteIds.has(String(game.placeId)))}
                onFavorite={() => handleFavorite(game)}
                onOpen={() => handleOpenGame(game)}
                onLaunch={() => handleLaunchGame(game)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface ChartRowProps {
  game: Game;
  rank: number;
  peakPlayers: number;
  index: number;
  animateIn: boolean;
  favorite: boolean;
  onFavorite: () => void;
  onOpen: () => void;
  onLaunch: () => void;
}

/**
 * One ranking entry: a 32px `.rk-row` on the table's shared `--cols` grid.
 *
 * The reach meter is drawn with `scaleX` from a left origin rather than an
 * animated `width`, so a re-ranked listing never triggers a layout pass per
 * row.
 */
function ChartRow({
  game,
  rank,
  peakPlayers,
  index,
  animateIn,
  favorite,
  onFavorite,
  onOpen,
  onLaunch,
}: ChartRowProps): JSX.Element {
  const { t } = useTranslation();
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = Boolean(game.thumbUrl) && !thumbFailed;
  const live = typeof game.playerCount === 'number' && game.playerCount > 0;
  const strength =
    typeof game.playerCount === 'number' && peakPlayers > 0
      ? Math.max(0.04, game.playerCount / peakPlayers)
      : 0.04;
  const style = { '--chart-strength': String(strength) } as CSSProperties;
  const name = game.name || t('charts.unknownGame');

  return (
    <motion.article
      className="rk-row charts-row"
      aria-label={t('charts.rankAria', { rank, name })}
      data-rank={rank}
      data-live={live || undefined}
      data-place-id={game.placeId ?? undefined}
      style={style}
      initial={animateIn ? { opacity: 0, y: 3 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: animateIn ? 0.15 : 0,
        delay: animateIn ? Math.min(index, 6) * 0.04 : 0,
        ease: 'easeOut',
      }}
    >
      <span className="rk-row__gutter">
        <span className="rk-row__tick" />
      </span>

      <span
        className="rk-table__cell--num charts-col--rank u-num"
        title={t('charts.chartPosition', { rank })}
      >
        {String(rank).padStart(2, '0')}
      </span>

      <span className="charts-row__thumb">
        {showThumb ? (
          <img
            src={game.thumbUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <Gamepad2 size={13} aria-hidden="true" />
        )}
      </span>

      <span className="charts-row__name">
        <span className="rk-row__title" title={name}>{name}</span>
        {rank === 1 ? (
          <span className="rk-chip rk-chip--sm" data-tone="accent">
            <Trophy size={10} aria-hidden="true" /> {t('charts.networkLeader')}
          </span>
        ) : null}
      </span>

      <span className="rk-table__cell--num charts-col--num u-num">
        {formatPlayers(game.playerCount)}
      </span>

      <span className="charts-row__meter" aria-hidden="true">
        <span />
      </span>

      <span
        className="rk-row__actions"
        aria-label={t('charts.actionsAria', { name: game.name || t('charts.gameFallback') })}
      >
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className={favorite ? 'charts-fav-on' : undefined}
          disabled={!game.placeId}
          aria-label={favorite ? t('charts.removeFavorite') : t('charts.saveFavorite')}
          title={favorite ? t('charts.removeFavorite') : t('charts.saveToLauncher')}
          onClick={onFavorite}
        >
          <Star size={14} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!game.placeId}
          aria-label={t('charts.open')}
          title={t('charts.openPage')}
          onClick={onOpen}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="charts-launch"
          disabled={!game.placeId}
          title={t('charts.chooseLaunch')}
          onClick={onLaunch}
        >
          <Rocket size={13} aria-hidden="true" />
          <span>{t('charts.launch')}</span>
        </Button>
      </span>
    </motion.article>
  );
}

/**
 * Loading state: hairline placeholder rows on the ranking's own `--cols` grid,
 * so the listing arrives into the shape it was already occupying instead of
 * replacing a floating spinner.
 */
function ChartsSkeleton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="charts-table charts-skeleton rk-table"
      role="status"
      aria-label={t('charts.loadingAria')}
    >
      <span className="sr-only">{t('charts.loading')}</span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="rk-row charts-row" key={index} aria-hidden="true">
          <span className="rk-row__gutter">
            <span className="rk-row__tick" />
          </span>
          <span className="charts-skeleton__bar charts-skeleton__bar--rank" />
          <span className="charts-skeleton__bar charts-skeleton__bar--thumb" />
          <span className="charts-skeleton__bar charts-skeleton__bar--name" />
          <span className="charts-skeleton__bar charts-skeleton__bar--num" />
          <span className="charts-row__meter" />
          <span />
        </div>
      ))}
    </div>
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
}

/** Empty / failure state, built on the shared `.rk-empty` recipe. */
function ChartMessage({
  tone,
  icon: Icon,
  eyebrow,
  title,
  copy,
  action,
  onAction,
}: ChartMessageProps): JSX.Element {
  return (
    <div
      className="rk-empty charts-empty"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="rk-empty__icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="rk-eyebrow">{eyebrow}</span>
      <h2 className="rk-empty__title">{title}</h2>
      <p className="rk-empty__text">{copy}</p>
      <Button variant="secondary" onClick={onAction}>
        <RefreshCw size={13} aria-hidden="true" /> {action}
      </Button>
    </div>
  );
}
