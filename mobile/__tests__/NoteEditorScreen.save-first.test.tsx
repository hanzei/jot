import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockGoBack,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

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
    jest.restoreAllMocks();
  });

  it('creates the note before pinning when it has not been saved yet', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    // Type some content so the note is non-empty (and therefore saveable).
    await act(async () => {
      fireEvent.changeText(getByTestId('note-content-input'), 'Fresh note');
    });

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-pin-btn'));
    });

    // Save-first: a create fires, then the pin update against the new id.
    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'server-1', data: expect.objectContaining({ pinned: true }) }),
      );
    });
  });

  it('creates the note before archiving when it has not been saved yet', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.changeText(getByTestId('note-content-input'), 'Fresh note');
    });

    await act(async () => {
      fireEvent.press(getByTestId('toolbar-archive-btn'));
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
