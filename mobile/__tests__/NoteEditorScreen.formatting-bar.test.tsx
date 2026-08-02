import React from 'react';
import { Alert, Platform } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const mockUseRoute = jest.fn();
const mockNavigationAddListener = jest.fn().mockReturnValue(jest.fn());
const mockUseOfflineNote = jest.fn();

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
  useCreateNote: () => ({ mutateAsync: jest.fn().mockResolvedValue({ id: 'server-1', note_type: 'text' }) }),
  useUpdateNote: () => ({ mutateAsync: jest.fn().mockResolvedValue({}) }),
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

// Stable t/i18n across renders — see the note in NoteEditorScreen.save-first.test.tsx.
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
      background: '#fff', surface: '#fff', surfaceVariant: '#f5f5f5', border: '#ddd', borderLight: '#eee',
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

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: '',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    deleted_at: null,
    ...overrides,
  };
}

describe('NoteEditorScreen formatting bar', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    // A brand-new text note opens straight into the editable content input.
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    jest.restoreAllMocks();
  });

  /** Renders the editor and returns helpers bound to the content input. */
  function renderEditor() {
    const utils = render(<NoteEditorScreen />);
    const input = () => utils.getByTestId('note-content-input');

    const type = async (text: string) => {
      await act(async () => {
        fireEvent.changeText(input(), text);
      });
    };

    const placeCaret = async (start: number, end = start) => {
      await act(async () => {
        fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start, end } } });
      });
    };

    const press = async (testID: string) => {
      await act(async () => {
        fireEvent.press(utils.getByTestId(testID));
      });
    };

    return { ...utils, input, type, placeCaret, press };
  }

  it('inserts bold markers at the caret and puts the caret between them', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('one\ntwo');
    await placeCaret(3); // end of the first line

    await press('format-bold-btn');

    expect(input().props.value).toBe('one****\ntwo');
    expect(input().props.selection).toEqual({ start: 5, end: 5 });
  });

  it('wraps the selected text and keeps it selected', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('make this bold');
    await placeCaret(5, 9); // "this"

    await press('format-bold-btn');

    expect(input().props.value).toBe('make **this** bold');
    expect(input().props.selection).toEqual({ start: 7, end: 11 });
  });

  it('unwraps when the same formatting is applied twice', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('make this italic');
    await placeCaret(5, 9);
    await press('format-italic-btn');
    expect(input().props.value).toBe('make *this* italic');

    // The selection prop reports where the caret went, mirroring the native input.
    await placeCaret(6, 10);
    await press('format-italic-btn');
    expect(input().props.value).toBe('make this italic');
  });

  it('headings the caret line rather than the last line of the note', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('title\nbody\nmore');
    await placeCaret(2); // inside "title"

    await press('format-heading-btn');

    expect(input().props.value).toBe('## title\nbody\nmore');
  });

  it('cycles the heading level on repeated presses', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('title');
    await placeCaret(2);

    await press('format-heading-btn');
    expect(input().props.value).toBe('## title');

    await press('format-heading-btn');
    expect(input().props.value).toBe('### title');

    await press('format-heading-btn');
    expect(input().props.value).toBe('title');
  });

  it('bullets the caret line and toggles it back off', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('one\ntwo');
    await placeCaret(5); // inside "two"

    await press('format-bullet-btn');
    expect(input().props.value).toBe('one\n- two');

    await press('format-bullet-btn');
    expect(input().props.value).toBe('one\ntwo');
  });

  it('adds a checklist marker and steps it down to a bullet', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('milk');
    await placeCaret(4);

    await press('format-checkbox-btn');
    expect(input().props.value).toBe('- [ ] milk');

    await press('format-bullet-btn');
    expect(input().props.value).toBe('- milk');
  });

  it('continues a list when Enter is pressed at the end of an item', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('- one');
    await placeCaret(5);
    await type('- one\n'); // Enter

    expect(input().props.value).toBe('- one\n- ');
    expect(input().props.selection).toEqual({ start: 8, end: 8 });
  });

  it('ends the list when Enter is pressed on an empty item', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('- one\n- ');
    await placeCaret(8);
    await type('- one\n- \n'); // Enter

    expect(input().props.value).toBe('- one\n');
  });

  it('leaves ordinary typing untouched', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('plain');
    await placeCaret(5);
    await type('plain\n');

    expect(input().props.value).toBe('plain\n');
  });

  it('releases the forced caret once the input reports it landed', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('hi');
    await placeCaret(2);
    await press('format-bold-btn');
    expect(input().props.selection).toEqual({ start: 4, end: 4 });

    // The native input confirms the caret move; the prop goes uncontrolled again
    // so it cannot fight the user's next tap.
    await placeCaret(4);
    expect(input().props.selection).toBeUndefined();
  });

  it('renders the bar on Android too', async () => {
    Platform.OS = 'android';
    const { getByTestId } = renderEditor();

    expect(getByTestId('format-bold-btn')).toBeTruthy();
    expect(getByTestId('format-checkbox-btn')).toBeTruthy();
  });

  it('hides the bar when the note is not being edited', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ content: 'Saved body' }) });

    const { queryByTestId, getByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('content-preview')).toBeTruthy();
    expect(queryByTestId('format-bold-btn')).toBeNull();
  });

  it('hides the bar on a read-only note', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    mockUseOfflineNote.mockReturnValue({
      data: makeNote({ content: 'Deleted body', deleted_at: '2026-07-03T00:00:00Z' }),
    });

    const { queryByTestId } = render(<NoteEditorScreen />);

    expect(queryByTestId('format-bold-btn')).toBeNull();
  });
});
