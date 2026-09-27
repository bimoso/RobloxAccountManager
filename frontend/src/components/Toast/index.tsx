import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { TOAST_AUTO_HIDE_MS, useToastStore } from '../../stores/toastStore';
import './Toast.css';

/**
 * App-owned notification stack.
 *
 * The Zustand store remains the single application-facing API so IPC, tests
 * and feature code do not depend on a renderer. This component mirrors the
 * latest store message as a bottom-right toast (fade + slide via framer-motion,
 * static cross-fade under `prefers-reduced-motion`); the store owns the
 * replacement + auto-hide semantics and this surface adds click-to-dismiss.
 */
export type ToastProps = Record<string, never>;

/** Mount the global toast viewport and mirror the latest toast-store event. */
export function Toast(): JSX.Element {
  const toast = useToastStore((state) => state.toast);
  const hideToast = useToastStore((state) => state.hideToast);
  const reduceMotion = useReducedMotion();

  return (
    <div className="ram-toast-viewport" aria-live="polite">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className={`ram-toast ram-toast--${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            data-testid="ram-toast"
            onClick={hideToast}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
          >
            {/* Auto-hide is store-driven (TOAST_AUTO_HIDE_MS); the meta hint is
                decorative, so it stays hidden from assistive tech. */}
            <span className="ram-toast-title">{toast.text}</span>
            <span className="ram-toast-meta u-num" aria-hidden="true">
              {Math.round(TOAST_AUTO_HIDE_MS / 1000)}s
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
