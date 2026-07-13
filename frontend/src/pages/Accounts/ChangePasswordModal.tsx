import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';

/**
 * Props for {@link ChangePasswordModal}.
 *
 * The modal changes a single account's password (Requirement 16.2) by invoking
 * `ipc.changePassword(cookie, currentPassword, newPassword)`. On failure the
 * backend message is surfaced inline within the modal (Requirement 16.5).
 */
export interface ChangePasswordModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The account whose password is being changed, or `null` when none is
   * selected. When `null` the modal renders closed regardless of {@link open}.
   */
  account: Account | null;
  /** Called when the user dismisses the modal. */
  onClose: () => void;
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: '340px',
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

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '4px',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: 'var(--danger, #e5484d)',
};

const successStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: 'var(--t2)',
};

/**
 * Extract the backend/thrown error message so it can be shown inside the modal
 * (Requirement 16.5), falling back to a generic message.
 */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  return 'No se pudo cambiar la contraseña.';
}

/**
 * Change-password modal for a single account (Requirement 16.2).
 *
 * Collects the current and new password and, on submit, invokes
 * `ipc.changePassword(account.cookie, currentPassword, newPassword)`. A
 * successful change closes the modal; a failure keeps it open and shows the
 * message returned by the backend inline (Requirement 16.5). The form resets
 * each time the modal opens.
 */
export function ChangePasswordModal({
  open,
  account,
  onClose,
}: ChangePasswordModalProps): JSX.Element {
  const titleId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword('');
    setNewPassword('');
    setBusy(false);
    setError(null);
    setDone(false);
  }, [open, account]);

  const submit = async (): Promise<void> => {
    if (!account) return;
    const current = currentPassword;
    const next = newPassword;
    if (!current || !next) return;

    setBusy(true);
    setError(null);
    try {
      await ipc.changePassword(account.cookie, current, next);
      setDone(true);
      setBusy(false);
      onClose();
    } catch (err) {
      // Surface the backend message inside the modal (Req 16.5).
      setError(describeError(err));
      setBusy(false);
    }
  };

  const label = account ? displayName(account) : '';

  return (
    <Modal open={open && account !== null} onClose={onClose} titleId={titleId}>
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          {label ? `Cambiar contraseña - ${label}` : 'Cambiar contraseña'}
        </h2>

        <label style={labelStyle}>
          Contraseña actual
          <input
            style={inputStyle}
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            placeholder="Contraseña actual"
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        <label style={labelStyle}>
          Nueva contraseña
          <input
            style={inputStyle}
            type="password"
            value={newPassword}
            autoComplete="new-password"
            placeholder="Nueva contraseña"
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p style={errorStyle}>{error}</p>}
        {done && !error && <p style={successStyle}>Contraseña cambiada.</p>}

        <div style={footerStyle}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={
              busy ||
              currentPassword.length === 0 ||
              newPassword.length === 0
            }
          >
            {busy ? 'Cambiando…' : 'Cambiar contraseña'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
