import { useEffect, useId, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AtSign,
  CheckCircle2,
  LoaderCircle,
  Send,
  UserRoundPlus,
  UsersRound,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';
import {
  parseTargetUserId,
  processBatchFriendRequests,
  type FriendRequestProgressEvent,
  type FriendRequestSender,
  type FriendRequestSummary,
} from './friendRequest';
import './FriendRequestModal.css';

/** Props for the themed batch friend-request flow. */
export interface FriendRequestModalProps {
  open: boolean;
  accounts: Account[];
  onClose: () => void;
  /** Test/composition seam; production delegates to the typed IPC bridge. */
  sendRequest?: (cookie: string, targetUserId: string) => Promise<unknown> | unknown;
}

/** Build the dependency-free sender list from the selected accounts. */
function toSenders(accounts: Account[]): FriendRequestSender[] {
  return accounts.map((account) => ({
    id: account.id,
    label: displayName(account),
    cookie: account.cookie,
  }));
}

function senderInitial(account: Account): string {
  return Array.from(displayName(account).trim())[0]?.toLocaleUpperCase() ?? '?';
}

/**
 * Send a friend request from one or more selected accounts to one validated
 * Roblox profile. The visual language mirrors the control-deck launcher while
 * keeping the operation legible as a source-to-target dispatch rather than a
 * generic form dropped inside the base modal.
 */
export function FriendRequestModal({
  open,
  accounts,
  onClose,
  sendRequest,
}: FriendRequestModalProps): JSX.Element {
  const titleId = useId();
  const targetId = useId();
  const targetErrorId = useId();
  const reducedMotion = useReducedMotion() ?? false;
  const [targetInput, setTargetInput] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FriendRequestProgressEvent | null>(null);
  const [summary, setSummary] = useState<FriendRequestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetInput('');
    setRunning(false);
    setProgress(null);
    setSummary(null);
    setError(null);
  }, [open]);

  const count = accounts.length;
  const parsedTarget = parseTargetUserId(targetInput);
  const currentPosition = progress ? progress.index + 1 : 0;
  const progressPercent = progress?.total
    ? (currentPosition / progress.total) * 100
    : 0;
  const send = sendRequest ?? ((cookie: string, id: string) => ipc.sendFriendRequest(cookie, id));

  const requestClose = (): void => {
    if (!running) onClose();
  };

  const handleTargetChange = (value: string): void => {
    setTargetInput(value);
    setError(null);
    setSummary(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const targetUserId = parseTargetUserId(targetInput);
    if (!targetUserId) {
      setError('Escribe un User ID o pega un perfil oficial de Roblox.');
      return;
    }

    const senders = toSenders(accounts);
    if (senders.length === 0) return;

    setError(null);
    setSummary(null);
    setProgress(null);
    setRunning(true);

    const result = await processBatchFriendRequests(targetUserId, senders, {
      send,
      onProgress: setProgress,
    });

    setProgress(null);
    setSummary(result);
    setRunning(false);
  };

  const summaryTone = summary
    ? summary.succeeded === summary.total
      ? 'success'
      : summary.succeeded === 0
        ? 'error'
        : 'mixed'
    : undefined;

  return (
    <Modal open={open && count > 0} onClose={requestClose} titleId={titleId}>
      <form className="friend-request-modal" onSubmit={(event) => void submit(event)}>
        <header className="friend-request-modal__header">
          <div className="friend-request-modal__beacon" aria-hidden="true">
            <span />
            <UserRoundPlus size={21} strokeWidth={2} />
          </div>
          <div className="friend-request-modal__heading">
            <span className="friend-request-modal__eyebrow">Social dispatch / Roblox</span>
            <h2 id={titleId}>Enviar solicitud</h2>
            <p>
              {count === 1
                ? `Desde ${displayName(accounts[0])}`
                : `Desde ${count} cuentas seleccionadas`}
            </p>
          </div>
          <button
            className="friend-request-modal__close"
            type="button"
            aria-label="Cerrar"
            disabled={running}
            onClick={requestClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="friend-request-modal__body">
          <section className="friend-request-route" aria-label="Ruta de la solicitud">
            <div className="friend-request-route__node friend-request-route__node--source">
              <div className="friend-request-route__avatars" aria-hidden="true">
                {accounts.slice(0, 3).map((account) => (
                  <span key={account.id} title={displayName(account)}>
                    {senderInitial(account)}
                  </span>
                ))}
                {count > 3 ? <span>+{count - 3}</span> : null}
              </div>
              <span>
                <small>{count === 1 ? 'Cuenta origen' : 'Cuentas origen'}</small>
                <strong>{count === 1 ? displayName(accounts[0]) : `${count} remitentes`}</strong>
              </span>
            </div>

            <div className="friend-request-route__connector" data-running={running || undefined} aria-hidden="true">
              <span className="friend-request-route__line" />
              <AnimatePresence>
                {running ? (
                  <motion.span
                    className="friend-request-route__pulse"
                    initial={{ opacity: 0, x: '-120%' }}
                    animate={
                      reducedMotion
                        ? { opacity: 0.7, x: '90%' }
                        : { opacity: [0, 1, 0], x: ['-120%', '330%'] }
                    }
                    exit={{ opacity: 0 }}
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { duration: 1.35, ease: 'easeInOut', repeat: Infinity }
                    }
                  />
                ) : null}
              </AnimatePresence>
              <span className="friend-request-route__send"><Send size={13} /></span>
            </div>

            <div className="friend-request-route__node friend-request-route__node--target">
              <span className="friend-request-route__target-icon" aria-hidden="true">
                <AtSign size={17} />
              </span>
              <span>
                <small>Perfil destino</small>
                <strong>{parsedTarget ? `UID ${parsedTarget}` : 'Pendiente'}</strong>
              </span>
            </div>
          </section>

          <section className="friend-request-modal__command">
            <div className="friend-request-modal__command-heading">
              <span className="friend-request-modal__command-icon" aria-hidden="true">
                <UsersRound size={17} />
              </span>
              <span>
                <strong>Selecciona el destinatario</strong>
                <small>La misma persona recibirá una solicitud por cada cuenta origen.</small>
              </span>
            </div>

            <label className="friend-request-modal__field" htmlFor={targetId}>
              <span>User ID o enlace de perfil</span>
              <span
                className="friend-request-modal__input-shell"
                data-invalid={Boolean(error) || undefined}
              >
                <AtSign size={16} aria-hidden="true" />
                <input
                  id={targetId}
                  type="text"
                  inputMode="url"
                  value={targetInput}
                  placeholder="123456789 o roblox.com/users/.../profile"
                  autoComplete="off"
                  autoFocus
                  disabled={running}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? targetErrorId : undefined}
                  onChange={(event) => handleTargetChange(event.target.value)}
                />
                {parsedTarget ? <CheckCircle2 size={15} className="friend-request-modal__valid" aria-hidden="true" /> : null}
              </span>
            </label>

            <AnimatePresence initial={false} mode="popLayout">
              {error ? (
                <motion.p
                  key="input-error"
                  id={targetErrorId}
                  className="friend-request-modal__error"
                  role="alert"
                  initial={reducedMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reducedMotion ? 0 : -3 }}
                >
                  <XCircle size={14} aria-hidden="true" /> {error}
                </motion.p>
              ) : null}

              {running && progress ? (
                <motion.div
                  key="progress"
                  className="friend-request-progress"
                  role="status"
                  aria-live="polite"
                  initial={reducedMotion ? false : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="friend-request-progress__copy">
                    <span>
                      <LoaderCircle className="friend-request-modal__spinner" size={15} />
                      Enviando desde <strong>{progress.account.label}</strong>
                    </span>
                    <small>{currentPosition}/{progress.total}</small>
                  </div>
                  <div
                    className="friend-request-progress__track"
                    role="progressbar"
                    aria-label="Progreso del envío"
                    aria-valuemin={1}
                    aria-valuemax={progress.total}
                    aria-valuenow={currentPosition}
                  >
                    <motion.span
                      initial={false}
                      animate={{ width: `${progressPercent}%` }}
                      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 34 }}
                    />
                  </div>
                </motion.div>
              ) : null}

              {summary ? (
                <motion.div
                  key="summary"
                  className="friend-request-summary"
                  data-tone={summaryTone}
                  aria-live="polite"
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="friend-request-summary__heading">
                    <span className="friend-request-summary__icon" aria-hidden="true">
                      {summaryTone === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                    </span>
                    <span>
                      <strong>
                        {summaryTone === 'success'
                          ? 'Solicitudes enviadas'
                          : summaryTone === 'mixed'
                            ? 'Lote completado con alertas'
                            : 'Roblox rechazó el envío'}
                      </strong>
                      <small>{summary.succeeded} de {summary.total} aceptadas</small>
                    </span>
                  </div>
                  <ul className="friend-request-summary__list">
                    {summary.results.map((result) => (
                      <li key={result.id} data-ok={result.ok || undefined}>
                        {result.ok
                          ? <CheckCircle2 size={14} aria-label="Aceptada" />
                          : <XCircle size={14} aria-label="Rechazada" />}
                        <strong>{result.label}</strong>
                        <span>{result.ok ? 'Enviada' : result.reason ?? 'No se pudo enviar'}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>
        </div>

        <footer className="friend-request-modal__footer">
          <div className="friend-request-modal__status" data-running={running || undefined}>
            <span aria-hidden="true" />
            <small>{running ? 'Envío en curso' : summary ? 'Lote completado' : 'Listo para enviar'}</small>
          </div>
          <div className="friend-request-modal__actions">
            <Button variant="secondary" type="button" onClick={requestClose} disabled={running}>
              {summary ? 'Cerrar' : 'Cancelar'}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={running || targetInput.trim().length === 0}
            >
              {running ? <LoaderCircle className="friend-request-modal__spinner" size={16} /> : <Send size={15} />}
              {running ? 'Enviando…' : summary ? 'Enviar de nuevo' : 'Enviar solicitud'}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
