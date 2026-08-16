import { useRef } from 'react';
import type { ScrollView } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import type { TFunction } from 'i18next';
import { useEditorDoc } from '../src/screens/noteEditor/useEditorDoc';
import { useListItemEditing } from '../src/screens/noteEditor/useListItemEditing';
import type { ItemSnapshot, LocalItem } from '../src/screens/noteEditor/listItemModel';

// List-item editing driven directly, without mounting the editor. The screen
// tests cover the wiring; these cover the branches that are impractical to
// reach through a full render — an Enter that splits a row mid-text, and the
// bulk-delete revert, which has to restore deleted rows *around* an item added
// while its request was in flight.

const mockToggleItemCompleted = jest.fn().mockResolvedValue([]);
const mockUncheckAllItems = jest.fn().mockResolvedValue([]);
const mockDeleteCompletedItems = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/hooks/useNotes', () => ({
  __esModule: true,
  useToggleNoteItemCompleted: () => ({ mutateAsync: mockToggleItemCompleted }),
  useUncheckAllItems: () => ({ mutateAsync: mockUncheckAllItems }),
  useDeleteCompletedItems: () => ({ mutateAsync: mockDeleteCompletedItems }),
}));

const mockConfirm = jest.fn().mockResolvedValue(true);
const mockShowToast = jest.fn();
const markDirty = jest.fn();
const cancelScheduledSave = jest.fn();
const setSaveError = jest.fn();
const openAssigneePicker = jest.fn();

const t = ((key: string) => key) as unknown as TFunction;

function item(id: string, overrides: Partial<LocalItem> = {}): LocalItem {
  return { id, text: id, completed: false, position: 0, parentId: null, assigned_to: '', ...overrides };
}

function snapshot(it: LocalItem): ItemSnapshot {
  return { text: it.text, completed: it.completed, parentId: it.parentId, assigned_to: it.assigned_to };
}

function useHarness() {
  const doc = useEditorDoc({ initialNoteId: 'note-1' });
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  const scrollViewRef = useRef<ScrollView>(null);
  const editing = useListItemEditing({
    doc: doc.handle,
    items: doc.items,
    markDirtyAndScheduleUpdate: markDirty,
    cancelScheduledSave,
    setSaveError,
    savedItemsRef,
    savedOrderRef,
    // The pending bar is its own hook; here it just runs the action.
    withPendingIndicator: (fn) => fn(),
    scrollViewRef,
    openAssigneePicker,
    confirm: mockConfirm,
    showToast: mockShowToast,
    t,
  });
  return { doc, editing, savedItemsRef, savedOrderRef };
}

/** Mounts the harness and seeds it with `items` as the last-saved baseline. */
async function mountWith(items: LocalItem[]) {
  const view = await renderHook(() => useHarness());
  await act(async () => {});
  await act(async () => {
    view.result.current.doc.handle.setItems(items.map((it, i) => ({ ...it, position: i })));
  });
  view.result.current.savedItemsRef.current = new Map(items.map((it) => [it.id, snapshot(it)]));
  view.result.current.savedOrderRef.current = items.map((it) => it.id);
  return view;
}

const ids = (items: LocalItem[]) => items.map((it) => it.id);

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockToggleItemCompleted.mockResolvedValue([]);
  mockDeleteCompletedItems.mockResolvedValue(undefined);
});

describe('useListItemEditing — Enter at the cursor', () => {
  it('splits a row in two at the caret, the new row inheriting its group and assignee', async () => {
    const { result } = await mountWith([item('a', { text: 'hello world', parentId: 'p', assigned_to: 'u1' })]);

    await act(async () => { result.current.editing.listItemHandlers.onEnterAtCursor(0, 5); });

    const items = result.current.doc.items;
    expect(items.map((it) => it.text)).toEqual(['hello', ' world']);
    expect(items[1]!.parentId).toBe('p');
    expect(items[1]!.assigned_to).toBe('u1');
    // Positions are renumbered so the save diff sends a coherent order.
    expect(items.map((it) => it.position)).toEqual([0, 1]);
    expect(markDirty).toHaveBeenCalled();
  });

  it('inserts a blank row above when the caret sits at the start of a non-empty row', async () => {
    const { result } = await mountWith([item('a', { text: 'keep me' })]);

    await act(async () => { result.current.editing.listItemHandlers.onEnterAtCursor(0, 0); });

    const items = result.current.doc.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe('');
    // The row that was there keeps its text rather than being split at 0.
    expect(items[1]!.text).toBe('keep me');
  });

  it('appends a blank row when the caret is at the end', async () => {
    const { result } = await mountWith([item('a', { text: 'done' }), item('b', { text: 'later' })]);

    await act(async () => { result.current.editing.listItemHandlers.onEnterAtCursor(0, 4); });

    const items = result.current.doc.items;
    expect(items.map((it) => it.text)).toEqual(['done', '', 'later']);
  });
});

