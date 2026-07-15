import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUseOfflineNote = jest.fn();

// A deferred update mutation so a metadata PATCH can be held in flight while we
// simulate a stale refetch landing mid-request.
let mockResolveUpdate: (() => void) | null = null;
const mockUpdateMutateAsync = jest.fn(
  () => new Promise<Record<string, never>>((resolve) => {
    mockResolveUpdate = () => resolve({});
  }),
);

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

jest.mock('../src/hooks/useNotes', () => ({
  __esModule: true,
  useCreateNote: () => ({ mutateAsync: jest.fn() }),
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
      warning: '#fef3c7', warningBorder: '#fde68a', warningText: '#92400e',
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

function textNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'note-meta',
    user_id: 'u1',
    title: '',
    content: 'Hello',
    note_type: 'text',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: false,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [],
    shared_with: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen metadata refresh guard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockResolveUpdate = null;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-meta' } });
  });

  // A stale refetch landing while a pin PATCH is in flight must not revert the
  // optimistic pin. useUpdateNote doesn't touch saveInFlightRef, so the refresh
  // effect relies on the dedicated metadataUpdateInFlightRef guard here.
  it('keeps an optimistic pin while the metadata PATCH is in flight', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote() });
    const { getByTestId, rerender } = render(<NoteEditorScreen />);

    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.pin');

    // Tap pin: sets the optimistic state and starts the (deferred) PATCH.
    await act(async () => {
      fireEvent.press(getByTestId('toolbar-pin-btn'));
    });
    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.unpin');
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // A stale refetch (still pinned: false) arrives before the PATCH resolves.
    mockUseOfflineNote.mockReturnValue({
      data: textNote({ pinned: false, updated_at: '2026-01-01T00:05:00.000Z' }),
    });
    await act(async () => {
      rerender(<NoteEditorScreen />);
    });

    // The optimistic pin is preserved (guard blocked the refresh).
    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.unpin');

    // Let the PATCH settle so no promise is left dangling.
    await act(async () => {
      mockResolveUpdate?.();
    });
  });
});
