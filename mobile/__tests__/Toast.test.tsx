import React, { useEffect } from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { ToastProvider } from '../src/components/Toast';
import { useToast, type ToastContextType } from '../src/hooks/useToast';

// Exposes showToast from inside the provider so tests can call it directly.
function TestHarness({ onReady }: { onReady: (showToast: ToastContextType['showToast']) => void }) {
  const { showToast } = useToast();
  useEffect(() => {
    onReady(showToast);
  }, [showToast, onReady]);
  return null;
}

function renderToast() {
  let showToast!: ToastContextType['showToast'];
  const utils = render(
    <ToastProvider>
      <TestHarness onReady={(fn) => { showToast = fn; }} />
    </ToastProvider>,
  );
  return { ...utils, showToast: () => showToast };
}

describe('Toast onExpire', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires onExpire when the toast auto-dismisses without the action running', () => {
    const { showToast } = renderToast();
    const onPress = jest.fn();
    const onExpire = jest.fn();

    act(() => {
      showToast()('Image removed', 'info', { label: 'Undo', onPress, onExpire });
    });

    act(() => {
      jest.advanceTimersByTime(4000);
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('fires onExpire when the toast is dismissed via the close button', () => {
    const { showToast, getByTestId } = renderToast();
    const onPress = jest.fn();
    const onExpire = jest.fn();

    act(() => {
      showToast()('Image removed', 'info', { label: 'Undo', onPress, onExpire });
    });

    act(() => {
      fireEvent.press(getByTestId('toast-close-0'));
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('does not fire onExpire when the action runs before the timer elapses', async () => {
    const { showToast, getByTestId } = renderToast();
    const onPress = jest.fn();
    const onExpire = jest.fn();

    act(() => {
      showToast()('Image removed', 'info', { label: 'Undo', onPress, onExpire });
    });

    await act(async () => {
      fireEvent.press(getByTestId('toast-action-0'));
    });

    expect(onPress).toHaveBeenCalledTimes(1);

    // Advancing time past the original auto-dismiss point must not also fire
    // onExpire — the action already ran, so this must not double-fire.
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does not throw for a toast with no action at all', () => {
    const { showToast } = renderToast();

    act(() => {
      showToast()('Just a message', 'success');
    });

    expect(() => {
      act(() => {
        jest.advanceTimersByTime(4000);
      });
    }).not.toThrow();
  });
});
