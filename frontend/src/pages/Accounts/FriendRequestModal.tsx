import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  AtSign,
  CheckCircle2,
  Send,
  UsersRound,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account } from '@/types/models';
import {
  parseTargetUserId,
  processBatchFriendRequests,
  type FriendRequestProgressEvent,
  type FriendRequestSender,
  type FriendRequestSummary,
} from './friendRequest';
// `.acc-head` (the dialog head row) and `.acc-meter` (the determinate meter,
// animated with scaleX) are shared account-dialog recipes declared once in
// AddAccountModal.css.
import './AddAccountModal.css';
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

/** Meter fill as a `--fill` scale factor consumed by `.acc-meter__fill`. */
function meterStyle(ratio: number): CSSProperties {
  return { '--fill': Math.max(0, Math.min(1, ratio)) } as CSSProperties;
}

/**
 * Send a friend request from one or more selected accounts to one validated
 * Roblox profile. The dialog reads as a source -> target dispatch: a route
 * strip naming who sends and who receives, the shared field recipe for the
 * target, and a hairline-ruled per-account result list once the batch ends.
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
  const { t } = useTranslation();
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
  const progressRatio = progress?.total ? currentPosition / progress.total : 0;
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
      setError(t('friends.invalidTarget'));
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

  const statusTone = running ? 'accent' : summary ? 'ok' : undefined;

  return (
    <Modal open={open && count > 0} onClose={requestClose} titleId={titleId} size="lg">
      <form className="fm-root friend-request-modal" onSubmit={(event) => void submit(event)}>
        <div className="acc-head">
          <div className="fm-head">
            <h2 id={titleId} className="fm-title">{t('friends.title')}</h2>
            <p className="fm-hint">
              {count === 1
                ? t('friends.fromOne', { name: displayName(accounts[0]) })
                : t('friends.fromMany', { count })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            type="button"
            aria-label={t('friends.close')}
            disabled={running}
            onClick={requestClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        <section
          className="rk-panel friend-request-route"
          aria-label={t('friends.routeAria')}
          data-running={running || undefined}
        >
          <div className="friend-request-route__node">
            <div className="friend-request-route__avatars" aria-hidden="true">
              {accounts.slice(0, 3).map((account) => (
                <span key={account.id} title={displayName(account)}>
                  {senderInitial(account)}
                </span>
              ))}
              {count > 3 ? <span>+{count - 3}</span> : null}
            </div>
            <span className="friend-request-route__copy">
              <small>{count === 1 ? t('friends.sourceOne') : t('friends.sourceMany')}</small>
              <strong>
                {count === 1 ? displayName(accounts[0]) : t('friends.sendersCount', { count })}
              </strong>
            </span>
          </div>

          <span className="friend-request-route__arrow" aria-hidden="true">
            {running ? <span className="rk-spin" /> : <ArrowRight size={15} />}
          </span>

          <div className="friend-request-route__node">
            <span className="friend-request-route__icon" aria-hidden="true">
              <AtSign size={15} />
            </span>
            <span className="friend-request-route__copy">
              <small>{t('friends.targetLabel')}</small>
              <strong className="u-num">
                {parsedTarget ? t('friends.uid', { uid: parsedTarget }) : t('friends.pending')}
              </strong>
            </span>
          </div>
        </section>

        <div className="friend-request-modal__command">
          <div className="friend-request-modal__lead">
            <UsersRound size={15} aria-hidden="true" />
            <span>
              <strong>{t('friends.pickTitle')}</strong>
              <small>{t('friends.pickHint')}</small>
            </span>
          </div>

          <div className="fm-field">
            <label htmlFor={targetId}>{t('friends.fieldLabel')}</label>
            <input
              id={targetId}
              className="fm-input"
              type="text"
              inputMode="url"
              value={targetInput}
              placeholder={t('friends.fieldPlaceholder')}
              autoComplete="off"
              autoFocus
              disabled={running}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? targetErrorId : undefined}
              onChange={(event) => handleTargetChange(event.target.value)}
            />
          </div>

          <AnimatePresence initial={false} mode="popLayout">
            {error ? (
              <motion.p
                key="input-error"
                id={targetErrorId}
                className="fm-error"
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
                className="acc-meter friend-request-progress"
                role="status"
                aria-live="polite"
                initial={reducedMotion ? false : { opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <div className="friend-request-progress__copy">
                  <span>
                    <span className="rk-spin" aria-hidden="true" />
                    {t('friends.sendingFrom')} <strong>{progress.account.label}</strong>
                  </span>
                  <small className="u-num">{currentPosition}/{progress.total}</small>
                </div>
                <div
                  className="acc-meter__track"
                  role="progressbar"
                  aria-label={t('friends.progressAria')}
                  aria-valuemin={1}
                  aria-valuemax={progress.total}
                  aria-valuenow={currentPosition}
                >
                  <div className="acc-meter__fill" style={meterStyle(progressRatio)} />
                </div>
              </motion.div>
            ) : null}

            {summary ? (
              <motion.div
                key="summary"
                className="rk-panel friend-request-summary"
                data-tone={summaryTone}
                aria-live="polite"
                initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <div className="friend-request-summary__heading">
                  <span className="friend-request-summary__icon" aria-hidden="true">
                    {summaryTone === 'success' ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                  </span>
                  <span>
                    <strong>
                      {summaryTone === 'success'
                        ? t('friends.summarySuccess')
                        : summaryTone === 'mixed'
                          ? t('friends.summaryMixed')
                          : t('friends.summaryError')}
                    </strong>
                    <small>
                      {t('friends.acceptedCount', { ok: summary.succeeded, total: summary.total })}
                    </small>
                  </span>
                </div>
                <ul className="friend-request-summary__list">
                  {summary.results.map((result) => (
                    <li key={result.id} className="rk-row" data-ok={result.ok || undefined}>
                      <span className="rk-row__gutter">
                        {result.ok ? (
                          <CheckCircle2 size={14} aria-label={t('friends.acceptedAria')} />
                        ) : (
                          <XCircle size={14} aria-label={t('friends.rejectedAria')} />
                        )}
                      </span>
                      <strong className="rk-row__title">{result.label}</strong>
                      <span className="friend-request-summary__note">
                        {result.ok ? t('friends.sent') : result.reason ?? t('friends.failed')}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <footer className="friend-request-modal__footer">
          <div className="friend-request-modal__status" data-running={running || undefined}>
            <span className="rk-dot" data-tone={statusTone} aria-hidden="true" />
            <small>
              {running
                ? t('friends.statusRunning')
                : summary
                  ? t('friends.statusDone')
                  : t('friends.statusIdle')}
            </small>
          </div>
          <div className="fm-footer">
            <Button variant="secondary" type="button" onClick={requestClose} disabled={running}>
              {summary ? t('friends.close') : t('friends.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={running || targetInput.trim().length === 0}
            >
              {running ? (
                <span className="rk-spin" aria-hidden="true" />
              ) : (
                <Send size={15} aria-hidden="true" />
              )}
              {running ? t('friends.sending') : summary ? t('friends.resend') : t('friends.submit')}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
