import { render } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockMarkViewedMutate,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

function textNote(unread: 'new' | 'updated' | null, updatedAt = '2026-01-01T00:00:00.000Z') {
  return {
    id: 'note-unread',
    user_id: 'owner',
    content: 'Shared with you',
    note_type: 'text',
    version: 1,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: true,
    unread,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: updatedAt,
    labels: [],
    shared_with: [],
  };
}

describe('NoteEditorScreen unread badges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-unread' } });
  });

  it('marks an unread note viewed once when it opens', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote('new') });
    const { rerender, unmount } = await render(<NoteEditorScreen />);

    expect(mockMarkViewedMutate).toHaveBeenCalledTimes(1);
    expect(mockMarkViewedMutate).toHaveBeenCalledWith('note-unread');

    // The local clear lands; leaving afterwards needs no second call.
    mockUseOfflineNote.mockReturnValue({ data: textNote(null) });
    await rerender(<NoteEditorScreen />);
    await unmount();

    expect(mockMarkViewedMutate).toHaveBeenCalledTimes(1);
  });

  it('does not mark a note that has nothing new', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote(null) });
    const { unmount } = await render(<NoteEditorScreen />);
    await unmount();

    expect(mockMarkViewedMutate).not.toHaveBeenCalled();
  });

  it('marks a note viewed on leaving when a collaborator changed it while open', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote(null) });
    const { rerender, unmount } = await render(<NoteEditorScreen />);

    // An SSE update from a collaborator lands in the cache as 'updated'.
    mockUseOfflineNote.mockReturnValue({ data: textNote('updated', '2026-01-01T00:05:00.000Z') });
    await rerender(<NoteEditorScreen />);
    expect(mockMarkViewedMutate).not.toHaveBeenCalled();

    await unmount();

    expect(mockMarkViewedMutate).toHaveBeenCalledTimes(1);
    expect(mockMarkViewedMutate).toHaveBeenCalledWith('note-unread');
  });
});
