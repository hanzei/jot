import { render, screen } from '@testing-library/react-native';
import { makeListNote, makeNoteItem, makeTextNote } from './helpers/fixtures';
import {
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockUseRoute,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const NOTE_ID = 'note-focus-scroll';

// Android's ScrollView scrolls a newly focused descendant into view on its own,
// but it aims at the outermost ScrollView between the input and itself. A list
// row's input sits inside the reorderable list's FlatList, so Android scrolled
// the whole list's top edge into view — a jump on every tap, which the old
// keyboard helper then animated back (the flicker). The jump itself is native
// and cannot be reproduced here; what this pins is that the editor turns it off
// for lists, where useListItemEditing reveals the row itself, and keeps it for
// text notes, where it also keeps the caret in view while typing.
describe('NoteEditorScreen native scroll-to-focus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: NOTE_ID } });
  });

  it('is off for a list note', async () => {
    mockUseOfflineNote.mockReturnValue({
      data: makeListNote({
        id: NOTE_ID,
        items: [makeNoteItem({ id: 'aaaaaaaaaaaaaaaaaaaaaa', note_id: NOTE_ID, text: 'Item A', position: 0 })],
      }),
    });
    await render(<NoteEditorScreen />);

    expect(screen.getByTestId('note-editor-scroll').props.scrollsChildToFocus).toBe(false);
  });

  it('stays on for a text note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeTextNote({ id: NOTE_ID, content: 'Body' }) });
    await render(<NoteEditorScreen />);

    expect(screen.getByTestId('note-editor-scroll').props.scrollsChildToFocus).toBe(true);
  });
});
