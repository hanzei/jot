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
    buildLocalLabel: (name: string, userId: string) => ({
      id: `local-${name}`, user_id: userId, name, created_at: '', updated_at: '',
    }),
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
    t: (key: string, opts?: { name?: string }) => (opts?.name !== undefined ? `${key}:${opts.name}` : key),
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

    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    // Not awaited: the triggered mutation is deliberately left pending, and
    // awaiting fireEvent would wait for that whole chain to settle.
    void fireEvent.press(getByTestId('label-item-label-1'));

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

    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[labels[0]!]} onClose={jest.fn()} />,
    );

    // Not awaited: the triggered mutation is deliberately left pending, and
    // awaiting fireEvent would wait for that whole chain to settle.
    void fireEvent.press(getByTestId('label-item-label-1'));

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

  it('shows a spinner on the create row while creating a label, instead of a silent freeze', async () => {
    const { promise, resolve } = deferred<unknown>();
    mockAddLabelMutateAsync.mockReturnValue(promise);

    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    await fireEvent.changeText(getByTestId('label-search-input'), 'Errands');
    // Not awaited: the triggered mutation is deliberately left pending, and
    // awaiting fireEvent would wait for that whole chain to settle.
    void fireEvent.press(getByTestId('label-create-option'));

    await waitFor(() => {
      expect(getByTestId('label-create-option-spinner')).toBeTruthy();
    });
    expect(mockAddLabelMutateAsync).toHaveBeenCalledWith({ noteId: 'note-1', name: 'Errands' });

    await act(async () => {
      resolve({});
    });

    // A successful create clears the query, which removes the create row.
    await waitFor(() => {
      expect(queryByTestId('label-create-option')).toBeNull();
    });
    expect(getByTestId('label-search-input').props.value).toBe('');
  });

  it('filters the list as the user types, case-insensitively', async () => {
    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    await fireEvent.changeText(getByTestId('label-search-input'), 'wor');

    expect(getByTestId('label-item-label-1')).toBeTruthy();
    expect(queryByTestId('label-item-label-2')).toBeNull();
  });

  it('offers to create only when no label has the exact name', async () => {
    const { getByTestId, getByText, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );
    expect(queryByTestId('label-create-option')).toBeNull();

    await fireEvent.changeText(getByTestId('label-search-input'), 'Wor');
    expect(getByText('labels.createLabel:Wor')).toBeTruthy();

    await fireEvent.changeText(getByTestId('label-search-input'), ' work ');
    expect(queryByTestId('label-create-option')).toBeNull();
  });

  it('hides the create row while labels are loading', async () => {
    mockUseLabels.mockReturnValue({ data: undefined, isLoading: true });
    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    await fireEvent.changeText(getByTestId('label-search-input'), 'Errands');

    expect(queryByTestId('label-create-option')).toBeNull();
  });

  it('creates from the keyboard only when the query matches no label', async () => {
    mockAddLabelMutateAsync.mockResolvedValue({});
    const { getByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );
    const input = getByTestId('label-search-input');

    // "Wor" partially matches "Work", so Done does nothing.
    await fireEvent.changeText(input, 'Wor');
    await fireEvent(input, 'submitEditing');
    expect(mockAddLabelMutateAsync).not.toHaveBeenCalled();

    await fireEvent.changeText(input, 'Errands');
    await fireEvent(input, 'submitEditing');
    await waitFor(() => {
      expect(mockAddLabelMutateAsync).toHaveBeenCalledWith({ noteId: 'note-1', name: 'Errands' });
    });
  });

  it('clears the search when the sheet is closed', async () => {
    const onClose = jest.fn();
    const { getByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={onClose} />,
    );

    await fireEvent.changeText(getByTestId('label-search-input'), 'wor');
    await fireEvent.press(getByTestId('label-picker-backdrop'));

    expect(onClose).toHaveBeenCalled();
    expect(getByTestId('label-search-input').props.value).toBe('');
  });

  it('surfaces an error and clears the spinner when the toggle mutation fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockAddLabelMutateAsync.mockRejectedValue(new Error('network error'));

    const { getByTestId, queryByTestId } = await render(
      <LabelPicker visible noteId="note-1" noteLabels={[]} onClose={jest.fn()} />,
    );

    await fireEvent.press(getByTestId('label-item-label-1'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('common.error', 'labels.failedUpdate');
    });
    expect(queryByTestId('label-item-label-1-spinner')).toBeNull();
  });
});

// Issue #1126: a new note that does not exist yet has no id to send label
// writes to, so the picker edits the labels locally and the editor's create
// request carries them.
describe('LabelPicker on a note that does not exist yet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLabels.mockReturnValue({ data: labels, isLoading: false });
  });

  it('toggles labels locally without calling the server', async () => {
    const onLocalLabelsChange = jest.fn();
    const { getByTestId, rerender } = await render(
      <LabelPicker visible noteId={null} noteLabels={[]} onClose={jest.fn()} onLocalLabelsChange={onLocalLabelsChange} />,
    );

    await fireEvent.press(getByTestId('label-item-label-1'));
    expect(onLocalLabelsChange).toHaveBeenLastCalledWith([labels[0]]);

    await rerender(
      <LabelPicker visible noteId={null} noteLabels={[labels[0]!]} onClose={jest.fn()} onLocalLabelsChange={onLocalLabelsChange} />,
    );
    expect(getByTestId('label-item-label-1').props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(getByTestId('label-item-label-1'));
    expect(onLocalLabelsChange).toHaveBeenLastCalledWith([]);

    expect(mockAddLabelMutateAsync).not.toHaveBeenCalled();
    expect(mockRemoveLabelMutateAsync).not.toHaveBeenCalled();
  });

  it('adds a new label name as a local placeholder and lists it', async () => {
    const onLocalLabelsChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = await render(
      <LabelPicker visible noteId={null} noteLabels={[]} onClose={jest.fn()} onLocalLabelsChange={onLocalLabelsChange} />,
    );

    await fireEvent.changeText(getByTestId('label-search-input'), 'Errands');
    await fireEvent.press(getByTestId('label-create-option'));

    expect(onLocalLabelsChange).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'Errands' })]);
    expect(mockAddLabelMutateAsync).not.toHaveBeenCalled();
    expect(getByTestId('label-search-input').props.value).toBe('');

    // The placeholder is listed (and checked) like a stored label, so it can
    // be unchecked again and isn't offered for creation a second time.
    const placeholder = onLocalLabelsChange.mock.calls[0]![0][0] as Label;
    await rerender(
      <LabelPicker visible noteId={null} noteLabels={[placeholder]} onClose={jest.fn()} onLocalLabelsChange={onLocalLabelsChange} />,
    );
    expect(getByTestId(`label-item-${placeholder.id}`).props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.changeText(getByTestId('label-search-input'), 'errands');
    expect(queryByTestId('label-create-option')).toBeNull();
  });
});
