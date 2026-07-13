import { useEffect, useRef } from 'react';
import { sileo, Toaster } from 'sileo';
import { TOAST_AUTO_HIDE_MS, useToastStore } from '../../stores/toastStore';
import './Toast.css';

/**
 * Sileo-backed notification bridge.
 *
 * The Zustand store remains the single application-facing API so IPC, tests
 * and feature code do not depend on a renderer. This component translates the
 * latest store message into Sileo's spring/morph notification and keeps the
 * existing replacement + auto-hide semantics intact.
 */
export type ToastProps = Record<string, never>;

/** Mount the global Sileo viewport and mirror the latest toast-store event. */
export function Toast(): JSX.Element {
  const toast = useToastStore((state) => state.toast);
  const activeSileoId = useRef<string | null>(null);

  useEffect(() => {
    if (activeSileoId.current) {
      sileo.dismiss(activeSileoId.current);
      activeSileoId.current = null;
    }

    if (!toast) return;

    activeSileoId.current = toast.kind === 'error'
      ? sileo.error({
          title: 'Action failed',
          description: toast.text,
          duration: TOAST_AUTO_HIDE_MS,
        })
      : sileo.success({
          title: toast.text,
          duration: TOAST_AUTO_HIDE_MS,
        });

    const renderedId = activeSileoId.current;
    return () => {
      if (activeSileoId.current === renderedId) {
        sileo.dismiss(renderedId);
        activeSileoId.current = null;
      }
    };
  }, [toast]);

  return (
    <Toaster
      position="bottom-right"
      offset={{ right: 18, bottom: 18 }}
      theme="light"
      options={{
        fill: 'var(--ram-toast-surface)',
        roundness: 14,
        autopilot: { expand: 150, collapse: 2200 },
        styles: {
          title: 'ram-sileo-title',
          description: 'ram-sileo-description',
          badge: 'ram-sileo-badge',
          button: 'ram-sileo-button',
        },
      }}
    />
  );
}
