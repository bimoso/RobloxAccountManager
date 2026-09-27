import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  BookmarkPlus,
  Check,
  Home,
  Clock3,
  KeyRound,
  MapPin,
  RadioTower,
  Rocket,
  Star,
  UserRoundSearch,
  X,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { parsePrivateServerLink } from '@/lib/privateServers';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account } from '@/types/models';
import type { GameDetails } from '@/types/window';
import type { LaunchSeed } from '@/stores/launchIntentStore';
import {
  findPrivateServerByLink,
  listPrivateServers,
  usePlaceLibraryStore,
} from '@/stores/placeLibraryStore';
import { useToastStore } from '@/stores/toastStore';
import {
  EMPTY_LAUNCH_INPUTS,
  buildLaunchTarget,
  isValidJobId,
  launchAccounts,
  placeIdFromLaunchInput,
  type LaunchInputs,
  type LaunchOutcome,
  type LaunchTab,
} from './launch';
// `.acc-head` (the dialog head row) and `.acc-seg` (THE segmented tab strip,
// shared with AddAccountModal) are declared once, in that dialog's stylesheet.
import './AddAccountModal.css';
import './LaunchModal.css';

export interface LaunchModalProps {
  open: boolean;
  accounts: Account[];
  onClose: () => void;
  onLaunched?: (accountId: string) => void;
  launch?: (account: Account, target: string) => Promise<unknown>;
  fetchGameDetails?: (placeId: string, cookie: string) => Promise<GameDetails>;
  /**
   * Explicit destination handed off by Charts or the Games library; takes
   * precedence over account history. A seed carrying `privateServer` opens
   * the Private tab with that link.
   */
  seed?: LaunchSeed;
}

interface DestinationTab {
  dest: LaunchTab;
  label: string;
  caption: string;
  Icon: LucideIcon;
}

const PREVIEW_DEBOUNCE_MS = 450;

const TABS: readonly DestinationTab[] = [
  { dest: 'home', label: 'Inicio', caption: 'Abrir cliente', Icon: Home },
  { dest: 'place', label: 'Place', caption: 'Experiencia', Icon: MapPin },
  { dest: 'player', label: 'Jugador', caption: 'Seguir usuario', Icon: UserRoundSearch },
  { dest: 'private', label: 'Privado', caption: 'Enlace de acceso', Icon: KeyRound },
];

function previewCookie(accounts: Account[]): string {
  return accounts.find((account) => account.cookie)?.cookie ?? '';
}

