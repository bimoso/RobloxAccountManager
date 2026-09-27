// pages/Games/index.tsx
//
// The games library: every saved experience with the private servers filed
// under it, each one launchable with any set of accounts through the shared
// launch handoff (`launchIntentStore` → `LaunchModalHost`).
//
// Persistence is the existing place library (`placeLibraryStore`): the same
// entries the Charts star and the launcher's favorites already write, extended
// with per-game private servers and the roster used on the last launch.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Clock3,
  ExternalLink,
  Gamepad2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Share2,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { usePageActive } from '@/components/PageRouter/pageActivity';
import { ipc } from '@/lib/ipc';
import { parsePrivateServerLink, shortenPrivateCode } from '@/lib/privateServers';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import {
  isRetainedPlace,
  usePlaceLibraryStore,
  type PlaceLibraryEntry,
  type PrivateServerEntry,
} from '@/stores/placeLibraryStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Language, Translator } from '@/i18n';
import { AddGameModal } from './AddGameModal';
import { PrivateServerModal } from './PrivateServerModal';
import './Games.css';

type LibraryView = 'saved' | 'recent';

type PendingDelete =
  | { kind: 'game'; entry: PlaceLibraryEntry }
  | { kind: 'server'; entry: PlaceLibraryEntry; server: PrivateServerEntry };

interface ServerModalTarget {
  placeId: string;
  serverId: string | null;
}

