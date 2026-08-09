import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockGoBack,
  mockNavigationAddListener,
  mockRestoreMutateAsync,
  mockPermanentDeleteMutateAsync,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

function makeTrashedNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: 'Deleted note body',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    deleted_at: '2026-07-03T00:00:00Z',
    ...overrides,
  };
}

describe('NoteEditorScreen read-only trashed note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    mockRestoreMutateAsync.mockResolvedValue({});
    mockPermanentDeleteMutateAsync.mockResolvedValue({});
    mockUseOfflineNote.mockReturnValue({ data: makeTrashedNote() });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the content preview (not the editable input) and disables bar actions', () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // Read-only: preview shown, no editable content input.
    expect(getByTestId('content-preview')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();

    // Bar actions are disabled.
    expect(getByTestId('toolbar-pin-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-archive-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-color-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-add-image-btn').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('offers Restore and Delete-forever in the overflow menu and restores the note', async () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toolbar-menu-btn'));

    // Trashed menu: only restore + delete-forever, no move-to-trash/send.
    expect(getByTestId('editor-menu-restore')).toBeTruthy();
    expect(getByTestId('editor-menu-delete-permanently')).toBeTruthy();
    expect(queryByTestId('editor-menu-trash')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('editor-menu-restore'));
    });

    await waitFor(() => {
      expect(mockRestoreMutateAsync).toHaveBeenCalledWith('note-1');
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('permanently deletes the note after confirming the destructive dialog', async () => {
    const { getByTestId, findByTestId } = render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-confirm');
    expect(getByTestId('confirm-dialog-title').props.children).toBe('note.deleteForeverTitle');
    expect(getByTestId('confirm-dialog-message').props.children).toBe('note.deleteForeverConfirm');

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-confirm'));
    });

    expect(mockPermanentDeleteMutateAsync).toHaveBeenCalledWith('note-1');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  // Issue #697: these actions await a write with the menu sheet already closed.
  // A reachable-but-slow write must show a visible pending indicator instead of
  // a silent freeze; a known-unreachable server has nothing to wait for (the
  // mutation resolves via the local/queue path), so no indicator is needed.
  describe('menu-action pending indicator', () => {
    afterEach(() => {
      jest.useRealTimers();
      markServerReachable();
    });

    it('shows the pending indicator once the delay elapses while restoring on a reachable server', async () => {
      jest.useFakeTimers();
      markServerReachable();
      let resolveRestore!: () => void;
      mockRestoreMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveRestore = resolve; }));

      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-restore')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolveRestore(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('does not show the pending indicator when restoring while known unreachable', async () => {
      markServerUnreachable();
      let resolveRestore!: () => void;
      mockRestoreMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveRestore = resolve; }));

      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-restore'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolveRestore(); });
      await waitFor(() => { expect(mockGoBack).toHaveBeenCalledTimes(1); });
    });

    it('shows the pending indicator once the delay elapses while permanently deleting on a reachable server', async () => {
      jest.useFakeTimers();
      markServerReachable();
      let resolveDelete!: () => void;
      mockPermanentDeleteMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve; }));

      const { getByTestId, queryByTestId } = render(
        <ConfirmProvider>
          <NoteEditorScreen />
        </ConfirmProvider>,
      );

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-delete-permanently')); });
      await act(async () => { fireEvent.press(getByTestId('confirm-dialog-confirm')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolveDelete(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('does not show the pending indicator when permanently deleting while known unreachable', async () => {
      markServerUnreachable();
      let resolveDelete!: () => void;
      mockPermanentDeleteMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve; }));

      const { getByTestId, findByTestId, queryByTestId } = render(
        <ConfirmProvider>
          <NoteEditorScreen />
        </ConfirmProvider>,
      );

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-delete-permanently'));
      await findByTestId('confirm-dialog-confirm');
      fireEvent.press(getByTestId('confirm-dialog-confirm'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolveDelete(); });
      await waitFor(() => { expect(mockGoBack).toHaveBeenCalledTimes(1); });
    });
  });

  it('does not delete the note when the destructive dialog is cancelled', async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-cancel');
    fireEvent.press(getByTestId('confirm-dialog-cancel'));

    await waitFor(() => { expect(queryByTestId('confirm-dialog-cancel')).toBeNull(); });
    expect(mockPermanentDeleteMutateAsync).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('renders a trashed list note with non-interactive item controls', () => {
    mockUseOfflineNote.mockReturnValue({
      data: makeTrashedNote({
        note_type: 'list',
        title: 'Groceries',
        content: undefined,
        items: [
          { id: 'i1', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '' },
          { id: 'i2', text: 'Eggs', completed: true, position: 1, parent_id: null, assigned_to: '' },
        ],
      }),
    });

    const { getAllByTestId, getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // No "add item" affordance in read-only mode.
    expect(queryByTestId('add-list-item')).toBeNull();

    // Item checkboxes are disabled (non-interactive).
    for (const checkbox of getAllByTestId('list-item-checkbox')) {
      expect(checkbox.props.accessibilityState).toMatchObject({ disabled: true });
    }

    // The completed-items collapse toggle is disabled.
    expect(getByTestId('toggle-checked-items').props.accessibilityState).toMatchObject({ disabled: true });
  });
});
