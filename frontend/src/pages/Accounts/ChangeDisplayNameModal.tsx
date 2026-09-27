import { useEffect, useId, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ipc } from '@/lib/ipc';
import { displayName } from '@/lib/filters';
import type { Account } from '@/types/models';


/**
 * Props for {@link ChangeDisplayNameModal}.
 *
 * The modal changes a single account's Roblox display name (Requirement 16.3)
 * by invoking `ipc.changeDisplayName(cookie, userId, newDisplayName)`. On
 * failure the backend message is surfaced inline within the modal
 * (Requirement 16.5).
 */
export interface ChangeDisplayNameModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The account whose display name is being changed, or `null` when none is
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
  return 'No se pudo cambiar el nombre de display.';
}

/**
 * Change-display-name modal for a single account (Requirement 16.3).
 *
 * Collects the new display name and, on submit, invokes
 * `ipc.changeDisplayName(account.cookie, account.userId, newDisplayName)`. A
 * successful change closes the modal; a failure keeps it open and shows the
 * backend message inline (Requirement 16.5). The form resets each time the
 * modal opens.
 */
export function ChangeDisplayNameModal({
  open,
  account,
  onClose,
}: ChangeDisplayNameModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNewName('');
    setBusy(false);
    setError(null);
    setDone(false);
  }, [open, account]);

  const submit = async (): Promise<void> => {
    if (!account) return;
    const next = newName.trim();
    if (!next) return;

    setBusy(true);
    setError(null);
    try {
      await ipc.changeDisplayName(account.cookie, account.userId, next);
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
    <Modal open={open && account !== null} onClose={onClose} titleId={titleId} size="sm">
      <div className="fm-root">
        <div className="fm-head">
          <span className="fm-eyebrow">{t('accounts.edit.eyebrow')}</span>
          <h2 id={titleId} className="fm-title">
            {label ? t('accounts.displayName.titleWith', { label }) : t('accounts.displayName.title')}
          </h2>
        </div>

        <label className="fm-field">
          {t('accounts.displayName.label')}
          <input
            className="fm-input"
            type="text"
            value={newName}
            placeholder={t('accounts.displayName.placeholder')}
            onChange={(event) => setNewName(event.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <p className="fm-error">
            <CircleAlert size={15} aria-hidden="true" />
            {error}
          </p>
        )}
        {done && !error && (
          <p className="fm-success">
            <Check size={15} aria-hidden="true" />
            {t('accounts.displayName.success')}
          </p>
        )}

        <div className="fm-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('accounts.displayName.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || newName.trim().length === 0}
          >
            {busy ? t('accounts.displayName.submitting') : t('accounts.displayName.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
