import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import NotesListScreen from '../src/screens/NotesListScreen';
import { lightColors } from '../src/theme/colors';
import { ConfirmContext } from '../src/hooks/useConfirm';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import type { Label, NoteSort } from '@jot/shared';

jest.mock('@react-navigation/native', () => {
  const mockDispatch = jest.fn();
  return {
    useNavigation: jest.fn().mockReturnValue({ navigate: jest.fn(), dispatch: mockDispatch }),
    DrawerActions: {
      toggleDrawer: () => ({ type: 'DRAWER_TOGGLE' }),
    },
    __mockDispatch: mockDispatch,
  };
});

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
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
  },
}));

jest.mock('../src/hooks/useOfflineNotes', () => ({
  useOfflineNotes: jest.fn(),
  useOfflineNote: jest.fn(),
}));

jest.mock('../src/hooks/useNotes', () => ({
  useUpdateNote: jest.fn(),
  useDeleteNote: jest.fn(),
  useRestoreNote: jest.fn(),
  usePermanentDeleteNote: jest.fn(),
  useReorderNotes: jest.fn(),
  useDuplicateNote: jest.fn(),
}));

jest.mock('../src/store/UsersContext', () => ({
  useUsers: jest.fn(),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: jest.fn(),
}));

jest.mock('../src/hooks/useToast', () => ({
  useToast: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  updateMe: jest.fn(),
}));

jest.mock('../src/api/notes', () => ({
  emptyTrash: jest.fn(),
}));

jest.mock('../src/db/noteQueries', () => ({
  getLocalNotes: jest.fn().mockResolvedValue([]),
  permanentDeleteLocalNote: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/components/NoteCard', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');

  function MockNoteCard({ note }: { note: { id: string; title: string } }) {
    return (
      <ReactNative.View testID={`note-card-${note.id}`}>
        <ReactNative.Text>{note.title}</ReactNative.Text>
      </ReactNative.View>
    );
  }

  return MockNoteCard;
});

jest.mock('../src/components/ColorPicker', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../src/components/LabelPicker', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  function MockLabelPicker({ visible, noteLabels }: { visible: boolean; noteLabels: Array<{ id: string; name: string }> }) {
    if (!visible) return null;
    return (
      <ReactNative.View testID="label-picker">
        {noteLabels.map((l) => (
          <ReactNative.Text key={l.id} testID={`label-picker-label-${l.id}`}>{l.name}</ReactNative.Text>
        ))}
      </ReactNative.View>
    );
  }
  return { __esModule: true, default: MockLabelPicker };
});

const mockUseOfflineNotes = jest.requireMock('../src/hooks/useOfflineNotes').useOfflineNotes as jest.Mock;
const mockUseOfflineNote = jest.requireMock('../src/hooks/useOfflineNotes').useOfflineNote as jest.Mock;
const navigationModule = jest.requireMock('@react-navigation/native') as {
  __mockDispatch: jest.Mock;
};
const notesHooks = jest.requireMock('../src/hooks/useNotes') as {
  useUpdateNote: jest.Mock;
  useDeleteNote: jest.Mock;
  useRestoreNote: jest.Mock;
  usePermanentDeleteNote: jest.Mock;
  useReorderNotes: jest.Mock;
  useDuplicateNote: jest.Mock;
};
const mockUseUsers = jest.requireMock('../src/store/UsersContext').useUsers as jest.Mock;
const mockUseAuth = jest.requireMock('../src/store/AuthContext').useAuth as jest.Mock;
const mockUseTheme = jest.requireMock('../src/theme/ThemeContext').useTheme as jest.Mock;
const mockUseToast = jest.requireMock('../src/hooks/useToast').useToast as jest.Mock;
const mockUpdateMe = jest.requireMock('../src/api/settings').updateMe as jest.Mock;
const mockEmptyTrash = jest.requireMock('../src/api/notes').emptyTrash as jest.Mock;
const mockGetLocalNotes = jest.requireMock('../src/db/noteQueries').getLocalNotes as jest.Mock;
const mockEnqueueOperation = jest.requireMock('../src/db/syncQueue').enqueueOperation as jest.Mock;

const mockMutateAsync = jest.fn();
const mockUser = {
  id: 'user-1',
  username: 'mobile-user',
};
const baseSettings: {
  user_id: string;
  language: string;
  theme: 'system';
  note_sort: NoteSort;
  updated_at: string;
} = {
  user_id: 'user-1',
  language: 'en',
  theme: 'system',
  note_sort: 'manual',
  updated_at: '2024-01-01T00:00:00Z',
};

