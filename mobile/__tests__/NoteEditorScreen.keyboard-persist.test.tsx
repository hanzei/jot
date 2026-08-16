import { render } from '@testing-library/react-native';
import { makeListNote, makeNoteItem } from './helpers/fixtures';
import {
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockUseRoute,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const NOTE_ID = 'note-keyboard-persist';

// Regression test for the bug where moving between two list items took two
// taps: the first blurred the focused row and dismissed the keyboard, the
// second reached the row that was tapped.
//
// The mechanism is native and cannot be reproduced here. A ScrollView captures
// the touch responder — blurring the focused input and swallowing the tap —
// when `keyboardShouldPersistTaps` is left at its default and the tap lands on
// something that is not a TextInput
// (`ScrollView.scrollResponderHandleStartShouldSetResponderCapture`). The
// reorderable list is a FlatList, so it brings its own ScrollView, and a
// rendered row's tap target is a Text rather than its TextInput
// (docs/specs/markdown-rendering.md §1.2) — so every row-to-row move paid a
// tap. What this test can pin is the fix's mechanism: the list is rendered with
// the same policy as the ScrollViewContainer around it.
function latestListProps(): Record<string, unknown> {
  const mocked = jest.requireMock('react-native-reorderable-list') as {
    __getLatestProps: () => Record<string, unknown> | null;
  };
  const props = mocked.__getLatestProps();
  if (!props) throw new Error('NestedReorderableList has not rendered yet');
  return props;
}

describe('NoteEditorScreen keyboard persistence across list rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: NOTE_ID } });
    mockUseOfflineNote.mockReturnValue({
      data: makeListNote({
        id: NOTE_ID,
        title: 'Trip',
        items: [makeNoteItem({ id: 'aaaaaaaaaaaaaaaaaaaaaa', note_id: NOTE_ID, text: 'Item A', position: 0 })],
      }),
    });
  });

  it('lets the item list persist the keyboard for taps its rows handle', async () => {
    await render(<NoteEditorScreen />);

    expect(latestListProps().keyboardShouldPersistTaps).toBe('handled');
  });
});
