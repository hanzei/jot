import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUseOfflineNote = jest.fn();
const mockToggleMutateAsync = jest.fn();

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockUseRoute(),
  useNavigation: () => ({
    goBack: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    setParams: jest.fn(),
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
  useCreateNote: () => ({ mutateAsync: jest.fn() }),
  useUpdateNote: () => ({ mutateAsync: jest.fn().mockResolvedValue({}) }),
  useDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useRestoreNote: () => ({ mutateAsync: jest.fn() }),
  useDuplicateNote: () => ({ mutateAsync: jest.fn() }),
  useCreateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useUpdateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteItem: () => ({ mutateAsync: jest.fn() }),
  useReorderNoteItems: () => ({ mutateAsync: jest.fn() }),
  useToggleNoteItemCompleted: () => ({ mutateAsync: mockToggleMutateAsync }),
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
  useUsers: () => ({ usersById: new Map() }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {},
}));

const PARENT_ID = 'pppppppppppppppppppppp';
const CHILD_ID = 'cccccccccccccccccccccc';

function listNoteWithParentAndChild() {
  return {
    id: 'note-rollback',
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
        id: PARENT_ID,
        note_id: 'note-rollback',
        text: 'Parent',
        completed: false,
        position: 0,
        parent_id: null,
        assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: CHILD_ID,
        note_id: 'note-rollback',
        text: 'Child',
        completed: false,
        position: 1,
        parent_id: PARENT_ID,
        assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('NoteEditorScreen toggle rollback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-rollback' } });
    mockUseOfflineNote.mockReturnValue({ data: listNoteWithParentAndChild() });
  });

  // A child toggle (succeeds) immediately followed — before the first toggle
  // re-renders — by a parent toggle whose request fails. The parent toggle must
  // capture the child's *current* completed state, so its rollback restores only
  // the parent and leaves the child checked. A stale snapshot would revert the
  // child too. The two onPress handlers are invoked inside a single act() so the
  // second runs against the same un-rendered optimistic state a rapid double-tap
  // produces on device.
  it('keeps a sibling toggle when an overlapping parent toggle fails', async () => {
    mockToggleMutateAsync.mockImplementation(
      ({ itemId, completed }: { itemId: string; completed: boolean }) => {
        if (itemId === PARENT_ID) {
          return Promise.reject(new Error('toggle failed'));
        }
        return Promise.resolve([{ id: itemId, completed }]);
      },
    );

    const { getAllByTestId, getByText, UNSAFE_getAllByProps } = render(<NoteEditorScreen />);

    // Both items start unchecked, so both render in the active list:
    // [0] = Parent, [1] = Child. The checkbox composites carry onPress (= the
    // row's toggle handler); the testID host node does not.
    // Each checkbox surfaces as multiple nodes sharing one onPress reference;
    // dedupe by handler identity to get one entry per row (Parent, then Child).
    const seenToggles = new Set<unknown>();
    const checkboxes = UNSAFE_getAllByProps({ accessibilityRole: 'checkbox' })
      .filter((node) => typeof node.props.onPress === 'function')
      .filter((node) => {
        if (seenToggles.has(node.props.onPress)) return false;
        seenToggles.add(node.props.onPress);
        return true;
      });
    expect(checkboxes).toHaveLength(2);

    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Invoke both toggles in one act() so the parent toggle runs against the
    // child's optimistic state before a re-render — reproducing a rapid
    // double-tap. onPress wraps handleItemCompletedToggle(id, !completed).
    await act(async () => {
      checkboxes[1].props.onPress(); // check Child (request succeeds)
      checkboxes[0].props.onPress(); // check Parent (request fails)
    });

    // Parent rolled back to unchecked; Child stays checked.
    await waitFor(() => {
      expect(getByText('1 completed items')).toBeTruthy();
    });
    expect(getAllByTestId('icon-checkbox')).toHaveLength(1); // only Child completed
    expect(getAllByTestId('icon-square-outline')).toHaveLength(1); // only Parent active

    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: CHILD_ID, completed: true }),
    );
    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: PARENT_ID, completed: true }),
    );
  });
});
