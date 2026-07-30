import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockGoBack = jest.fn();
const mockCreateMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
const mockUseOfflineNote = jest.fn();

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockUseRoute(),
  useNavigation: () => ({
    goBack: mockGoBack,
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

// Return a STABLE t/i18n across renders. A fresh t each render would change the
// identity of the editor's flushSave callback, re-firing its mount effect and
// tripping an unmounting=true autosave that skips setNoteId — a test artifact,
// not real behavior (react-i18next's real t is stable).
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
  useUsers: () => ({ usersById: new Map() }),
}));

jest.mock('../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../src/i18n', () => ({ __esModule: true, default: {} }));


describe('NoteEditorScreen new-list quick action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'server-1', note_type: 'list', title: '' });
    mockUpdateMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens a brand-new note directly in list mode when initialNoteType is "list"', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // List UI is shown (title input + add-item row), not the text content input.
    expect(getByTestId('note-title-input')).toBeTruthy();
    expect(getByTestId('add-list-item')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();
  });

  it('opens a brand-new note in text mode by default', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('note-content-input')).toBeTruthy();
    expect(queryByTestId('add-list-item')).toBeNull();
  });

  it('measures the title limit in code points, not UTF-16 units', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId } = render(<NoteEditorScreen />);

    // 150 emoji is 300 UTF-16 units but only 150 code points, which is what the
    // server counts against TITLE_MAX_LENGTH — so it must be accepted whole.
    const title = '\u{1F600}'.repeat(150);
    const titleInput = getByTestId('note-title-input');
    fireEvent.changeText(titleInput, title);

    expect(titleInput.props.value).toBe(title);
  });

  it('clamps an over-limit title without splitting a surrogate pair', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId } = render(<NoteEditorScreen />);

    // The leading 'a' puts the 200th UTF-16 unit inside an emoji, so a .slice
    // would leave a lone surrogate that the server stores as U+FFFD.
    const titleInput = getByTestId('note-title-input');
    fireEvent.changeText(titleInput, `a${'\u{1F600}'.repeat(300)}`);

    const value: string = titleInput.props.value;
    expect([...value]).toHaveLength(VALIDATION.TITLE_MAX_LENGTH);
    expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
