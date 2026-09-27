import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { useTranslation } from '@/i18n/useTranslation';
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
  const { t } = useTranslation();
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
    <Modal open={open && account !== null} onClose={onClose} titleId={titleId} size="md">
      <div className="fm-root editacc">
        <div className="fm-head">
          <span className="fm-eyebrow">{t('accounts.edit.eyebrow')}</span>
          <h2 id={titleId} className="fm-title">
            {label ? t('accounts.edit.titleWith', { label }) : t('accounts.edit.title')}
          </h2>
        </div>

        <label className="fm-field">
          {t('accounts.edit.nickname')}
          <input
            className="fm-input"
            type="text"
            value={values.nickname}
            placeholder={t('accounts.edit.nicknamePlaceholder')}
            onChange={(event) => setField('nickname', event.target.value)}
          />
        </label>

        <label className="fm-field">
          {t('accounts.edit.target')}
          <input
            className="fm-input"
            type="text"
            value={values.gameTarget}
            placeholder={t('accounts.edit.targetPlaceholder')}
            onChange={(event) => setField('gameTarget', event.target.value)}
          />
        </label>

        <label className="fm-field">
          {t('accounts.edit.notes')}
          <textarea
            className="fm-textarea"
            value={values.notes}
            placeholder={t('accounts.edit.notesPlaceholder')}
            onChange={(event) => setField('notes', event.target.value)}
          />
        </label>

        <label className="fm-field">
          {t('accounts.edit.loginUsername')}
          <input
            className="fm-input"
            type="text"
            value={values.loginUsername}
            placeholder={t('accounts.edit.loginUsernamePlaceholder')}
            autoComplete="off"
            onChange={(event) => setField('loginUsername', event.target.value)}
          />
        </label>

        <label className="fm-field">
          {t('accounts.edit.password')}
          <input
            className="fm-input"
            type="password"
            value={values.password}
            placeholder={t('accounts.edit.passwordPlaceholder')}
            autoComplete="new-password"
            onChange={(event) => setField('password', event.target.value)}
          />
        </label>

        {error && <p className="fm-error">{error}</p>}

        <div className="fm-footer">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('accounts.edit.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {t('accounts.edit.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
