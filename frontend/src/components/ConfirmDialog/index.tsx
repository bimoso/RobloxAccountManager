import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Props for {@link ConfirmDialog}, the modal confirmation prompt used by
 * destructive flows such as bulk delete (Requirements 10.4 / 10.7) and
 * "Delete all" (Requirement 21.6) (design.md → Component_Library).
 *
 * The caller owns the open/closed state and both outcomes: confirming calls
 * {@link ConfirmDialogProps.onConfirm} and cancelling (button, backdrop, or
 * Escape) calls {@link ConfirmDialogProps.onCancel}. Neither handler closes the
 * dialog on its own — the parent decides by flipping
 * {@link ConfirmDialogProps.open}.
 */
export interface ConfirmDialogProps {
  /** Whether the dialog is visible. Mounting/unmounting is animated. */
  open: boolean;
  /** The confirmation prompt shown to the user (e.g. "Delete 3 accounts?"). */
  message: string;
  /** Invoked when the user confirms the action. */
  onConfirm: () => void;
  /** Invoked when the user cancels via the button, backdrop click, or Escape. */
  onCancel: () => void;
  /** Optional heading shown above the message. @defaultValue "Confirm" */
  title?: string;
  /** Label for the confirm button. @defaultValue "Confirm" */
  confirmLabel?: string;
  /** Label for the cancel button. @defaultValue "Cancel" */
  cancelLabel?: string;
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,.5)',
  padding: '20px',
};

const dialogStyle: CSSProperties = {
  width: '100%',
  maxWidth: '360px',
  padding: '20px',
  borderRadius: 'var(--r, 12px)',
  border: '1px solid var(--bd2)',
  background: 'var(--glass-2, var(--s1))',
  color: 'var(--t1)',
  boxShadow: 'var(--glass-shadow, 0 20px 50px rgba(0,0,0,.5))',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '10px',
  marginTop: '20px',
};

const buttonBase: CSSProperties = {
  padding: '8px 16px',
  borderRadius: 'var(--r2, 8px)',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--bd2)',
};

/**
 * Modal confirm/cancel prompt. Built self-contained on `AnimatePresence` (so it
 * is not removed from the DOM until its exit animation finishes) and native
 * buttons; it can later be refactored onto the shared `Modal`/`Button`
 * components without changing this prop contract.
 */
export function ConfirmDialog({
  open,
  message,
  onConfirm,
  onCancel,
  title = 'Confirm',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          style={backdropStyle}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onCancel}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            style={dialogStyle}
            initial={{ opacity: 0, transform: 'scale(0.95)' }}
            animate={{ opacity: 1, transform: 'scale(1)' }}
            exit={{ opacity: 0, transform: 'scale(0.95)' }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 style={{ margin: '0 0 8px', fontSize: '16px' }}>{title}</h2>
            <p style={{ margin: 0, color: 'var(--t2)', fontSize: '14px' }}>{message}</p>
            <div style={buttonRowStyle}>
              <button
                type="button"
                onClick={onCancel}
                style={{ ...buttonBase, background: 'var(--s3)', color: 'var(--t1)' }}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                style={{ ...buttonBase, background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' }}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
