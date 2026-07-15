import React from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { useSSESubscription } from '../src/store/SSEContext';

const mockUseRoute = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUseOfflineNote = jest.fn();

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
  usePermanentDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useDuplicateNote: () => ({ mutateAsync: jest.fn() }),
  useConvertNoteType: () => ({ mutateAsync: jest.fn() }),
  useCreateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useUpdateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteItem: () => ({ mutateAsync: jest.fn() }),
  useReorderNoteItems: () => ({ mutateAsync: jest.fn() }),
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

// A stable `t`/`i18n` reference across renders mirrors real i18next; a fresh
// function each render would change memoized callbacks (e.g. flushSave) and make
// the unmount-flush effect fire spuriously on rerender.
const stableT = (key: string, options?: { count?: number }) => {
  if (key === 'note.completedItems') {
    return `${options?.count ?? 0} completed items`;
  }
  return key;
};
const stableI18n = { language: 'en' };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: stableT, i18n: stableI18n }),
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

function makeItem(id: string, text: string, position: number) {
  return {
    id,
    note_id: 'note-refresh',
    text,
    completed: false,
    position,
    parent_id: null,
    assigned_to: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function listNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'note-refresh',
    user_id: 'u1',
    title: 'Packliste',
    content: '',
    note_type: 'list',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [],
    shared_with: [],
    items: [makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0)],
    ...overrides,
  };
}

function itemTexts(getAllByTestId: (id: string) => { props: { value?: string } }[]): string[] {
  return getAllByTestId('list-item-text').map((node) => node.props.value ?? '');
}

describe('NoteEditorScreen remote refresh', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-refresh' } });
  });

  // The core bug: another user adds a checklist item to a shared note. The
  // update lands in the offline cache and re-runs the query, but the editor
  // kept its first-hydration snapshot, so the new item never appeared. A clean
  // editor must now re-hydrate from the refreshed note.
  it('reflects checklist items added by another user when the editor is clean', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getAllByTestId, rerender } = render(<NoteEditorScreen />);

    expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe']);

    // Simulate the SSE-driven refetch: the cache now holds an extra item.
    const updated = listNote({
      items: [
        makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0),
        makeItem('bbbbbbbbbbbbbbbbbbbbbb', 'Kultur', 1),
      ],
      updated_at: '2026-01-01T00:05:00.000Z',
    });
    mockUseOfflineNote.mockReturnValue({ data: updated });
    await act(async () => {
      rerender(<NoteEditorScreen />);
    });

    await waitFor(() => {
      expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe', 'Kultur']);
    });
  });

  // The safety guard: when the local user has unsaved edits, an incoming remote
  // update must NOT clobber their in-progress work. The banner alone signals the
  // remote change; the editor keeps the dirty local state.
  it('does not clobber unsaved local edits when a remote update arrives', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getByTestId, getAllByTestId, rerender } = render(<NoteEditorScreen />);

    // Local user edits the title — this marks the editor dirty.
    await act(async () => {
      fireEvent.changeText(getByTestId('note-title-input'), 'Packliste (mine)');
    });

    // A remote update arrives with a different title and an extra item.
    const updated = listNote({
      title: 'Packliste (theirs)',
      items: [
        makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0),
        makeItem('bbbbbbbbbbbbbbbbbbbbbb', 'Kultur', 1),
      ],
      updated_at: '2026-01-01T00:05:00.000Z',
    });
    mockUseOfflineNote.mockReturnValue({ data: updated });
    await act(async () => {
      rerender(<NoteEditorScreen />);
    });

    // The local edit is preserved and the remote item was not merged in.
    expect(getByTestId('note-title-input').props.value).toBe('Packliste (mine)');
    expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe']);
  });

  // The banner is now state-aware: a clean editor silently absorbs the remote
  // change (no banner), while a dirty editor — where the refresh is suppressed —
  // gets the warning banner as the only signal of the divergence.
  it('warns about a remote change only while the editor has unsaved edits', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // The SSE hook is mocked; grab the latest handler the editor registered so
    // we can simulate an inbound "another user updated this note" event.
    const fireRemoteUpdate = () => {
      const calls = (useSSESubscription as jest.Mock).mock.calls;
      (calls[calls.length - 1][1] as () => void)();
    };

    // Clean editor: no banner (the change is auto-applied by the refresh effect).
    await act(async () => { fireRemoteUpdate(); });
    expect(queryByTestId('sync-toast')).toBeNull();

    // Introduce an unsaved local edit.
    await act(async () => {
      fireEvent.changeText(getByTestId('note-title-input'), 'Packliste (mine)');
    });

    // Now a remote update surfaces the warning banner.
    await act(async () => { fireRemoteUpdate(); });
    expect(queryByTestId('sync-toast')).not.toBeNull();
  });
});
