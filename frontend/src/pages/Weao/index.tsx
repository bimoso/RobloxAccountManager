// pages/Weao/index.tsx
//
// WEAO hub: what Roblox is shipping right now, how the clients on this machine
// compare, and which executors survived the last update. Data flow follows the
// Charts page exactly — impure fetching in `weaoApi`, pure logic in
// `clientStatus`/`filterExecutors`, a session cache that paints instantly on
// re-entry and revalidates silently behind it.
//
// RACKLINE: the page is the mandatory `.rk-page` frame — head / toolbar / one
// scroll port. Published client versions are a `.rk-stats` strip, the client
// verdict is a flat `.rk-panel`, and the executor catalogue is a `.rk-table`
// with a sticky header. Every status is a `.rk-chip[data-tone]` carrying a text
// code, never a bare colour.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Apple,
  Blocks,
  Boxes,
  Bug,
  CircleCheck,
  CircleHelp,
  Clock,
  Download,
  FlaskConical,
  Gauge,
  Globe,
  Layers,
  MessageCircle,
  Monitor,
  Puzzle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  TabletSmartphone,
  Terminal,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Dropdown } from '@/components/Dropdown';
import { EmptyState } from '@/components/EmptyState';
import { Switch } from '@/components/Switch';
import { ipc } from '@/lib/ipc';
import { loadClientsSnapshot, peekClientsSnapshot } from '@/lib/clientsSnapshotCache';
import { createSessionCache } from '@/lib/sessionCache';
import { useTranslation } from '@/i18n/useTranslation';
import type { Translator } from '@/i18n';
import type { RobloxInstallation } from '@/types/models';
import {
  aggregateVerdict,
  clientVerdict,
  collectInstalledGuids,
  executorTargetsInstalled,
  type ClientVerdict,
} from './clientStatus';
import { visibleExecutors } from './filterExecutors';
import { fetchWeaoExecutors, fetchWeaoVersions } from './weaoApi';
import {
  DEFAULT_EXECUTOR_FILTERS,
  WEAO_PLATFORMS,
  type CostFilter,
  type Executor,
  type ExecutorFilters,
  type ExecutorStatusFilter,
  type PlatformVersion,
  type WeaoPlatform,
  type WeaoVersions,
} from './types';
import './Weao.css';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** The five tones `.rk-chip` / `.rk-dot` understand. Tone is data, not a class. */
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

/** Everything one WEAO load produces, kept together so the cache is atomic. */
interface WeaoSnapshot {
  versions: WeaoVersions;
  executors: Executor[];
  /** Oldest of the two backend stamps — the chip must not over-promise. */
  fetchedAt: number;
  fromCache: boolean;
  staleReason: string | null;
}

/**
 * Survives page unmounts so re-entering WEAO paints the last catalogue instead
 * of the skeleton. `createSessionCache` (rather than a loose `Map`) is required:
 * the test setup wipes every registered cache between tests.
 */
const weaoCache = createSessionCache<WeaoSnapshot>();

/**
 * How long a cached load is served without revalidating. The backend already
 * caps upstream traffic (4 h for versions, 30 min for executors); this shorter
 * window only decides when the page asks it again.
 */
const WEAO_CACHE_TTL_MS = 10 * 60_000;

/** Icon shown per platform tile in the versions strip. */
const PLATFORM_ICONS: Record<WeaoPlatform, LucideIcon> = {
  windows: Monitor,
  mac: Apple,
  android: Smartphone,
  ios: TabletSmartphone,
};

/** Icon shown next to the aggregate client verdict. */
const VERDICT_ICONS: Record<ClientVerdict, LucideIcon> = {
  'up-to-date': ShieldCheck,
  outdated: ShieldAlert,
  'update-incoming': Clock,
  unknown: CircleHelp,
};

/**
 * One meaning per colour (spec §8): a client that matches the live build is
 * `ok`, one that is behind is `danger`, an announced forced update is `warn`,
 * and "we cannot tell" is neutral — never accent, which only ever means
 * selection.
 */