describe('useListItemEditing — backspace on an empty row', () => {
  it('removes the row', async () => {
    const { result } = await mountWith([item('a'), item('b', { text: '' }), item('c')]);

    await act(async () => { result.current.editing.listItemHandlers.onBackspaceOnEmpty(1); });

    expect(ids(result.current.doc.items)).toEqual(['a', 'c']);
  });

  it('leaves a row that still has text', async () => {
    const { result } = await mountWith([item('a'), item('b', { text: 'typed' })]);

    await act(async () => { result.current.editing.listItemHandlers.onBackspaceOnEmpty(1); });

    expect(ids(result.current.doc.items)).toEqual(['a', 'b']);
    expect(markDirty).not.toHaveBeenCalled();
  });
});

describe('useListItemEditing — accepting a completed-item suggestion', () => {
  it('restores the completed row in place of the row being typed', async () => {
    const { result } = await mountWith([
      item('typing', { text: 'mil' }),
      item('other'),
      item('done', { text: 'Milk', completed: true }),
    ]);

    await act(async () => { result.current.editing.handleAcceptSuggestion('typing', 'Milk'); });

    const items = result.current.doc.items;
    // The completed row is un-checked and takes the typed row's slot; the typed
    // row itself is consumed rather than left behind as a duplicate.
    expect(ids(items)).toEqual(['done', 'other']);
    expect(items[0]!.completed).toBe(false);
  });
});

describe('useListItemEditing — deleting the completed rows', () => {
  it('drops them from the list and prunes the save baseline', async () => {
    const { result } = await mountWith([
      item('a', { completed: true }),
      item('b'),
      item('c', { completed: true }),
    ]);

    await act(async () => { await result.current.editing.handleDeleteCompletedItems(); });

    expect(ids(result.current.doc.items)).toEqual(['b']);
    expect(mockDeleteCompletedItems).toHaveBeenCalledWith({ noteId: 'note-1', itemIds: ['a', 'c'] });
    expect([...result.current.savedItemsRef.current.keys()]).toEqual(['b']);
    expect(result.current.savedOrderRef.current).toEqual(['b']);
  });

  it('does nothing when the confirm is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const { result } = await mountWith([item('a', { completed: true }), item('b')]);

    await act(async () => { await result.current.editing.handleDeleteCompletedItems(); });

    expect(ids(result.current.doc.items)).toEqual(['a', 'b']);
    expect(mockDeleteCompletedItems).not.toHaveBeenCalled();
  });

  it('restores the deleted rows around one added while the request was in flight', async () => {
    const { result } = await mountWith([
      item('a', { completed: true }),
      item('b'),
      item('c', { completed: true }),
    ]);

    let rejectDelete!: (err: Error) => void;
    mockDeleteCompletedItems.mockReturnValue(new Promise((_res, rej) => { rejectDelete = rej; }));

    let deleting!: Promise<void>;
    await act(async () => {
      deleting = result.current.editing.handleDeleteCompletedItems();
      // Let the confirm resolve and the optimistic removal commit.
      await Promise.resolve();
    });
    expect(ids(result.current.doc.items)).toEqual(['b']);

    // A row added mid-flight must survive the revert — reverting to the stale
    // pre-delete snapshot would silently discard it.
    await act(async () => { result.current.editing.handleAddItem(); });
    const addedId = result.current.doc.items[1]!.id;

    await act(async () => { rejectDelete(new Error('offline')); await deleting; });

    // a has no surviving predecessor so it goes back to the front; c is anchored
    // after b, which is still present. The added row keeps its own position.
    expect(ids(result.current.doc.items)).toEqual(['a', 'b', 'c', addedId]);
    expect(result.current.savedOrderRef.current).toEqual(['a', 'b', 'c']);
    expect([...result.current.savedItemsRef.current.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(setSaveError).toHaveBeenCalledWith('note.failedSaveChanges');
  });
});

describe('useListItemEditing — derived lists', () => {
  it('splits the rows into active and completed, and offers distinct completed texts as suggestions', async () => {
    const { result } = await mountWith([
      item('a', { text: 'Milk', completed: true }),
      item('b', { text: 'Bread' }),
      item('c', { text: 'milk', completed: true }),
      item('d', { text: '   ', completed: true }),
    ]);

    const { uncheckedItems, checkedItems, completedItemTexts, itemIndexMap } = result.current.editing;
    expect(ids(uncheckedItems)).toEqual(['b']);
    expect(ids(checkedItems)).toEqual(['a', 'c', 'd']);
    // Case-insensitively deduplicated, and blank rows are not suggestions.
    expect(completedItemTexts).toEqual(['Milk']);
    expect(itemIndexMap.get('c')).toBe(2);
  });
});
