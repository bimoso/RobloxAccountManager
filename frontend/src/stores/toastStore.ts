/**
 * Toast notification store.
 *
 * The React_Frontend surfaces the outcome of user-initiated actions as brief
 * toast notifications. This store owns the single visible toast and its
 * auto-hide lifecycle.
 *
 * Design references:
 * - Requirement 2.5: a user-initiated IPC_Command error is shown as an error
 *   toast with the received message for a minimum of 2000ms.
 * - Requirement 2.6: an error without a usable message shows a generic
 *   "operation failed" toast instead.
 * - Requirement 2.7 / 25.3: a new error arriving while a previous toast is
 *   still visible replaces it rather than stacking — at most one toast is ever
 *   visible.
 * - Requirement 25.1: a successful action shows a success toast.
 * - Requirement 25.2: a failed action shows an error toast describing the
 *   cause.
 * - Requirement 25.3: a shown toast is hidden automatically after a fixed
 *   interval when the user does not interact with it.
 *
 * Correctness properties (property-tested in `toastStore.test.ts`):
 * - Property 1: after processing any sequence of action results, at most one
 *   toast is visible and it always corresponds to the most recent result; an
 *   error without a usable message uses the generic failure text, otherwise
 *   the provided message.
 * - Property 2: a shown toast is no longer present after the fixed auto-hide
 *   interval elapses without interaction; if hidden explicitly before that,
 *   it is likewise gone.
 *
 * The show/hide/replace logic is kept pure and deterministic (a fresh id and
 * the timer are the only side channels), and the timer scheduler is injectable
 * so the auto-hide behaviour can be exercised with fake timers in tests.
 */

import { create } from 'zustand';
import type { ToastMessage } from '../types/models';

/**
 * Fixed auto-hide interval, in milliseconds. Must be at least 2000ms so a
 * user-initiated error toast stays visible for the minimum required duration
 * (Requirement 2.5).
 */
export const TOAST_AUTO_HIDE_MS = 3000;

/**
 * Generic failure message shown when an IPC_Command error carries no usable
 * message (undefined, empty, or whitespace-only) — Requirement 2.6.
 */
export const GENERIC_FAILURE_MESSAGE = 'The operation failed.';

/** Kind of a toast notification. */
export type ToastKind = ToastMessage['kind'];

/**
 * Minimal timer surface the store depends on. Mirrors the browser
 * `setTimeout`/`clearTimeout` signatures so the real implementation is the
 * default, while tests can inject deterministic fakes.
 */
export interface ToastTimer {
  set: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Default timer backed by the global `setTimeout`/`clearTimeout`. Referenced
 * indirectly so a test can swap {@link setToastTimer} before exercising the
 * store.
 */
const defaultTimer: ToastTimer = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: (handle) => clearTimeout(handle),
};

let activeTimer: ToastTimer = defaultTimer;

/**
 * Override the timer implementation used for auto-hide scheduling. Intended for
 * deterministic property/unit tests; production code uses the default timer.
 *
 * @param timer - The timer to use, or `undefined`/omitted to restore the
 *   default `setTimeout`-based timer.
 */
export function setToastTimer(timer?: ToastTimer): void {
  activeTimer = timer ?? defaultTimer;
}

/** Monotonic counter guaranteeing a unique id per shown toast. */
let toastSeq = 0;

function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

/**
 * Extract a displayable message from an arbitrary thrown value, falling back to
 * the generic failure message when no usable message is present
 * (Requirement 2.6).
 *
 * A message is "usable" only when it is a non-empty, non-whitespace string.
 *
 * @param err - The value thrown/rejected by an IPC_Command.
 * @returns A non-empty message suitable for an error toast.
 */
export function normalizeErrorMessage(err: unknown): string {
  let message: unknown;
  if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object' && 'message' in err) {
    message = (err as { message: unknown }).message;
  }
  if (typeof message === 'string' && message.trim().length > 0) {
    return message;
  }
  return GENERIC_FAILURE_MESSAGE;
}

/** ToastStore state and actions. */
export interface ToastState {
  /** The single visible toast, or `null` when none is shown. */
  toast: ToastMessage | null;
  /** Internal auto-hide timer handle for the currently visible toast. */
  timerHandle: ReturnType<typeof setTimeout> | null;
  /**
   * Show a toast of the given kind, replacing any currently visible toast and
   * resetting the auto-hide timer (Requirement 2.7 / 25.3).
   */
  showToast: (kind: ToastKind, text: string) => void;
  /** Show a success toast (Requirement 25.1). */
  showSuccess: (text: string) => void;
  /** Show an error toast (Requirement 25.2). */
  showError: (text: string) => void;
  /** Hide the currently visible toast, if any, and cancel its auto-hide timer. */
  hideToast: () => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toast: null,
  timerHandle: null,

  showToast: (kind, text) => {
    // Cancel any pending auto-hide from a previous toast so the replacement
    // gets a full, fresh interval.
    const { timerHandle } = get();
    if (timerHandle !== null) {
      activeTimer.clear(timerHandle);
    }

    const toast: ToastMessage = { id: nextToastId(), kind, text };

    const handle = activeTimer.set(() => {
      // Only clear if this exact toast is still the visible one; a newer toast
      // owns its own timer and must not be dismissed by a stale one.
      const current = get();
      if (current.toast?.id === toast.id) {
        set({ toast: null, timerHandle: null });
      }
    }, TOAST_AUTO_HIDE_MS);

    set({ toast, timerHandle: handle });
  },

  showSuccess: (text) => {
    get().showToast('success', text);
  },

  showError: (text) => {
    get().showToast('error', text);
  },

  hideToast: () => {
    const { timerHandle } = get();
    if (timerHandle !== null) {
      activeTimer.clear(timerHandle);
    }
    set({ toast: null, timerHandle: null });
  },
}));

/**
 * Surface an IPC_Command error as an error toast.
 *
 * This is the exact export `lib/ipc.ts` imports to report failures of
 * user-initiated calls (Requirement 2.5–2.7). The error message is normalized
 * via {@link normalizeErrorMessage}: a usable message is shown as-is, otherwise
 * the generic failure message is used (Requirement 2.6). The resulting toast
 * replaces any currently visible toast (Requirement 2.7).
 *
 * @param err - The value thrown/rejected by the IPC_Command.
 */
export function reportIpcError(err: unknown): void {
  useToastStore.getState().showError(normalizeErrorMessage(err));
}
