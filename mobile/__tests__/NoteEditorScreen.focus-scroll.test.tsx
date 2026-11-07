import { render, screen } from '@testing-library/react-native';
import { makeListNote, makeNoteItem, makeTextNote } from './helpers/fixtures';
import {
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockUseRoute,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const NOTE_ID = 'note-focus-scroll';

// The native jump this guards against (Android scrolling the reorderable
// list's whole FlatList into view on a row's focus) cannot be reproduced here;
// what this pins is the switch: off for lists, on for text notes.
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
