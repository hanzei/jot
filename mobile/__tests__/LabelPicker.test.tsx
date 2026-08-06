import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import LabelPicker from '../src/components/LabelPicker';
import type { Label } from '@jot/shared';

// Issue #698: toggling a label or adding a new one on the label-picker sheet
// awaits a mutation while only a global row-dimming opacity applies, with no
// row-specific spinner and no feedback on the add button. These tests assert
// the fix: the specific row/button being mutated shows a spinner while the
// write is in flight, and it clears once the write resolves.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const mockUseLabels = jest.fn();
const mockAddLabelMutateAsync = jest.fn();
const mockRemoveLabelMutateAsync = jest.fn();

jest.mock('../src/hooks/useLabels', () => {
  const ReactActual = jest.requireActual('react');
  function useTrackedMutation(mutateAsyncMock: (...args: unknown[]) => Promise<unknown>) {
    const [isPending, setIsPending] = ReactActual.useState(false);
    const mutateAsync = ReactActual.useCallback(async (...args: unknown[]) => {
      setIsPending(true);
      try {
        return await mutateAsyncMock(...args);
      } finally {
        setIsPending(false);
      }
    }, [mutateAsyncMock]);
    return { mutateAsync, isPending };
  }
  return {
    useLabels: () => mockUseLabels(),
    useAddLabelToNote: () => useTrackedMutation(mockAddLabelMutateAsync),
    useRemoveLabelFromNote: () => useTrackedMutation(mockRemoveLabelMutateAsync),
  };
});

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: {
      overlay: 'rgba(0,0,0,0.4)',
      sheetBackground: '#fff',
      handleColor: '#ddd',
      text: '#111',
      primary: '#2563eb',
      iconMuted: '#999',
      textMuted: '#777',
      placeholder: '#9ca3af',
      border: '#d1d5db',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    SafeAreaInsetsContext: createContext({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

const labels: Label[] = [
  { id: 'label-1', user_id: 'user-1', name: 'Work', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'label-2', user_id: 'user-1', name: 'Home', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];

describe('LabelPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLabels.mockReturnValue({ data: labels, isLoading: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a spinner only on the toggled row while adding a label to the note, and clears it on success', async () => {
    const { promise, resolve } = deferred<unknown>();
    mockAddLabelMutateAsync.mockReturnValue(promise);

    const { getByTestId, queryByTestId } = render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    fireEvent.press(getByTestId('label-item-label-1'));

    await waitFor(() => {
      expect(getByTestId('label-item-label-1-spinner')).toBeTruthy();
    });
    expect(queryByTestId('label-item-label-2-spinner')).toBeNull();

    await act(async () => {
      resolve({});
    });

    await waitFor(() => {
      expect(queryByTestId('label-item-label-1-spinner')).toBeNull();
    });
  });

  it('shows a spinner on the toggled row while removing a label already on the note', async () => {
    const { promise, resolve } = deferred<unknown>();
    mockRemoveLabelMutateAsync.mockReturnValue(promise);

    const { getByTestId, queryByTestId } = render(
      <LabelPicker visible noteId="note-1" noteLabels={[labels[0]!]} onClose={jest.fn()} />,
    );

    fireEvent.press(getByTestId('label-item-label-1'));

    await waitFor(() => {
      expect(getByTestId('label-item-label-1-spinner')).toBeTruthy();
    });

    await act(async () => {
      resolve({});
    });

    await waitFor(() => {
      expect(queryByTestId('label-item-label-1-spinner')).toBeNull();
    });
  });

  it('shows a spinner on the add-new-label button while creating a label, instead of a silent freeze', async () => {
    const { promise, resolve } = deferred<unknown>();
    mockAddLabelMutateAsync.mockReturnValue(promise);

    const { getByTestId, queryByTestId } = render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    fireEvent.changeText(getByTestId('new-label-input'), 'Errands');
    fireEvent.press(getByTestId('add-label-btn'));

    await waitFor(() => {
      expect(getByTestId('add-label-btn-spinner')).toBeTruthy();
    });

    await act(async () => {
      resolve({});
    });

    await waitFor(() => {
      expect(queryByTestId('add-label-btn-spinner')).toBeNull();
    });
  });

  it('surfaces an error and clears the spinner when the toggle mutation fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockAddLabelMutateAsync.mockRejectedValue(new Error('network error'));

    const { getByTestId, queryByTestId } = render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    fireEvent.press(getByTestId('label-item-label-1'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('common.error', 'labels.failedUpdate');
    });
    expect(queryByTestId('label-item-label-1-spinner')).toBeNull();
  });
});
