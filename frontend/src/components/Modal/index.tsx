import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { motionDuration } from '@/lib/animation';
import './Modal.css';

/**
 * Props for the {@link Modal} component.
 */
export interface ModalProps {
  /**
   * Whether the modal is open. While `false` the modal content is animated out
   * and only removed from the DOM after the exit transition completes
   * (Requirement 5.2).
   */
  open: boolean;
  /**
   * Called when the user requests to dismiss the modal, either by pressing
   * `Escape` or clicking the backdrop outside the content.
   */
  onClose: () => void;
  /**
   * Optional id of the element that labels the dialog. When provided it is
   * wired to `aria-labelledby` so assistive technology announces the modal
   * title.
   */
  titleId?: string;
  /** Content rendered inside the dialog surface. */
  children: React.ReactNode;
}

/**
 * Base duration (ms) of the opening opacity + scale transition. Sits inside
 * the 180–280ms range required by Requirement 5.1 / 5.2. The close is quicker
 * (open/close asymmetry): dismissal should get out of the way, so the exit
 * runs at {@link MODAL_CLOSE_DURATION_MS} while staying inside the same range.
 */
const MODAL_DURATION_MS = 240;

/** Duration (ms) of the closing transition (see {@link MODAL_DURATION_MS}). */
const MODAL_CLOSE_DURATION_MS = 180;

/** Ease-out curve shared by the open and close phases (never bounce a close). */
const MODAL_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Accessible, animated modal dialog.
 *
 * Mounts and unmounts through framer-motion's `AnimatePresence` so the content
 * is only removed from the DOM *after* the exit animation finishes
 * (Requirement 5.2). Opening and closing animate `opacity` and `scale` over
 * {@link MODAL_DURATION_MS} (Requirement 5.1), collapsing to 0ms when the user
 * prefers reduced motion (Requirement 6.2) via {@link motionDuration}.
 *
 * Accessibility: renders `role="dialog"` with `aria-modal`, wires
 * `aria-labelledby` to {@link ModalProps.titleId} when given, closes on
 * `Escape`, and closes when the backdrop (outside the content) is clicked.
 */
export function Modal({ open, onClose, titleId, children }: ModalProps): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const duration = motionDuration(MODAL_DURATION_MS, reducedMotion) / 1000;
  const closeDuration = motionDuration(MODAL_CLOSE_DURATION_MS, reducedMotion) / 1000;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: closeDuration, ease: MODAL_EASE } }}
          transition={{ duration, ease: MODAL_EASE }}
          onClick={onClose}
        >
          <motion.div
            className="modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{
              opacity: 0,
              scale: 0.98,
              transition: { duration: closeDuration, ease: MODAL_EASE },
            }}
            transition={{ duration, ease: MODAL_EASE }}
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
