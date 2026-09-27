import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from '../../i18n/useTranslation';
import { Button } from '../Button';
import '../Modal/Modal.css';

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

/**
 * Modal confirm/cancel prompt.
 *
 * It shares the app's modal chrome (`.modal-backdrop` / `.modal-content` from
 * components/Modal) and the shared form chrome (`.fm-*` from
 * styles/form-modal.css), and routes both actions through the shared
 * {@link Button}, so a confirmation looks exactly like every other dialog
 * instead of carrying its own inline-styled surface and buttons.
 *
 * It keeps its own `AnimatePresence` (so it is not removed from the DOM until
 * its exit animation finishes) rather than delegating to `Modal`, because the
 * caller contract here is confirm/cancel rather than open/close.
 */
export function ConfirmDialog({
  open,
  message,
  onConfirm,
  onCancel,
  title,
  confirmLabel,
  cancelLabel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;
  const resolvedTitle = title ?? t('common.confirm');
  const resolvedConfirmLabel = confirmLabel ?? t('common.confirm');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  // Open/close asymmetry on the motion-token scale: the dialog arrives over
  // --dur-fast and gets out of the way over --dur-quick; both collapse to 0
  // under reduced motion.
  const openDuration = reducedMotion ? 0 : 0.25;
  const closeDuration = reducedMotion ? 0 : 0.15;
  const ease = [0.22, 1, 0.36, 1] as const;
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
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: closeDuration, ease } }}
          transition={{ duration: openDuration, ease }}
          onClick={onCancel}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={resolvedTitle}
            className="modal-content"
            data-size="sm"
            initial={{ opacity: 0, transform: 'scale(0.96)' }}
            animate={{ opacity: 1, transform: 'scale(1)' }}
            exit={{
              opacity: 0,
              transform: 'scale(0.98)',
              transition: { duration: closeDuration, ease },
            }}
            transition={{ duration: openDuration, ease }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fm-root">
              <div className="fm-head">
                <h2 className="fm-title">{resolvedTitle}</h2>
              </div>
              <p className="fm-hint">{message}</p>
              <div className="fm-footer">
                <Button variant="secondary" onClick={onCancel}>
                  {resolvedCancelLabel}
                </Button>
                <Button variant="danger" onClick={onConfirm}>
                  {resolvedConfirmLabel}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
