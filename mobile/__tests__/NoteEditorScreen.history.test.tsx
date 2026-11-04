import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigate,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

// The overflow menu's History entry (#1129): online-only, so it is disabled
// with a hint while the server is unusable, and absent for a note that does
// not exist yet or is in the trash.

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: 'Body',
    version: 2,
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

describe('NoteEditorScreen History entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markServerReachable();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote() });
  });

  afterEach(() => {
    markServerReachable();
  });

  it('opens the note history', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    await act(async () => {
      await fireEvent.press(getByTestId('editor-menu-history'));
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('NoteHistory', { noteId: 'note-1' }));
  });

  it('is disabled with a hint while the server is unreachable', async () => {
    markServerUnreachable();
    const { getByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(getByTestId('editor-menu-history')).toBeDisabled();
    expect(getByTestId('editor-menu-history-hint')).toBeTruthy();
  });

  it('is absent on a brand-new note', async () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: undefined });
    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');
    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(queryByTestId('editor-menu-history')).toBeNull();
  });

  it('is absent on a trashed note', async () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ deleted_at: '2026-07-03T00:00:00Z' }) });
    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.press(getByTestId('toolbar-menu-btn'));
    expect(queryByTestId('editor-menu-history')).toBeNull();
  });
});
