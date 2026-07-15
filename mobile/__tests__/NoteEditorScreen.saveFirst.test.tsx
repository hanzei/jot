import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// Save-first flow (issue #652): on a brand-new note (noteId === null), the
// server-only actions (Add image, Labels, Share) are available immediately.
// Tapping one flushes a create first, then runs the action against the new id.

const mockUseRoute = jest.fn();
const mockNavigate = jest.fn();
const mockCreateMutateAsync = jest.fn();
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
    addListener: jest.fn().mockReturnValue(jest.fn()),
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
  useCreateNote: () => ({ mutateAsync: mockCreateMutateAsync }),
  useUpdateNote: () => ({ mutateAsync: jest.fn() }),
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

// Render a detectable marker only while the picker/sheet is visible so the
// tests can assert the save-first flow actually opened it.
jest.mock('../src/components/AddImageActionSheet', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <Text testID="add-image-sheet-open" /> : null,
  };
});

jest.mock('../src/components/LabelPicker', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <Text testID="label-picker-open" /> : null,
  };
});

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === 'note.completedItems') return `${options?.count ?? 0} completed items`;
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
  useUsers: () => ({ usersById: new Map() }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../src/i18n', () => ({ __esModule: true, default: {} }));

describe('NoteEditorScreen save-first server actions on a brand-new note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    // Brand-new note: no persisted note yet.
    mockUseOfflineNote.mockReturnValue({ data: undefined });
    mockCreateMutateAsync.mockResolvedValue({ id: 'note-new', note_type: 'text', content: 'Hello' });
  });

  it('enables Add image and offers Share + Labels before the first save', () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    // Add-image is enabled on an unsaved note (save-first will create it on tap).
    expect(getByTestId('toolbar-add-image-btn').props.accessibilityState).toMatchObject({ disabled: false });

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(getByTestId('editor-menu-share')).toBeTruthy();
    expect(getByTestId('editor-menu-label')).toBeTruthy();
  });

  it('flushes a create then opens the image sheet when Add image is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    // Give the note content so the create isn't a no-op empty flush.
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-add-image-btn'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(getByTestId('add-image-sheet-open')).toBeTruthy();
    });
  });

  it('flushes a create then navigates to Share when Share is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    await act(async () => {
      fireEvent.press(getByTestId('editor-menu-share'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-new' });
    });
  });
});
