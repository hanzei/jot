import { Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigate,
  mockCreateMutateAsync,
  mockUseOfflineNote,
  mockLabelPicker,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// Save-first flow (issue #652): on a brand-new note (noteId === null), the
// server-only actions (Add image, Labels, Share) are available immediately.
// Tapping one flushes a create first, then runs the action against the new id.

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

  it('enables Add image and offers Share + Labels before the first save', () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    // Add-image is enabled on an unsaved note (save-first will create it on tap).
    expect(getByTestId('toolbar-add-image-btn').props.accessibilityState).toMatchObject({ disabled: false });

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(getByTestId('editor-menu-share')).toBeTruthy();
    expect(getByTestId('editor-menu-label')).toBeTruthy();
  });

  it('flushes a create then opens the image sheet when Add image is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    // Give the note content so the create isn't a no-op empty flush.
    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-add-image-btn'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(getByTestId('add-image-sheet-open')).toBeTruthy();
    });
  });

  it('flushes a create then navigates to Share when Share is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    fireEvent.press(getByTestId('toolbar-menu-btn'));
    await act(async () => {
      fireEvent.press(getByTestId('editor-menu-share'));
    });

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-new' });
    });
  });
});