const buildNote = (overrides: Partial<{
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  labels: Label[];
  created_at: string;
  updated_at: string;
}> = {}) => ({
  id: 'note-1',
  user_id: 'user-1',
  title: 'Test Note',
  content: '',
  note_type: 'text' as const,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  checked_items_collapsed: false,
  is_shared: false,
  labels: [],
  shared_with: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

type SortPreferenceResponse = {
  user: typeof mockUser;
  settings: typeof baseSettings & { note_sort: NoteSort };
};

describe('NotesListScreen sorting', () => {
  const openSortControls = async () => {
    await fireEvent.press(screen.getByTestId('sort-toggle'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    markServerReachable();
    mockGetLocalNotes.mockResolvedValue([]);
    mockUseToast.mockReturnValue({ showToast: jest.fn() });
    notesHooks.useUpdateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useRestoreNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.usePermanentDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useReorderNotes.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDuplicateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    mockUseUsers.mockReturnValue({ refreshUsers: jest.fn() });
    mockUseTheme.mockReturnValue({ colors: lightColors });
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings: jest.fn(),
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUseOfflineNote.mockReturnValue({ data: null });
  });

  afterEach(() => {
    markServerReachable();
  });

  it('normalizes an unsupported saved sort preference back to manual', async () => {
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'unsupported' as unknown as NoteSort },
      setSettings: jest.fn(),
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    // The draggable masonry only positions and reveals cards once it has
    // measured their real height via onLayout; simulate the native layout
    // pass the test renderer doesn't perform on its own. The card starts out
    // in the (accessibility-hidden) off-screen measurement pool, so it must
    // be queried with includeHiddenElements.
    for (const id of ['pinned-zulu', 'unpinned-bravo', 'unpinned-alpha']) {
      await fireEvent(screen.getByTestId(`note-card-${id}`, { includeHiddenElements: true }), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 150, height: 100 } },
      });
    }

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(screen.queryByTestId('sort-controls')).toBeNull();
    expect(screen.getByTestId('drawer-toggle')).toBeTruthy();
    expect(screen.getByTestId('sort-toggle')).toBeTruthy();
    expect(screen.getByTestId('notes-masonry-draggable')).toBeTruthy();
    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByText('sort-demo-zulu')).toBeTruthy();
    expect(screen.getByText('sort-demo-alpha')).toBeTruthy();
    expect(screen.getByText('sort-demo-bravo')).toBeTruthy();
  });

  it('persists a sort selection from the notes screen', async () => {
    const setSettings = jest.fn();
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUpdateMe.mockResolvedValue({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'created_at' },
    });

    await render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    // Manual sort is draggable; a non-manual sort drops to the static masonry.
    expect(screen.getByTestId('notes-masonry-draggable')).toBeTruthy();
    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'created_at' });
      expect(screen.getByTestId('sort-disabled-notice')).toBeTruthy();
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
    expect(screen.queryByTestId('notes-masonry-draggable')).toBeNull();
    expect(screen.getByTestId('notes-masonry-grid')).toBeTruthy();
  });

  it('rolls back the selected sort when persistence fails', async () => {
    const setSettings = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUpdateMe.mockRejectedValue(new Error('network error'));

    await render(<NotesListScreen variant="notes" />);

    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'created_at' });
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Failed to update sort preference');
    });

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'manual' }));
    alertSpy.mockRestore();
  });

  it('enqueues the sort change without a network call when the server is known-unreachable', async () => {
    markServerUnreachable();
    const setSettings = jest.fn();
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: { note_sort: 'created_at' },
        }),
      );
    });

    // The doomed round-trip is skipped entirely, and the optimistic sort stands.
    expect(mockUpdateMe).not.toHaveBeenCalled();
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
  });

  it('rolls back the sort change when the local enqueue itself fails while known-unreachable', async () => {
    markServerUnreachable();
    mockEnqueueOperation.mockRejectedValueOnce(new Error('sqlite write failed'));
    const setSettings = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    // Since the local SQLite enqueue itself failed (not just the network), the
    // change can never replay — roll back rather than silently pretending it saved.
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Failed to update sort preference');
    });
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'manual' }));
    alertSpy.mockRestore();
  });

  it('enqueues the sort change (without rolling back) when persistence fails transiently', async () => {
    const setSettings = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    // A transient (queueable) failure: a network error surfaced as an axios error.
    mockUpdateMe.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }));

    await render(<NotesListScreen variant="notes" />);

    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: { note_sort: 'created_at' },
        }),
      );
    });

    // No rollback and no blocking dialog for a transient failure.
    expect(alertSpy).not.toHaveBeenCalled();
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
    alertSpy.mockRestore();
  });

  it('ignores stale sort responses when selections change quickly', async () => {
    const setSettings = jest.fn();
    const first = createDeferred<SortPreferenceResponse>();
    const second = createDeferred<SortPreferenceResponse>();

    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings,
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        buildNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUpdateMe
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await render(<NotesListScreen variant="notes" />);

    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-updated_at'));
    await openSortControls();
    await fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    second.resolve({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'created_at' },
    });

    await waitFor(() => {
      expect(within(screen.getByTestId('sort-disabled-notice')).getByText(/Date created/)).toBeTruthy();
    });

    first.resolve({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'updated_at' },
    });

    await waitFor(() => {
      expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
    });
    expect(within(screen.getByTestId('sort-disabled-notice')).getByText(/Date created/)).toBeTruthy();
  });

  it('toggles sort controls visibility from the compact header', async () => {
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-controls')).toBeNull();
    await fireEvent.press(screen.getByTestId('sort-toggle'));
    expect(screen.getByTestId('sort-controls')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sort-toggle'));
    expect(screen.queryByTestId('sort-controls')).toBeNull();
  });

  it('opens the drawer from the compact menu button', async () => {
    await render(<NotesListScreen variant="notes" />);

    await fireEvent.press(screen.getByTestId('drawer-toggle'));

    expect(navigationModule.__mockDispatch).toHaveBeenCalledWith({ type: 'DRAWER_TOGGLE' });
  });

  it('clears search text from the compact header control', async () => {
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    await fireEvent.changeText(screen.getByTestId('search-input'), 'demo query');
    expect(screen.getByLabelText('Clear search')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('clear-search'));

    await waitFor(() => {
      expect(screen.queryByTestId('clear-search')).toBeNull();
    });
  });

  it('pull-to-refresh on empty state reloads notes and users', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    const refreshUsers = jest.fn().mockResolvedValue(undefined);
    mockUseOfflineNotes.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch,
      isRefetching: false,
    });
    mockUseUsers.mockReturnValue({ refreshUsers });

    await render(<NotesListScreen variant="notes" />);

    const emptyState = screen.getByTestId('notes-empty-state');
    const onRefresh = emptyState.props.refreshControl.props.onRefresh as () => Promise<void>;
    await onRefresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refreshUsers).toHaveBeenCalledTimes(1);
  });

  it('pull-to-refresh on error state reloads notes and users', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    const refreshUsers = jest.fn().mockResolvedValue(undefined);
    mockUseOfflineNotes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
      isRefetching: false,
    });
    mockUseUsers.mockReturnValue({ refreshUsers });

    await render(<NotesListScreen variant="notes" />);

    const errorState = screen.getByTestId('notes-error-state');
    const onRefresh = errorState.props.refreshControl.props.onRefresh as () => Promise<void>;
    await onRefresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refreshUsers).toHaveBeenCalledTimes(1);
  });

  it('retry button on error state reloads notes and users', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    const refreshUsers = jest.fn().mockResolvedValue(undefined);
    mockUseOfflineNotes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
      isRefetching: false,
    });
    mockUseUsers.mockReturnValue({ refreshUsers });

    await render(<NotesListScreen variant="notes" />);
    await fireEvent.press(screen.getByTestId('retry-fetch'));

    await waitFor(() => {
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(refreshUsers).toHaveBeenCalledTimes(1);
    });
  });
});

