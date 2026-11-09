import { act, fireEvent, render, within } from '@testing-library/react-native';
import { makeListNote, makeNoteItem } from './helpers/fixtures';
import {
  mockNavigationAddListener,
  mockReorderItemsMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
  mockUseRoute,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// Dragging a parent lifts its children with it. The reorderable list can only
// lift one cell, so pressing a parent's drag handle draws its children inside
// the parent's own row (and empties theirs) before the long-press starts the
// drag. jest.setup.js's list mock renders every cell, so the grouping shows up
// as the children's rows moving inside the parent's `list-item-group`.
interface ListProps {
  itemLayoutAnimation?: unknown;
  onDragStart: (e: { index: number }) => void;
  onReorder: (e: { from: number; to: number }) => void;
}

function latestListProps(): ListProps {
  const mocked = jest.requireMock('react-native-reorderable-list') as {
    __getLatestProps: () => ListProps | null;
  };
  const props = mocked.__getLatestProps();
  if (!props) throw new Error('NestedReorderableList has not rendered yet');
  return props;
}

const NOTE_ID = 'note-drag-group';
const PARENT_ID = 'pppppppppppppppppppppp';
const CHILD_1_ID = 'c1c1c1c1c1c1c1c1c1c1c1';
const CHILD_2_ID = 'c2c2c2c2c2c2c2c2c2c2c2';
const OTHER_ID = 'oooooooooooooooooooooo';

const groupedNote = () => makeListNote({
  id: NOTE_ID,
  title: 'Trip',
  items: [
    makeNoteItem({ id: PARENT_ID, note_id: NOTE_ID, text: 'Parent', position: 0 }),
    makeNoteItem({ id: CHILD_1_ID, note_id: NOTE_ID, text: 'Child 1', position: 1, parent_id: PARENT_ID }),
    makeNoteItem({ id: CHILD_2_ID, note_id: NOTE_ID, text: 'Child 2', position: 2, parent_id: PARENT_ID }),
    makeNoteItem({ id: OTHER_ID, note_id: NOTE_ID, text: 'Other', position: 3 }),
  ],
});

type Query = { props: { value?: string } }[];
const texts = (nodes: Query) => nodes.map((node) => node.props.value ?? '');

describe('NoteEditorScreen dragging a parent item', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: NOTE_ID } });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockReorderItemsMutateAsync.mockResolvedValue([]);
    mockUseOfflineNote.mockReturnValue({ data: groupedNote() });
  });

  // Ungrouping resumes the reflow animation on the next frame; the tests
  // advance it explicitly, and a frame left pending is dropped here.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('draws the children inside the parent row while its handle is held', async () => {
    const { getAllByTestId, getByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    expect(queryByTestId('list-item-group')).toBeNull();

    const parentHandle = getAllByTestId('list-item-drag-handle')[0]!;
    await fireEvent(parentHandle, 'onPressIn');

    const group = getByTestId('list-item-group');
    expect(texts(within(group).getAllByTestId('list-item-text'))).toEqual(['Parent', 'Child 1', 'Child 2']);
    // Same rows, same order on screen.
    expect(texts(getAllByTestId('list-item-text'))).toEqual(['Parent', 'Child 1', 'Child 2', 'Other']);

    await fireEvent(parentHandle, 'onPressOut');
    expect(queryByTestId('list-item-group')).toBeNull();
  });

  it("keeps a sliver of height in the children's own cells so the group can move down", async () => {
    const { getAllByTestId, queryAllByTestId } = await render(<NoteEditorScreen />);
    await fireEvent(getAllByTestId('list-item-drag-handle')[0]!, 'onPressIn');
    // A zero-height cell would tie the library's slot comparison forever, so
    // each child's cell keeps a placeholder (empty would be `null`).
    const placeholders = queryAllByTestId('list-item-group-placeholder');
    expect(placeholders).toHaveLength(2);
    for (const placeholder of placeholders) expect(placeholder.props.style).toEqual({ height: 1 });
  });

  it('pauses the reflow animation while a group is held and through its drop', async () => {
    const { getAllByTestId } = await render(<NoteEditorScreen />);
    expect(latestListProps().itemLayoutAnimation).toBeDefined();

    const parentHandle = getAllByTestId('list-item-drag-handle')[0]!;
    await fireEvent(parentHandle, 'onPressIn');
    expect(latestListProps().itemLayoutAnimation).toBeUndefined();

    await fireEvent(parentHandle, 'onLongPress');
    await act(() => {
      latestListProps().onDragStart({ index: 0 });
    });
    await act(() => {
      latestListProps().onReorder({ from: 0, to: 3 });
    });
    // Still paused for the drop's own render; resumes a frame later.
    expect(latestListProps().itemLayoutAnimation).toBeUndefined();
    await act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(latestListProps().itemLayoutAnimation).toBeDefined();
  });

  it('draws every other group as a block too, so the held one can only pass whole groups', async () => {
    const OTHER_CHILD_ID = 'ocococococococococococ';
    const note = groupedNote();
    note.items!.push(makeNoteItem({ id: OTHER_CHILD_ID, note_id: NOTE_ID, text: 'Other child', position: 4, parent_id: OTHER_ID }));
    mockUseOfflineNote.mockReturnValue({ data: note });
    const { getAllByTestId, queryAllByTestId } = await render(<NoteEditorScreen />);

    await fireEvent(getAllByTestId('list-item-drag-handle')[0]!, 'onPressIn');

    const groups = getAllByTestId('list-item-group');
    expect(groups).toHaveLength(2);
    expect(texts(within(groups[1]!).getAllByTestId('list-item-text'))).toEqual(['Other', 'Other child']);
    expect(queryAllByTestId('list-item-group-placeholder')).toHaveLength(3);
    expect(texts(getAllByTestId('list-item-text'))).toEqual(['Parent', 'Child 1', 'Child 2', 'Other', 'Other child']);
  });

  it('does not group a row without children', async () => {
    const { getAllByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    await fireEvent(getAllByTestId('list-item-drag-handle')[3]!, 'onPressIn');
    expect(queryByTestId('list-item-group')).toBeNull();
  });

  it('drops the whole group in its new place', async () => {
    const { getAllByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    const parentHandle = getAllByTestId('list-item-drag-handle')[0]!;
    await fireEvent(parentHandle, 'onPressIn');
    await fireEvent(parentHandle, 'onLongPress');
    await act(() => {
      latestListProps().onDragStart({ index: 0 });
    });
    await act(() => {
      latestListProps().onReorder({ from: 0, to: 3 });
    });

    expect(queryByTestId('list-item-group')).toBeNull();
    expect(texts(getAllByTestId('list-item-text'))).toEqual(['Other', 'Parent', 'Child 1', 'Child 2']);
  });
});
