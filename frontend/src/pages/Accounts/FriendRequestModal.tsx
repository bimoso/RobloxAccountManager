import { useEffect, useId, useState, type CSSProperties } from 'react';
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

/**
 * Props for {@link FriendRequestModal}.
 *
 * The modal sends a friend request to a single target user id FROM one or more
 * selected accounts (Requirement 16.1). The sequential batch loop is delegated
 * to the pure {@link processBatchFriendRequests}; each send is wired to
 * `ipc.sendFriendRequest(cookie, targetUserId)`. Any per-account failure is
 * reported inline (Requirements 16.1, 16.5) without stopping the rest.
 */
export interface FriendRequestModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The accounts to send friend requests from. May be a single account or a
   * batch selection; when empty the modal renders closed regardless of
   * {@link open}.
   */
  accounts: Account[];
  /** Called when the user dismisses the modal. */
  onClose: () => void;
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: '340px',
  maxWidth: '440px',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  color: 'var(--t1)',
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '13px',
  color: 'var(--t2)',
};

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: 'var(--bg2)',
  color: 'var(--t1)',
  fontSize: '14px',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: 'var(--t2)',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '4px',
};

const progressTrackStyle: CSSProperties = {
  height: '8px',
  borderRadius: '999px',
  background: 'var(--bg2)',
  overflow: 'hidden',
};

const progressFillStyle = (percent: number): CSSProperties => ({
  height: '100%',
  width: `${Math.max(0, Math.min(100, percent))}%`,
  background: 'var(--accent, #5b8def)',
  transition: 'width 120ms linear',
});

const resultListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  fontSize: '13px',
  maxHeight: '180px',
  overflowY: 'auto',
};

const okResultStyle: CSSProperties = { color: 'var(--t2)' };
const failResultStyle: CSSProperties = { color: 'var(--danger, #e5484d)' };

/** Build the injected sender list from the selected accounts. */
function toSenders(accounts: Account[]): FriendRequestSender[] {
  return accounts.map((account) => ({
    id: account.id,
    label: displayName(account),
    cookie: account.cookie,
  }));
}

/**
 * Batch friend-request modal (Requirement 16.1).
 *
 * The user enters a single target user id (a bare id or a profile URL, parsed
 * by {@link parseTargetUserId}); on submit the modal sends a friend request to
 * that user FROM each selected account by invoking
 * `ipc.sendFriendRequest(cookie, targetUserId)` once per account through the
 * pure {@link processBatchFriendRequests} loop. The individual outcome of every
 * send is reported inline (Requirements 16.1, 16.5). The form resets each time
 * the modal opens.
 */
export function FriendRequestModal({
  open,
  accounts,
  onClose,
}: FriendRequestModalProps): JSX.Element {
  const titleId = useId();
  const [targetInput, setTargetInput] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FriendRequestProgressEvent | null>(
    null,
  );
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

  const submit = async (): Promise<void> => {
    const targetUserId = parseTargetUserId(targetInput);
    if (!targetUserId) {
      setError('Introduce un ID de usuario o enlace de perfil válido.');
      return;
    }
    const senders = toSenders(accounts);
    if (senders.length === 0) return;

    setError(null);
    setSummary(null);
    setRunning(true);
    setProgress({ index: 0, total: senders.length, account: senders[0] });

    const result = await processBatchFriendRequests(targetUserId, senders, {
      send: (cookie, id) => ipc.sendFriendRequest(cookie, id),
      onProgress: (event) => setProgress(event),
    });

    setProgress(null);
    setSummary(result);
    setRunning(false);
  };

  const count = accounts.length;

  return (
    <Modal open={open && count > 0} onClose={onClose} titleId={titleId}>
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          Enviar solicitud de amistad
        </h2>

        <p style={hintStyle}>
          {count === 1
            ? `Se enviará desde ${displayName(accounts[0])}.`
            : `Se enviará desde ${count} cuentas.`}
        </p>

        <label style={labelStyle}>
          Usuario destino (ID o enlace de perfil)
          <input
            style={inputStyle}
            type="text"
            value={targetInput}
            placeholder="p. ej. 123456789"
            onChange={(event) => setTargetInput(event.target.value)}
            disabled={running}
          />
        </label>

        {running && progress && (
          <>
            <div style={progressTrackStyle} aria-hidden="true">
              <div
                style={progressFillStyle(
                  progress.total > 0
                    ? (progress.index / progress.total) * 100
                    : 0,
                )}
              />
            </div>
            <p style={hintStyle}>
              {`Enviando desde ${progress.account.label} (${progress.index + 1} de ${progress.total})…`}
            </p>
          </>
        )}

        {summary && (
          <div style={labelStyle}>
            <p style={hintStyle}>
              {`Se enviaron ${summary.succeeded} de ${summary.total} solicitudes.`}
            </p>
            <ul style={resultListStyle}>
              {summary.results.map((res) => (
                <li key={res.id} style={res.ok ? okResultStyle : failResultStyle}>
                  {res.ok
                    ? `${res.label}: enviada.`
                    : `${res.label}: ${res.reason ?? 'error'}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p style={failResultStyle}>{error}</p>}

        <div style={footerStyle}>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {summary ? 'Cerrar' : 'Cancelar'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={running || targetInput.trim().length === 0}
          >
            {running ? 'Enviando…' : 'Enviar solicitud'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