describe('NotesListScreen empty trash', () => {
  const confirmingConfirm = jest.fn().mockResolvedValue(true);

  const renderTrashScreen = () =>
    render(
      <ConfirmContext.Provider value={{ confirm: confirmingConfirm }}>
        <NotesListScreen variant="trash" />
      </ConfirmContext.Provider>,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    markServerReachable();
    confirmingConfirm.mockResolvedValue(true);
    mockGetLocalNotes.mockResolvedValue([
      buildNote({ id: 'trashed-1', title: 'Trashed note' }),
    ]);
    mockUseToast.mockReturnValue({ showToast: jest.fn() });
    notesHooks.useUpdateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useRestoreNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.usePermanentDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useReorderNotes.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDuplicateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    mockUseUsers.mockReturnValue({ refreshUsers: jest.fn().mockResolvedValue(undefined) });
    mockUseTheme.mockReturnValue({ colors: lightColors });
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: baseSettings,
      setSettings: jest.fn(),
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [buildNote({ id: 'trashed-1', title: 'Trashed note' })],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUseOfflineNote.mockReturnValue({ data: null });
  });

  afterEach(() => {
    markServerReachable();
  });

  it('skips the network call and shows a bounded error when the server is known-unreachable', async () => {
    markServerUnreachable();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    await renderTrashScreen();

    await waitFor(() => expect(screen.getByTestId('empty-trash-button')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('empty-trash-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Error', "Empty Trash isn't available offline");
    });

    expect(mockEmptyTrash).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('empties the trash normally when the server is reachable', async () => {
    mockEmptyTrash.mockResolvedValue({ deleted_count: 1 });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    await renderTrashScreen();

    await waitFor(() => expect(screen.getByTestId('empty-trash-button')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('empty-trash-button'));

    await waitFor(() => {
      expect(mockEmptyTrash).toHaveBeenCalled();
    });
    alertSpy.mockRestore();
  });
});

describe('NotesListScreen layout toggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseToast.mockReturnValue({ showToast: jest.fn() });
    notesHooks.useUpdateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useRestoreNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.usePermanentDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useReorderNotes.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDuplicateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    mockUseUsers.mockReturnValue({ refreshUsers: jest.fn() });
    mockUseTheme.mockReturnValue({ colors: lightColors });
    mockUseOfflineNote.mockReturnValue({ data: null });
  });

  it('switches between one- and two-column layouts and persists the choice', async () => {
    // A non-manual sort keeps the static (non-draggable) masonry, which renders
    // its cards without needing a measured layout pass. The list layout renders a
    // single column; the grid layout adds a second.
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'created_at' as NoteSort },
      setSettings: jest.fn(),
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'n1', title: 'grid-note-1' }),
        buildNote({ id: 'n2', title: 'grid-note-2' }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    await render(<NotesListScreen variant="notes" />);

    // List layout: a single masonry column.
    expect(screen.getByTestId('notes-masonry-grid')).toBeTruthy();
    expect(screen.getByTestId('masonry-column-0')).toBeTruthy();
    expect(screen.queryByTestId('masonry-column-1')).toBeNull();

    await fireEvent.press(screen.getByTestId('layout-toggle'));

    // Grid layout: a second column appears.
    await waitFor(() => {
      expect(screen.getByTestId('masonry-column-1')).toBeTruthy();
    });
    expect(screen.getByText('grid-note-1')).toBeTruthy();
    expect(screen.getByText('grid-note-2')).toBeTruthy();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('jot_dashboard_layout', 'grid');

    // Toggling back returns to the single-column list.
    await fireEvent.press(screen.getByTestId('layout-toggle'));
    await waitFor(() => {
      expect(screen.queryByTestId('masonry-column-1')).toBeNull();
    });
    expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith('jot_dashboard_layout', 'list');
  });
});

