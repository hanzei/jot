import type React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
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
const mockUseOfflineNote = jest.fn();
const mockReorderItemsMutateAsync = jest.fn();

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

// Declared at module scope (rather than inline inside the jest.mock() factory
// below) to work around a babel-plugin-jest-hoist limitation: a named
// function-type parameter written inline inside a factory is misread as an
// out-of-scope variable reference. A plain type-reference identifier to an
// alias declared out here does not trip that check.
type RenderItemFn = (info: { item: unknown; index: number }) => React.ReactNode;

// Override the shared react-native-reorderable-list mock from jest.setup.js so
// the test can invoke `onReorder` directly, the same way the real library does
// once a drag drops on a new slot — without needing to drive an actual
// gesture. `__getLatestProps` exposes the props NestedReorderableList was last
// rendered with, purely for this test file's own use.
jest.mock('react-native-reorderable-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactActual = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RN = require('react-native') as typeof import('react-native');
  let latestProps: Record<string, unknown> | null = null;
  function ReorderableList(props: Record<string, unknown>) {
    latestProps = props;
    const items = (props.data as { id: string }[]) || [];
    const renderItem = props.renderItem as RenderItemFn;
    return ReactActual.createElement(
      RN.View,
      null,
      items.map((item, index) =>
        ReactActual.createElement(
          ReactActual.Fragment,
          { key: item.id },
          renderItem({ item, index }),
        ),
      ),
    );
  }
  ReorderableList.displayName = 'ReorderableList';
  const ScrollViewContainer = ReactActual.forwardRef(function ScrollViewContainer(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    return ReactActual.createElement(RN.ScrollView, { ...props, ref } as never);
  });
  return {
    __esModule: true,
    default: ReorderableList,
    ReorderableList,
    NestedReorderableList: ReorderableList,
    ScrollViewContainer,
    useReorderableDrag: () => () => {},
    useReorderableDragStart: () => () => {},
    useReorderableDragEnd: () => () => {},
    useIsActive: () => false,
    reorderItems: (arr: unknown[], from: number, to: number) => {
      const copy = [...arr];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    },
    __getLatestProps: () => latestProps,
  };
});

jest.mock('../src/hooks/useNotes', () => ({
  __esModule: true,
  useCreateNote: () => ({ mutateAsync: mockCreateMutateAsync }),
  useUpdateNote: () => ({ mutateAsync: mockUpdateMutateAsync }),
  useDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useRestoreNote: () => ({ mutateAsync: jest.fn() }),
  usePermanentDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useDuplicateNote: () => ({ mutateAsync: jest.fn() }),
  useConvertNoteType: () => ({ mutateAsync: jest.fn() }),
  useCreateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useUpdateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteItem: () => ({ mutateAsync: jest.fn() }),
  useReorderNoteItems: () => ({ mutateAsync: mockReorderItemsMutateAsync }),
  useToggleNoteItemCompleted: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
  useUncheckAllItems: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
  useDeleteCompletedItems: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../src/hooks/useNoteImages', () => ({
  __esModule: true,
  useUploadNoteImage: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteImage: () => ({ mutateAsync: jest.fn() }),
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
    t: (key: string, options?: { count?: number }) =>
      key === 'note.completedItems' ? `${options?.count ?? 0} completed items` : key,
    i18n: { language: 'en' },
  }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    isDark: false,
    colors: {
      background: '#fff', surface: '#fff', border: '#ddd', borderLight: '#eee',
      text: '#111', textSecondary: '#444', textMuted: '#777', placeholder: '#aaa',
      icon: '#555', iconMuted: '#888', primary: '#2563eb', primaryLight: '#dbeafe',
      error: '#dc2626', errorLight: '#fee2e2', cardBackground: '#fff', cardBorder: '#ddd',
    },
  }),
}));

jest.mock('../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { id: 'u1', username: 'alice' }, isAuthenticated: true }),
}));

jest.mock('../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({ usersById: new Map() }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../src/i18n', () => ({ __esModule: true, default: {} }));

const ITEM_A_ID = 'aaaaaaaaaaaaaaaaaaaaaa';
const ITEM_B_ID = 'bbbbbbbbbbbbbbbbbbbbbb';

function twoItemListNote() {
  return {
    id: 'note-drag-focus',
    user_id: 'u1',
    title: 'Trip',
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
        id: ITEM_A_ID, note_id: 'note-drag-focus', text: 'Item A', completed: false,
        position: 0, parent_id: null, assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: ITEM_B_ID, note_id: 'note-drag-focus', text: 'Item B', completed: false,
        position: 1, parent_id: null, assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('NoteEditorScreen list item focus across a drag reorder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-drag-focus' } });
    mockUseOfflineNote.mockReturnValue({ data: twoItemListNote() });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockReorderItemsMutateAsync.mockResolvedValue([]);
  });

  // Regression test for the bug where focusing a list item and then dragging
  // it to reorder moved focus to the title input. The real
  // react-native-reorderable-list force-remounts any row whose slot changed
  // (a new `key`, to fix a layout glitch — see ReorderableListCore's
  // `createCellKey`), which drops the focused TextInput. This mock doesn't
  // reproduce that remount, but it lets us verify the fix's actual mechanism:
  // NoteEditorScreen re-arms `autoFocus` on the previously-focused item so
  // that when the real library remounts it, native `autoFocus`-on-mount
  // behavior re-opens the keyboard on it instead of leaving focus to fall
  // back elsewhere.
  it('re-arms autoFocus on the item that was focused before the drag committed', () => {
    const { getByDisplayValue } = render(<NoteEditorScreen />);

    const itemAInput = getByDisplayValue('Item A');
    fireEvent(itemAInput, 'focus', { nativeEvent: { target: 1 } });

    const reorderableListMock = jest.requireMock('react-native-reorderable-list') as {
      __getLatestProps: () => { onReorder: (e: { from: number; to: number }) => void };
    };

    act(() => {
      reorderableListMock.__getLatestProps().onReorder({ from: 0, to: 1 });
    });

    expect(getByDisplayValue('Item A').props.autoFocus).toBe(true);
    expect(getByDisplayValue('Item B').props.autoFocus).not.toBe(true);
  });

  it('does not mark an item for autoFocus when nothing was focused before the drag', () => {
    const { getByDisplayValue } = render(<NoteEditorScreen />);

    const reorderableListMock = jest.requireMock('react-native-reorderable-list') as {
      __getLatestProps: () => { onReorder: (e: { from: number; to: number }) => void };
    };

    act(() => {
      reorderableListMock.__getLatestProps().onReorder({ from: 0, to: 1 });
    });

    expect(getByDisplayValue('Item A').props.autoFocus).not.toBe(true);
    expect(getByDisplayValue('Item B').props.autoFocus).not.toBe(true);
  });
});
