import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockCreateMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
const mockDeleteMutateAsync = jest.fn();
const mockDuplicateMutateAsync = jest.fn();
const mockCreateItemMutateAsync = jest.fn();
const mockUpdateItemMutateAsync = jest.fn();
const mockDeleteItemMutateAsync = jest.fn();
const mockReorderItemsMutateAsync = jest.fn();
const mockUseOfflineNote = jest.fn();

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockUseRoute(),
  useNavigation: () => ({
    goBack: mockGoBack,
    replace: mockReplace,
    navigate: mockNavigate,
    dispatch: mockDispatch,
    setParams: mockSetParams,
    addListener: mockNavigationAddListener,
  }),
  useFocusEffect: jest.fn(),
}));

jest.mock('@react-navigation/elements', () => ({
  __esModule: true,
  useHeaderHeight: () => 56,
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    useSafeAreaInsets: () => insets,
    SafeAreaInsetsContext: createContext(insets),
  };
});

jest.mock('expo-haptics', () => ({
  __esModule: true,
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Error: 'error' },
}));

// react-native-reorderable-list is mocked once globally in jest.setup.js.

jest.mock('../src/hooks/useNotes', () => ({
  __esModule: true,
  useCreateNote: () => ({
    mutateAsync: mockCreateMutateAsync,
  }),
  useUpdateNote: () => ({
    mutateAsync: mockUpdateMutateAsync,
  }),
  useDeleteNote: () => ({
    mutateAsync: mockDeleteMutateAsync,
  }),
  useRestoreNote: () => ({
    mutateAsync: jest.fn(),
  }),
  usePermanentDeleteNote: () => ({
    mutateAsync: jest.fn(),
  }),
  useDuplicateNote: () => ({
    mutateAsync: mockDuplicateMutateAsync,
  }),
  useCreateNoteItem: () => ({
    mutateAsync: mockCreateItemMutateAsync,
  }),
  useUpdateNoteItem: () => ({
    mutateAsync: mockUpdateItemMutateAsync,
  }),
  useDeleteNoteItem: () => ({
    mutateAsync: mockDeleteItemMutateAsync,
  }),
  useReorderNoteItems: () => ({
    mutateAsync: mockReorderItemsMutateAsync,
  }),
  useToggleNoteItemCompleted: () => ({
    mutateAsync: jest.fn().mockResolvedValue([]),
  }),
}));

jest.mock('../src/hooks/useNoteImages', () => ({
  __esModule: true,
  useUploadNoteImage: () => ({
    mutateAsync: jest.fn(),
  }),
  useDeleteNoteImage: () => ({
    mutateAsync: jest.fn(),
  }),
}));

jest.mock('../src/hooks/usePendingImageUploads', () => ({
  __esModule: true,
  usePendingImageUploads: () => [],
  useRetryPendingImageUpload: () => ({ mutate: jest.fn() }),
  useDismissPendingImageUpload: () => ({ mutate: jest.fn() }),
}));

jest.mock('../src/hooks/useOfflineNotes', () => ({
  __esModule: true,
  useOfflineNote: () => mockUseOfflineNote(),
}));

jest.mock('../src/store/SSEContext', () => ({
  __esModule: true,
  useSSESubscription: jest.fn(),
  useSSEContext: jest.fn(() => ({ sseReconnecting: false })),
}));

jest.mock('../src/components/LabelPicker', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === 'note.completedItems') {
        return `${options?.count ?? 0} completed items`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    isDark: false,
    colors: {
      background: '#fff',
      surface: '#fff',
      border: '#ddd',
      borderLight: '#eee',
      text: '#111',
      textSecondary: '#444',
      textMuted: '#777',
      placeholder: '#aaa',
      icon: '#555',
      iconMuted: '#888',
      primary: '#2563eb',
      primaryLight: '#dbeafe',
      error: '#dc2626',
      errorLight: '#fee2e2',
      cardBackground: '#fff',
      cardBorder: '#ddd',
    },
  }),
}));

jest.mock('../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    user: { id: 'u1', username: 'alice' },
    isAuthenticated: true,
  }),
}));

jest.mock('../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({
    usersById: new Map(),
  }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({
    showToast: jest.fn(),
  }),
}));

jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {},
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
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    fireEvent.press(getByTestId('add-list-item'));

    const baselineCount = getAllByTestId('list-item-text').length;
    const firstInput = getAllByTestId('list-item-text')[0];
    fireEvent.changeText(firstInput, 'Buy milk');
    fireEvent(firstInput, 'submitEditing');

    await waitFor(() => {
      expect(getAllByTestId('list-item-text').length).toBe(baselineCount + 1);
    });
  });

  it('pressing Enter at the start of a non-empty item inserts an empty item before it', async () => {
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    fireEvent.press(getByTestId('add-list-item'));

    const input = getAllByTestId('list-item-text')[0];
    fireEvent.changeText(input, 'hello');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
    fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      expect(inputsAfter[0].props.value).toBe('');
      expect(inputsAfter[1].props.value).toBe('hello');
    });
  });

  it('pressing Enter in the middle of an item splits it into two items at the cursor', async () => {
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    fireEvent.press(getByTestId('add-list-item'));

    const input = getAllByTestId('list-item-text')[0];
    fireEvent.changeText(input, 'helloworld');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      expect(inputsAfter[0].props.value).toBe('hello');
      expect(inputsAfter[1].props.value).toBe('world');
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

    const { getAllByTestId } = render(<NoteEditorScreen />);

    const input = getAllByTestId('list-item-text')[1];
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent(input, 'submitEditing');

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

    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('checked-items-section')).toBeTruthy();

    const input = getAllByTestId('list-item-text')[0];
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
    fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      // New (uncompleted) blank item renders above the completed section;
      // the completed item's own text is untouched.
      expect(inputsAfter[0].props.value).toBe('');
      expect(inputsAfter[1].props.value).toBe('hello');
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

    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('checked-items-section')).toBeTruthy();

    const input = getAllByTestId('list-item-text')[0];
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent(input, 'submitEditing');

    await waitFor(() => {
      const inputsAfter = getAllByTestId('list-item-text');
      expect(inputsAfter).toHaveLength(2);
      // The split-off remainder is a new (uncompleted) item, rendered above
      // the still-completed original.
      expect(inputsAfter[0].props.value).toBe('world');
      expect(inputsAfter[1].props.value).toBe('hello');
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

    const { unmount } = render(<NoteEditorScreen />);
    unmount();

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

    const { getAllByTestId, unmount } = render(<NoteEditorScreen />);

    fireEvent.changeText(getAllByTestId('list-item-text')[0], 'Oat milk');
    unmount();

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

    const { unmount } = render(<NoteEditorScreen />);
    unmount();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('keeps dirty state for color change when note id is not yet available', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    fireEvent.changeText(getByTestId('note-content-input'), 'Draft note');

    const colorButton = getByTestId('toolbar-color-btn');
    fireEvent.press(colorButton);
    const swatch = await waitFor(() => getByTestId('color-swatch-f28b82'));
    fireEvent.press(swatch);

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
