// pages/Weao/index.tsx
//
// WEAO hub: what Roblox is shipping right now, how the clients on this machine
// compare, and which executors survived the last update. Data flow follows the
// Charts page exactly — impure fetching in `weaoApi`, pure logic in
// `clientStatus`/`filterExecutors`, a session cache that paints instantly on
// re-entry and revalidates silently behind it.

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
  CircleDollarSign,
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
  Radar,
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
import { Card } from '@/components/Card';
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

/** Everything one WEAO load produces, kept together so the cache is atomic. */
interface WeaoSnapshot {
  versions: WeaoVersions;
  executors: Executor[];
  /** Oldest of the two backend stamps — the pill must not over-promise. */
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

/** Icon shown per platform tile in the versions panel. */
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

/** WEAO hub: Roblox version tracking, client verdicts and executor status. */
export default function WeaoPage(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const { t, language } = useTranslation();
  const cached = weaoCache.get();
  const [snapshot, setSnapshot] = useState<WeaoSnapshot | undefined>(cached);
  const [status, setStatus] = useState<LoadStatus>(cached ? 'loaded' : 'idle');
  // Seeded from whatever sweep the Clients deck (or the idle warm-up) already
  // paid for, so the verdict band paints with the rest of the board instead of
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
      // A failed client scan only costs the verdict band; the catalogue below
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
    <section className="weao-page" aria-labelledby="weao-title">
      <motion.header
        className="weao-header"
        initial={{ opacity: 0, y: reducedMotion ? 0 : -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.28, ease: 'easeOut' }}
      >
        <div className="weao-heading">
          <span className="weao-eyebrow">
            <Radar size={12} aria-hidden="true" /> {t('weao.eyebrow')}
          </span>
          <h1 id="weao-title">{t('weao.title')}</h1>
          <p>{t('weao.subtitle')}</p>
        </div>
        <div className="weao-header__aside">
          <div className="weao-fresh" data-state={freshness.state} aria-live="polite">
            <span className="weao-fresh__signal" aria-hidden="true" />
            {freshness.label}
          </div>
          <Button
            variant="secondary"
            className="weao-refresh"
            disabled={status === 'loading'}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} aria-hidden="true" /> {t('weao.refresh')}
          </Button>
        </div>
      </motion.header>

      <div className="weao-scroll">
        <AnimatePresence mode="sync" initial={false}>
          {isLoading ? (
            <WeaoSkeleton key="loading" />
          ) : isError ? (
            <motion.div
              key="error"
              className="weao-message"
              role="alert"
              initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.22 }}
            >
              <div className="weao-message__glyph" aria-hidden="true">
                <TriangleAlert size={24} />
              </div>
              <h2>{t('weao.error.title')}</h2>
              <p>{t('weao.error.body')}</p>
              <Button onClick={() => void load(true)}>
                <RefreshCw size={14} aria-hidden="true" /> {t('weao.error.retry')}
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="board"
              className="weao-board"
              initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
              transition={{ duration: reducedMotion ? 0 : 0.22, ease: 'easeOut' }}
            >
              <Card className="weao-clients" data-verdict={verdict}>
                <div className="weao-clients__verdict">
                  <span className="weao-clients__glyph" aria-hidden="true">
                    <VerdictIcon size={19} />
                  </span>
                  <div>
                    <span className="weao-section-eyebrow">{t('weao.clients.title')}</span>
                    <strong>{t(`weao.verdict.${verdict}`)}</strong>
                    <p>{t(`weao.clients.hint.${verdict}`)}</p>
                  </div>
                </div>
                <ul className="weao-clients__list">
                  {installations.length === 0 ? (
                    <li className="weao-clients__none">{t('weao.clients.empty')}</li>
                  ) : (
                    installations.slice(0, 6).map((installation) => (
                      <li key={installation.id}>
                        <span title={installation.displayName}>{installation.displayName}</span>
                        <code title={installation.versionGuid ?? undefined}>
                          {installation.versionGuid ?? t('weao.clients.versionUnknown')}
                        </code>
                      </li>
                    ))
                  )}
                </ul>
                {banwaveCount > 0 ? (
                  <p className="weao-banwave" role="status">
                    <TriangleAlert size={14} aria-hidden="true" />
                    <strong>{t('weao.banwave.title')}</strong>
                    <span>{t('weao.banwave.body', { count: banwaveCount })}</span>
                  </p>
                ) : null}
              </Card>