function seedSavedPlaceTarget(saved: string): Pick<LaunchInputs, 'place' | 'jobId'> {
  if (/^\d+$/.test(saved)) return { place: saved, jobId: '' };
  try {
    const url = new URL(/^https?:\/\//i.test(saved) ? saved : `https://${saved}`);
    const jobId =
      url.searchParams.get('gameId') ??
      url.searchParams.get('gameInstanceId') ??
      url.searchParams.get('jobId') ??
      '';
    if (!jobId) return { place: saved, jobId: '' };
    url.searchParams.delete('gameId');
    url.searchParams.delete('gameInstanceId');
    url.searchParams.delete('jobId');
    return { place: url.toString(), jobId };
  } catch {
    return { place: saved, jobId: '' };
  }
}

function shortenToken(value: string): string {
  const token = value.trim();
  if (token.length <= 18) return token;
  return `${token.slice(0, 9)}…${token.slice(-6)}`;
}

/**
 * Roving-tabindex arithmetic for the `.acc-seg` tab strip (see
 * AddAccountModal.css, which declares the strip's one shared treatment):
 * horizontal and vertical arrows wrap around, Home/End jump to the ends, and
 * any other key is left unhandled so it reaches the dialog.
 */
function rovingTarget(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

function launchErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

export function LaunchModal({
  open,
  accounts,
  onClose,
  onLaunched,
  launch,
  fetchGameDetails,
  seed,
}: LaunchModalProps): JSX.Element {
  const titleId = useId();
  const tabIdPrefix = useId();
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tab, setTab] = useState<LaunchTab>('home');
  const [inputs, setInputs] = useState<LaunchInputs>(EMPTY_LAUNCH_INPUTS);
  const [preview, setPreview] = useState<GameDetails | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryView, setLibraryView] = useState<'favorites' | 'recent'>('favorites');
  const [privateName, setPrivateName] = useState('');
  const placeLibrary = usePlaceLibraryStore((state) => state.entries);
  const toggleFavorite = usePlaceLibraryStore((state) => state.toggleFavorite);
  const recordPlaceLaunch = usePlaceLibraryStore((state) => state.recordLaunch);
  const addPrivateServer = usePlaceLibraryStore((state) => state.addPrivateServer);
  const recordPrivateServerLaunch = usePlaceLibraryStore(
    (state) => state.recordPrivateServerLaunch,
  );
  const showSuccess = useToastStore((state) => state.showSuccess);

  const doLaunch = launch ?? ((account: Account, target: string) =>
    ipc.launchRoblox(account.id, account.cookie, target));
  const getDetails = fetchGameDetails ?? ipc.getGameDetails;
  const cookie = useMemo(() => previewCookie(accounts), [accounts]);
  const target = buildLaunchTarget(tab, inputs);
  const seedPrivateLink = seed?.privateServer?.link;
  const privateLink = inputs.privateLink.trim();
  const privateParsed = useMemo(() => parsePrivateServerLink(privateLink), [privateLink]);
  const savedPrivate = useMemo(
    () => (privateLink ? findPrivateServerByLink(placeLibrary, privateLink) : undefined),
    [placeLibrary, privateLink],
  );
  const savedServers = useMemo(() => listPrivateServers(placeLibrary), [placeLibrary]);
  // The Place whose details the preview strip shows: the Place field on the
  // Place tab, or the game a private link names on the Private tab.
  const previewPlace =
    tab === 'place'
      ? inputs.place.trim()
      : tab === 'private' && privateParsed?.kind === 'private'
        ? privateParsed.placeId
        : '';

  useEffect(() => {
    if (!open) return;
    setLaunching(false);
    setError(null);
    setPreview(null);
    setPreviewLoading(false);
    setPrivateName('');

    if (seed?.placeId) {
      if (seedPrivateLink) {
        setTab('private');
        setInputs({ ...EMPTY_LAUNCH_INPUTS, privateLink: seedPrivateLink });
        return;
      }
      setTab('place');
      setInputs({ ...EMPTY_LAUNCH_INPUTS, place: seed.placeId });
      return;
    }

    if (accounts.length === 1) {
      const saved =
        typeof accounts[0].gameTarget === 'string' ? accounts[0].gameTarget.trim() : '';
      if (saved) {
        if (/privateServerLinkCode=/.test(saved)) {
          setTab('private');
          setInputs({ ...EMPTY_LAUNCH_INPUTS, privateLink: saved });
          return;
        }
        const seeded = seedSavedPlaceTarget(saved);
        setTab('place');
        setInputs({ ...EMPTY_LAUNCH_INPUTS, ...seeded });
        return;
      }
    }

    setTab('home');
    setInputs(EMPTY_LAUNCH_INPUTS);
  }, [open, accounts, seed?.placeId, seedPrivateLink]);

  useEffect(() => {
    if (!open || (tab !== 'place' && tab !== 'private')) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }

    const place = previewPlace;
    if (!place) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const details = await getDetails(place, cookie);
          if (!cancelled) setPreview(details?.ok ? details : null);
        } catch {
          if (!cancelled) setPreview(null);
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, tab, previewPlace, cookie, getDetails]);

  const setField = (field: keyof LaunchInputs, value: string): void => {
    setError(null);
    setInputs((current) => ({ ...current, [field]: value }));
  };

  const n = accounts.length;
  const who =
    n === 1
      ? accounts[0].nickname?.trim() || accounts[0].username || 'Cuenta'
      : `${n} cuentas seleccionadas`;
  const place = inputs.place.trim();
  const jobId = inputs.jobId.trim();
  const placeId = placeIdFromLaunchInput(place);
  const jobIdIssue =
    tab !== 'place' || !jobId
      ? null
      : !place
        ? 'Ingresa primero el Place ID de la experiencia.'
        : !isValidJobId(jobId)
          ? 'El Job ID sólo puede contener letras, números, guiones y guion bajo.'
          : !placeId
            ? 'Para usar Job ID, escribe un Place ID o una URL /games/ válida.'
            : null;
  const canLaunch = target !== undefined && !launching && n > 0 && !jobIdIssue;
  // A `/games/<id>?privateServerLinkCode=` link can be filed under its game
  // from here; a share link does not name its game, so it is saved from the
  // Games page where the user picks the game explicitly.
  const canSavePrivate = privateParsed?.kind === 'private' && !savedPrivate && !launching;

  const savePrivateLink = (): void => {
    if (!privateParsed || privateParsed.kind !== 'private') return;
    const result = addPrivateServer(
      {
        placeId: privateParsed.placeId,
        name: preview?.name || (seed?.placeId === privateParsed.placeId ? seed.name : undefined),
        iconUrl: preview?.iconUrl || undefined,
        creator: preview?.creator || undefined,
      },
      { name: privateName, link: privateParsed.url },
    );
    if (!result.ok) {
      setError(result.reason === 'duplicate' ? t('launch.privateDuplicate') : t('launch.privateInvalid'));
      return;
    }
    setPrivateName('');
    showSuccess(t('launch.privateSavedToast'));
  };

  const routeSummary = (() => {
    switch (tab) {
      case 'home':
        return { label: 'Aplicación', value: 'Inicio de Roblox' };
      case 'place':
        if (!place) return { label: 'Destino pendiente', value: 'Añade un Place ID' };
        return jobId
          ? { label: 'Servidor exacto', value: `Place ${placeId ?? '—'} · ${shortenToken(jobId)}` }
          : { label: 'Experiencia', value: placeId ? `Place ${placeId}` : shortenToken(place) };
      case 'player':
        return {
          label: 'Seguir jugador',
          value: inputs.followUserId.trim() || 'Añade un User ID',
        };
      case 'private':
        return {
          label: 'Servidor privado',
          value: savedPrivate
            ? `${savedPrivate.server.name} · ${savedPrivate.entry.name}`
            : privateLink
              ? 'Enlace listo'
              : 'Añade un enlace',
        };
    }
  })();

  const requestClose = (): void => {
    if (!launching) onClose();
  };

  const handleLaunch = async (): Promise<void> => {
    if (!canLaunch || target === undefined) return;
    setLaunching(true);
    setError(null);

    let outcomes: LaunchOutcome<unknown>[];
    try {
      outcomes = await launchAccounts(accounts, target, { launch: doLaunch });
    } catch {
      setError('No se pudo iniciar el flujo de lanzamiento. Inténtalo de nuevo.');
      setLaunching(false);
      return;
    }

    const succeeded = outcomes.filter((outcome) => outcome.ok);
    succeeded.forEach((outcome) => onLaunched?.(outcome.account.id));
    const launchedIds = succeeded.map((outcome) => outcome.account.id);

    if (succeeded.length > 0 && tab === 'place' && placeId) {
      recordPlaceLaunch(
        {
          placeId,
          name: preview?.name || (seed?.placeId === placeId ? seed.name : undefined),
          iconUrl: preview?.iconUrl || (seed?.placeId === placeId ? seed.iconUrl : undefined),
          creator: preview?.creator || (seed?.placeId === placeId ? seed.creator : undefined),
        },
        launchedIds,
      );
    }

    if (succeeded.length > 0 && tab === 'private') {
      if (savedPrivate) {
        recordPrivateServerLaunch(savedPrivate.entry.placeId, savedPrivate.server.id, launchedIds);
      } else if (privateParsed?.kind === 'private') {
        recordPlaceLaunch(
          {
            placeId: privateParsed.placeId,
            name: preview?.name || undefined,
            iconUrl: preview?.iconUrl || undefined,
            creator: preview?.creator || undefined,
          },
          launchedIds,
        );
      }
    }

    if (succeeded.length === outcomes.length) {
      onClose();
      return;
    }

    const firstFailure = outcomes.find((outcome) => !outcome.ok);
    const detail = launchErrorMessage(firstFailure?.error);
    setError(
      n === 1 && detail
        ? detail
        : `${succeeded.length}/${outcomes.length} sesiones iniciadas${detail ? ` · ${detail}` : '.'}`,
    );
    setLaunching(false);
  };

  const visibleLibrary = placeLibrary
    .filter((entry) => libraryView === 'favorites' ? entry.favorite : entry.lastLaunchedAt !== null)
    .sort((a, b) =>
      libraryView === 'favorites'
        ? a.name.localeCompare(b.name)
        : (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0),
    );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleLaunch();
  };

  const previewStrip = (
    <>
      {previewLoading && (
        <div className="rk-panel launch-modal__preview" aria-live="polite">
          <span className="rk-spin" aria-hidden="true" />
          <span>{t('launch.locating')}</span>
        </div>
      )}

      {!previewLoading && preview && (
        <div className="rk-panel launch-modal__preview">
          {preview.iconUrl ? (
            <img className="launch-modal__thumb" src={preview.iconUrl} alt="" />
          ) : (
            <span className="launch-modal__thumb">
              <MapPin size={15} aria-hidden="true" />
            </span>
          )}
          <div className="launch-modal__preview-copy">
            <small>{t('launch.detected')}</small>
            <strong>{preview.name ?? t('launch.fallbackGame')}</strong>
            <span>
              {preview.creator
                ? t('launch.byCreator', { name: preview.creator })
                : t('launch.creatorMissing')}
              {typeof preview.playing === 'number' ? (
                <>
                  {' · '}
                  <span className="u-num">
                    {t('launch.playing', { count: preview.playing.toLocaleString() })}
                  </span>
                </>
              ) : null}
            </span>
          </div>
          {tab === 'place' && jobId && !jobIdIssue && (
            <span className="rk-chip" data-tone="accent">
              <RadioTower size={11} aria-hidden="true" /> {t('launch.exactChip')}
            </span>
          )}
          {tab === 'private' && (
            <span className="rk-chip" data-tone="accent">
              <KeyRound size={11} aria-hidden="true" /> {t('launch.privateTitle')}
            </span>
          )}
        </div>
      )}
    </>
  );

  const activeIndex = TABS.findIndex((entry) => entry.dest === tab);
  const panelId = `${tabIdPrefix}-panel`;
  const activeTabId = `${tabIdPrefix}-${tab}`;

  const selectTab = (dest: LaunchTab): void => {
    setError(null);
    setTab(dest);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = rovingTarget(TABS.length, activeIndex, event.key);
    if (next === null) return;
    event.preventDefault();
    selectTab(TABS[next].dest);
    tabRefs.current[next]?.focus();
  };

  return (
    <Modal open={open && n > 0} onClose={requestClose} titleId={titleId} size="lg">
      <form className="fm-root launch-modal" onSubmit={submit}>
        <div className="acc-head">
          <div className="fm-head">
            <h2 id={titleId} className="fm-title">
              {n === 1 ? t('launch.titleOne') : t('launch.titleMany', { count: n })}
            </h2>
            <p className="fm-hint">
              <strong>{who}</strong>
              <span>{n === 1 ? t('launch.subOne') : t('launch.subShared')}</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            type="button"
            aria-label={t('launch.close')}
            disabled={launching}
            onClick={requestClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <div
          className="acc-seg"
          role="tablist"
          aria-label={t('launch.tabsAria')}
          onKeyDown={onTabKeyDown}
        >
          {TABS.map(({ dest, label, caption, Icon }, index) => (
            <button
              key={dest}
              id={`${tabIdPrefix}-${dest}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              className="acc-seg__tab"
              type="button"
              role="tab"
              aria-selected={tab === dest}
              aria-controls={panelId}
              tabIndex={tab === dest ? 0 : -1}
              onClick={() => selectTab(dest)}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="acc-seg__copy">
                <strong>{label}</strong>
                <small>{caption}</small>
              </span>
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={tab}
            id={panelId}
            className="launch-modal__panel"
            role="tabpanel"
            aria-labelledby={activeTabId}
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'home' && (
              <div className="rk-empty">
                <span className="rk-empty__icon">
                  <Home size={18} aria-hidden="true" />
                </span>
                <div className="launch-modal__empty-copy">
                  <h3 className="rk-empty__title">{t('launch.homeTitle')}</h3>
                  <p className="rk-empty__text">{t('launch.homeDesc')}</p>
                </div>
                <span className="rk-chip" data-tone="accent">{t('launch.chipFree')}</span>
              </div>
            )}

            {tab === 'place' && (
              <>
                <div className="launch-modal__intro">
                  <h3>{t('launch.placeTitle')}</h3>
                  <p>{t('launch.placeDesc')}</p>
                </div>

                <div className="fm-field">
                  <label htmlFor={`${titleId}-place`}>{t('launch.placeLabel')}</label>
                  <input
                    id={`${titleId}-place`}
                    className="fm-input"
                    type="text"
                    value={inputs.place}
                    placeholder={t('launch.placePlaceholder')}
                    autoComplete="off"
                    onChange={(event) => setField('place', event.target.value)}
                  />
                  <small className="launch-modal__hint">{t('launch.placeHint')}</small>
                </div>

                <div className="fm-field">
                  <label className="launch-modal__label" htmlFor={`${titleId}-job`}>
                    <span>Job ID</span>
                    <em>{t('launch.jobOptional')}</em>
                  </label>
                  <input
                    id={`${titleId}-job`}
                    className="fm-input u-num"
                    type="text"
                    value={inputs.jobId}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(jobIdIssue)}
                    aria-describedby={jobIdIssue ? `${titleId}-job-error` : `${titleId}-job-help`}
                    onChange={(event) => setField('jobId', event.target.value)}
                  />
                  <small className="launch-modal__hint" id={`${titleId}-job-help`}>
                    {t('launch.jobHelp')}
                  </small>
                </div>

                {jobIdIssue && (
                  <p id={`${titleId}-job-error`} className="fm-error" role="alert">
                    {jobIdIssue}
                  </p>
                )}

                {previewStrip}

                <section className="launch-modal__library" aria-label={t('launch.libraryAria')}>
                  <div className="launch-modal__library-head">
                    <div className="launch-modal__library-titles">
                      <strong>{t('launch.libraryTitle')}</strong>
                    </div>
                    <div
                      className="launch-modal__library-switch"
                      role="group"
                      aria-label={t('launch.viewAria')}
                    >
                      <button
                        type="button"
                        data-active={libraryView === 'favorites' || undefined}
                        onClick={() => setLibraryView('favorites')}
                      >
                        <Star size={12} aria-hidden="true" /> {t('launch.favorites')}
                      </button>
                      <button
                        type="button"
                        data-active={libraryView === 'recent' || undefined}
                        onClick={() => setLibraryView('recent')}
                      >
                        <Clock3 size={12} aria-hidden="true" /> {t('launch.recent')}
                      </button>
                    </div>
                  </div>

                  {visibleLibrary.length ? (
                    <ul className="launch-modal__library-list">
                      {visibleLibrary.map((entry) => (
                        <li className="rk-row" key={entry.placeId}>
                          <span className="rk-row__gutter">
                            {entry.iconUrl ? (
                              <img className="launch-modal__place-thumb" src={entry.iconUrl} alt="" />
                            ) : (
                              <span className="launch-modal__place-thumb">
                                <MapPin size={12} aria-hidden="true" />
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            className="launch-modal__place-pick"
                            title={t('launch.useTile', { name: entry.name })}
                            onClick={() => {
                              setError(null);
                              setInputs((current) => ({ ...current, place: entry.placeId, jobId: '' }));
                            }}
                          >
                            <span className="rk-row__title">{entry.name}</span>
                            <span className="rk-row__meta launch-modal__place-meta">
                              <span className="u-num">{entry.placeId}</span>
                              {entry.launchCount ? (
                                <span className="u-num">
                                  {t('launch.tileCount', { count: entry.launchCount })}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="launch-modal__place-star"
                            aria-label={
                              entry.favorite
                                ? t('launch.unfavorite', { name: entry.name })
                                : t('launch.favorite', { name: entry.name })
                            }
                            data-active={entry.favorite || undefined}
                            onClick={() => toggleFavorite(entry)}
                          >
                            <Star size={13} fill={entry.favorite ? 'currentColor' : 'none'} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="launch-modal__library-empty">
                      {libraryView === 'favorites'
                        ? t('launch.emptyFav')
                        : t('launch.emptyRecent')}
                    </p>
                  )}
                </section>
              </>
            )}

            {tab === 'player' && (
              <>
                <div className="launch-modal__intro">
                  <h3>{t('launch.playerTitle')}</h3>
                  <p>{t('launch.playerDesc')}</p>
                </div>
                <div className="fm-field">
                  <label htmlFor={`${titleId}-player`}>User ID</label>
                  <input
                    id={`${titleId}-player`}
                    className="fm-input u-num"
                    type="text"
                    inputMode="numeric"
                    value={inputs.followUserId}
                    placeholder={t('launch.playerPlaceholder')}
                    autoComplete="off"
                    onChange={(event) => setField('followUserId', event.target.value)}
                  />
                </div>
              </>
            )}

            {tab === 'private' && (
              <>
                <div className="launch-modal__intro">
                  <h3>{t('launch.privateTitle')}</h3>
                  <p>{t('launch.privateDesc')}</p>
                </div>
                <div className="fm-field">
                  <label htmlFor={`${titleId}-private`}>{t('launch.privateLabel')}</label>
                  <div className="launch-modal__private-row">
                    <input
                      id={`${titleId}-private`}
                      className="fm-input"
                      type="url"
                      value={inputs.privateLink}
                      placeholder="https://www.roblox.com/games/..."
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setField('privateLink', event.target.value)}
                    />
                    {savedPrivate ? (
                      <span className="rk-chip" data-tone="ok">
                        <Check size={12} aria-hidden="true" /> {t('launch.privateSaved')}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={!canSavePrivate}
                        title={t('launch.privateSave')}
                        onClick={savePrivateLink}
                      >
                        <BookmarkPlus size={14} aria-hidden="true" />
                        {t('launch.privateSave')}
                      </Button>
                    )}
                  </div>
                  {privateParsed?.kind === 'share' && !savedPrivate ? (
                    <small className="launch-modal__hint">{t('launch.privateSaveHint')}</small>
                  ) : null}
                </div>

                {canSavePrivate ? (
                  <div className="fm-field">
                    <label htmlFor={`${titleId}-private-name`}>{t('launch.privateSaveName')}</label>
                    <input
                      id={`${titleId}-private-name`}
                      className="fm-input"
                      type="text"
                      value={privateName}
                      placeholder="VIP, EU, farm…"
                      autoComplete="off"
                      onChange={(event) => setPrivateName(event.target.value)}
                    />
                  </div>
                ) : null}

                {previewStrip}

                <section className="launch-modal__library" aria-label={t('launch.privateSavedTitle')}>
                  <div className="launch-modal__library-head">
                    <div className="launch-modal__library-titles">
                      <strong>{t('launch.privateSavedTitle')}</strong>
                    </div>
                  </div>
                  {savedServers.length ? (
                    <ul className="launch-modal__library-list">
                      {savedServers.map(({ entry, server }) => {
                        const selected = savedPrivate?.server.id === server.id;
                        return (
                          <li className="rk-row" key={server.id} data-selected={selected || undefined}>
                            <span className="rk-row__gutter">
                              {entry.iconUrl ? (
                                <img className="launch-modal__place-thumb" src={entry.iconUrl} alt="" />
                              ) : (
                                <span className="launch-modal__place-thumb">
                                  <KeyRound size={12} aria-hidden="true" />
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              className="launch-modal__place-pick"
                              title={t('launch.useTile', { name: server.name })}
                              onClick={() => setField('privateLink', server.link)}
                            >
                              <span className="rk-row__title">{server.name}</span>
                              <span className="rk-row__meta launch-modal__place-meta">
                                <span>{entry.name}</span>
                                {server.launchCount ? (
                                  <span className="u-num">
                                    {t('launch.tileCount', { count: server.launchCount })}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <span className="launch-modal__place-check" aria-hidden="true">
                              {selected ? <Check size={13} /> : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="launch-modal__library-empty">{t('launch.privateSavedEmpty')}</p>
                  )}
                </section>
              </>
            )}
          </motion.section>
        </AnimatePresence>

        {error && <p className="fm-error" role="alert">{error}</p>}

        <footer className="launch-modal__footer">
          <div className="launch-modal__route" data-ready={canLaunch || undefined}>
            <span
              className="rk-dot"
              data-tone={canLaunch ? 'ok' : undefined}
              aria-hidden="true"
            />
            <span className="launch-modal__route-copy">
              <small>{routeSummary.label}</small>
              <strong>{routeSummary.value}</strong>
            </span>
          </div>
          <div className="fm-footer">
            <Button variant="secondary" type="button" onClick={requestClose} disabled={launching}>
              {t('launch.cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={!canLaunch}>
              {launching ? (
                <span className="rk-spin" aria-hidden="true" />
              ) : (
                <Rocket size={16} aria-hidden="true" />
              )}
              {launching ? t('launch.starting') : n <= 1 ? t('launch.goOne') : t('launch.goMany', { count: n })}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
