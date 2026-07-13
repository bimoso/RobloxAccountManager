import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Modal } from './index';

/**
 * Requirement 5.2: when a modal closes, its content is removed from the DOM
 * *only after* the exit (opacity + scale) transition has fully completed.
 *
 * `Modal` delegates that lifecycle to framer-motion's `AnimatePresence`, which
 * keeps the exiting child mounted while the exit animation runs and unmounts it
 * on completion. We verify the two observable phases:
 *
 *   1. Immediately after `open` flips true -> false the dialog is STILL in the
 *      DOM (the exit animation is in progress).
 *   2. Once the animation timeline has elapsed the dialog is removed.
 *
 * Timing is driven deterministically with fake timers (framer-motion advances
 * its animation loop off timers / `requestAnimationFrame` and finalises removal
 * through a microtask), so the test never relies on wall-clock sleeps.
 */
describe('Modal exit-animation DOM lifecycle (Requirement 5.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any pending animation frames/timers before restoring real timers so
    // one test can never leak scheduled work into the next.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  /**
   * Flush framer-motion's animation loop to completion: advance well past the
   * ~220ms transition and interleave microtask draining, since AnimatePresence
   * finalises the unmount via a resolved promise rather than a timer callback.
   */
  async function flushExitAnimation(): Promise<void> {
    // Multiple passes: each timer batch can queue follow-up frames/microtasks.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      if (screen.queryByRole('dialog') === null) return;
    }
  }

  it('keeps the dialog mounted while closing and removes it after the transition completes', async () => {
    const onClose = vi.fn();
    const props = {
      onClose,
      titleId: 'modal-title',
      children: (
        <>
          <h2 id="modal-title">Confirm</h2>
          <p>Modal body content</p>
        </>
      ),
    };

    const { rerender } = render(<Modal open {...props} />);

    // Phase 0: an open modal renders its dialog.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Modal body content')).toBeInTheDocument();

    // Close the modal.
    act(() => {
      rerender(<Modal open={false} {...props} />);
    });

    // Phase 1: exit animation in progress — the dialog must NOT be gone yet.
    expect(screen.queryByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('Modal body content')).toBeInTheDocument();

    // Phase 2: after the exit transition finishes, the dialog is removed.
    await flushExitAnimation();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Modal body content')).not.toBeInTheDocument();
  });
});