              <Card className="weao-versions">
                <span className="weao-section-eyebrow">{t('weao.versions.title')}</span>
                <div className="weao-versions__grid">
                  {WEAO_PLATFORMS.map((platform) => (
                    <PlatformTile
                      key={platform}
                      platform={platform}
                      current={snapshot?.versions.current[platform]}
                      future={snapshot?.versions.future[platform]}
                    />
                  ))}
                </div>
              </Card>

              <div className="weao-toolbar">
                <div className="weao-search" role="search">
                  <Search size={16} aria-hidden="true" />
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
                      <X size={13} />
                    </button>
                  ) : null}
                  <span className="weao-search__count" aria-live="polite">
                    {shownExecutors.length}/{sourceExecutors.length}
                  </span>
                </div>
                <div className="weao-filters">
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
                </div>
                <label className="weao-supported" htmlFor="weao-supported-only">
                  <Switch
                    id="weao-supported-only"
                    checked={supportedOnly}
                    // Without a local guid there is nothing to match against, so
                    // the toggle would silently empty the grid.
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

              {shownExecutors.length === 0 ? (
                <EmptyState
                  icon={<Boxes size={26} />}
                  message={filtersActive ? t('weao.empty.filtered') : t('weao.empty.body')}
                  actionLabel={filtersActive ? t('weao.empty.clear') : undefined}
                  onAction={filtersActive ? clearFilters : undefined}
                />
              ) : (
                <div className="weao-grid">
                  {shownExecutors.map((executor, index) => (
                    <ExecutorCard
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

/** Everything the header pill needs to decide what it says. */
interface FreshnessInput {
  snapshot: WeaoSnapshot | undefined;
  status: LoadStatus;
  relative: Intl.RelativeTimeFormat;
  t: Translator;
}

/** The pill's visual state plus its resolved label. */
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

/** Props for {@link PlatformTile}. */
interface PlatformTileProps {
  platform: WeaoPlatform;
  current: PlatformVersion | undefined;
  future: PlatformVersion | undefined;
}

/** One platform column of the versions panel: the live build and the next one. */
function PlatformTile({ platform, current, future }: PlatformTileProps): JSX.Element {
  const { t } = useTranslation();
  const Icon = PLATFORM_ICONS[platform];
  return (
    <div className="weao-version" data-platform={platform}>
      <span className="weao-version__head">
        <Icon size={14} aria-hidden="true" />
        {t(`weao.platform.${platform}`)}
      </span>
      <small>{t('weao.versions.current')}</small>
      <code title={current?.version}>{current?.version ?? t('weao.versions.none')}</code>
      {current?.updatedAt ? <time>{current.updatedAt}</time> : null}
      {future ? (
        <>
          <small className="weao-version__future">
            <Clock size={11} aria-hidden="true" /> {t('weao.versions.future')}
          </small>
          <code title={future.version}>{future.version}</code>
        </>
      ) : null}
    </div>
  );
}

/** Props for {@link ExecutorCard}. */
interface ExecutorCardProps {
  executor: Executor;
  index: number;
  reducedMotion: boolean;
  installed: boolean;
}

/** One catalogue entry: identity, risk, capabilities, price and links. */
function ExecutorCard({
  executor,
  index,
  reducedMotion,
  installed,
}: ExecutorCardProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <motion.div
      layout={reducedMotion ? false : 'position'}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reducedMotion ? 0 : 0.22,
        delay: reducedMotion ? 0 : Math.min(index, 8) * 0.025,
        ease: 'easeOut',
      }}
    >
      <Card
        className="weao-executor"
        data-detected={executor.detected ? 'true' : undefined}
        data-banwave={executor.possibleBanwave ? 'true' : undefined}
      >
        <header className="weao-executor__head">
          <ExecutorLogo executor={executor} />
          <div className="weao-executor__id">
            <h2 title={executor.title}>{executor.title}</h2>
            <span>
              {t(`weao.extype.${executor.extype}`)}
              {executor.version ? ` · ${executor.version}` : ''}
            </span>
          </div>
          <span
            className="weao-executor__state"
            data-state={executor.updateStatus ? 'updated' : 'outdated'}
          >
            {executor.updateStatus ? t('weao.status.updated') : t('weao.status.outdated')}
          </span>
        </header>

        {executor.possibleBanwave || executor.detected ? (
          <p className="weao-executor__risk" data-severity={executor.possibleBanwave ? 'banwave' : 'detected'}>
            <TriangleAlert size={13} aria-hidden="true" />
            <strong>
              {executor.possibleBanwave ? t('weao.card.banwave') : t('weao.card.detected')}
            </strong>
            {executor.detectionReason ? <span>{executor.detectionReason}</span> : null}
          </p>
        ) : null}

        <ul className="weao-executor__traits">
          {executor.multiInject ? (
            <Trait icon={Layers} label={t('weao.card.multiInject')} highlight />
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
        </ul>

        <dl className="weao-executor__facts">
          <div>
            <dt>
              <CircleDollarSign size={12} aria-hidden="true" /> {t('weao.card.price')}
            </dt>
            <dd>
              {executor.free
                ? t('weao.card.free')
                : (executor.cost ?? t('weao.card.priceUnknown'))}
            </dd>
          </div>
          <div>
            <dt>
              <Download size={12} aria-hidden="true" /> {t('weao.card.targets')}
            </dt>
            <dd title={executor.rbxversion ?? undefined}>
              {executor.rbxversion ?? t('weao.card.targetsUnknown')}
              {installed ? (
                <em>
                  <CircleCheck size={11} aria-hidden="true" /> {t('weao.card.installed')}
                </em>
              ) : null}
            </dd>
          </div>
          {executor.updatedDate ? (
            <div>
              <dt>
                <Clock size={12} aria-hidden="true" /> {t('weao.card.updatedOn')}
              </dt>
              <dd>{executor.updatedDate}</dd>
            </div>
          ) : null}
        </dl>

        <footer className="weao-executor__links">
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
        </footer>
      </Card>
    </motion.div>
  );
}

/** Props for {@link Trait}. */
interface TraitProps {
  icon: LucideIcon;
  label: string;
  highlight?: boolean;
}

/** A single capability chip. */
function Trait({ icon: Icon, label, highlight = false }: TraitProps): JSX.Element {
  return (
    <li data-highlight={highlight ? 'true' : undefined}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </li>
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
    <button type="button" title={url} onClick={() => void ipc.openExternal(url)}>
      <Icon size={12} aria-hidden="true" /> {label}
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
 * the normal path for a third of the grid, not an edge case.
 */
function ExecutorLogo({ executor }: ExecutorLogoProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const logo = executor.slug.logo;
  if (logo === null || failed) {
    return (
      <span className="weao-executor__logo" data-fallback="true" aria-hidden="true">
        <Puzzle size={15} />
        <small>{executor.title.slice(0, 1).toUpperCase()}</small>
      </span>
    );
  }
  return (
    <span className="weao-executor__logo">
      <img src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

/** Placeholder deck shown only when there is no cached catalogue at all. */
function WeaoSkeleton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <motion.div
      className="weao-skeleton"
      role="status"
      aria-label={t('weao.loading')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <span className="sr-only">{t('weao.loading')}</span>
      <div className="weao-skeleton__band" aria-hidden="true" />
      <div className="weao-skeleton__versions" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className="weao-skeleton__grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
    </motion.div>
  );
}
