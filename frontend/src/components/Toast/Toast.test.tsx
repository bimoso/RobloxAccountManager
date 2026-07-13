import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dismissMock, errorMock, successMock, toasterMock } = vi.hoisted(() => ({
  dismissMock: vi.fn(),
  errorMock: vi.fn(),
  successMock: vi.fn(),
  toasterMock: vi.fn(),
}));

vi.mock('sileo', () => ({
  sileo: {
    dismiss: dismissMock,
    error: errorMock,
    success: successMock,
  },
  Toaster: (props: unknown) => {
    toasterMock(props);
    return null;
  },
}));

import { Toast } from './index';
import { TOAST_AUTO_HIDE_MS, useToastStore } from '../../stores/toastStore';

beforeEach(() => {
  vi.useFakeTimers();
  dismissMock.mockReset();
  errorMock.mockReset().mockReturnValue('error-id');
  successMock.mockReset().mockReturnValue('success-id');
  toasterMock.mockReset();
  useToastStore.setState({ toast: null, timerHandle: null });
});

afterEach(() => {
  act(() => useToastStore.getState().hideToast());
  vi.useRealTimers();
});

describe('Toast Sileo adapter', () => {
  it('translates a success message into a timed Sileo success notification', async () => {
    render(<Toast />);

    act(() => useToastStore.getState().showSuccess('Account launched'));

    expect(successMock).toHaveBeenCalledWith({
      title: 'Account launched',
      duration: TOAST_AUTO_HIDE_MS,
    });
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('uses the error text as the Sileo description', async () => {
    render(<Toast />);

    act(() => useToastStore.getState().showError('Wayfern download failed'));

    expect(errorMock).toHaveBeenCalledWith({
      title: 'Action failed',
      description: 'Wayfern download failed',
      duration: TOAST_AUTO_HIDE_MS,
    });
    expect(successMock).not.toHaveBeenCalled();
  });

  it('dismisses the prior Sileo notification when replacing or hiding it', async () => {
    render(<Toast />);

    act(() => useToastStore.getState().showSuccess('First result'));
    expect(successMock).toHaveBeenCalledTimes(1);

    act(() => useToastStore.getState().showError('Replacement result'));
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(dismissMock).toHaveBeenCalledWith('success-id');

    act(() => useToastStore.getState().hideToast());
    expect(dismissMock).toHaveBeenCalledWith('error-id');

    expect(dismissMock.mock.calls.map(([id]) => id)).toEqual([
      'success-id',
      'error-id',
    ]);
  });

  it('configures the Sileo toaster shell for the application surface', () => {
    render(<Toast />);

    const props = toasterMock.mock.calls.at(-1)?.[0];
    expect(props).toEqual(expect.objectContaining({
      position: 'bottom-right',
      offset: { right: 18, bottom: 18 },
      theme: 'light',
      options: {
        fill: 'var(--ram-toast-surface)',
        roundness: 14,
        autopilot: { expand: 150, collapse: 2200 },
        styles: {
          title: 'ram-sileo-title',
          description: 'ram-sileo-description',
          badge: 'ram-sileo-badge',
          button: 'ram-sileo-button',
        },
      },
    }));
  });
});
