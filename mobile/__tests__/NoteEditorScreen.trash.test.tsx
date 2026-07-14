import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

const mockUseRoute = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockRestoreMutateAsync = jest.fn();
const mockPermanentDeleteMutateAsync = jest.fn();
const mockUseOfflineNote = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockUseRoute(),
  useNavigation: () => ({
    goBack: mockGoBack,
    replace: jest.fn(),
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

jest.mock('../src/hooks/useNotes', () => ({
  __esModule: true,
  useCreateNote: () => ({ mutateAsync: jest.fn() }),
  useUpdateNote: () => ({ mutateAsync: jest.fn() }),
  useDeleteNote: () => ({ mutateAsync: jest.fn() }),
  useRestoreNote: () => ({ mutateAsync: mockRestoreMutateAsync }),
  usePermanentDeleteNote: () => ({ mutateAsync: mockPermanentDeleteMutateAsync }),
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
  useToast: () => ({ showToast: mockShowToast }),
}));

jest.mock('../src/i18n', () => ({ __esModule: true, default: {} }));

function makeTrashedNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: 'Deleted note body',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    deleted_at: '2026-07-03T00:00:00Z',
    ...overrides,
  };
}

describe('NoteEditorScreen read-only trashed note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    mockRestoreMutateAsync.mockResolvedValue({});
    mockPermanentDeleteMutateAsync.mockResolvedValue({});
    mockUseOfflineNote.mockReturnValue({ data: makeTrashedNote() });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the content preview (not the editable input) and disables bar actions', () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // Read-only: preview shown, no editable content input.
    expect(getByTestId('content-preview')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();

    // Bar actions are disabled.
    expect(getByTestId('toolbar-pin-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-archive-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-color-btn').props.accessibilityState).toMatchObject({ disabled: true });
    expect(getByTestId('toolbar-add-image-btn').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('offers Restore and Delete-forever in the overflow menu and restores the note', async () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toolbar-menu-btn'));

    // Trashed menu: only restore + delete-forever, no move-to-trash/send.
    expect(getByTestId('editor-menu-restore')).toBeTruthy();
    expect(getByTestId('editor-menu-delete-permanently')).toBeTruthy();
    expect(queryByTestId('editor-menu-trash')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('editor-menu-restore'));
    });

    await waitFor(() => {
      expect(mockRestoreMutateAsync).toHaveBeenCalledWith('note-1');
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('permanently deletes the note after confirming the destructive dialog', async () => {
    const { getByTestId, findByTestId } = render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-confirm');
    expect(getByTestId('confirm-dialog-title').props.children).toBe('note.deleteForeverTitle');
    expect(getByTestId('confirm-dialog-message').props.children).toBe('note.deleteForeverConfirm');

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-confirm'));
    });

    expect(mockPermanentDeleteMutateAsync).toHaveBeenCalledWith('note-1');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  // Issue #697: these actions await a write with the menu sheet already closed.
  // A reachable-but-slow write must show a visible pending indicator instead of
  // a silent freeze; a known-unreachable server has nothing to wait for (the
  // mutation resolves via the local/queue path), so no indicator is needed.
  describe('menu-action pending indicator', () => {
    afterEach(() => {
      jest.useRealTimers();
      markServerReachable();
    });

    it('shows the pending indicator once the delay elapses while restoring on a reachable server', async () => {
      jest.useFakeTimers();
      markServerReachable();
      let resolveRestore!: () => void;
      mockRestoreMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveRestore = resolve; }));

      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-restore')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolveRestore(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('does not show the pending indicator when restoring while known unreachable', async () => {
      markServerUnreachable();
      let resolveRestore!: () => void;
      mockRestoreMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveRestore = resolve; }));

      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-restore'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolveRestore(); });
      await waitFor(() => { expect(mockGoBack).toHaveBeenCalledTimes(1); });
    });

    it('shows the pending indicator once the delay elapses while permanently deleting on a reachable server', async () => {
      jest.useFakeTimers();
      markServerReachable();
      let resolveDelete!: () => void;
      mockPermanentDeleteMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve; }));

      const { getByTestId, queryByTestId } = render(
        <ConfirmProvider>
          <NoteEditorScreen />
        </ConfirmProvider>,
      );

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-delete-permanently')); });
      await act(async () => { fireEvent.press(getByTestId('confirm-dialog-confirm')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolveDelete(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('does not show the pending indicator when permanently deleting while known unreachable', async () => {
      markServerUnreachable();
      let resolveDelete!: () => void;
      mockPermanentDeleteMutateAsync.mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve; }));

      const { getByTestId, findByTestId, queryByTestId } = render(
        <ConfirmProvider>
          <NoteEditorScreen />
        </ConfirmProvider>,
      );

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-delete-permanently'));
      await findByTestId('confirm-dialog-confirm');
      fireEvent.press(getByTestId('confirm-dialog-confirm'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolveDelete(); });
      await waitFor(() => { expect(mockGoBack).toHaveBeenCalledTimes(1); });
    });
  });

  it('does not delete the note when the destructive dialog is cancelled', async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(
      <ConfirmProvider>
        <NoteEditorScreen />
      </ConfirmProvider>,
    );

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    fireEvent.press(getByTestId('editor-menu-delete-permanently'));

    await findByTestId('confirm-dialog-cancel');
    fireEvent.press(getByTestId('confirm-dialog-cancel'));

    await waitFor(() => { expect(queryByTestId('confirm-dialog-cancel')).toBeNull(); });
    expect(mockPermanentDeleteMutateAsync).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('renders a trashed list note with non-interactive item controls', () => {
    mockUseOfflineNote.mockReturnValue({
      data: makeTrashedNote({
        note_type: 'list',
        title: 'Groceries',
        content: undefined,
        items: [
          { id: 'i1', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '' },
          { id: 'i2', text: 'Eggs', completed: true, position: 1, parent_id: null, assigned_to: '' },
        ],
      }),
    });

    const { getAllByTestId, getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // No "add item" affordance in read-only mode.
    expect(queryByTestId('add-list-item')).toBeNull();

    // Item checkboxes are disabled (non-interactive).
    for (const checkbox of getAllByTestId('list-item-checkbox')) {
      expect(checkbox.props.accessibilityState).toMatchObject({ disabled: true });
    }

    // The completed-items collapse toggle is disabled.
    expect(getByTestId('toggle-checked-items').props.accessibilityState).toMatchObject({ disabled: true });
  });
});
