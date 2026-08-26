import { act, fireEvent, render } from '@testing-library/react-native';
import { makeListNote, makeNoteItem } from './helpers/fixtures';
import {
  mockNavigationAddListener,
  mockReorderItemsMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
  mockUseRoute,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// jest.setup.js's shared react-native-reorderable-list mock records the props
// NestedReorderableList was last rendered with; reading them here lets a test
// invoke `onReorder` directly instead of driving an actual gesture.
function latestOnReorder(): (e: { from: number; to: number }) => void {
  const mocked = jest.requireMock('react-native-reorderable-list') as {
    __getLatestProps: () => { onReorder: (e: { from: number; to: number }) => void } | null;
  };
  const props = mocked.__getLatestProps();
  if (!props) throw new Error('NestedReorderableList has not rendered yet');
  return props.onReorder;
}

const NOTE_ID = 'note-drag-focus';
const ITEM_A_ID = 'aaaaaaaaaaaaaaaaaaaaaa';
const ITEM_B_ID = 'bbbbbbbbbbbbbbbbbbbbbb';

const twoItemListNote = () => makeListNote({
  id: NOTE_ID,
  title: 'Trip',
  items: [
    makeNoteItem({ id: ITEM_A_ID, note_id: NOTE_ID, text: 'Item A', position: 0 }),
    makeNoteItem({ id: ITEM_B_ID, note_id: NOTE_ID, text: 'Item B', position: 1 }),
  ],
});

// Regression test for the bug where focusing a list item and then dragging it
// to reorder moved focus to the title input. The real
// react-native-reorderable-list force-remounts any row whose slot changed (a
// new `key`, to fix a layout glitch — see ReorderableListCore's
// `createCellKey`), which drops the focused TextInput. This jsdom-based mock
// doesn't reproduce that remount, but it lets us verify the fix's actual
// mechanism: NoteEditorScreen re-arms `autoFocus` on the previously-focused
// item so that when the real library remounts it, native `autoFocus`-on-mount
// behavior re-opens the keyboard on it instead of leaving focus to fall back
// elsewhere.
describe('NoteEditorScreen list item focus across a drag reorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: NOTE_ID } });
    mockUseOfflineNote.mockReturnValue({ data: twoItemListNote() });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockReorderItemsMutateAsync.mockResolvedValue([]);
  });

  it('re-arms autoFocus on the item that was focused before the drag committed', async () => {
    const { getByDisplayValue } = await render(<NoteEditorScreen />);

    await fireEvent(getByDisplayValue('Item A'), 'focus', { nativeEvent: { target: 1 } });
    await act(() => {
      latestOnReorder()({ from: 0, to: 1 });
    });

    expect(getByDisplayValue('Item A').props.autoFocus).toBe(true);
    expect(getByDisplayValue('Item B').props.autoFocus).not.toBe(true);
  });

  it('does not mark an item for autoFocus when nothing was focused before the drag', async () => {
    const { getByDisplayValue } = await render(<NoteEditorScreen />);

    await act(() => {
      latestOnReorder()({ from: 0, to: 1 });
    });

    expect(getByDisplayValue('Item A').props.autoFocus).not.toBe(true);
    expect(getByDisplayValue('Item B').props.autoFocus).not.toBe(true);
  });
});
