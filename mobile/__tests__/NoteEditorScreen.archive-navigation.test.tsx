import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUpdateMutateAsync = jest.fn();
const mockUseOfflineNote = jest.fn();
const mockShowToast = jest.fn();

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
  useCreateNote: () => ({ mutateAsync: jest.fn() }),
  useUpdateNote: () => ({ mutateAsync: mockUpdateMutateAsync }),
  useDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useRestoreNote: () => ({ mutateAsync: jest.fn() }),
  useDuplicateNote: () => ({ mutateAsync: jest.fn() }),
  useCreateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useUpdateNoteItem: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteItem: () => ({ mutateAsync: jest.fn() }),
  useReorderNoteItems: () => ({ mutateAsync: jest.fn() }),
  useToggleNoteItemCompleted: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
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
    showToast: mockShowToast,
  }),
}));

jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {},
}));

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    note_type: 'text',
    title: '',
    content: 'Hello world',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen archive navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUpdateMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('navigates back to the dashboard after archiving an existing note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ archived: false }) });

    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-archive-btn'));
    });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', data: expect.objectContaining({ archived: true }) }),
      );
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('dashboard.noteArchived', 'success', expect.anything());
  });

  it('does not navigate back when unarchiving an existing note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ archived: true }) });

    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-archive-btn'));
    });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', data: expect.objectContaining({ archived: false }) }),
      );
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('dashboard.noteUnarchived');
  });
});
