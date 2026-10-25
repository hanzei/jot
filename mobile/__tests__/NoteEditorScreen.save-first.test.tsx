import { Alert, Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigate,
  mockNavigationAddListener,
  mockGoBack,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
  mockLabelPicker,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { VALIDATION } from '@jot/shared';

// Save-first flow (issue #652): on a brand-new note (noteId === null), actions
// that need a server id — archive, and the server-only Add image, Labels and
// Share — are available immediately. Tapping one flushes a create first, then
// runs the action against the new id. Pin is the exception: on a note that does
// not exist yet it is a local toggle carried by the create request, and archive
// is disabled while the new note is still blank.

// Render a detectable marker only while the sheet is visible so the tests can
// assert the save-first flow actually opened it.
jest.mock('../src/components/AddImageActionSheet', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <RNText testID="add-image-sheet-open" /> : null,
  };
});

describe('NoteEditorScreen save-first actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    // Brand-new note: no id yet, nothing hydrated.
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'server-1', note_type: 'text', content: 'Fresh note' });
    mockUpdateMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('pins an unsaved note with content locally and creates it pinned', async () => {
    jest.useFakeTimers();
    const { getByTestId } = await render(<NoteEditorScreen />);

    // Type some content so the note is non-empty (and therefore saveable).
    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Fresh note');
    });

    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-pin-btn'));
    });

    // Pin on a note that does not exist yet is a local toggle: the autosave
    // create carries it, so no separate pin update is sent.
    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS); });
    expect(mockCreateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Fresh note', pinned: true }),
    );
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('creates the note before archiving when it has not been saved yet', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Fresh note');
    });

    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-archive-btn'));
    });

    // Save-first: a create fires, then the archive update against the new id.
    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'server-1', data: expect.objectContaining({ archived: true }) }),
      );
    });
    // Archiving a note returns the user to the dashboard.
    await waitFor(() => {
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });
});

describe('NoteEditorScreen pin and archive on a blank new note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'server-1', note_type: 'text', content: 'Later' });
    mockUpdateMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('toggles pin locally without creating, then creates pinned once there is content', async () => {
    jest.useFakeTimers();
    const { getByTestId } = await render(<NoteEditorScreen />);
    const pinBtn = () => getByTestId('toolbar-pin-btn');

    expect(pinBtn().props.accessibilityLabel).toBe('note.pin');
    await act(async () => {
      await fireEvent.press(pinBtn());
    });
    // The icon reflects the local state...
    expect(pinBtn().props.accessibilityLabel).toBe('note.unpin');

    // ...but a blank note is never created, even after the autosave delay.
    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS * 2); });
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();

    // Typing makes it saveable; autosave creates it already pinned.
    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Later');
    });
    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS); });

    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ note_type: 'text', content: 'Later', pinned: true }),
    );
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('pinning then unpinning a blank note creates it unpinned', async () => {
    jest.useFakeTimers();
    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => { await fireEvent.press(getByTestId('toolbar-pin-btn')); });
    await act(async () => { await fireEvent.press(getByTestId('toolbar-pin-btn')); });
    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Later');
    });
    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS); });

    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateMutateAsync.mock.calls[0]![0]).not.toHaveProperty('pinned', true);
  });

  it('disables archive until the note has content', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    expect(getByTestId('toolbar-archive-btn').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-archive-btn'));
    });
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();

    await act(async () => {
      await fireEvent.changeText(getByTestId('note-content-input'), 'Later');
    });
    expect(getByTestId('toolbar-archive-btn').props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe('NoteEditorScreen save-first server actions on a brand-new note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    // Brand-new note: no persisted note yet.
    mockUseOfflineNote.mockReturnValue({ data: undefined });
    mockCreateMutateAsync.mockResolvedValue({ id: 'note-new', note_type: 'text', content: 'Hello' });
    // Render a detectable marker only while the picker is visible so tests can
    // assert the save-first flow actually opened it.
    mockLabelPicker.mockImplementation(({ visible }: { visible: boolean }) =>
      visible ? <Text testID="label-picker-open" /> : null);
  });

  it('enables Add image and offers Share + Labels before the first save', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    // Add-image is enabled on an unsaved note (save-first will create it on tap).
    expect(getByTestId('toolbar-add-image-btn').props.accessibilityState).toMatchObject({ disabled: false });

    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(getByTestId('editor-menu-share')).toBeTruthy();
    expect(getByTestId('editor-menu-label')).toBeTruthy();
  });

  it('flushes a create then opens the image sheet when Add image is tapped', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    // Give the note content so the create isn't a no-op empty flush.
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-add-image-btn'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(getByTestId('add-image-sheet-open')).toBeTruthy();
    });
  });

  it('flushes a create then navigates to Share when Share is tapped', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    await act(async () => {
      await fireEvent.press(getByTestId('editor-menu-share'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-new' });
    });
  });
});
