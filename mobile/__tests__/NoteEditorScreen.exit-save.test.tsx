import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

const mockUseRoute = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockSetParams = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockCreateMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
const mockDeleteMutateAsync = jest.fn();
const mockDuplicateMutateAsync = jest.fn();
const mockCreateItemMutateAsync = jest.fn();
const mockUpdateItemMutateAsync = jest.fn();
const mockDeleteItemMutateAsync = jest.fn();
const mockReorderItemsMutateAsync = jest.fn();
const mockUseOfflineNote = jest.fn();

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
  useCreateNote: () => ({
    mutateAsync: mockCreateMutateAsync,
  }),
  useUpdateNote: () => ({
    mutateAsync: mockUpdateMutateAsync,
  }),
  useDeleteNote: () => ({
    mutateAsync: mockDeleteMutateAsync,
  }),
  useRestoreNote: () => ({
    mutateAsync: jest.fn(),
  }),
  usePermanentDeleteNote: () => ({
    mutateAsync: jest.fn(),
  }),
  useDuplicateNote: () => ({
    mutateAsync: mockDuplicateMutateAsync,
  }),
  useConvertNoteType: () => ({
    mutateAsync: jest.fn(),
  }),
  useCreateNoteItem: () => ({
    mutateAsync: mockCreateItemMutateAsync,
  }),
  useUpdateNoteItem: () => ({
    mutateAsync: mockUpdateItemMutateAsync,
  }),
  useDeleteNoteItem: () => ({
    mutateAsync: mockDeleteItemMutateAsync,
  }),
  useReorderNoteItems: () => ({
    mutateAsync: mockReorderItemsMutateAsync,
  }),
  useToggleNoteItemCompleted: () => ({
    mutateAsync: jest.fn().mockResolvedValue([]),
  }),
  useUncheckAllItems: () => ({
    mutateAsync: jest.fn().mockResolvedValue([]),
  }),
  useDeleteCompletedItems: () => ({
    mutateAsync: jest.fn().mockResolvedValue([]),
  }),
}));

