import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockNavigate = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUseOfflineNote = jest.fn();

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockUseRoute(),
  useNavigation: () => ({
    goBack: jest.fn(),
    replace: jest.fn(),
    navigate: mockNavigate,
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

// Render the label picker as a detectable node when it is open, so a test can
// assert that tapping a label chip / "Add labels" surfaced it.
jest.mock('../src/components/LabelPicker', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <Text testID="label-picker-open">picker</Text> : null,
  };
});

// Avoid pulling in UserAvatar's network/profile-icon hooks; render a stub.
jest.mock('../src/components/UserAvatar', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ username }: { username: string }) => <Text>{username}</Text>,
  };
});

jest.mock('react-i18next', () => {
  const t = (key: string, options?: { count?: number }) =>
    key === 'note.completedItems' ? `${options?.count ?? 0} completed items` : key;
  const i18n = { language: 'en' };
  return { __esModule: true, useTranslation: () => ({ t, i18n }) };
});

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    isDark: false,
    colors: {
      background: '#fff', surface: '#fff', border: '#ddd', borderLight: '#eee',
      text: '#111', textSecondary: '#444', textMuted: '#777', placeholder: '#aaa',
      icon: '#555', iconMuted: '#888', primary: '#2563eb', primaryLight: '#dbeafe',
      error: '#dc2626', errorLight: '#fee2e2', cardBackground: '#fff', cardBorder: '#ddd',
      overlay: 'rgba(0,0,0,0.4)', sheetBackground: '#fff', handleColor: '#ccc',
    },
  }),
}));

jest.mock('../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { id: 'u1', username: 'alice' }, isAuthenticated: true, isLocalMode: false }),
}));

jest.mock('../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({
    usersById: new Map([
      ['u1', { id: 'u1', username: 'alice' }],
      ['u2', { id: 'u2', username: 'bob' }],
    ]),
  }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../src/i18n', () => ({ __esModule: true, default: {} }));

const sharedNote = {
  id: 'note-1',
  user_id: 'u1',
  note_type: 'text' as const,
  content: 'hello',
  color: '#ffffff',
  pinned: false,
  archived: false,
  is_shared: true,
  shared_with: [{ id: 'share-1', shared_with_user_id: 'u2', username: 'bob' }],
  labels: [{ id: 'lbl-1', name: 'Geschenkideen' }],
};

describe('NoteEditorScreen collaborators + labels row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: sharedNote });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the note labels and collaborators', async () => {
    const { getByText, getByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => {
      expect(getByTestId('note-meta-label-lbl-1')).toBeTruthy();
    });
    expect(getByText('Geschenkideen')).toBeTruthy();
    // Owner + shared collaborator avatars are shown.
    expect(getByTestId('note-meta-collaborators')).toBeTruthy();
    expect(getByText('alice')).toBeTruthy();
    expect(getByText('bob')).toBeTruthy();
  });

  it('opens the label picker when a label chip is tapped', async () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-label-lbl-1')).toBeTruthy());
    expect(queryByTestId('label-picker-open')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-label-lbl-1'));
    });

    await waitFor(() => expect(getByTestId('label-picker-open')).toBeTruthy());
  });

  it('opens the label picker when "Add labels" is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-add-labels')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-add-labels'));
    });

    await waitFor(() => expect(getByTestId('label-picker-open')).toBeTruthy());
  });

  it('navigates to the share screen when a collaborator avatar is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-collaborators')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-collaborators'));
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-1' });
    });
  });

  it('renders collaborators non-interactively on a read-only (trashed) note', async () => {
    // Opened from the trash: read-only, so the avatars mirror the menu having
    // no Share action here — they display but do not navigate.
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    const { getByTestId, getByText } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-collaborators')).toBeTruthy());
    expect(getByText('alice')).toBeTruthy();
    expect(getByText('bob')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-collaborators'));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
