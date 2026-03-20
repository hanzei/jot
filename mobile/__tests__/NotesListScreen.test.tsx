import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import NotesListScreen from '../src/screens/NotesListScreen';
import { lightColors } from '../src/theme/colors';
import type { NoteSort } from '@jot/shared';

jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn().mockReturnValue({ navigate: jest.fn() }),
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

  return {
    __esModule: true,
    default: MockDraggableFlatList,
    ScaleDecorator: MockScaleDecorator,
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
const notesHooks = jest.requireMock('../src/hooks/useNotes') as {
  useUpdateNote: jest.Mock;
  useDeleteNote: jest.Mock;
  useRestoreNote: jest.Mock;
  usePermanentDeleteNote: jest.Mock;
  useReorderNotes: jest.Mock;
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
  theme: 'system' as const,
  note_sort: 'manual',
  updated_at: '2024-01-01T00:00:00Z',
};

const createMockNote = (overrides: Partial<{
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
  beforeEach(() => {
    jest.clearAllMocks();
    notesHooks.useUpdateNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useRestoreNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.usePermanentDeleteNote.mockReturnValue({ mutateAsync: mockMutateAsync });
    notesHooks.useReorderNotes.mockReturnValue({ mutateAsync: mockMutateAsync });
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

  it('shows pinned-first alphabetical ordering when title sort is active', () => {
    mockUseAuth.mockReturnValue({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'title' },
      setSettings: jest.fn(),
    });
    mockUseOfflineNotes.mockReturnValue({
      data: [
        createMockNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        createMockNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        createMockNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });

    render(<NotesListScreen variant="notes" />);

    expect(screen.getByTestId('sort-disabled-notice')).toBeTruthy();
    expect(screen.queryByTestId('pinned-draggable-list')).toBeNull();
    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByText('Others')).toBeTruthy();

    const renderedTitles = screen.getAllByText(/sort-demo-/).map(node => node.props.children);
    expect(renderedTitles).toEqual([
      'sort-demo-zulu',
      'sort-demo-alpha',
      'sort-demo-bravo',
    ]);
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
        createMockNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        createMockNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        createMockNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUpdateMe.mockResolvedValue({
      user: mockUser,
      settings: { ...baseSettings, note_sort: 'title' },
    });

    render(<NotesListScreen variant="notes" />);

    expect(screen.queryByTestId('sort-disabled-notice')).toBeNull();
    expect(screen.getByTestId('notes-section-list')).toBeTruthy();
    expect(screen.getByTestId('unpinned-draggable-list')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sort-chip-title'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'title' });
      expect(screen.getByTestId('sort-disabled-notice')).toBeTruthy();
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ note_sort: 'title' }));
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
        createMockNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        createMockNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
      isRefetching: false,
    });
    mockUpdateMe.mockRejectedValue(new Error('network error'));

    render(<NotesListScreen variant="notes" />);

    fireEvent.press(screen.getByTestId('sort-chip-title'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ note_sort: 'title' });
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
        createMockNote({ id: 'pinned-zulu', title: 'sort-demo-zulu', pinned: true }),
        createMockNote({ id: 'unpinned-bravo', title: 'sort-demo-bravo', pinned: false }),
        createMockNote({ id: 'unpinned-alpha', title: 'sort-demo-alpha', pinned: false }),
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

    fireEvent.press(screen.getByTestId('sort-chip-title'));
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
      settings: { ...baseSettings, note_sort: 'title' },
    });

    await waitFor(() => {
      expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'created_at' }));
    });
    expect(within(screen.getByTestId('sort-disabled-notice')).getByText(/Date created/)).toBeTruthy();
  });
});
