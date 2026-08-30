import { render, act, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockToggleItemCompletedMutateAsync as mockToggleMutateAsync,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const ITEM_ID = 'iiiiiiiiiiiiiiiiiiiiii';

/**
 * The note as SQLite still holds it while a toggle request is in flight: the
 * local row is only patched once the response lands, so every read in that
 * window reports the item unchecked. A fresh object each call is what a
 * refetch produces, and that new identity is what re-runs the editor's
 * refresh effect.
 */
function staleListNote() {
  return {
    id: 'note-race',
    user_id: 'u1',
    title: 'Groceries',
    content: '',
    note_type: 'list',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: false,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [],
    shared_with: [],
    items: [
      {
        id: ITEM_ID,
        note_id: 'note-race',
        text: 'Milk',
        completed: false,
        position: 0,
        parent_id: null,
        assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('NoteEditorScreen toggle / refresh race', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-race' } });
    mockUseOfflineNote.mockReturnValue({ data: staleListNote() });
  });

  // The flicker: a checked row jumps back into the active list for the length of
  // one round trip. The local SQLite row is patched only after the toggle
  // response lands, so anything that re-reads the note in that window (the
  // queue drain's invalidation, the background note sync, a sibling toggle's
  // onSuccess) yields a note that still says unchecked — and the editor's
  // refresh effect applies it over the optimistic state.
  it('keeps a checked item checked when the note is re-read mid-request', async () => {
    const pending = deferred<{ id: string; completed: boolean }[]>();
    mockToggleMutateAsync.mockReturnValue(pending.promise);

    const { getAllByTestId, getByText, queryAllByTestId, rerender } = await render(<NoteEditorScreen />);

    const press = (node: { props: unknown }) =>
      (node.props as { onClick?: () => void }).onClick?.();
    await act(() => {
      press(getAllByTestId('list-item-checkbox')[0]!);
    });

    // Optimistically checked: the row has moved into the completed section.
    expect(getByText('1 completed items')).toBeTruthy();

    // A re-read lands while the request is still in flight, returning the note
    // as SQLite still has it — unchecked.
    mockUseOfflineNote.mockReturnValue({ data: staleListNote() });
    await act(async () => {
      await rerender(<NoteEditorScreen />);
    });

    // The row must not come back to the active list.
    expect(queryAllByTestId('icon-Square')).toHaveLength(0);
    expect(getAllByTestId('icon-SquareCheck')).toHaveLength(1);
    expect(getByText('1 completed items')).toBeTruthy();

    // And it stays checked once the response lands.
    await act(async () => {
      pending.resolve([{ id: ITEM_ID, completed: true }]);
      await pending.promise;
    });
    await waitFor(() => {
      expect(getAllByTestId('icon-SquareCheck')).toHaveLength(1);
    });
    expect(queryAllByTestId('icon-Square')).toHaveLength(0);
  });
});
