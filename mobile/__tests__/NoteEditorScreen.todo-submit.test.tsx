import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockDeleteMutateAsync,
  mockDuplicateMutateAsync,
  mockCreateItemMutateAsync,
  mockUpdateItemMutateAsync,
  mockUseOfflineNote,
  mockUseTranslation,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// A fresh `t`/`i18n` on every call (unlike the shared helper's stable default):
// some of the flushes below rely on the resulting callback churn to re-fire
// and coalesce a pending edit with a same-tick metadata change.
mockUseTranslation.mockImplementation(() => ({
  t: (key: string, options?: { count?: number }) =>
    (key === 'note.completedItems' ? `${options?.count ?? 0} completed items` : key),
  i18n: { language: 'en' },
}));

describe('NoteEditorScreen list submit behavior', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'created-note-id' });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockDeleteMutateAsync.mockResolvedValue({});
    mockDuplicateMutateAsync.mockResolvedValue({ id: 'duplicate-note-id' });
  });

  it('creates a new list item when submitting existing list item text input', async () => {
    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toggle-note-type'));
    await fireEvent.press(getByTestId('add-list-item'));

    const baselineCount = getAllByTestId('list-item-text').length;
    const firstInput = getAllByTestId('list-item-text')[0]!;
    await fireEvent.changeText(firstInput, 'Buy milk');
    await fireEvent(firstInput, 'submitEditing');

    await waitFor(() => {
      expect(getAllByTestId('list-item-text').length).toBe(baselineCount + 1);
    });
  });

  it('pressing Enter at the start of a non-empty item inserts an empty item before it', async () => {
    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toggle-note-type'));
    await fireEvent.press(getByTestId('add-list-item'));

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent.changeText(input, 'hello');
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
    await fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      expect(inputsAfter[0]!.props.value).toBe('');
      expect(inputsAfter[1]!.props.value).toBe('hello');
    });
  });

  it('pressing Enter in the middle of an item splits it into two items at the cursor', async () => {
    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toggle-note-type'));
    await fireEvent.press(getByTestId('add-list-item'));

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent.changeText(input, 'helloworld');
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    await fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      expect(inputsAfter[0]!.props.value).toBe('hello');
      expect(inputsAfter[1]!.props.value).toBe('world');
    });
  });

  it('split/insert-before new items inherit the current item\'s group and assignee', async () => {
    const existingNote = {
      id: 'note-split',
      user_id: 'u1',
      title: 'Split test',
      content: '',
      note_type: 'list',
      color: '#ffffff',
      pinned: false,
      archived: false,
      position: 0,
      checked_items_collapsed: false,
      is_shared: false,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      labels: [],
      shared_with: [],
      items: [
        {
          id: 'parent-item',
          note_id: 'note-split',
          text: 'parent',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'child-item',
          note_id: 'note-split',
          text: 'helloworld',
          completed: false,
          position: 1,
          parent_id: 'parent-item',
          assigned_to: 'user1',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-split' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });
    mockCreateItemMutateAsync.mockClear();

    const { getAllByTestId } = await render(<NoteEditorScreen />);

    const input = getAllByTestId('list-item-text')[1]!;
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    await fireEvent(input, 'submitEditing');

    await waitFor(() => {
      expect(mockCreateItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          noteId: 'note-split',
          item: expect.objectContaining({
            text: 'world',
            parent_id: 'parent-item',
            assigned_to: 'user1',
          }),
        }),
      );
    });
  });

  it('pressing Enter at the start of a non-empty completed item inserts an empty item before it', async () => {
    const existingNote = {
      id: 'note-split-completed-start',
      user_id: 'u1',
      title: 'Split completed test',
      content: '',
      note_type: 'list',
      color: '#ffffff',
      pinned: false,
      archived: false,
      position: 0,
      checked_items_collapsed: false,
      is_shared: false,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      labels: [],
      shared_with: [],
      items: [
        {
          id: 'completed-item',
          note_id: 'note-split-completed-start',
          text: 'hello',
          completed: true,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-split-completed-start' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });

    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    expect(getByTestId('checked-items-section')).toBeTruthy();

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
    await fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      const checkboxesAfter = getAllByTestId('list-item-checkbox');
      expect(inputsAfter).toHaveLength(2);
      // New blank item is inserted before the original, inheriting its
      // completed state; the original item's own text is untouched.
      expect(inputsAfter[0]!.props.value).toBe('');
      expect(inputsAfter[1]!.props.value).toBe('hello');
      expect(checkboxesAfter[0]!.props.accessibilityState.checked).toBe(true);
      expect(checkboxesAfter[1]!.props.accessibilityState.checked).toBe(true);
    });
  });

  it('pressing Enter in the middle of a completed item splits it into two items at the cursor', async () => {
    const existingNote = {
      id: 'note-split-completed-mid',
      user_id: 'u1',
      title: 'Split completed test',
      content: '',
      note_type: 'list',
      color: '#ffffff',
      pinned: false,
      archived: false,
      position: 0,
      checked_items_collapsed: false,
      is_shared: false,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      labels: [],
      shared_with: [],
      items: [
        {
          id: 'completed-item',
          note_id: 'note-split-completed-mid',
          text: 'helloworld',
          completed: true,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-split-completed-mid' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });

    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    expect(getByTestId('checked-items-section')).toBeTruthy();

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    await fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      const checkboxesAfter = getAllByTestId('list-item-checkbox');
      expect(inputsAfter).toHaveLength(2);
      // The original keeps the text before the cursor; the split-off
      // remainder inherits its completed state and stays in the completed
      // section, right after it.
      expect(inputsAfter[0]!.props.value).toBe('hello');
      expect(inputsAfter[1]!.props.value).toBe('world');
      expect(checkboxesAfter[0]!.props.accessibilityState.checked).toBe(true);
      expect(checkboxesAfter[1]!.props.accessibilityState.checked).toBe(true);
    });
  });

  it('does not persist unchanged existing note when leaving editor', async () => {
    const existingNote = {
      id: 'note-123',
      user_id: 'u1',
      title: 'Existing title',
      content: 'Existing content',
      note_type: 'text',
      color: '#ffffff',
      pinned: false,
      archived: false,
      position: 0,
      checked_items_collapsed: false,
      is_shared: false,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      labels: [],
      shared_with: [],
      items: [],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-123' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });

    const { unmount } = await render(<NoteEditorScreen />);
    await unmount();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('edits an existing list item via the granular per-item endpoint', async () => {
    const existingNote = {
      id: 'note-789',
      user_id: 'u1',
      title: 'Groceries',
      content: '',
      note_type: 'list',
      color: '#ffffff',
      pinned: false,
      archived: false,
      position: 0,
      checked_items_collapsed: false,
      is_shared: false,
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      labels: [],
      shared_with: [],
      items: [
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaa',
          note_id: 'note-789',
          text: 'Milk',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-789' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });
    mockUpdateMutateAsync.mockClear();
    mockUpdateItemMutateAsync.mockClear();

    const { getAllByTestId, unmount } = await render(<NoteEditorScreen />);

    await fireEvent.changeText(getAllByTestId('list-item-text')[0]!, 'Oat milk');
    await unmount();

    await waitFor(() => {
      // The item is patched individually; the whole note is not re-sent.
      expect(mockUpdateItemMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          noteId: 'note-789',
          itemId: 'aaaaaaaaaaaaaaaaaaaaaa',
          data: expect.objectContaining({ text: 'Oat milk' }),
        }),
      );
    });
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('does not persist when existing note is still hydrating and user leaves', async () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-456' } });
    mockUseOfflineNote.mockReturnValue({ data: null });

    const { unmount } = await render(<NoteEditorScreen />);
    await unmount();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('keeps dirty state for color change when note id is not yet available', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.changeText(getByTestId('note-content-input'), 'Draft note');

    const colorButton = getByTestId('toolbar-color-btn');
    await fireEvent.press(colorButton);
    const swatch = await waitFor(() => getByTestId('color-swatch-f28b82'));
    await fireEvent.press(swatch);

    await waitFor(
      () => {
        expect(mockCreateMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            content: 'Draft note',
            color: '#f28b82',
          }),
        );
      },
      { timeout: VALIDATION.AUTO_SAVE_TIMEOUT_MS + 2000 },
    );
  });
});
