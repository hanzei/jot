import type React from 'react';

/**
 * Shared `jest.mock()` wiring for tests that render `NoteEditorScreen`.
 * Import this module (before importing `NoteEditorScreen`) for its side
 * effects — NoteEditorScreen calls every hook mocked here unconditionally, so
 * a test that omits one crashes on render rather than failing its assertion.
 *
 * Each export is the underlying `jest.fn()`; a test configures return values
 * in its own `beforeEach` exactly as if the mock were declared inline.
 *
 * A consuming test file cannot override one of these `jest.mock()` calls by
 * declaring its own `jest.mock()` for the same module: babel hoists jest.mock
 * calls above imports *within a file*, so the test file's own call always runs
 * before this module is even required — and this module's own hoisted call
 * then runs afterward (as a side effect of that `require`), overwriting it.
 * If a future mock needs to be file-overridable, expose it as an additional
 * `jest.fn()` export here (as most of the below already are) rather than
 * hardcoding its behavior in the `jest.mock()` factory.
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
export const mockConvertMutateAsync = jest.fn();
export const mockRestoreMutateAsync = jest.fn();
export const mockPermanentDeleteMutateAsync = jest.fn();
export const mockCreateItemMutateAsync = jest.fn();
export const mockUpdateItemMutateAsync = jest.fn();
export const mockDeleteItemMutateAsync = jest.fn();
export const mockReorderItemsMutateAsync = jest.fn();
export const mockToggleItemCompletedMutateAsync = jest.fn().mockResolvedValue([]);
export const mockUncheckAllItemsMutateAsync = jest.fn().mockResolvedValue([]);
export const mockDeleteCompletedItemsMutateAsync = jest.fn().mockResolvedValue([]);
export const mockUseOfflineNote = jest.fn();
export const mockShowToast = jest.fn();
export const mockLabelPicker = jest.fn((_props: { visible: boolean }): React.ReactNode => null);
export const mockUseUsers = jest.fn().mockReturnValue({ usersById: new Map() });

// Stable `t`/`i18n` identity across renders by default, mirroring production:
// an unstable `t` recreates callbacks (e.g. flushSave) on every render and can
// distort what's under test. A `mockReturnValue` (not `mockImplementation`)
// is what makes it stable — every call returns the same object/function.
const stableT = (key: string, options?: { count?: number; server?: string }) => {
  if (key === 'note.completedItems') return `${options?.count ?? 0} completed items`;
  return key;
};
export const mockUseTranslation = jest.fn().mockReturnValue({ t: stableT, i18n: { language: 'en' } });

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
  useRestoreNote: () => ({ mutateAsync: mockRestoreMutateAsync }),
  usePermanentDeleteNote: () => ({ mutateAsync: mockPermanentDeleteMutateAsync }),
  useDuplicateNote: () => ({ mutateAsync: mockDuplicateMutateAsync }),
  useConvertNoteType: () => ({ mutateAsync: mockConvertMutateAsync }),
  useCreateNoteItem: () => ({ mutateAsync: mockCreateItemMutateAsync }),
  useUpdateNoteItem: () => ({ mutateAsync: mockUpdateItemMutateAsync }),
  useDeleteNoteItem: () => ({ mutateAsync: mockDeleteItemMutateAsync }),
  useReorderNoteItems: () => ({ mutateAsync: mockReorderItemsMutateAsync }),
  useToggleNoteItemCompleted: () => ({ mutateAsync: mockToggleItemCompletedMutateAsync }),
  useUncheckAllItems: () => ({ mutateAsync: mockUncheckAllItemsMutateAsync }),
  useDeleteCompletedItems: () => ({ mutateAsync: mockDeleteCompletedItemsMutateAsync }),
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
  default: (props: { visible: boolean }) => mockLabelPicker(props),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockUseTranslation(),
}));

jest.mock('../../src/theme/ThemeContext', () => {
  const { lightColors } = jest.requireActual<typeof import('../../src/theme/colors')>(
    '../../src/theme/colors',
  );
  return {
    __esModule: true,
    useTheme: () => ({ isDark: false, colors: lightColors }),
  };
});

jest.mock('../../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { id: 'u1', username: 'alice' }, isAuthenticated: true, isLocalMode: false }),
}));

jest.mock('../../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => mockUseUsers(),
}));

jest.mock('../../src/hooks/useToast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: mockShowToast }),
}));

jest.mock('../../src/i18n', () => ({ __esModule: true, default: {} }));
