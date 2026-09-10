import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockGoBack,
  mockNavigationAddListener,
  mockDeleteMutateAsync,
  mockUseOfflineNote,
  mockUseUsers,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// The mocked auth user (helpers/noteEditorScreenTestSetup) is u1 ("alice").
// A note owned by u1 is the current user's own note; a note whose user_id is
// someone else but whose shared_with includes u1 is a note shared *with* the
// current user, which they can view/edit but not delete (server-side only the
// owner may delete — see DeleteNote / MoveToTrash).

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: 'hello',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen move-to-trash ownership gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockDeleteMutateAsync.mockResolvedValue({});
    mockUseUsers.mockReturnValue({
      usersById: new Map([
        ['u1', { id: 'u1', username: 'alice' }],
        ['u2', { id: 'u2', username: 'bob' }],
      ]),
    });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('offers Move to trash in the overflow menu for a note the user owns', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote() });

    const { getByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toolbar-menu-btn'));

    expect(getByTestId('editor-menu-trash')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(getByTestId('editor-menu-trash'));
    });

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('note-1');
    });
  });

  it('hides Move to trash in the overflow menu for a note shared with the user', async () => {
    // Owned by u2, shared with the current user (u1): editable, not trashed.
    mockUseOfflineNote.mockReturnValue({
      data: makeNote({
        user_id: 'u2',
        is_shared: true,
        shared_with: [{ id: 'share-1', shared_with_user_id: 'u1', username: 'alice' }],
      }),
    });

    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('toolbar-menu-btn'));

    // Delete is owner-only, so the non-owner never sees the action. Sharing is
    // likewise owner-only, so that row is absent too.
    expect(queryByTestId('editor-menu-trash')).toBeNull();
    expect(queryByTestId('editor-menu-share')).toBeNull();
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });
});