const VERDICT_TONES: Record<ClientVerdict, Tone> = {
  'up-to-date': 'ok',
  outdated: 'danger',
  'update-incoming': 'warn',
  unknown: 'neutral',
};

/** Freshness state → chip tone. `cached`/`syncing` are informational, not risk. */
const FRESHNESS_TONES: Record<Freshness['state'], Tone> = {
  live: 'ok',
  cached: 'neutral',
  syncing: 'neutral',
  stale: 'warn',
  error: 'danger',
};

/** WEAO hub: Roblox version tracking, client verdicts and executor status. */
export default function WeaoPage(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const { t, language } = useTranslation();
  const cached = weaoCache.get();
  const [snapshot, setSnapshot] = useState<WeaoSnapshot | undefined>(cached);
  const [status, setStatus] = useState<LoadStatus>(cached ? 'loaded' : 'idle');
  // Seeded from whatever sweep the Clients deck (or the idle warm-up) already
  // paid for, so the verdict panel paints with the rest of the board instead of
  // popping in a beat later.
  const [installations, setInstallations] = useState<RobloxInstallation[]>(
    () => peekClientsSnapshot()?.installations ?? [],
  );
  const [filters, setFilters] = useState<ExecutorFilters>(DEFAULT_EXECUTOR_FILTERS);
  const [supportedOnly, setSupportedOnly] = useState(false);
  // Captured before the first render can write back, so a revisit inside the
  // TTL costs zero IPC while a stale one still revalidates exactly once.
  const revalidateOnMount = useRef(!weaoCache.isFresh(WEAO_CACHE_TTL_MS));

  const load = useCallback(async (force: boolean): Promise<void> => {
    setStatus('loading');
    try {
      const [versions, executors] = await Promise.all([
        fetchWeaoVersions(force),
        fetchWeaoExecutors(force),
      ]);
      const next: WeaoSnapshot = {
        versions: versions.data,
        executors: executors.data,
        fetchedAt: Math.min(versions.fetchedAt, executors.fetchedAt),
        fromCache: versions.fromCache || executors.fromCache,
        staleReason: versions.staleReason ?? executors.staleReason,
      };
      weaoCache.set(next);
      setSnapshot(next);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!revalidateOnMount.current) return;
    revalidateOnMount.current = false;
    void load(false);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void loadClientsSnapshot()
      .then((clients) => {
        if (!cancelled) setInstallations(clients.installations);
      })
      // A failed client scan only costs the verdict panel; the catalogue below
      // is independent and must still render.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const executors = snapshot?.executors;
  // This launcher is Windows-only — `platform::ensure_windows` gates every
  // launch — so a Mac/Android/iOS executor could never be used from here.
  // Dropping them at the source keeps the list, the result count and the
  // banwave tally consistent with each other.
  const sourceExecutors = useMemo(
    () => (executors ?? []).filter((executor) => executor.platform === 'windows'),
    [executors],
  );
  const installedGuids = useMemo(
    () => collectInstalledGuids(installations),
    [installations],
  );
  const currentWindows = snapshot?.versions.current.windows?.version ?? null;
  const futureWindows = snapshot?.versions.future.windows?.version ?? null;
  const verdict = useMemo(
    () => aggregateVerdict(installations, currentWindows, futureWindows),
    [currentWindows, futureWindows, installations],
  );
  const banwaveCount = useMemo(
    () => sourceExecutors.filter((executor) => executor.possibleBanwave).length,
    [sourceExecutors],
  );

  const shownExecutors = useMemo(() => {
    const ordered = visibleExecutors(sourceExecutors, filters);
    if (!supportedOnly) return ordered;
    return ordered.filter((executor) =>
      executorTargetsInstalled(executor, installedGuids),
    );
  }, [filters, installedGuids, sourceExecutors, supportedOnly]);

  // An uncached page is loading from the first frame; waiting for the effect to
  // flip `status` would paint the empty state for one frame.
  const isLoading = executors === undefined && status !== 'error';
  const isError = executors === undefined && status === 'error';
  const filtersActive =
    filters.query.trim().length > 0 ||
    filters.cost !== 'all' ||
    filters.status !== 'all' ||
    supportedOnly;

  const relative = useMemo(
    () => new Intl.RelativeTimeFormat(language, { numeric: 'auto' }),
    [language],
  );
  const freshness = describeFreshness({ snapshot, status, relative, t });

  const costOptions = useMemo(
    () => [
      { value: 'all' as CostFilter, label: t('weao.filter.allCosts') },
      { value: 'free' as CostFilter, label: t('weao.cost.free') },
      { value: 'paid' as CostFilter, label: t('weao.cost.paid') },
    ],
    [t],
  );
  const statusOptions = useMemo(
    () => [
      { value: 'all' as ExecutorStatusFilter, label: t('weao.filter.allStatuses') },
      { value: 'updated' as ExecutorStatusFilter, label: t('weao.status.updated') },
      { value: 'outdated' as ExecutorStatusFilter, label: t('weao.status.outdated') },
      { value: 'undetected' as ExecutorStatusFilter, label: t('weao.status.undetected') },
      { value: 'flagged' as ExecutorStatusFilter, label: t('weao.status.flagged') },
    ],
    [t],
  );

  const clearFilters = (): void => {
    setFilters(DEFAULT_EXECUTOR_FILTERS);
    setSupportedOnly(false);
  };

  const VerdictIcon = VERDICT_ICONS[verdict];

  return (
    <section className="rk-page weao-page" aria-labelledby="weao-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="weao-title">{t('weao.title')}</h1>
          <span className="rk-page__sub">{t('weao.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <span
            className="rk-chip weao-fresh"
            data-tone={FRESHNESS_TONES[freshness.state]}
            aria-live="polite"
          >
            <span
              className={
                freshness.state === 'syncing' ? 'rk-dot rk-dot--live' : 'rk-dot'
              }
              data-tone={FRESHNESS_TONES[freshness.state]}
              aria-hidden="true"
            />
            {freshness.label}
          </span>
          <Button
            variant="secondary"
            disabled={status === 'loading'}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} aria-hidden="true" /> {t('weao.refresh')}
          </Button>
        </div>
      </header>

      <div className="rk-toolbar weao-toolbar">
        <div className="rk-search weao-search" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={t('weao.search.aria')}
            placeholder={t('weao.search.placeholder')}
            value={filters.query}
            onChange={(event) =>
              setFilters((previous) => ({ ...previous, query: event.target.value }))
            }
          />
          {filters.query.length > 0 ? (
            <button
              type="button"
              className="weao-search__clear"
              aria-label={t('weao.search.clear')}
              onClick={() => setFilters((previous) => ({ ...previous, query: '' }))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <span className="weao-count u-num" aria-live="polite">
          {shownExecutors.length}/{sourceExecutors.length}
        </span>
        <Dropdown
          options={costOptions}
          value={filters.cost}
          aria-label={t('weao.filter.cost')}
          onChange={(cost) => setFilters((previous) => ({ ...previous, cost }))}
        />
        <Dropdown
          options={statusOptions}
          value={filters.status}
          aria-label={t('weao.filter.status')}
          onChange={(next) => setFilters((previous) => ({ ...previous, status: next }))}
        />
        <span className="rk-toolbar__spacer" />
        <label
          className="weao-supported"
          htmlFor="weao-supported-only"
          title={t('weao.supported.hint')}
        >
          <Switch
            id="weao-supported-only"
            checked={supportedOnly}
            // Without a local guid there is nothing to match against, so
            // the toggle would silently empty the table.
            disabled={installedGuids.length === 0}
            aria-label={t('weao.supported.label')}
            onChange={setSupportedOnly}
          />
          <span>
            <strong>{t('weao.supported.label')}</strong>
            <small>{t('weao.supported.hint')}</small>
          </span>
        </label>
      </div>

      <div className="rk-page__body">
        <AnimatePresence mode="sync" initial={false}>
          {isLoading ? (
            <div key="loading" className="rk-empty" role="status">
              <span className="rk-spin" aria-hidden="true" />
              <p className="rk-empty__text">{t('weao.loading')}</p>
            </div>
          ) : isError ? (
            <motion.div
              key="error"
              className="rk-empty"
              role="alert"
              initial={{ opacity: 0, y: reducedMotion ? 0 : 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15 }}
            >
              <div className="rk-empty__icon weao-empty__icon" aria-hidden="true">
                <TriangleAlert size={20} />
              </div>
              <h2 className="rk-empty__title">{t('weao.error.title')}</h2>
              <p className="rk-empty__text">{t('weao.error.body')}</p>
              <Button onClick={() => void load(true)}>
                <RefreshCw size={14} aria-hidden="true" /> {t('weao.error.retry')}
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="board"
              initial={{ opacity: 0, y: reducedMotion ? 0 : 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }}
            >
              <div className="rk-section weao-section">{t('weao.versions.title')}</div>
              <div className="rk-stats weao-stats">
                {WEAO_PLATFORMS.map((platform) => (
                  <PlatformStat
                    key={platform}
                    platform={platform}
                    current={snapshot?.versions.current[platform]}
                    future={snapshot?.versions.future[platform]}
                  />
                ))}
              </div>

              <div className="weao-brief">
                <section className="rk-panel weao-verdict" data-verdict={verdict}>
                  <div className="rk-panel__head">
                    <VerdictIcon size={15} aria-hidden="true" />
                    <h2 className="rk-panel__title">{t('weao.clients.title')}</h2>
                    <span className="weao-verdict__spacer" />
                    <span className="rk-chip" data-tone={VERDICT_TONES[verdict]}>
                      {t(`weao.verdict.${verdict}`)}
                    </span>
                  </div>
                  <div className="rk-panel__body weao-verdict__body">
                    <p className="weao-verdict__hint">{t(`weao.clients.hint.${verdict}`)}</p>
                    {banwaveCount > 0 ? (
                      <p className="weao-banwave" role="status">
                        <span className="rk-chip" data-tone="danger">
                          <TriangleAlert size={11} aria-hidden="true" />
                          {t('weao.banwave.title')}
                        </span>
                        <span>{t('weao.banwave.body', { count: banwaveCount })}</span>
                      </p>
                    ) : null}
                  </div>
                  <ul className="weao-clients">
                    {installations.length === 0 ? (
                      <li className="weao-clients__none">{t('weao.clients.empty')}</li>
                    ) : (
                      installations.slice(0, 6).map((installation) => (
                        <ClientRow
                          key={installation.id}
                          installation={installation}
                          currentWindows={currentWindows}
                          futureWindows={futureWindows}
                        />
                      ))
                    )}
                  </ul>
                </section>
              </div>

              {shownExecutors.length === 0 ? (
                <EmptyState
                  icon={<Boxes size={20} />}
                  message={filtersActive ? t('weao.empty.filtered') : t('weao.empty.body')}
                  actionLabel={filtersActive ? t('weao.empty.clear') : undefined}
                  onAction={filtersActive ? clearFilters : undefined}
                />
              ) : (
                <div className="rk-table weao-table">
                  <div className="rk-table__head">
                    <span />
                    <span>{t('packages.modal.name')}</span>
                    <span>{t('titlebar.clientStatus')}</span>
                    <span>{t('clients.versionGuid')}</span>
                    <span>{t('weao.platform.windows')}</span>
                    <span>{t('weao.card.price')}</span>
                  </div>
                  {shownExecutors.map((executor, index) => (
                    <ExecutorRow
                      key={executor.trackerId}
                      executor={executor}
                      index={index}
                      reducedMotion={reducedMotion}
                      installed={executorTargetsInstalled(executor, installedGuids)}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

/** Everything the header chip needs to decide what it says. */
interface FreshnessInput {
  snapshot: WeaoSnapshot | undefined;
  status: LoadStatus;
  relative: Intl.RelativeTimeFormat;
  t: Translator;
}

/** The chip's visual state plus its resolved label. */
interface Freshness {
  state: 'live' | 'cached' | 'stale' | 'syncing' | 'error';
  label: string;
}

/**
 * Describes how trustworthy the data on screen is. `stale` and `cached` are
 * distinct on purpose: the backend serves its cached copy rather than failing
 * whenever it has one, so "shown from cache" and "shown because the refresh
 * failed" must not read the same.
 */
function describeFreshness({ snapshot, status, relative, t }: FreshnessInput): Freshness {
  if (snapshot === undefined) {
    return status === 'error'
      ? { state: 'error', label: t('weao.offline') }
      : { state: 'syncing', label: t('weao.syncing') };
  }
  if (status === 'loading') return { state: 'syncing', label: t('weao.syncing') };
  const ago = formatAge(snapshot.fetchedAt, relative);
  // A refresh that failed on top of usable data is the stale case, not the
  // offline one: the board is still readable, it just stopped being current.
  if (status === 'error' || snapshot.staleReason !== null) {
    return { state: 'stale', label: t('weao.stale', { ago }) };
  }
  if (snapshot.fromCache) return { state: 'cached', label: t('weao.cached', { ago }) };
  return { state: 'live', label: t('weao.updated', { ago }) };
}

/**
 * Renders a relative age ("2 minutes ago") from an epoch stamp, stepping up
 * through seconds/minutes/hours so a four-hour-old versions cache still reads
 * naturally.
 */
function formatAge(fetchedAt: number, relative: Intl.RelativeTimeFormat): string {
  const seconds = Math.round((fetchedAt - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  return relative.format(Math.round(minutes / 60), 'hour');
}

/** Props for {@link PlatformStat}. */
interface PlatformStatProps {
  platform: WeaoPlatform;
  current: PlatformVersion | undefined;
  future: PlatformVersion | undefined;
}

/**
 * One cell of the published-versions strip: the live build for a platform, its
 * freshness chip, and the announced next build when WEAO has one.
 *
 * The version string is mono + tabular (`u-num`) because a Windows deployment
 * guid is an opaque hash the eye has to diff character by character, and a
 * proportional face makes that impossible.
 */
function PlatformStat({ platform, current, future }: PlatformStatProps): JSX.Element {
  const { t, language } = useTranslation();
  const Icon = PLATFORM_ICONS[platform];
  // A published next build is the thing that breaks executors, so it outranks
  // "there is a live build" for the tone of this cell.
  const tone: Tone = future ? 'warn' : current ? 'ok' : 'neutral';
  const chipLabel = future
    ? t('weao.versions.future')
    : current
      ? t('weao.versions.current')
      : t('weao.versions.none');
  // WEAO stamps builds with a full ISO timestamp; a short date is what fits the
  // tile and what people actually compare. Unparseable stamps pass through.
  const updated = current?.updatedAt ? new Date(current.updatedAt) : null;
  const updatedLabel =
    updated && !Number.isNaN(updated.getTime())
      ? new Intl.DateTimeFormat(language === 'es' ? 'es-MX' : 'en-US', {
          day: 'numeric',
          month: 'short',
        }).format(updated)
      : current?.updatedAt;
  return (
    <div className="rk-stat weao-stat">
      <span className="rk-stat__label weao-stat__label">
        <Icon size={13} aria-hidden="true" />
        {t(`weao.platform.${platform}`)}
      </span>
      <span className="rk-stat__value weao-stat__version u-num" title={current?.version}>
        {current?.version ?? t('weao.versions.none')}
      </span>
      <span className="weao-stat__foot">
        <span className="rk-chip rk-chip--sm" data-tone={tone}>
          {chipLabel}
        </span>
        {future ? (
          <code className="weao-stat__next u-num" title={future.version}>
            {future.version}
          </code>
        ) : current?.updatedAt ? (
          <time className="weao-stat__time u-num" dateTime={current.updatedAt} title={current.updatedAt}>
            {updatedLabel}
          </time>
        ) : null}
      </span>
    </div>
  );
}

/** Props for {@link ClientRow}. */
interface ClientRowProps {
  installation: RobloxInstallation;
  currentWindows: string | null;
  futureWindows: string | null;
}

/** One detected Roblox install, judged against the published Windows builds. */
function ClientRow({
  installation,
  currentWindows,
  futureWindows,
}: ClientRowProps): JSX.Element {
  const { t } = useTranslation();
  const rowVerdict = clientVerdict(installation, currentWindows, futureWindows);
  const tone = VERDICT_TONES[rowVerdict];
  return (
    <li className="rk-row weao-client" data-tone={tone}>
      <span className="rk-row__gutter">
        <span className="rk-row__tick" aria-hidden="true" />
      </span>
      <span className="rk-row__main">
        <span className="rk-row__title" title={installation.displayName}>
          {installation.displayName}
        </span>
        <span className="rk-row__meta u-num" title={installation.versionGuid ?? undefined}>
          {installation.versionGuid ?? t('weao.clients.versionUnknown')}
        </span>
      </span>
      <span className="rk-chip rk-chip--sm" data-tone={tone}>
        {t(`weao.verdict.${rowVerdict}`)}
      </span>
    </li>
  );
}

/** Props for {@link ExecutorRow}. */
interface ExecutorRowProps {
  executor: Executor;
  index: number;
  reducedMotion: boolean;
  installed: boolean;
}

/**
 * One catalogue entry, as two lines of the rack: the aligned column line
 * (identity, status, version, platform, price) and a wrapping detail line that
 * carries risk, capabilities, target build and outbound links.
 */
function ExecutorRow({
  executor,
  index,
  reducedMotion,
  installed,
}: ExecutorRowProps): JSX.Element {
  const { t } = useTranslation();
  // Risk outranks freshness: an executor that is current but in an active
  // banwave is not a green row.
  const tone: Tone = executor.possibleBanwave
    ? 'danger'
    : executor.detected
      ? 'warn'
      : executor.updateStatus
        ? 'ok'
        : 'warn';
  const price = executor.free
    ? t('weao.card.free')
    : (executor.cost ?? t('weao.card.priceUnknown'));
  return (
    <motion.div
      className="weao-exec"
      data-rail-row
      data-tone={tone}
      data-detected={executor.detected ? 'true' : undefined}
      data-banwave={executor.possibleBanwave ? 'true' : undefined}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reducedMotion ? 0 : 0.15,
        delay: reducedMotion ? 0 : Math.min(index, 6) * 0.04,
        ease: 'easeOut',
      }}
    >
      <div className="rk-row weao-exec__main">
        <span className="rk-row__gutter">
          <span className="rk-row__tick" aria-hidden="true" />
        </span>
        <span className="weao-exec__id">
          <ExecutorLogo executor={executor} />
          <span className="rk-row__main">
            <h2 className="rk-row__title" title={executor.title}>
              {executor.title}
            </h2>
            <span className="rk-row__meta">{t(`weao.extype.${executor.extype}`)}</span>
          </span>
        </span>
        <span className="rk-chip rk-chip--sm" data-tone={executor.updateStatus ? 'ok' : 'warn'}>
          {executor.updateStatus ? t('weao.status.updated') : t('weao.status.outdated')}
        </span>
        <span className="rk-table__cell rk-table__cell--num u-num" title={executor.version}>
          {executor.version}
        </span>
        <span className="rk-table__cell" title={executor.platformLabel}>
          {executor.platformLabel}
        </span>
        <span className="rk-table__cell weao-exec__price" title={price}>
          {price}
        </span>
      </div>

      <div className="weao-exec__detail">
        {executor.possibleBanwave || executor.detected ? (
          <span className="weao-exec__risk">
            <span
              className="rk-chip rk-chip--sm"
              data-tone={executor.possibleBanwave ? 'danger' : 'warn'}
            >
              <TriangleAlert size={11} aria-hidden="true" />
              {executor.possibleBanwave ? t('weao.card.banwave') : t('weao.card.detected')}
            </span>
            {executor.detectionReason ? <span>{executor.detectionReason}</span> : null}
          </span>
        ) : null}

        {executor.multiInject ? (
          <Trait icon={Layers} label={t('weao.card.multiInject')} tone="accent" />
        ) : null}
        {executor.decompiler ? <Trait icon={Terminal} label={t('weao.card.decompiler')} /> : null}
        {executor.raknet ? <Trait icon={Zap} label={t('weao.card.raknet')} /> : null}
        {executor.clientmods ? <Trait icon={Blocks} label={t('weao.card.clientmods')} /> : null}
        {executor.uncPercentage !== null ? (
          <Trait icon={Gauge} label={t('weao.card.unc', { percent: executor.uncPercentage })} />
        ) : executor.uncStatus ? (
          <Trait icon={Gauge} label={t('weao.card.uncOk')} />
        ) : null}
        {executor.suncPercentage !== null ? (
          <Trait icon={Gauge} label={t('weao.card.sunc', { percent: executor.suncPercentage })} />
        ) : null}
        {executor.beta ? <Trait icon={FlaskConical} label={t('weao.card.beta')} /> : null}
        {executor.hasIssues ? <Trait icon={Bug} label={t('weao.card.issues')} /> : null}

        <span className="weao-fact">
          <Download size={11} aria-hidden="true" />
          <b>{t('weao.card.targets')}</b>
          <code className="u-num" title={executor.rbxversion ?? undefined}>
            {executor.rbxversion ?? t('weao.card.targetsUnknown')}
          </code>
        </span>
        {installed ? (
          <span className="rk-chip rk-chip--sm" data-tone="ok">
            <CircleCheck size={11} aria-hidden="true" />
            {t('weao.card.installed')}
          </span>
        ) : null}
        {executor.updatedDate ? (
          <span className="weao-fact">
            <Clock size={11} aria-hidden="true" />
            <b>{t('weao.card.updatedOn')}</b>
            <time className="u-num">{executor.updatedDate}</time>
          </span>
        ) : null}

        <span className="weao-exec__links">
          <LinkButton url={executor.websitelink} icon={Globe} label={t('weao.card.website')} />
          <LinkButton
            url={executor.discordlink}
            icon={MessageCircle}
            label={t('weao.card.discord')}
          />
          <LinkButton
            url={executor.purchaselink}
            icon={ShoppingCart}
            label={t('weao.card.purchase')}
          />
        </span>
      </div>
    </motion.div>
  );
}

/** Props for {@link Trait}. */
interface TraitProps {
  icon: LucideIcon;
  label: string;
  tone?: Tone;
}

/** A single capability chip. */
function Trait({ icon: Icon, label, tone = 'neutral' }: TraitProps): JSX.Element {
  return (
    <span className="rk-chip rk-chip--sm" data-tone={tone}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Props for {@link LinkButton}. */
interface LinkButtonProps {
  url: string | null;
  icon: LucideIcon;
  label: string;
}

/**
 * An outbound link. Rendered as a button that calls `ipc.openExternal`, never as
 * an `<a href>`: inside the Tauri webview an anchor would navigate the app shell
 * itself instead of handing the URL to the system browser.
 */
function LinkButton({ url, icon: Icon, label }: LinkButtonProps): ReactNode {
  if (url === null) return null;
  return (
    <button type="button" className="weao-link" title={url} onClick={() => void ipc.openExternal(url)}>
      <Icon size={11} aria-hidden="true" /> {label}
    </button>
  );
}

/** Props for {@link ExecutorLogo}. */
interface ExecutorLogoProps {
  executor: Executor;
}

/**
 * The catalogue logo from `cdn.weao.gg`. Only 18 of 29 entries ship one and the
 * CDN can fail independently of the API, so the glyph-plus-initial fallback is
 * the normal path for a third of the table, not an edge case.
 */
function ExecutorLogo({ executor }: ExecutorLogoProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const logo = executor.slug.logo;
  if (logo === null || failed) {
    return (
      <span className="weao-logo" data-fallback="true" aria-hidden="true">
        <Puzzle size={12} />
        <small>{executor.title.slice(0, 1).toUpperCase()}</small>
      </span>
    );
  }
  return (
    <span className="weao-logo">
      <img src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}
