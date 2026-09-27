import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Animation stub: mirrors the markup without framer-motion's frame loop so
 * exit removal is synchronous and assertions stay deterministic (the real
 * transition is exercised by the packaged-app smoke check).
 */
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition', 'variants'];
  /**
   * Render a plain DOM element for a motion component.
   *
   * @param tag - HTML tag the motion proxy was queried for.
   * @returns A stub component rendering that tag without motion-only props.
   */
  function stubMotionTag(tag: string) {
    /**
     * Forwarding stub body.
     *
     * @param props - Props handed to the motion component.
     * @param ref - Ref forwarded to the underlying DOM node.
     * @returns The plain element.
     */
    const Stub = (props: Record<string, unknown>, ref: unknown) => {
      const rest = Object.fromEntries(
        Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.includes(key)),
      );
      return React.createElement(tag, { ...rest, ref });
    };
    return React.forwardRef(Stub);
  }
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    motion: new Proxy({}, { get: (_target, tag: string) => stubMotionTag(tag) }),
    useReducedMotion: () => false,
  };
});

import { Toast } from './index';
import { TOAST_AUTO_HIDE_MS, useToastStore } from '../../stores/toastStore';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toast: null, timerHandle: null });
});

afterEach(() => {
  act(() => useToastStore.getState().hideToast());
  vi.useRealTimers();
});

describe('Toast viewport', () => {
  it('renders a success toast as a status region and auto-hides it', () => {
    render(<Toast />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => useToastStore.getState().showSuccess('Account launched'));

    expect(screen.getByRole('status')).toHaveTextContent('Account launched');

    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_HIDE_MS);
    });

    expect(useToastStore.getState().toast).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('marks error toasts as alerts with the raw message text', () => {
    render(<Toast />);

    act(() => useToastStore.getState().showError('Wayfern download failed'));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Wayfern download failed');
    expect(alert.className).toContain('ram-toast--error');
  });

  it('replaces the visible toast when a new one arrives', () => {
    render(<Toast />);

    act(() => useToastStore.getState().showSuccess('First result'));
    act(() => useToastStore.getState().showError('Second result'));

    // The store keeps a single visible toast; the viewport mirrors exactly it.
    expect(screen.queryByText('First result')).not.toBeInTheDocument();
    expect(screen.getByText('Second result')).toBeInTheDocument();
  });

  it('dismisses on click by clearing the store toast', () => {
    render(<Toast />);

    act(() => useToastStore.getState().showSuccess('Click me'));
    fireEvent.click(screen.getByRole('status'));

    expect(useToastStore.getState().toast).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
