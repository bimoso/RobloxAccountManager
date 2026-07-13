import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';

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
  return 'No se pudo autorizar el código de quick login.';
}

/**
 * Quick-login modal for a single account (Requirement 16.4).
 *
 * Collects the quick-login code the user reads from the Roblox login screen and,
 * on submit, invokes `ipc.quickLogin(account.cookie, code)`. A successful
 * authorization closes the modal; a failure keeps it open and shows the backend
 * message inline (Requirement 16.5). The form resets each time the modal opens.
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
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          {label ? `Quick login - ${label}` : 'Quick login'}
        </h2>

        <p style={hintStyle}>
          Introduce el código que aparece en la pantalla de inicio de sesión de
          Roblox para autorizar esta cuenta.
        </p>

        <label style={labelStyle}>
          Código de quick login
          <input
            style={inputStyle}
            type="text"
            value={code}
            placeholder="p. ej. ABC-DEF"
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p style={errorStyle}>{error}</p>}
        {done && !error && <p style={successStyle}>Quick login autorizado.</p>}

        <div style={footerStyle}>
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
