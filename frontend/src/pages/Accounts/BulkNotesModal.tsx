import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import type { Account } from '@/types/models';
import './accountModal.css';

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
    setResult(`Notas guardadas para ${ok} de ${accounts.length} cuentas.`);
    if (ok === accounts.length) {
      setTimeout(onClose, 500);
    }
  };

  const count = accounts.length;

  return (
    <Modal open={open && count > 0} onClose={onClose} titleId={titleId}>
      <div className="acctmodal">
        <div className="acctmodal__head">
          <span className="acctmodal__eyebrow">Cuentas</span>
          <h2 id={titleId} className="acctmodal__title">
            Notas en lote
          </h2>
        </div>
        <p className="acctmodal__hint">
          {count === 1 ? '1 cuenta seleccionada.' : `${count} cuentas seleccionadas.`}
        </p>

        <label className="acctmodal__field">
          Nota
          <textarea
            className="acctmodal__textarea"
            value={text}
            placeholder="Escribe una nota…"
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
        </label>

        <label className="acctmodal__check">
          <input
            type="checkbox"
            checked={append}
            onChange={(event) => setAppend(event.target.checked)}
            disabled={busy}
          />
          Añadir a las notas existentes (en lugar de reemplazarlas)
        </label>

        {result && <p className="acctmodal__hint">{result}</p>}

        <div className="acctmodal__footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {result ? 'Cerrar' : 'Cancelar'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || (append && text.trim().length === 0)}
          >
            {busy ? 'Guardando…' : 'Guardar notas'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
