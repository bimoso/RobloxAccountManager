import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
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

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: '360px',
  maxWidth: '440px',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: '17px', color: 'var(--t1)' };
const hintStyle: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--t2)' };
const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '13px',
  color: 'var(--t2)',
};
const textareaStyle: CSSProperties = {
  minHeight: '96px',
  resize: 'vertical',
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--bd2)',
  background: 'var(--s2)',
  color: 'var(--t1)',
  font: 'inherit',
  fontSize: '14px',
};
const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '13px',
  color: 'var(--t2)',
};
const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '4px',
};

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
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          Notas en lote
        </h2>
        <p style={hintStyle}>
          {count === 1 ? '1 cuenta seleccionada.' : `${count} cuentas seleccionadas.`}
        </p>

        <label style={labelStyle}>
          Nota
          <textarea
            style={textareaStyle}
            value={text}
            placeholder="Escribe una nota…"
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
        </label>

        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={append}
            onChange={(event) => setAppend(event.target.checked)}
            disabled={busy}
          />
          Añadir a las notas existentes (en lugar de reemplazarlas)
        </label>

        {result && <p style={hintStyle}>{result}</p>}

        <div style={footerStyle}>
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
