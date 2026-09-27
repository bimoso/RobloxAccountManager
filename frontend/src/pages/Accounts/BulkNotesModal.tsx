import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account } from '@/types/models';


/**
 * Props for {@link BulkNotesModal}.
 *
 * Writes a note to every selected account. When "append" is on, the text is
 * added to each account's existing notes; otherwise it replaces them (mirrors
 * the legacy renderer's bulk-notes flow).
 */
export interface BulkNotesModalProps {
  open: boolean;
  accounts: Account[];
  onClose: () => void;
  /** Persist the notes field for a single account. */
  onSave: (id: string, notes: string) => Promise<void>;
}

/** Read the existing notes (with legacy `note` fallback) as a plain string. */
function existingNotes(account: Account): string {
  const raw = (account.notes ?? account.note ?? '') as unknown;
  return String(raw);
}

export function BulkNotesModal({
  open,
  accounts,
  onClose,
  onSave,
}: BulkNotesModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [append, setAppend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setAppend(true);
    setBusy(false);
    setResult(null);
  }, [open]);

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (append && !value) return;
    setBusy(true);
    setResult(null);
    let ok = 0;
    for (const account of accounts) {
      const current = existingNotes(account).trim();
      const notes = append && current && value ? `${current}\n${value}` : value;
      try {
        await onSave(account.id, notes);
        ok += 1;
      } catch {
        /* keep going; store surfaced the toast */
      }
    }
    setBusy(false);
    setResult(t('accounts.bulkNotes.result', { ok, total: accounts.length }));
    if (ok === accounts.length) {
      setTimeout(onClose, 500);
    }
  };

  const count = accounts.length;

  return (
    <Modal open={open && count > 0} onClose={onClose} titleId={titleId} size="md">
      <div className="fm-root">
        <div className="fm-head">
          <span className="fm-eyebrow">{t('accounts.bulkNotes.eyebrow')}</span>
          <h2 id={titleId} className="fm-title">
            {t('accounts.bulkNotes.title')}
          </h2>
        </div>
        <p className="fm-hint">
          {count === 1 ? t('accounts.bulkNotes.oneSelected') : t('accounts.bulkNotes.manySelected', { count })}
        </p>

        <label className="fm-field">
          {t('accounts.bulkNotes.noteLabel')}
          <textarea
            className="fm-textarea"
            value={text}
            placeholder={t('accounts.bulkNotes.notePlaceholder')}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
        </label>

        <label className="fm-check">
          <input
            type="checkbox"
            checked={append}
            onChange={(event) => setAppend(event.target.checked)}
            disabled={busy}
          />
          {t('accounts.bulkNotes.appendLabel')}
        </label>

        {result && <p className="fm-hint">{result}</p>}

        <div className="fm-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {result ? t('accounts.bulkNotes.close') : t('accounts.bulkNotes.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || (append && text.trim().length === 0)}
          >
            {busy ? t('accounts.bulkNotes.saving') : t('accounts.bulkNotes.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
