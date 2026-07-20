import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import type { Account } from '@/types/models';
import {
  computeChangedFields,
  editFormInitialValues,
  type EditFormValues,
} from './editAccount';

/**
 * Props for {@link EditAccountModal}.
 *
 * The modal edits a single account's nickname, launch destination and notes
 * (Requirement 14). Preloading and the changed-field computation are delegated
 * to the pure helpers in `./editAccount` ({@link editFormInitialValues} /
 * {@link computeChangedFields}); persistence itself is the account store's
 * responsibility, invoked through {@link onSave}.
 */
export interface EditAccountModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The account being edited, or `null` when no account is selected. When
   * `null` the modal renders closed regardless of {@link open}.
   */
  account: Account | null;
  /** Called when the user dismisses the modal without saving. */
  onClose: () => void;
  /**
   * Persist the changed fields for the account (Requirement 14.2). The page
   * wires this to `accountStore.update(account.id, changedFields)`. May reject;
   * the modal then stays open and shows an inline message so the user can
   * retry.
   */
  onSave: (id: string, changedFields: Partial<EditFormValues>) => Promise<void>;
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: '320px',
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

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: '72px',
  resize: 'vertical',
  fontFamily: 'inherit',
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

/**
 * Edit modal for a saved account.
 *
 * On open it preloads the nickname, launch destination (`gameTarget`) and notes
 * from the account via {@link editFormInitialValues} (Requirement 14.1). On save
 * it trims the current inputs, derives the changed subset with
 * {@link computeChangedFields}, and — when at least one field changed — invokes
 * {@link EditAccountModalProps.onSave} with the account id and only those
 * changed fields (Requirement 14.2), which the page forwards to
 * `accounts_update`. Saving with no changes closes the modal without an IPC
 * call. The form resets to the given account every time the modal opens.
 */
export function EditAccountModal({
  open,
  account,
  onClose,
  onSave,
}: EditAccountModalProps): JSX.Element {
  const titleId = useId();
  const [initial, setInitial] = useState<EditFormValues>({
    nickname: '',
    gameTarget: '',
    notes: '',
    loginUsername: '',
    password: '',
  });
  const [values, setValues] = useState<EditFormValues>({
    nickname: '',
    gameTarget: '',
    notes: '',
    loginUsername: '',
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preload the form from the account each time the modal opens (Req 14.1).
  useEffect(() => {
    if (!open || !account) return;
    const preloaded = editFormInitialValues(account);
    setInitial(preloaded);
    setValues(preloaded);
    setSaving(false);
    setError(null);
  }, [open, account]);

  const setField = (field: keyof EditFormValues, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSave = async (): Promise<void> => {
    if (!account) return;
    // Trim before diffing so trailing whitespace never counts as a change,
    // matching the legacy edit form.
    const finalValues: EditFormValues = {
      nickname: values.nickname.trim(),
      gameTarget: values.gameTarget.trim(),
      notes: values.notes.trim(),
      loginUsername: values.loginUsername.trim(),
      // The password is stored verbatim — never trimmed — since surrounding
      // whitespace could be significant.
      password: values.password,
    };
    const changedFields = computeChangedFields(initial, finalValues);

    // Nothing changed: no IPC call, just close (Req 14.2 fires only for changes).
    if (Object.keys(changedFields).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(account.id, changedFields);
      onClose();
    } catch {
      // The IPC layer already surfaced a toast; keep the modal open for a retry.
      setError('No se pudieron guardar los cambios. Inténtalo de nuevo.');
      setSaving(false);
    }
  };

  const label = account ? account.nickname?.trim() || account.username : '';

  return (
    <Modal open={open && account !== null} onClose={onClose} titleId={titleId}>
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          {label ? `Editar - ${label}` : 'Editar cuenta'}
        </h2>

        <label style={labelStyle}>
          Apodo
          <input
            style={inputStyle}
            type="text"
            value={values.nickname}
            placeholder="Apodo"
            onChange={(event) => setField('nickname', event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Destino
          <input
            style={inputStyle}
            type="text"
            value={values.gameTarget}
            placeholder="ID de juego o enlace de servidor privado"
            onChange={(event) => setField('gameTarget', event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Notas
          <textarea
            style={textareaStyle}
            value={values.notes}
            placeholder="Notas"
            onChange={(event) => setField('notes', event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Usuario de inicio de sesión
          <input
            style={inputStyle}
            type="text"
            value={values.loginUsername}
            placeholder="Usuario o correo (para re-login)"
            autoComplete="off"
            onChange={(event) => setField('loginUsername', event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Contraseña
          <input
            style={inputStyle}
            type="password"
            value={values.password}
            placeholder="Contraseña guardada (para re-login)"
            autoComplete="new-password"
            onChange={(event) => setField('password', event.target.value)}
          />
        </label>

        {error && <p style={errorStyle}>{error}</p>}

        <div style={footerStyle}>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
