import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { PanResponder, StyleSheet } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';
import { VALIDATION } from '@jot/shared';
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
const mockUseOfflineNote = jest.fn();
const mockGestureResponderEvent = {} as GestureResponderEvent;
const createPanState = (dx: number, dy: number): PanResponderGestureState => ({
  stateID: 1,
  moveX: 0,
  moveY: 0,
  x0: 0,
  y0: 0,
  dx,
  dy,
  vx: 0,
  vy: 0,
  numberActiveTouches: 1,
  _accountsForMovesUpTo: 0,
});

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

jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

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
}));

jest.mock('../src/hooks/useOfflineNotes', () => ({
  __esModule: true,
  useOfflineNote: () => mockUseOfflineNote(),
}));

jest.mock('../src/store/SSEContext', () => ({
  __esModule: true,
  useSSESubscription: jest.fn(),
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

describe('NoteEditorScreen list submit behavior', () => {
  function getPanResponderConfig(createSpy: jest.SpiedFunction<typeof PanResponder.create>, callsBefore: number) {
    return createSpy.mock.calls
      .slice(callsBefore)
      .map(([config]) => config)
      .find((config) => typeof config.onPanResponderRelease === 'function');
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'created-note-id' });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockDeleteMutateAsync.mockResolvedValue({});
    mockDuplicateMutateAsync.mockResolvedValue({ id: 'duplicate-note-id' });
  });

  it('creates a new list item when submitting existing list item text input', async () => {
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    fireEvent.press(getByTestId('add-list-item'));

    const baselineCount = getAllByTestId('list-item-text').length;
    const firstInput = getAllByTestId('list-item-text')[0];
    fireEvent.changeText(firstInput, 'Buy milk');
    fireEvent(firstInput, 'submitEditing');

    await waitFor(() => {
      expect(getAllByTestId('list-item-text').length).toBe(baselineCount + 1);
    });
  });

  it('does not persist unchanged existing note when leaving editor', async () => {
    const existingNote = {
      id: 'note-123',
      user_id: 'u1',
      title: 'Existing title',
      content: 'Existing content',
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
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-123' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });

    const { unmount } = render(<NoteEditorScreen />);
    unmount();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('does not persist when existing note is still hydrating and user leaves', async () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-456' } });
    mockUseOfflineNote.mockReturnValue({ data: null });

    const { unmount } = render(<NoteEditorScreen />);
    unmount();

    await waitFor(() => {
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('updates list item indentation from horizontal swipe gesture', async () => {
    const panResponderSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = panResponderSpy.mock.calls.length;
    const { getByTestId, getAllByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('toggle-note-type'));
    fireEvent.press(getByTestId('add-list-item'));

    expect(StyleSheet.flatten(getAllByTestId('list-item-row')[0].props.style)?.marginLeft).toBe(0);

    const panResponderConfig = getPanResponderConfig(panResponderSpy, callsBefore);
    expect(panResponderConfig).toBeDefined();
    await act(async () => {
      panResponderConfig?.onPanResponderRelease?.(mockGestureResponderEvent, createPanState(60, 0));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[0].props.style)?.marginLeft).toBe(
        VALIDATION.INDENT_PX_PER_LEVEL,
      );
    });

    const updatedPanResponderConfig = getPanResponderConfig(panResponderSpy, callsBefore);
    expect(updatedPanResponderConfig).toBeDefined();
    await act(async () => {
      updatedPanResponderConfig?.onPanResponderRelease?.(mockGestureResponderEvent, createPanState(-60, 0));
    });

    await waitFor(() => {
      expect(StyleSheet.flatten(getAllByTestId('list-item-row')[0].props.style)?.marginLeft).toBe(0);
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              text: '',
              position: 0,
              completed: false,
              indent_level: 0,
              assigned_to: '',
            }),
          ]),
        }),
      );
    });

    mockUpdateMutateAsync.mockClear();

    fireEvent.changeText(getAllByTestId('list-item-text')[0], 'Indented item');
    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              text: 'Indented item',
              position: 0,
              completed: false,
              indent_level: 0,
              assigned_to: '',
            }),
          ]),
        }),
      );
    }, { timeout: 3000 });
  });

  it('keeps dirty state for color change when note id is not yet available', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    fireEvent.changeText(getByTestId('note-title-input'), 'Draft note');

    const colorButton = getByTestId('toolbar-color-btn');
    fireEvent.press(colorButton);
    const swatch = await waitFor(() => getByTestId('color-swatch-f28b82'));
    fireEvent.press(swatch);

    await waitFor(
      () => {
        expect(mockCreateMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Draft note',
            color: '#f28b82',
          }),
        );
      },
      { timeout: VALIDATION.AUTO_SAVE_TIMEOUT_MS + 2000 },
    );
  });
});
