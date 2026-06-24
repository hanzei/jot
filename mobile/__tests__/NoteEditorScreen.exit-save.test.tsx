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

jest.mock('react-native-draggable-flatlist', () => {
  const ReactNative = jest.requireActual('react-native') as typeof import('react-native');
  const ReactModule = jest.requireActual('react') as typeof import('react');
  return {
    __esModule: true,
    default: ({ data, renderItem }: { data: Array<{ id: string }>; renderItem: (args: { item: { id: string }; drag: () => void; isActive: boolean }) => React.ReactNode }) => (
      <ReactNative.View>
        {data.map((item) => (
          <ReactModule.Fragment key={item.id}>
            {renderItem({ item, drag: () => {}, isActive: false })}
          </ReactModule.Fragment>
        ))}
      </ReactNative.View>
    ),
    ScaleDecorator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

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
  useDuplicateNote: () => ({
    mutateAsync: mockDuplicateMutateAsync,
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
    showToast: jest.fn(),
  }),
}));

jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {},
}));

type BeforeRemoveEvent = { preventDefault: jest.Mock; data: { action: object } };
type AlertButton = { text: string; style?: string; onPress?: () => void | Promise<void> };

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
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'created-note-id' });
    mockUpdateMutateAsync.mockResolvedValue({});
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows Retry/Discard alert when save fails permanently at exit', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    expect(beforeRemove).toBeDefined();

    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    const [title, message, buttons] = alertSpy.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe('note.saveFailedExitTitle');
    expect(message).toBe('note.saveFailedExitMessage');
    expect(buttons.map((b) => b.text)).toContain('note.discardAndLeave');
    expect(buttons.map((b) => b.text)).toContain('common.retry');
  });

  it('dispatches navigation when Discard & leave is chosen', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => { expect(alertSpy).toHaveBeenCalledTimes(1); });

    const buttons = alertSpy.mock.calls[0]?.[2] as AlertButton[];
    const discardButton = buttons.find((b) => b.text === 'note.discardAndLeave')!;
    expect(discardButton).toBeDefined();

    discardButton.onPress?.();

    expect(mockDispatch).toHaveBeenCalledWith(event.data.action);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches navigation when Retry succeeds', async () => {
    // First save fails permanently, retry succeeds — user exits cleanly.
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => { expect(alertSpy).toHaveBeenCalledTimes(1); });

    // Swap mock to succeed so the Retry path exits cleanly.
    mockCreateMutateAsync.mockResolvedValue({ id: 'new-note-id' });

    const buttons = alertSpy.mock.calls[0]?.[2] as AlertButton[];
    const retryButton = buttons.find((b) => b.text === 'common.retry')!;
    expect(retryButton).toBeDefined();

    await act(async () => { await retryButton.onPress?.(); });

    expect(mockDispatch).toHaveBeenCalledWith(event.data.action);
  });

  it('shows alert again when Retry also fails', async () => {
    mockCreateMutateAsync.mockRejectedValue(new Error('400 Bad Request'));

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => { expect(alertSpy).toHaveBeenCalledTimes(1); });

    const buttons = alertSpy.mock.calls[0]?.[2] as AlertButton[];
    const retryButton = buttons.find((b) => b.text === 'common.retry')!;

    await act(async () => { await retryButton.onPress?.(); });

    await waitFor(() => { expect(alertSpy).toHaveBeenCalledTimes(2); });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('navigates without alert when save succeeds at exit', async () => {
    mockCreateMutateAsync.mockResolvedValue({ id: 'new-note-id' });

    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    act(() => { beforeRemove(event); });

    await waitFor(() => { expect(mockDispatch).toHaveBeenCalledWith(event.data.action); });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('does not block navigation when there are no pending changes', () => {
    render(<NoteEditorScreen />);

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    beforeRemove(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