jest.mock('../src/hooks/useNoteImages', () => ({
  __esModule: true,
  useUploadNoteImage: () => ({
    mutateAsync: jest.fn(),
  }),
  useDeleteNoteImage: () => ({
    mutateAsync: jest.fn(),
  }),
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

jest.mock('react-i18next', () => {
  // Stable `t` identity across renders, mirroring production: an unstable `t`
  // recreates flushSave every render, which re-fires the unmount-flush effect
  // cleanup and distorts the save flow under test.
  const t = (key: string, options?: { count?: number }) => {
    if (key === 'note.completedItems') {
      return `${options?.count ?? 0} completed items`;
    }
    return key;
  };
  const i18n = { language: 'en' };
  return {
    __esModule: true,
    useTranslation: () => ({ t, i18n }),
  };
});

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

const mockShowToast = jest.fn();
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

type BeforeRemoveEvent = { preventDefault: jest.Mock; data: { action: object } };

function getBeforeRemoveHandler() {
  const calls = mockNavigationAddListener.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'beforeRemove') {
      return calls[i]?.[1] as (event: BeforeRemoveEvent) => void;
    }
  }
  return undefined;
}

function makeEvent(): BeforeRemoveEvent {
  return { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
}

describe('NoteEditorScreen exit save behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'created-note-id' });
    mockUpdateMutateAsync.mockResolvedValue({});
    // The exit path branches on server reachability; keep the default (reachable)
    // for the blocking-prompt cases below and reset any override from a prior test.
    markServerReachable();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    markServerReachable();
  });

  it('shows Retry/Discard dialog when save fails permanently at exit', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    expect(beforeRemove).toBeDefined();

    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-confirm');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(getByTestId('confirm-dialog-title').props.children).toBe('note.saveFailedExitTitle');
    expect(getByTestId('confirm-dialog-message').props.children).toBe('note.saveFailedExitMessage');
    expect(getByTestId('confirm-dialog-confirm').props.accessibilityLabel).toBe('note.discardAndLeave');
    expect(getByTestId('confirm-dialog-cancel').props.accessibilityLabel).toBe('common.retry');
  });

  it('does not trigger a retry when the backdrop is tapped', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-cancel');
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // The "cancel" slot is repurposed for Retry here, not a true dismiss —
    // tapping outside the dialog must be a no-op, not a silent retry attempt.
    fireEvent.press(getByTestId('confirm-dialog-overlay'));

    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(getByTestId('confirm-dialog-cancel')).toBeTruthy();
  });

  it('dispatches navigation when Discard & leave is chosen', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-confirm');

    fireEvent.press(getByTestId('confirm-dialog-confirm'));

    expect(mockDispatch).toHaveBeenCalledWith(event.data.action);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches navigation when Retry succeeds', async () => {
    // First save fails permanently, retry succeeds — user exits cleanly.
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-cancel');

    // Swap mock to succeed so the Retry path exits cleanly.
    mockCreateMutateAsync.mockResolvedValue({ id: 'new-note-id' });

    fireEvent.press(getByTestId('confirm-dialog-cancel'));

    await waitFor(() => { expect(mockDispatch).toHaveBeenCalledWith(event.data.action); });
  });

  it('shows dialog again when Retry also fails', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-cancel');
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-cancel'));
    });

    // A second failed save attempt means the retry actually ran, not just a no-op.
    await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalledTimes(2); });
    expect(getByTestId('confirm-dialog-cancel')).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('disables both actions while a retry is in flight and ignores extra taps', async () => {
    mockCreateMutateAsync.mockRejectedValueOnce(new Error('400 Bad Request'));

    const { getByTestId, findByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await findByTestId('confirm-dialog-cancel');
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // Keep the retry's save in flight so we can observe the busy state.
    let resolveRetrySave!: (value: { id: string }) => void;
    mockCreateMutateAsync.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRetrySave = resolve; }),
    );

    fireEvent.press(getByTestId('confirm-dialog-cancel'));
    await waitFor(() => {
      expect(getByTestId('confirm-dialog-cancel').props.accessibilityState.disabled).toBe(true);
    });
    expect(getByTestId('confirm-dialog-confirm').props.accessibilityState.disabled).toBe(true);

    // Extra taps while the retry is in flight must not fire a second save or
    // a premature discard/dispatch.
    fireEvent.press(getByTestId('confirm-dialog-cancel'));
    fireEvent.press(getByTestId('confirm-dialog-confirm'));
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockDispatch).not.toHaveBeenCalled();

    await act(async () => { resolveRetrySave({ id: 'new-note-id' }); });

    await waitFor(() => { expect(mockDispatch).toHaveBeenCalledWith(event.data.action); });
  });

  it('shows only the discard action once retries are exhausted', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId, findByTestId, queryByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });
    await findByTestId('confirm-dialog-cancel');

    // MAX_EXIT_SAVE_RETRIES is 3 — three failed retries exhaust the budget,
    // after which only the discard action remains.
    for (let attempt = 2; attempt <= 3; attempt++) {
      await act(async () => {
        fireEvent.press(getByTestId('confirm-dialog-cancel'));
      });
      await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalledTimes(attempt); });
    }
    await act(async () => {
      fireEvent.press(getByTestId('confirm-dialog-cancel'));
    });
    await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalledTimes(4); });

    expect(queryByTestId('confirm-dialog-cancel')).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('confirm-dialog-confirm'));
    expect(mockDispatch).toHaveBeenCalledWith(event.data.action);
  });

  it('navigates without showing a dialog when save succeeds at exit', async () => {
    mockCreateMutateAsync.mockResolvedValue({ id: 'new-note-id' });

    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => { expect(mockDispatch).toHaveBeenCalledWith(event.data.action); });
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('does not drop edits typed while a save is in flight', async () => {
    jest.useFakeTimers();
    // First create stays in flight until we resolve it manually.
    let resolveCreate!: (value: { id: string }) => void;
    mockCreateMutateAsync.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }),
    );

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    // Fire the debounced autosave; the create request is now in flight.
    act(() => { jest.advanceTimersByTime(1500); });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // Type more while the save is still in flight.
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello world');

    // Let the in-flight create finish. This must NOT mark the mid-save edit clean.
    await act(async () => { resolveCreate({ id: 'created-note-id' }); });

    // Exiting must flush the mid-save edit instead of leaving without saving.
    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });
    expect(event.preventDefault).toHaveBeenCalled();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'created-note-id',
          data: expect.objectContaining({ content: 'Hello world' }),
        }),
      );
    });
    await waitFor(() => { expect(mockDispatch).toHaveBeenCalledWith(event.data.action); });
  });

  it('does not block navigation when there are no pending changes', () => {
    const { queryByTestId } = render(<NoteEditorScreen />);

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    beforeRemove(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('navigates immediately without a dialog when the server is unreachable', async () => {
    // Server is known-down: leaving must not block on (or wait out) the network.
    markServerUnreachable();
    mockCreateMutateAsync.mockResolvedValue({ id: 'queued-note-id' });

    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    // Navigation is allowed to proceed (no preventDefault) and no Retry/Discard
    // dialog is shown — the edit is flushed to the local DB + queue in the
    // background instead.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
    await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalled(); });
  });

  it('surfaces a save-error toast when the offline background flush fails', async () => {
    // Server unreachable so we navigate immediately; if the background flush
    // then genuinely fails, the in-editor banner is suppressed by the unmounting
    // guard, so the failure must surface via a global toast instead.
    markServerUnreachable();
    mockCreateMutateAsync.mockRejectedValue(new Error('local persist failed'));

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    expect(event.preventDefault).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('note.failedSaveChanges', 'error');
    });
  });
});
