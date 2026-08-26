import { act, render } from '@testing-library/react-native';
import type { LocalItem } from '../src/screens/noteEditor/listItemModel';
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
// NestedReorderableList was last rendered with, which is how these tests reach
// the drag callbacks and keyExtractor the screen wired up.
interface ListProps {
  data: LocalItem[];
  keyExtractor: (item: LocalItem, index: number) => string;
  onDragStart: (e: { index: number }) => void;
  onReorder: (e: { from: number; to: number }) => void;
  onDragEnd: (e: { from: number; to: number }) => void;
}

function latestListProps(): ListProps {
  const mocked = jest.requireMock('react-native-reorderable-list') as {
    __getLatestProps: () => ListProps | null;
  };
  const props = mocked.__getLatestProps();
  if (!props) throw new Error('NestedReorderableList has not rendered yet');
  return props;
}

const NOTE_ID = 'note-stale-drag';
const ITEM_A_ID = 'aaaaaaaaaaaaaaaaaaaaaa';
const ITEM_B_ID = 'bbbbbbbbbbbbbbbbbbbbbb';
const ITEM_C_ID = 'cccccccccccccccccccccc';

function listNote(itemIds: string[], updatedAt = '2026-01-01T00:00:00Z') {
  return makeListNote({
    id: NOTE_ID,
    title: 'Packliste',
    updated_at: updatedAt,
    items: itemIds.map((id, position) =>
      makeNoteItem({ id, note_id: NOTE_ID, text: `Item ${position}`, position }),
    ),
  });
}

function itemTexts(getAllByTestId: (id: string) => { props: { value?: string } }[]): string[] {
  return getAllByTestId('list-item-text').map((node) => node.props.value ?? '');
}

// Regression tests for the reorder crash reported three times now (#821, #850,
// and again after both fixes were reverted in #859): a background note refresh
// replaces the item list while a drag is still in flight, and the library —
// which only calls back once its drop animation finishes — hands back indices
// measured against the list as it was. Reading `data` at those indices used to
// throw "Cannot read property 'id' of undefined" in keyExtractor, and
// committing them would have spliced `undefined` into the list.
describe('NoteEditorScreen drag against a list that changed underneath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: NOTE_ID } });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockReorderItemsMutateAsync.mockResolvedValue([]);
  });

  it('yields a key for an index the list no longer has instead of throwing', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote([ITEM_A_ID]) });
    await render(<NoteEditorScreen />);

    const { keyExtractor, data } = latestListProps();
    // The library calls keyExtractor(data[i], i) for the whole moved range, so
    // an index past the end arrives as `undefined`.
    expect(keyExtractor(data[1] as LocalItem, 1)).toBe('1');
  });

  it('discards a drop whose indices no longer fit the list', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote([ITEM_A_ID, ITEM_B_ID, ITEM_C_ID]) });
    const { getAllByTestId, rerender } = await render(<NoteEditorScreen />);

    await act(() => {
      latestListProps().onDragStart({ index: 2 });
    });

    // A remote update shrinks the note while the drag is still in flight. The
    // editor is clean, so the refresh effect applies it immediately.
    mockUseOfflineNote.mockReturnValue({
      data: listNote([ITEM_A_ID], '2026-01-01T00:05:00Z'),
    });
    await act(async () => {
      await rerender(<NoteEditorScreen />);
    });
    expect(itemTexts(getAllByTestId)).toEqual(['Item 0']);

    // The drop lands with the pre-refresh indices.
    await act(() => {
      latestListProps().onReorder({ from: 2, to: 0 });
    });

    expect(itemTexts(getAllByTestId)).toEqual(['Item 0']);
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('discards a drop whose indices now point at a different row', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote([ITEM_A_ID, ITEM_B_ID]) });
    const { getAllByTestId, rerender } = await render(<NoteEditorScreen />);

    await act(() => {
      latestListProps().onDragStart({ index: 1 });
    });

    // Same length, different contents: the indices are in range but no longer
    // describe the row the user picked up.
    mockUseOfflineNote.mockReturnValue({
      data: listNote([ITEM_C_ID, ITEM_A_ID], '2026-01-01T00:05:00Z'),
    });
    await act(async () => {
      await rerender(<NoteEditorScreen />);
    });

    await act(() => {
      latestListProps().onReorder({ from: 1, to: 0 });
    });

    expect(itemTexts(getAllByTestId)).toEqual(['Item 0', 'Item 1']);
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('still commits a drop when the list is unchanged', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote([ITEM_A_ID, ITEM_B_ID]) });
    const { getAllByTestId } = await render(<NoteEditorScreen />);

    await act(() => {
      latestListProps().onDragStart({ index: 0 });
    });
    await act(() => {
      latestListProps().onReorder({ from: 0, to: 1 });
    });

    expect(itemTexts(getAllByTestId)).toEqual(['Item 1', 'Item 0']);
  });
});
