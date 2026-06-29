import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { PanResponder, StyleSheet } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';
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
const mockGestureResponderEvent = {} as GestureResponderEvent;
const createPanState = (dx: number, dy: number): PanResponderGestureState => ({
  stateID: 1,
  moveX: 0,
  moveY: 0,
  x0: 0,
  y0: 0,
  dx,
  dy,
  vx: 0,
  vy: 0,
  numberActiveTouches: 1,
  _accountsForMovesUpTo: 0,
});

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

jest.mock('react-native-reorderable-list', () => {
  const ReactNative = jest.requireActual('react-native') as typeof import('react-native');
  const ReactModule = jest.requireActual('react') as typeof import('react');
  const ReorderableList = ({ data, renderItem }: { data: Array<{ id: string }>; renderItem: (args: { item: { id: string }; index: number }) => React.ReactNode }) => (
    <ReactNative.View>
      {data.map((item, index) => (
        <ReactModule.Fragment key={item.id}>{renderItem({ item, index })}</ReactModule.Fragment>
      ))}
    </ReactNative.View>
  );
  return {
    __esModule: true,
    default: ReorderableList,
    ReorderableList,
    NestedReorderableList: ReorderableList,
    ScrollViewContainer: ReactModule.forwardRef(function ScrollViewContainer(props: Record<string, unknown>, ref: React.Ref<unknown>) {
      return <ReactNative.ScrollView ref={ref as never} {...props} />;
    }),
    useReorderableDrag: () => () => {},
    useIsActive: () => false,
    reorderItems: (arr: Array<{ id: string }>, from: number, to: number) => {
      const copy = [...arr];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    },
  };
});

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
  function getLastPanResponderConfig(createSpy: jest.SpiedFunction<typeof PanResponder.create>, callsBefore: number) {
    const configs = createSpy.mock.calls
      .slice(callsBefore)
      .map(([config]) => config)
      .filter((config) => typeof config.onPanResponderRelease === 'function');
    return configs[configs.length - 1];
  }

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

  it('updates list item indentation from horizontal swipe gesture', async () => {
    const panResponderSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = panResponderSpy.mock.calls.length;
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    // Add two items so the second can be nested under the first
    fireEvent.press(getByTestId('add-list-item'));
    fireEvent.press(getByTestId('add-list-item'));

    // Both items start with no indentation
    expect(StyleSheet.flatten(getAllByTestId('list-item-row')[1].props.style)?.marginLeft).toBe(0);

    // Get the last PanResponder created — belongs to the second (to-be-indented) item
    const secondItemConfig = getLastPanResponderConfig(panResponderSpy, callsBefore);
    expect(secondItemConfig).toBeDefined();

    // Swipe right on the second item to nest it under the first
    await act(async () => {
      secondItemConfig?.onPanResponderRelease?.(mockGestureResponderEvent, createPanState(60, 0));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[1].props.style)?.marginLeft).toBe(
        VALIDATION.INDENT_PX_PER_LEVEL,
      );
    });

    // Re-query the latest configs after re-render
    const secondItemConfigAfter = getLastPanResponderConfig(panResponderSpy, callsBefore);

    // Swipe left to outdent
    await act(async () => {
      secondItemConfigAfter?.onPanResponderRelease?.(mockGestureResponderEvent, createPanState(-60, 0));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[1].props.style)?.marginLeft).toBe(0);
    });
  });

  it('indents and outdents list item via toolbar buttons', async () => {
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    // Add two items so the second can be nested under the first
    fireEvent.press(getByTestId('add-list-item'));
    fireEvent.press(getByTestId('add-list-item'));

    const secondItemRow = getAllByTestId('list-item-row')[1];
    expect(StyleSheet.flatten(secondItemRow.props.style)?.marginLeft).toBe(0);

    // Focus the second list item input to set focusedListItemId
    fireEvent(getAllByTestId('list-item-text')[1], 'focus', { nativeEvent: { target: 2 } });

    // Tap indent button — nests second item under first
    await act(async () => {
      fireEvent.press(getByTestId('list-indent-btn'));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[1].props.style)?.marginLeft).toBe(
        VALIDATION.INDENT_PX_PER_LEVEL,
      );
    });

    // Tap outdent button — promotes back to top-level
    await act(async () => {
      fireEvent.press(getByTestId('list-outdent-btn'));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[1].props.style)?.marginLeft).toBe(0);
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
