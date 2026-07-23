import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import type { Account } from '@/types/models';
import {
  computeChangedFields,
  editFormInitialValues,
  type EditFormValues,
} from './editAccount';
import './EditAccountModal.css';

/**
 * Props for {@link EditAccountModal}.
 *
 * The modal edits a single account's nickname, launch destination, notes, and
 * saved login credentials (Requirement 14). Preloading and the changed-field
 * computation are delegated to the pure helpers in `./editAccount`
 * ({@link editFormInitialValues} / {@link computeChangedFields}); persistence
 * itself is the account store's responsibility, invoked through {@link onSave}.
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

/**
 * Edit modal for a saved account.
 *
 * On open it preloads the nickname, launch destination (`gameTarget`), notes and
 * login credentials from the account via {@link editFormInitialValues}
 * (Requirement 14.1). On save it trims the current inputs (except the password),
 * derives the changed subset with {@link computeChangedFields}, and — when at
 * least one field changed — invokes {@link EditAccountModalProps.onSave} with the
 * account id and only those changed fields (Requirement 14.2), which the page
 * forwards to `accounts_update`. Saving with no changes closes the modal without
 * an IPC call. The form resets to the given account every time the modal opens.
 */
export function EditAccountModal({
  open,
  account,
  onClose,
  onSave,
}: EditAccountModalProps): JSX.Element {
  const titleId = useId();
  const empty: EditFormValues = {
    nickname: '',
    gameTarget: '',
    notes: '',
    loginUsername: '',
    password: '',
  };
  const [initial, setInitial] = useState<EditFormValues>(empty);
  const [values, setValues] = useState<EditFormValues>(empty);
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
    // matching the legacy edit form. The password is left verbatim since
    // surrounding whitespace could be significant.
    const finalValues: EditFormValues = {
      nickname: values.nickname.trim(),
      gameTarget: values.gameTarget.trim(),
      notes: values.notes.trim(),
      loginUsername: values.loginUsername.trim(),
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
      <div className="editacc">
        <div className="editacc__head">
          <span className="editacc__eyebrow">Cuenta</span>
          <h2 id={titleId} className="editacc__title">
            {label ? `Editar — ${label}` : 'Editar cuenta'}
          </h2>
        </div>

        <label className="editacc__field">
          Apodo
          <input
            className="editacc__input"
            type="text"
            value={values.nickname}
            placeholder="Apodo"
            onChange={(event) => setField('nickname', event.target.value)}
          />
        </label>

        <label className="editacc__field">
          Destino
          <input
            className="editacc__input"
            type="text"
            value={values.gameTarget}
            placeholder="ID de juego o enlace de servidor privado"
            onChange={(event) => setField('gameTarget', event.target.value)}
          />
        </label>

        <label className="editacc__field">
          Notas
          <textarea
            className="editacc__textarea"
            value={values.notes}
            placeholder="Notas"
            onChange={(event) => setField('notes', event.target.value)}
          />
        </label>

        <label className="editacc__field">
          Usuario de inicio de sesión
          <input
            className="editacc__input"
            type="text"
            value={values.loginUsername}
            placeholder="Usuario o correo (para re-login)"
            autoComplete="off"
            onChange={(event) => setField('loginUsername', event.target.value)}
          />
        </label>

        <label className="editacc__field">
          Contraseña
          <input
            className="editacc__input"
            type="password"
            value={values.password}
            placeholder="Contraseña guardada (para re-login)"
            autoComplete="new-password"
            onChange={(event) => setField('password', event.target.value)}
          />
        </label>

        {error && <p className="editacc__error">{error}</p>}

        <div className="editacc__footer">
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
