import { useEffect, useId, useState } from 'react';
import { Check, CircleAlert, Info } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';
import './accountModal.css';

/**
 * Props for {@link QuickLoginModal}.
 *
 * The modal authorizes a quick-login code for a single account (Requirement
 * 16.4) by invoking `ipc.quickLogin(cookie, code)`. On failure the backend
 * message is surfaced inline within the modal (Requirement 16.5).
 */
export interface QuickLoginModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The account to authorize the quick-login code for, or `null` when none is
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
  return 'No se pudo autorizar el código de quick login.';
}

/**
 * Quick-login modal for a single account (Requirement 16.4).
 *
 * Collects the quick-login code the user reads from the Roblox login screen and,
 * on submit, invokes `ipc.quickLogin(account.cookie, code)`, which enters AND
 * confirms the cross-device login code. A successful authorization closes the
 * modal; a failure keeps it open and shows the backend message inline
 * (Requirement 16.5). The form resets each time the modal opens.
 */
export function QuickLoginModal({
  open,
  account,
  onClose,
}: QuickLoginModalProps): JSX.Element {
  const titleId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setBusy(false);
    setError(null);
    setDone(false);
  }, [open, account]);

  const submit = async (): Promise<void> => {
    if (!account) return;
    const trimmed = code.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);
    try {
      await ipc.quickLogin(account.cookie, trimmed);
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
            {label ? `Quick login — ${label}` : 'Quick login'}
          </h2>
        </div>

        <p className="acctmodal__hint">
          <Info size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />
          Introduce el código que aparece en la pantalla de inicio de sesión de Roblox del otro
          dispositivo; esta cuenta lo autorizará y ese dispositivo quedará dentro.
        </p>

        <label className="acctmodal__field">
          Código de quick login
          <input
            className="acctmodal__input"
            type="text"
            value={code}
            placeholder="p. ej. ABC-DEF"
            onChange={(event) => setCode(event.target.value)}
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
            Quick login autorizado.
          </p>
        )}

        <div className="acctmodal__footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || code.trim().length === 0}
          >
            {busy ? 'Autorizando…' : 'Autorizar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
