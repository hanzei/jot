import React, { useEffect } from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { useConfirm, type ConfirmContextType } from '../src/hooks/useConfirm';

// Exposes confirm() from inside the provider so tests can call it directly.
function TestHarness({ onReady }: { onReady: (confirm: ConfirmContextType['confirm']) => void }) {
  const { confirm } = useConfirm();
  useEffect(() => {
    onReady(confirm);
  }, [confirm, onReady]);
  return null;
}

function renderConfirm() {
  let confirm!: ConfirmContextType['confirm'];
  const utils = render(
    <ConfirmProvider>
      <TestHarness onReady={(fn) => { confirm = fn; }} />
    </ConfirmProvider>,
  );
  return { ...utils, confirm: () => confirm };
}

describe('ConfirmDialog / useConfirm', () => {
  it('does not render the dialog until confirm() is called', () => {
    const { queryByTestId } = renderConfirm();
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('resolves true and hides the dialog when confirm is pressed', async () => {
    const { getByTestId, queryByTestId, confirm } = renderConfirm();
    let result: boolean | undefined;

    act(() => {
      confirm()({ title: 'Delete note', message: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true })
        .then((value) => { result = value; });
    });

    expect(getByTestId('confirm-dialog-title').props.children).toBe('Delete note');
    expect(getByTestId('confirm-dialog-message').props.children).toBe('This cannot be undone.');

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-confirm'));
    });

    expect(result).toBe(true);
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('resolves false and hides the dialog when cancel is pressed', async () => {
    const { getByTestId, queryByTestId, confirm } = renderConfirm();
    let result: boolean | undefined;

    act(() => {
      confirm()({ title: 'Log out', message: 'Are you sure?', confirmLabel: 'Log out' })
        .then((value) => { result = value; });
    });

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-cancel'));
    });

    expect(result).toBe(false);
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('resolves false and hides the dialog when the backdrop is pressed', async () => {
    const { getByTestId, queryByTestId, confirm } = renderConfirm();
    let result: boolean | undefined;

    act(() => {
      confirm()({ title: 'Log out', message: 'Are you sure?', confirmLabel: 'Log out' })
        .then((value) => { result = value; });
    });

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-overlay'));
    });

    expect(result).toBe(false);
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('defaults the cancel label to the translated common.cancel string', () => {
    const { getByTestId, confirm } = renderConfirm();

    act(() => {
      void confirm()({ title: 'Empty trash', message: 'Delete 3 notes?', confirmLabel: 'Empty trash' });
    });

    expect(getByTestId('confirm-dialog-cancel').props.accessibilityLabel).toBe('Cancel');
  });
});

describe('useConfirm default (no provider)', () => {
  it('resolves false so an unconfirmed destructive action never proceeds', async () => {
    let result: boolean | undefined;
    function Harness() {
      const { confirm } = useConfirm();
      useEffect(() => {
        void confirm({ title: 'x', message: 'y', confirmLabel: 'z' }).then((value) => { result = value; });
      }, [confirm]);
      return null;
    }
    render(<Harness />);
    await act(async () => {});
    expect(result).toBe(false);
  });
});
