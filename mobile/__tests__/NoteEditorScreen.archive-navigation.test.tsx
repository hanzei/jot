import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockGoBack,
  mockNavigationAddListener,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
  mockShowToast,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    note_type: 'text',
    title: '',
    content: 'Hello world',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen archive navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUpdateMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('navigates back to the dashboard after archiving an existing note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ archived: false }) });

    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-archive-btn'));
    });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', data: expect.objectContaining({ archived: true }) }),
      );
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('dashboard.noteArchived', 'success', expect.anything());
  });

  it('does not navigate back when unarchiving an existing note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ archived: true }) });

    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByTestId('toolbar-archive-btn'));
    });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', data: expect.objectContaining({ archived: false }) }),
      );
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('dashboard.noteUnarchived');
  });
});
