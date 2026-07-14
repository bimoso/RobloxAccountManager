import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  Home,
  KeyRound,
  Link2,
  LoaderCircle,
  MapPin,
  RadioTower,
  Rocket,
  Server,
  UserRoundSearch,
  X,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import type { Account } from '@/types/models';
import type { GameDetails } from '@/types/window';
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
import './LaunchModal.css';

export interface LaunchModalProps {
  open: boolean;
  accounts: Account[];
  onClose: () => void;
  onLaunched?: (accountId: string) => void;
  launch?: (account: Account, target: string) => Promise<unknown>;
  fetchGameDetails?: (placeId: string, cookie: string) => Promise<GameDetails>;
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
}: LaunchModalProps): JSX.Element {
  const titleId = useId();
  const tabIdPrefix = useId();
  const reducedMotion = useReducedMotion() ?? false;
  const [tab, setTab] = useState<LaunchTab>('home');
  const [inputs, setInputs] = useState<LaunchInputs>(EMPTY_LAUNCH_INPUTS);
  const [preview, setPreview] = useState<GameDetails | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLaunch = launch ?? ((account: Account, target: string) =>
    ipc.launchRoblox(account.id, account.cookie, target));
  const getDetails = fetchGameDetails ?? ipc.getGameDetails;
  const cookie = useMemo(() => previewCookie(accounts), [accounts]);
  const target = buildLaunchTarget(tab, inputs);

  useEffect(() => {
    if (!open) return;
    setLaunching(false);
    setError(null);
    setPreview(null);
    setPreviewLoading(false);

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
  }, [open, accounts]);

  useEffect(() => {
    if (!open || tab !== 'place') {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }

    const place = inputs.place.trim();
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
  }, [open, tab, inputs.place, cookie, getDetails]);

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
          value: inputs.privateLink.trim() ? 'Enlace listo' : 'Añade un enlace',
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

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleLaunch();
  };

  return (
    <Modal open={open && n > 0} onClose={requestClose} titleId={titleId}>
      <form className="launch-modal" onSubmit={submit}>
        <header className="launch-modal__header">
          <div className="launch-modal__beacon" aria-hidden="true">
            <span className="launch-modal__beacon-ring" />
            <Rocket size={21} strokeWidth={2} />
          </div>
          <div className="launch-modal__heading">
            <span className="launch-modal__eyebrow">Session launcher / ready</span>
            <h2 id={titleId}>{n === 1 ? 'Lanzar Roblox' : `Lanzar ${n} cuentas`}</h2>
            <p>
              <strong>{who}</strong>
              <span>{n === 1 ? ' · Configura el destino de esta sesión.' : ' · Un destino compartido.'}</span>
            </p>
          </div>
          <button
            className="launch-modal__close"
            type="button"
            aria-label="Cerrar"
            disabled={launching}
            onClick={requestClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="launch-modal__tabs" role="tablist" aria-label="Destino de lanzamiento">
          {TABS.map(({ dest, label, caption, Icon }) => {
            const active = tab === dest;
            const tabId = `${tabIdPrefix}-${dest}`;
            return (
              <button
                id={tabId}
                key={dest}
                className="launch-modal__tab"
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${tabId}-panel`}
                data-active={active || undefined}
                onClick={() => {
                  setError(null);
                  setTab(dest);
                }}
              >
                {active && (
                  <motion.span
                    className="launch-modal__tab-active"
                    layoutId="launch-modal-active-route"
                    transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 430, damping: 34 }}
                  />
                )}
                <span className="launch-modal__tab-icon"><Icon size={16} /></span>
                <span className="launch-modal__tab-copy">
                  <strong>{label}</strong>
                  <small>{caption}</small>
                </span>
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={tab}
            id={`${tabIdPrefix}-${tab}-panel`}
            className="launch-modal__panel"
            role="tabpanel"
            aria-labelledby={`${tabIdPrefix}-${tab}`}
            initial={reducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
            transition={{ duration: reducedMotion ? 0 : 0.17, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'home' && (
              <div className="launch-modal__empty-state">
                <span className="launch-modal__empty-icon"><Home size={23} /></span>
                <div>
                  <span>Open client</span>
                  <h3>Inicio de Roblox</h3>
                  <p>Abre la aplicación sin forzar experiencia, jugador o servidor.</p>
                </div>
                <span className="launch-modal__mode-chip">Libre</span>
              </div>
            )}

            {tab === 'place' && (
              <div className="launch-modal__place-grid">
                <div className="launch-modal__panel-intro launch-modal__place-intro">
                  <span className="launch-modal__panel-icon"><MapPin size={18} /></span>
                  <div>
                    <h3>Entrar a una experiencia</h3>
                    <p>Elige el Place y, si lo necesitas, apunta a una instancia pública exacta.</p>
                  </div>
                </div>

                <div className="launch-modal__field launch-modal__field--place">
                  <label htmlFor={`${titleId}-place`}>Place ID o enlace</label>
                  <span className="launch-modal__input-shell">
                    <Link2 size={16} aria-hidden="true" />
                    <input
                      id={`${titleId}-place`}
                      type="text"
                      value={inputs.place}
                      placeholder="920587237 o roblox.com/games/..."
                      autoComplete="off"
                      onChange={(event) => setField('place', event.target.value)}
                    />
                  </span>
                  <small>La vista previa usa este Place; no modifica el Job ID.</small>
                </div>

                <div className="launch-modal__field launch-modal__field--job">
                  <label className="launch-modal__field-label" htmlFor={`${titleId}-job`}>
                    <span>Job ID</span>
                    <em>Opcional</em>
                  </label>
                  <span className="launch-modal__input-shell" data-invalid={Boolean(jobIdIssue) || undefined}>
                    <Server size={16} aria-hidden="true" />
                    <input
                      id={`${titleId}-job`}
                      type="text"
                      value={inputs.jobId}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(jobIdIssue)}
                      aria-describedby={jobIdIssue ? `${titleId}-job-error` : `${titleId}-job-help`}
                      onChange={(event) => setField('jobId', event.target.value)}
                    />
                  </span>
                  <small id={`${titleId}-job-help`}>Vacío entra a cualquier servidor disponible.</small>
                </div>

                {jobIdIssue && (
                  <p id={`${titleId}-job-error`} className="launch-modal__field-error" role="alert">
                    {jobIdIssue}
                  </p>
                )}

                {previewLoading && (
                  <div className="launch-modal__preview launch-modal__preview--loading" aria-live="polite">
                    <LoaderCircle className="launch-modal__spinner" size={18} />
                    <span>Localizando experiencia…</span>
                  </div>
                )}

                {!previewLoading && preview && (
                  <div className="launch-modal__preview">
                    {preview.iconUrl ? (
                      <img src={preview.iconUrl} alt="" />
                    ) : (
                      <span className="launch-modal__preview-fallback"><MapPin size={20} /></span>
                    )}
                    <div className="launch-modal__preview-copy">
                      <small>Experiencia detectada</small>
                      <strong>{preview.name ?? 'Juego de Roblox'}</strong>
                      <span>
                        {preview.creator ? `por ${preview.creator}` : 'Creador no disponible'}
                        {typeof preview.playing === 'number' ? ` · ${preview.playing.toLocaleString()} jugando` : ''}
                      </span>
                    </div>
                    {jobId && !jobIdIssue && <span className="launch-modal__exact-chip"><RadioTower size={12} /> Exacto</span>}
                  </div>
                )}
              </div>
            )}

            {tab === 'player' && (
              <div className="launch-modal__single-pane">
                <div className="launch-modal__panel-intro">
                  <span className="launch-modal__panel-icon"><UserRoundSearch size={18} /></span>
                  <div>
                    <h3>Seguir a un jugador</h3>
                    <p>Roblox intentará entrar a la sesión pública donde esté jugando.</p>
                  </div>
                </div>
                <div className="launch-modal__field">
                  <label htmlFor={`${titleId}-player`}>User ID</label>
                  <span className="launch-modal__input-shell">
                    <UserRoundSearch size={16} aria-hidden="true" />
                    <input
                      id={`${titleId}-player`}
                      type="text"
                      inputMode="numeric"
                      value={inputs.followUserId}
                      placeholder="ID numérico del jugador"
                      autoComplete="off"
                      onChange={(event) => setField('followUserId', event.target.value)}
                    />
                  </span>
                </div>
              </div>
            )}

            {tab === 'private' && (
              <div className="launch-modal__single-pane">
                <div className="launch-modal__panel-intro">
                  <span className="launch-modal__panel-icon"><KeyRound size={18} /></span>
                  <div>
                    <h3>Servidor privado</h3>
                    <p>Usa el enlace completo con su código de acceso privado.</p>
                  </div>
                </div>
                <div className="launch-modal__field">
                  <label htmlFor={`${titleId}-private`}>Enlace privado</label>
                  <span className="launch-modal__input-shell">
                    <Link2 size={16} aria-hidden="true" />
                    <input
                      id={`${titleId}-private`}
                      type="url"
                      value={inputs.privateLink}
                      placeholder="https://www.roblox.com/games/..."
                      autoComplete="off"
                      onChange={(event) => setField('privateLink', event.target.value)}
                    />
                  </span>
                </div>
              </div>
            )}
          </motion.section>
        </AnimatePresence>

        {error && <p className="launch-modal__error" role="alert">{error}</p>}

        <footer className="launch-modal__footer">
          <div className="launch-modal__route-status" data-ready={canLaunch || undefined}>
            <span className="launch-modal__route-dot" aria-hidden="true" />
            <span>
              <small>{routeSummary.label}</small>
              <strong>{routeSummary.value}</strong>
            </span>
          </div>
          <div className="launch-modal__actions">
            <Button variant="secondary" type="button" onClick={requestClose} disabled={launching}>
              Cancelar
            </Button>
            <Button variant="primary" type="submit" disabled={!canLaunch}>
              {launching ? <LoaderCircle className="launch-modal__spinner" size={16} /> : <Rocket size={16} />}
              {launching ? 'Iniciando…' : n <= 1 ? 'Lanzar ahora' : `Lanzar ${n}`}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
