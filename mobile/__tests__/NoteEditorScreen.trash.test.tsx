import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockGoBack,
  mockNavigationAddListener,
  mockRestoreMutateAsync,
  mockPermanentDeleteMutateAsync,
  mockUseOfflineNote,
  mockCreateMutateAsync,
  mockDeleteMutateAsync,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { ConfirmProvider } from '../src/components/ConfirmDialog';

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

  it('renders the content preview (not the editable input) and disables bar actions', async () => {
    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);

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
    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toolbar-menu-btn'));

    // Trashed menu: only restore + delete-forever, no move-to-trash/send.
    expect(getByTestId('editor-menu-restore')).toBeTruthy();
    expect(getByTestId('editor-menu-delete-permanently')).toBeTruthy();
    expect(queryByTestId('editor-menu-trash')).toBeNull();

    await act(async () => {
      await fireEvent.press(getByTestId('editor-menu-restore'));
    });

    await waitFor(() => {
      expect(mockRestoreMutateAsync).toHaveBeenCalledWith('note-1');
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('permanently deletes the note after confirming the destructive dialog', async () => {
    const { getByTestId, findByTestId } = await render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    await fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-confirm');
    expect(getByTestId('confirm-dialog-title').props.children).toBe('note.deleteForeverTitle');
    expect(getByTestId('confirm-dialog-message').props.children).toBe('note.deleteForeverConfirm');

    await act(async () => {
      await fireEvent.press(getByTestId('confirm-dialog-confirm'));
    });

    expect(mockPermanentDeleteMutateAsync).toHaveBeenCalledWith('note-1');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('does not delete the note when the destructive dialog is cancelled', async () => {
    const { getByTestId, findByTestId, queryByTestId } = await render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    await fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-cancel');
    await fireEvent.press(getByTestId('confirm-dialog-cancel'));

    await waitFor(() => { expect(queryByTestId('confirm-dialog-cancel')).toBeNull(); });
    expect(mockPermanentDeleteMutateAsync).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('renders a trashed list note with non-interactive item controls', async () => {
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

    const { getAllByTestId, getByTestId, queryByTestId } = await render(<NoteEditorScreen />);

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

describe('NoteEditorScreen move to trash on a new note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockDeleteMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('just exits a blank new note, which has nothing to delete', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    await act(async () => {
      await fireEvent.press(getByTestId('editor-menu-trash'));
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });

  it('waits for the first save still creating the note, then trashes the created note', async () => {
    jest.useFakeTimers();
    let resolveCreate!: (note: unknown) => void;
    mockCreateMutateAsync.mockReturnValue(new Promise((res) => { resolveCreate = res; }));
    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');
    });
    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS); });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // Trash while the create is still in flight: the note has no id yet.
    await act(async () => { await fireEvent.press(getByTestId('toolbar-menu-btn')); });
    await act(async () => { await fireEvent.press(getByTestId('editor-menu-trash')); });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();

    await act(async () => { resolveCreate({ id: 'note-new', note_type: 'text', content: 'Hello' }); });

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('note-new');
    });
    await waitFor(() => {
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
  });
});
