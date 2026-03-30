import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import NotesListScreen from '../src/screens/NotesListScreen';
import { lightColors } from '../src/theme/colors';
import type { NoteSort } from '@jot/shared';

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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
  },
}));

jest.mock('react-native-draggable-flatlist', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');

  function MockDraggableFlatList({
    data,
    renderItem,
    testID,
  }: {
    data: unknown[];
    renderItem: (args: { item: unknown; drag: () => void; isActive: boolean }) => React.ReactNode;
    testID?: string;
  }) {
    return (
      <ReactNative.View testID={testID}>
        {data.map((item, index) => (
          <ReactNative.View key={(item as { id?: string }).id ?? index.toString()}>
            {renderItem({ item, drag: jest.fn(), isActive: false })}
          </ReactNative.View>
        ))}
      </ReactNative.View>
    );
  }

  function MockScaleDecorator({ children }: { children: React.ReactNode }) {
    return children;
  }

  function MockNestableScrollContainer(props: Record<string, unknown>) {
    return <ReactNative.ScrollView {...props} />;
  }

  return {
    __esModule: true,
    default: MockDraggableFlatList,
    ScaleDecorator: MockScaleDecorator,
    NestableDraggableFlatList: MockDraggableFlatList,
    NestableScrollContainer: MockNestableScrollContainer,
  };
});

jest.mock('../src/hooks/useOfflineNotes', () => ({
  useOfflineNotes: jest.fn(),
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

jest.mock('../src/api/settings', () => ({
  updateMe: jest.fn(),
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

jest.mock('../src/components/NoteContextMenu', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../src/components/ColorPicker', () => ({
  __esModule: true,
  default: () => null,
}));

const mockUseOfflineNotes = jest.requireMock('../src/hooks/useOfflineNotes').useOfflineNotes as jest.Mock;
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
const mockUpdateMe = jest.requireMock('../src/api/settings').updateMe as jest.Mock;

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
  const openSortControls = () => {
    fireEvent.press(screen.getByTestId('sort-toggle'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
  });

  it('normalizes an unsupported saved sort preference back to manual', () => {
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

    render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(screen.queryByTestId('sort-controls')).toBeNull();
    expect(screen.getByTestId('drawer-toggle')).toBeTruthy();
    expect(screen.getByTestId('sort-toggle')).toBeTruthy();
    expect(screen.getByTestId('pinned-draggable-list')).toBeTruthy();
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

    render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(screen.getByTestId('notes-section-list')).toBeTruthy();
    expect(screen.getByTestId('unpinned-draggable-list')).toBeTruthy();
    openSortControls();
    fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'created_at' });
      expect(screen.getByTestId('sort-disabled-notice')).toBeTruthy();
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
    expect(screen.queryByTestId('unpinned-draggable-list')).toBeNull();
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

    render(<NotesListScreen variant="notes" />);

    openSortControls();
    fireEvent.press(screen.getByTestId('sort-chip-created_at'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'created_at' });
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Failed to update sort preference');
    });

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'manual' }));
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

    render(<NotesListScreen variant="notes" />);

    openSortControls();
    fireEvent.press(screen.getByTestId('sort-chip-updated_at'));
    openSortControls();
    fireEvent.press(screen.getByTestId('sort-chip-created_at'));

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

  it('toggles sort controls visibility from the compact header', () => {
    mockUseOfflineNotes.mockReturnValue({
      data: [
        buildNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-controls')).toBeNull();
    fireEvent.press(screen.getByTestId('sort-toggle'));
    expect(screen.getByTestId('sort-controls')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sort-toggle'));
    expect(screen.queryByTestId('sort-controls')).toBeNull();
  });

  it('opens the drawer from the compact menu button', () => {
    render(<NotesListScreen variant="notes" />);

    fireEvent.press(screen.getByTestId('drawer-toggle'));

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

    render(<NotesListScreen variant="notes" />);

    fireEvent.changeText(screen.getByTestId('search-input'), 'demo query');
    expect(screen.getByLabelText('Clear search')).toBeTruthy();
    fireEvent.press(screen.getByTestId('clear-search'));

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

    render(<NotesListScreen variant="notes" />);

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

    render(<NotesListScreen variant="notes" />);

    const errorState = screen.getByTestId('notes-error-state');
    const onRefresh = errorState.props.refreshControl.props.onRefresh as () => Promise<void>;
    await onRefresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refreshUsers).toHaveBeenCalledTimes(1);
  });
});