/** "3 minutes ago" / "hace 3 minutos" for a launch timestamp. */
function relativeTime(timestamp: number, language: Language, now = Date.now()): string {
  const locale = language === 'es' ? 'es-MX' : 'en-US';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = (timestamp - now) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return format.format(0, 'second');
  if (magnitude < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (magnitude < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  if (magnitude < 86_400 * 30) return format.format(Math.round(seconds / 86_400), 'day');
  if (magnitude < 86_400 * 365) {
    return format.format(Math.round(seconds / (86_400 * 30)), 'month');
  }
  return format.format(Math.round(seconds / (86_400 * 365)), 'year');
}

function launchCountLabel(count: number, t: Translator): string {
  return count > 0 ? t('games.launchCount', { count }) : t('games.neverLaunched');
}

/** Name, creator, Place ID and every server label/code take part in search. */
function matchesQuery(entry: PlaceLibraryEntry, query: string): boolean {
  if (!query) return true;
  const haystack = [
    entry.name,
    entry.creator ?? '',
    entry.placeId,
    ...entry.privateServers.flatMap((server) => [server.name, server.link]),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(query);
}

function byRecency(a: PlaceLibraryEntry, b: PlaceLibraryEntry): number {
  return (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0) || a.name.localeCompare(b.name);
}

/** True when a keystroke arrived while the user was typing in a field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Saved games and their private servers, launchable with one or many accounts. */
export function GamesPage(): JSX.Element {
  const { t, language } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;
  const pageActive = usePageActive();
  const entries = usePlaceLibraryStore((state) => state.entries);
  const favorite = usePlaceLibraryStore((state) => state.favorite);
  const remove = usePlaceLibraryStore((state) => state.remove);
  const updateDetails = usePlaceLibraryStore((state) => state.updateDetails);
  const removePrivateServer = usePlaceLibraryStore((state) => state.removePrivateServer);
  const accounts = useAccountStore((state) => state.accounts);
  const loadAccounts = useAccountStore((state) => state.load);
  const openLaunch = useLaunchIntentStore((state) => state.open);
  const launchPending = useLaunchIntentStore((state) => state.intent !== null);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);

  const [view, setView] = useState<LibraryView>('saved');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [serverTarget, setServerTarget] = useState<ServerModalTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  useEffect(() => {
    if (accounts.length === 0) void loadAccounts();
  }, [accounts.length, loadAccounts]);

  const accountIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);
  const cookie = useMemo(
    () => accounts.find((account) => account.cookie)?.cookie ?? '',
    [accounts],
  );

  const saved = useMemo(() => entries.filter(isRetainedPlace).sort(byRecency), [entries]);
  const recent = useMemo(
    () =>
      entries
        .filter((entry) => !isRetainedPlace(entry) && entry.lastLaunchedAt !== null)
        .sort(byRecency),
    [entries],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const source = view === 'saved' ? saved : recent;
  const visible = useMemo(
    () => source.filter((entry) => matchesQuery(entry, normalizedQuery)),
    [source, normalizedQuery],
  );
  const serverCount = useMemo(
    () => saved.reduce((sum, entry) => sum + entry.privateServers.length, 0),
    [saved],
  );
  const launchTotal = useMemo(
    () => saved.reduce((sum, entry) => sum + entry.launchCount, 0),
    [saved],
  );

  const serverModalEntry = serverTarget
    ? entries.find((entry) => entry.placeId === serverTarget.placeId) ?? null
    : null;
  const serverModalServer =
    serverModalEntry && serverTarget?.serverId
      ? serverModalEntry.privateServers.find((server) => server.id === serverTarget.serverId) ?? null
      : null;

  const dialogOpen =
    !pageActive || addOpen || serverTarget !== null || pendingDelete !== null || launchPending;
  const openAdd = useCallback((): void => setAddOpen(true), []);

  // "N" adds a game whenever the page is idle and the user is not typing.
  useEffect(() => {
    if (dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'n' && event.key !== 'N') return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      openAdd();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, openAdd]);

  const seedFor = (entry: PlaceLibraryEntry) => ({
    placeId: entry.placeId,
    name: entry.name,
    iconUrl: entry.iconUrl,
    creator: entry.creator,
  });

  const handleLaunchGame = (entry: PlaceLibraryEntry): void => {
    openLaunch({ accountIds: [], seed: seedFor(entry) });
  };

  const handleLaunchServer = (entry: PlaceLibraryEntry, server: PrivateServerEntry): void => {
    openLaunch({
      accountIds: [],
      seed: {
        ...seedFor(entry),
        privateServer: { id: server.id, name: server.name, link: server.link },
      },
    });
  };

  const handleOpenPage = (entry: PlaceLibraryEntry): void => {
    void ipc.openExternal(`https://www.roblox.com/games/${entry.placeId}`);
  };

  const handleRefresh = async (entry: PlaceLibraryEntry): Promise<void> => {
    setRefreshingId(entry.placeId);
    try {
      const details = await ipc.getGameDetails(entry.placeId, cookie);
      if (!details?.ok) {
        showError(t('games.detailsFailed'));
        return;
      }
      updateDetails({
        placeId: entry.placeId,
        name: details.name || undefined,
        iconUrl: details.iconUrl || undefined,
        creator: details.creator || undefined,
      });
      showSuccess(t('games.detailsUpdated'));
    } catch {
      // The IPC layer already reported the failure as a toast.
    } finally {
      setRefreshingId(null);
    }
  };

  const handleSaveRecent = (entry: PlaceLibraryEntry): void => {
    favorite(seedFor(entry));
    showSuccess(t('games.saved'));
  };

  const handleConfirmDelete = (): void => {
    const target = pendingDelete;
    if (!target) return;
    if (target.kind === 'game') {
      remove(target.entry.placeId);
      showSuccess(t('games.removed'));
    } else {
      removePrivateServer(target.entry.placeId, target.server.id);
      showSuccess(t('games.serverDeleted'));
    }
    setPendingDelete(null);
  };

  const clearFilters = (): void => setQuery('');

  return (
    <section className="rk-page games-page" aria-labelledby="games-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="games-title">
            {t('games.title')}
            {saved.length > 0 ? (
              <span className="acc-title__count u-num">{saved.length}</span>
            ) : null}
          </h1>
          <span className="rk-page__sub">{t('games.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <Button variant="primary" onClick={openAdd}>
            <Plus size={15} aria-hidden="true" />
            {t('games.add')}
          </Button>
        </div>
      </header>

      {saved.length > 0 ? (
        <div className="rk-stats gm-stats" role="group" aria-label={t('games.summaryAria')}>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <Gamepad2 size={12} aria-hidden="true" /> {t('games.statSaved')}
            </span>
            <span className="rk-stat__value u-num">{saved.length}</span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <KeyRound size={12} aria-hidden="true" /> {t('games.statServers')}
            </span>
            <span className="rk-stat__value u-num">{serverCount}</span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <Rocket size={12} aria-hidden="true" /> {t('games.statLaunches')}
            </span>
            <span className="rk-stat__value u-num">{launchTotal}</span>
          </div>
        </div>
      ) : null}

      <div className="rk-toolbar gm-toolbar">
        <div className="rk-seg" role="group" aria-label={t('games.viewAria')}>
          <button
            type="button"
            aria-pressed={view === 'saved'}
            onClick={() => setView('saved')}
          >
            <Star size={12} aria-hidden="true" /> {t('games.viewSaved')}
            <span className="gm-toolbar__count u-num">{saved.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={view === 'recent'}
            onClick={() => setView('recent')}
          >
            <Clock3 size={12} aria-hidden="true" /> {t('games.viewRecent')}
            <span className="gm-toolbar__count u-num">{recent.length}</span>
          </button>
        </div>
        <div className="rk-search gm-search" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={t('games.searchAria')}
            placeholder={t('games.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.length > 0 ? (
            <button
              className="gm-search__clear"
              type="button"
              aria-label={t('games.clearSearch')}
              onClick={clearFilters}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="rk-page__body rk-page__body--pad">
        {source.length === 0 ? (
          <div className="rk-empty gm-empty" role="status">
            <span className="rk-empty__icon" aria-hidden="true">
              {view === 'saved' ? <Gamepad2 size={20} /> : <Clock3 size={20} />}
            </span>
            <h2 className="rk-empty__title">
              {view === 'saved' ? t('games.emptyTitle') : t('games.recentEmptyTitle')}
            </h2>
            <p className="rk-empty__text">
              {view === 'saved' ? t('games.emptyCopy') : t('games.recentEmptyCopy')}
            </p>
            {view === 'saved' ? (
              <>
                <Button variant="primary" onClick={openAdd}>
                  <Plus size={15} aria-hidden="true" />
                  {t('games.add')}
                </Button>
                <p className="gm-empty__hint">
                  <span className="rk-keys">
                    <kbd className="rk-key">N</kbd>
                  </span>
                  {t('games.emptyHint')}
                </p>
              </>
            ) : null}
          </div>
        ) : visible.length === 0 ? (
          <div className="rk-empty gm-empty" role="status">
            <span className="rk-empty__icon" aria-hidden="true">
              <Search size={20} />
            </span>
            <h2 className="rk-empty__title">{t('games.noMatchTitle')}</h2>
            <p className="rk-empty__text">{t('games.noMatchCopy')}</p>
            <Button variant="secondary" onClick={clearFilters}>
              <X size={13} aria-hidden="true" /> {t('games.clearSearch')}
            </Button>
          </div>
        ) : view === 'saved' ? (
          <div className="gm-list" role="list" aria-label={t('games.listAria')}>
            {visible.map((entry, index) => (
              <GameBlock
                key={entry.placeId}
                entry={entry}
                index={index}
                animateIn={!reducedMotion && !normalizedQuery}
                language={language}
                lastAccountCount={entry.lastAccountIds.filter((id) => accountIds.has(id)).length}
                refreshing={refreshingId === entry.placeId}
                onLaunch={() => handleLaunchGame(entry)}
                onLaunchServer={(server) => handleLaunchServer(entry, server)}
                onAddServer={() => setServerTarget({ placeId: entry.placeId, serverId: null })}
                onEditServer={(server) =>
                  setServerTarget({ placeId: entry.placeId, serverId: server.id })}
                onDeleteServer={(server) => setPendingDelete({ kind: 'server', entry, server })}
                onOpen={() => handleOpenPage(entry)}
                onRefresh={() => void handleRefresh(entry)}
                onRemove={() => setPendingDelete({ kind: 'game', entry })}
              />
            ))}
          </div>
        ) : (
          <div className="gm-recent" role="list" aria-label={t('games.viewRecent')}>
            {visible.map((entry) => (
              <div className="rk-row gm-recent__row" role="listitem" key={entry.placeId}>
                <span className="rk-row__gutter">
                  <GameThumb entry={entry} size="sm" />
                </span>
                <span className="rk-row__main">
                  <span className="rk-row__title" title={entry.name}>{entry.name}</span>
                  <span className="rk-row__meta gm-meta">
                    <span className="u-num">{entry.placeId}</span>
                    <span className="u-num">{launchCountLabel(entry.launchCount, t)}</span>
                    {entry.lastLaunchedAt !== null ? (
                      <span>{relativeTime(entry.lastLaunchedAt, language)}</span>
                    ) : null}
                  </span>
                </span>
                <span className="rk-row__actions gm-recent__tools">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={t('games.openPage')}
                    title={t('games.openPage')}
                    onClick={() => handleOpenPage(entry)}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                  </Button>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`${t('games.save')}: ${entry.name}`}
                  title={t('games.save')}
                  onClick={() => handleSaveRecent(entry)}
                >
                  <Star size={13} aria-hidden="true" />
                  {t('games.save')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={t('games.launchGameAria', { name: entry.name })}
                  onClick={() => handleLaunchGame(entry)}
                >
                  <Rocket size={13} aria-hidden="true" />
                  {t('games.launch')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AddGameModal
        open={addOpen}
        accounts={accounts}
        onClose={() => setAddOpen(false)}
        onSaved={(_placeId, withServer) =>
          showSuccess(withServer ? t('games.serverSaved') : t('games.saved'))}
      />
      <PrivateServerModal
        open={serverTarget !== null && serverModalEntry !== null}
        entry={serverModalEntry}
        server={serverModalServer}
        onClose={() => setServerTarget(null)}
        onSaved={() => showSuccess(t('games.serverSaved'))}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'server'
            ? t('games.deleteServer.title')
            : t('games.delete.title')
        }
        message={
          pendingDelete?.kind === 'server'
            ? t('games.deleteServer.confirm', { name: pendingDelete.server.name })
            : t('games.delete.confirm', {
                name: pendingDelete?.entry.name ?? '',
                count: pendingDelete?.entry.privateServers.length ?? 0,
              })
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

function GameThumb({
  entry,
  size,
}: {
  entry: PlaceLibraryEntry;
  size: 'sm' | 'md';
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const className = `gm-thumb gm-thumb--${size}`;
  if (entry.iconUrl && !failed) {
    return (
      <img
        className={className}
        src={entry.iconUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className={className} aria-hidden="true">
      <Gamepad2 size={size === 'sm' ? 13 : 18} />
    </span>
  );
}

interface GameBlockProps {
  entry: PlaceLibraryEntry;
  index: number;
  animateIn: boolean;
  language: Language;
  lastAccountCount: number;
  refreshing: boolean;
  onLaunch: () => void;
  onLaunchServer: (server: PrivateServerEntry) => void;
  onAddServer: () => void;
  onEditServer: (server: PrivateServerEntry) => void;
  onDeleteServer: (server: PrivateServerEntry) => void;
  onOpen: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}

/** One saved game: its identity row plus the private servers filed under it. */
function GameBlock({
  entry,
  index,
  animateIn,
  language,
  lastAccountCount,
  refreshing,
  onLaunch,
  onLaunchServer,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onOpen,
  onRefresh,
  onRemove,
}: GameBlockProps): JSX.Element {
  const { t } = useTranslation();
  const serverLabel =
    entry.privateServers.length === 1
      ? t('games.serverOne')
      : t('games.serverCount', { count: entry.privateServers.length });

  return (
    <motion.article
      className="gm-game rk-panel"
      role="listitem"
      aria-label={t('games.gameAria', { name: entry.name })}
      data-place-id={entry.placeId}
      initial={animateIn ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: animateIn ? 0.2 : 0,
        delay: animateIn ? Math.min(index, 6) * 0.04 : 0,
        ease: 'easeOut',
      }}
    >
      <header className="gm-game__head">
        <GameThumb entry={entry} size="md" />
        <div className="gm-game__titles">
          <h2 className="gm-game__name" title={entry.name}>{entry.name}</h2>
          <span className="gm-meta gm-game__meta">
            <span>
              {entry.creator
                ? t('launch.byCreator', { name: entry.creator })
                : t('launch.creatorMissing')}
            </span>
            <span className="u-num">{entry.placeId}</span>
            <span className="u-num">{launchCountLabel(entry.launchCount, t)}</span>
            {entry.lastLaunchedAt !== null ? (
              <span>
                {t('games.lastLaunched', { when: relativeTime(entry.lastLaunchedAt, language) })}
              </span>
            ) : null}
            {lastAccountCount > 0 ? (
              <span className="gm-meta__accounts">
                <Users size={11} aria-hidden="true" />
                {t('games.lastAccounts', { count: lastAccountCount })}
              </span>
            ) : null}
          </span>
        </div>
        <div className="gm-game__actions">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('games.openPage')}
            title={t('games.openPage')}
            onClick={onOpen}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('games.refresh')}
            title={t('games.refresh')}
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <span className="rk-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="gm-game__remove"
            aria-label={t('games.unsave')}
            title={t('games.unsave')}
            onClick={onRemove}
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
          <Button variant="secondary" size="sm" onClick={onAddServer}>
            <Plus size={13} aria-hidden="true" />
            {t('games.addServer')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="gm-game__launch"
            aria-label={t('games.launchGameAria', { name: entry.name })}
            onClick={onLaunch}
          >
            <Rocket size={13} aria-hidden="true" />
            {t('games.launch')}
          </Button>
        </div>
      </header>

      <div className="gm-game__servers" role="list" aria-label={t('games.serversAria', { name: entry.name })}>
        <div className="gm-game__servers-head">
          <Server size={12} aria-hidden="true" />
          <span>{entry.privateServers.length === 0 ? t('games.noServers') : serverLabel}</span>
        </div>
        {entry.privateServers.length === 0 ? (
          <button type="button" className="gm-server gm-server--new" onClick={onAddServer}>
            <KeyRound size={13} aria-hidden="true" />
            <span>{t('games.addServer')}</span>
          </button>
        ) : (
          entry.privateServers.map((server) => {
            const parsed = parsePrivateServerLink(server.link);
            const isShare = parsed?.kind === 'share';
            return (
              <div className="rk-row gm-server" role="listitem" key={server.id}>
                <span className="rk-row__gutter">
                  <span className="gm-server__icon" aria-hidden="true">
                    {isShare ? <Share2 size={13} /> : <KeyRound size={13} />}
                  </span>
                </span>
                <span className="rk-row__main">
                  <span className="rk-row__title" title={server.link}>{server.name}</span>
                  <span className="rk-row__meta gm-meta">
                    <span>{isShare ? t('games.shareKind') : t('games.privateKind')}</span>
                    <span className="u-num">{shortenPrivateCode(parsed?.code ?? server.link)}</span>
                    <span className="u-num">{launchCountLabel(server.launchCount, t)}</span>
                    {server.lastLaunchedAt !== null ? (
                      <span>{relativeTime(server.lastLaunchedAt, language)}</span>
                    ) : null}
                  </span>
                </span>
                <span className="rk-row__actions gm-server__tools">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`${t('games.editServer')}: ${server.name}`}
                    title={t('games.editServer')}
                    onClick={() => onEditServer(server)}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    className="gm-server__delete"
                    aria-label={`${t('games.deleteServer')}: ${server.name}`}
                    title={t('games.deleteServer')}
                    onClick={() => onDeleteServer(server)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </Button>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gm-server__launch"
                  aria-label={t('games.launchServerAria', { name: server.name })}
                  onClick={() => onLaunchServer(server)}
                >
                  <Rocket size={13} aria-hidden="true" />
                  {t('games.launch')}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </motion.article>
  );
}

export default GamesPage;
