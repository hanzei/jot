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

describe('useListItemEditing — toggling a row completed', () => {
  // A parent and its child, plus an unrelated row that must never be touched by
  // the cascade or by the baseline bookkeeping around it.
  const cascadeItems = () => [
    item('parent'),
    item('child', { parentId: 'parent' }),
    item('other'),
  ];

  it('reconciles from the server response and advances the baseline for the rows it returned', async () => {
    const { result } = await mountWith(cascadeItems());
    mockToggleItemCompleted.mockResolvedValue([
      { id: 'parent', completed: true },
      { id: 'child', completed: true },
    ]);

    await act(async () => { result.current.editing.listItemHandlers.onToggle('parent', true); });

    const byId = new Map(result.current.doc.items.map((it) => [it.id, it]));
    expect(byId.get('parent')!.completed).toBe(true);
    expect(byId.get('child')!.completed).toBe(true);
    expect(byId.get('other')!.completed).toBe(false);

    // Baseline advanced only for the rows the server reported, so the diff
    // engine does not re-patch `completed` on the next save.
    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('parent')!.completed).toBe(true);
    expect(baseline.get('child')!.completed).toBe(true);
    expect(baseline.get('other')!.completed).toBe(false);
  });

  it('advances the baseline for the cascade itself when the write went offline', async () => {
    const { result } = await mountWith(cascadeItems());
    // An empty response is the offline path: the cascade was applied to the
    // local DB, so there is nothing to reconcile but the baseline still moves.
    mockToggleItemCompleted.mockResolvedValue([]);

    await act(async () => { result.current.editing.listItemHandlers.onToggle('parent', true); });

    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('parent')!.completed).toBe(true);
    expect(baseline.get('child')!.completed).toBe(true);
    expect(baseline.get('other')!.completed).toBe(false);
  });

  it('reverts only the cascade, and leaves the baseline untouched, when the write is rejected', async () => {
    // `other` starts completed: a revert that blanket-clears every row rather
    // than restoring the prior state of just the cascade would lose it.
    const { result } = await mountWith([
      item('parent'),
      item('child', { parentId: 'parent' }),
      item('other', { completed: true }),
    ]);
    mockToggleItemCompleted.mockRejectedValue(new Error('rejected'));

    await act(async () => { result.current.editing.listItemHandlers.onToggle('parent', true); });

    const byId = new Map(result.current.doc.items.map((it) => [it.id, it]));
    expect(byId.get('parent')!.completed).toBe(false);
    expect(byId.get('child')!.completed).toBe(false);
    expect(byId.get('other')!.completed).toBe(true);

    // Nothing was recorded as saved — the next save must still carry the real state.
    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('parent')!.completed).toBe(false);
    expect(baseline.get('child')!.completed).toBe(false);
    expect(setSaveError).toHaveBeenCalledWith('note.failedSaveChanges');
  });

  it('ignores a toggle that would not change the row', async () => {
    const { result } = await mountWith([item('a', { completed: true })]);

    await act(async () => { result.current.editing.listItemHandlers.onToggle('a', true); });

    expect(mockToggleItemCompleted).not.toHaveBeenCalled();
  });
});

describe('useListItemEditing — unchecking every completed row', () => {
  const mixedItems = () => [
    item('a', { completed: true }),
    item('b'),
    item('c', { completed: true }),
  ];

  it('clears them optimistically and advances the baseline from the server response', async () => {
    const { result } = await mountWith(mixedItems());
    mockUncheckAllItems.mockResolvedValue([
      { id: 'a', completed: false },
      { id: 'c', completed: false },
    ]);

    await act(async () => { await result.current.editing.handleUncheckAllItems(); });

    expect(mockUncheckAllItems).toHaveBeenCalledWith({ noteId: 'note-1', itemIds: ['a', 'c'] });
    expect(result.current.doc.items.every((it) => !it.completed)).toBe(true);
    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('a')!.completed).toBe(false);
    expect(baseline.get('c')!.completed).toBe(false);
  });

  it('advances the baseline for the unchecked rows when the write went offline', async () => {
    const { result } = await mountWith(mixedItems());
    mockUncheckAllItems.mockResolvedValue([]);

    await act(async () => { await result.current.editing.handleUncheckAllItems(); });

    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('a')!.completed).toBe(false);
    expect(baseline.get('c')!.completed).toBe(false);
  });

  it('puts the rows back when the write is rejected', async () => {
    const { result } = await mountWith(mixedItems());
    mockUncheckAllItems.mockRejectedValue(new Error('rejected'));

    await act(async () => { await result.current.editing.handleUncheckAllItems(); });

    const byId = new Map(result.current.doc.items.map((it) => [it.id, it]));
    expect(byId.get('a')!.completed).toBe(true);
    expect(byId.get('c')!.completed).toBe(true);
    expect(byId.get('b')!.completed).toBe(false);
    expect(setSaveError).toHaveBeenCalledWith('note.failedSaveChanges');
  });

  it('does nothing when no row is completed', async () => {
    const { result } = await mountWith([item('a'), item('b')]);

    await act(async () => { await result.current.editing.handleUncheckAllItems(); });

    expect(mockUncheckAllItems).not.toHaveBeenCalled();
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