describe('NotesListScreen archived search', () => {
  const offlineResult = (notes: ReturnType<typeof buildNote>[]) => ({
    data: notes,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    isRefetching: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseToast.mockReturnValue({ showToast: jest.fn() });
    notesHooks.useUpdateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useRestoreNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.usePermanentDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useReorderNotes.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDuplicateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    mockUseUsers.mockReturnValue({ refreshUsers: jest.fn() });
    mockUseTheme.mockReturnValue({ colors: lightColors });
    mockUseAuth.mockReturnValue({ user: mockUser, settings: baseSettings, setSettings: jest.fn() });
    mockUseOfflineNote.mockReturnValue({ data: null });
  });

  it('separates archived matches into their own section when searching', async () => {
    // Stable result references per branch so the notes-dependent effects don't loop.
    const activeResult = offlineResult([buildNote({ id: 'active-1', title: 'active match' })]);
    const archivedResult = offlineResult([buildNote({ id: 'archived-1', title: 'archived match', archived: true })]);
    mockUseOfflineNotes.mockImplementation((params?: { archived?: boolean }) =>
      params?.archived ? archivedResult : activeResult,
    );

    await render(<NotesListScreen variant="notes" />);

    // No archived section before a search is entered
    expect(screen.queryByText('Archived')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('search-input'), 'match');

    await waitFor(() => {
      expect(screen.getByText('Archived')).toBeTruthy();
    });
    expect(screen.getByText('archived match')).toBeTruthy();
    expect(screen.getByText('active match')).toBeTruthy();
  });

  it('disables the archived fetch until a search is active', async () => {
    const activeResult = offlineResult([buildNote({ id: 'active-1', title: 'active match' })]);
    mockUseOfflineNotes.mockImplementation(() => activeResult);

    await render(<NotesListScreen variant="notes" />);

    // The second (archived) hook call is invoked with enabled: false while idle
    const archivedCall = mockUseOfflineNotes.mock.calls.find(
      ([params]) => params?.archived === true,
    );
    expect(archivedCall?.[1]).toEqual({ enabled: false });
  });
});
