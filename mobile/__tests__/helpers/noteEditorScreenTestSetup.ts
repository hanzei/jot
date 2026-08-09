/**
 * Shared `jest.mock()` wiring for tests that render `NoteEditorScreen`.
 * Import this module (before importing `NoteEditorScreen`) for its side
 * effects — NoteEditorScreen calls every hook mocked here unconditionally, so
 * a test that omits one crashes on render rather than failing its assertion.
 *
 * Each export is the underlying `jest.fn()`; a test configures return values
 * in its own `beforeEach` exactly as if the mock were declared inline.
 */

export const mockUseRoute = jest.fn();
export const mockGoBack = jest.fn();
export const mockReplace = jest.fn();
export const mockNavigate = jest.fn();
export const mockDispatch = jest.fn();
export const mockSetParams = jest.fn();
export const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
export const mockCreateMutateAsync = jest.fn();
export const mockUpdateMutateAsync = jest.fn();
export const mockDeleteMutateAsync = jest.fn();
export const mockDuplicateMutateAsync = jest.fn();
export const mockCreateItemMutateAsync = jest.fn();
export const mockUpdateItemMutateAsync = jest.fn();
export const mockDeleteItemMutateAsync = jest.fn();
export const mockReorderItemsMutateAsync = jest.fn();
export const mockUseOfflineNote = jest.fn();

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

jest.mock('../../src/hooks/useNotes', () => ({
  __esModule: true,
  useCreateNote: () => ({ mutateAsync: mockCreateMutateAsync }),
  useUpdateNote: () => ({ mutateAsync: mockUpdateMutateAsync }),
  useDeleteNote: () => ({ mutateAsync: mockDeleteMutateAsync }),
  useRestoreNote: () => ({ mutateAsync: jest.fn() }),
  usePermanentDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useDuplicateNote: () => ({ mutateAsync: mockDuplicateMutateAsync }),
  useConvertNoteType: () => ({ mutateAsync: jest.fn() }),
  useCreateNoteItem: () => ({ mutateAsync: mockCreateItemMutateAsync }),
  useUpdateNoteItem: () => ({ mutateAsync: mockUpdateItemMutateAsync }),
  useDeleteNoteItem: () => ({ mutateAsync: mockDeleteItemMutateAsync }),
  useReorderNoteItems: () => ({ mutateAsync: mockReorderItemsMutateAsync }),
  useToggleNoteItemCompleted: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
  useUncheckAllItems: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
  useDeleteCompletedItems: () => ({ mutateAsync: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../../src/hooks/useNoteImages', () => ({
  __esModule: true,
  useUploadNoteImage: () => ({ mutateAsync: jest.fn() }),
  useDeleteNoteImage: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('../../src/hooks/usePendingImageUploads', () => ({
  __esModule: true,
  usePendingImageUploads: () => [],
  useRetryPendingImageUpload: () => ({ mutate: jest.fn() }),
  useDismissPendingImageUpload: () => ({ mutate: jest.fn() }),
}));

jest.mock('../../src/hooks/useOfflineNotes', () => ({
  __esModule: true,
  useOfflineNote: () => mockUseOfflineNote(),
}));

jest.mock('../../src/store/SSEContext', () => ({
  __esModule: true,
  useSSESubscription: jest.fn(),
  useSSEContext: jest.fn(() => ({ sseReconnecting: false })),
}));

jest.mock('../../src/components/LabelPicker', () => ({
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

jest.mock('../../src/theme/ThemeContext', () => ({
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

jest.mock('../../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { id: 'u1', username: 'alice' }, isAuthenticated: true }),
}));

jest.mock('../../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({ usersById: new Map() }),
}));

jest.mock('../../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../../src/i18n', () => ({ __esModule: true, default: {} }));
