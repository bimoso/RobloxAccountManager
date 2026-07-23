import { useEffect, useId, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';
import './accountModal.css';

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
      <div className="acctmodal">
        <div className="acctmodal__head">
          <span className="acctmodal__eyebrow">Cuenta</span>
          <h2 id={titleId} className="acctmodal__title">
            {label ? `Cambiar contraseña — ${label}` : 'Cambiar contraseña'}
          </h2>
        </div>

        <label className="acctmodal__field">
          Contraseña actual
          <input
            className="acctmodal__input"
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            placeholder="Contraseña actual"
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        <label className="acctmodal__field">
          Nueva contraseña
          <input
            className="acctmodal__input"
            type="password"
            value={newPassword}
            autoComplete="new-password"
            placeholder="Nueva contraseña"
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <p className="acctmodal__error">
            <CircleAlert size={15} aria-hidden="true" />
            {error}
          </p>
        )}
        {done && !error && (
          <p className="acctmodal__success">
            <Check size={15} aria-hidden="true" />
            Contraseña cambiada.
          </p>
        )}

        <div className="acctmodal__footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || currentPassword.length === 0 || newPassword.length === 0}
          >
            {busy ? 'Cambiando…' : 'Cambiar contraseña'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
