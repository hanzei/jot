import { useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import type { TFunction } from 'i18next';
import { createCompletedWriteTracker } from '@jot/shared';
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
  const [completedWrites] = useState(createCompletedWriteTracker);
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
    // The refresh guard lives in useNoteEditorSync; the screen tests cover it.
    withItemWriteInFlight: (op) => op(),
    completedWrites,
    scrollViewRef,
    openAssigneePicker,
    confirm: mockConfirm,
    showToast: mockShowToast,
    t,
  });
  return { doc, editing, savedItemsRef, savedOrderRef, completedWrites, scrollViewRef };
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

  it('un-completes the checked parent of a restored child, as unchecking it would', async () => {
    const { result } = await mountWith([
      item('typing', { text: 'soc' }),
      item('packing', { completed: true }),
      item('socks', { text: 'Socks', parentId: 'packing', completed: true }),
      item('shirts', { parentId: 'packing', completed: true }),
    ]);

    await act(async () => { result.current.editing.handleAcceptSuggestion('typing', 'Socks'); });

    const byId = new Map(result.current.doc.items.map((it) => [it.id, it]));
    expect(byId.get('socks')!.completed).toBe(false);
    expect(byId.get('packing')!.completed).toBe(false);
    expect(byId.get('shirts')!.completed).toBe(true);
  });

  it('unchecks through the toggle endpoint and advances the baseline before saving', async () => {
    const { result } = await mountWith([
      item('typing', { text: 'soc' }),
      item('packing', { completed: true }),
      item('socks', { text: 'Socks', parentId: 'packing', completed: true }),
      item('shirts', { parentId: 'packing', completed: true }),
    ]);
    mockToggleItemCompleted.mockResolvedValue([
      { id: 'packing', completed: false },
      { id: 'socks', completed: false },
      { id: 'shirts', completed: true },
    ]);

    await act(async () => { result.current.editing.handleAcceptSuggestion('typing', 'Socks'); });

    expect(mockToggleItemCompleted).toHaveBeenCalledWith({ noteId: 'note-1', itemId: 'socks', completed: false });
    // The cascaded parent is already in the baseline, so the save that follows
    // does not PATCH it unchecked — which the server would cascade to "shirts".
    const baseline = result.current.savedItemsRef.current;
    expect(baseline.get('packing')!.completed).toBe(false);
    expect(baseline.get('socks')!.completed).toBe(false);
    expect(markDirty).toHaveBeenCalled();
    expect(mockToggleItemCompleted.mock.invocationCallOrder[0]!)
      .toBeLessThan(markDirty.mock.invocationCallOrder[0]!);
  });

  it('puts the typed row back when the uncheck request fails', async () => {
    const { result } = await mountWith([
      item('a'),
      item('typing', { text: 'mil' }),
      item('milk', { text: 'Milk', completed: true }),
    ]);
    mockToggleItemCompleted.mockRejectedValue(new Error('server down'));

    await act(async () => { result.current.editing.handleAcceptSuggestion('typing', 'Milk'); });

    const items = result.current.doc.items;
    expect(ids(items)).toEqual(['a', 'typing', 'milk']);
    expect(items[1]!.text).toBe('mil');
    expect(items[2]!.completed).toBe(true);
    expect(setSaveError).toHaveBeenCalledWith('note.failedSaveChanges');
    expect(result.current.completedWrites.claimed().size).toBe(0);
  });

  it('settles a restored child back under its parent rather than at the typed row', async () => {
    const { result } = await mountWith([
      item('produce'),
      item('apples', { parentId: 'produce' }),
      item('bread'),
      item('typing', { text: 'ban' }),
      item('bananas', { text: 'Bananas', parentId: 'produce', completed: true }),
    ]);

    await act(async () => { result.current.editing.handleAcceptSuggestion('typing', 'Bananas'); });

    const items = result.current.doc.items;
    // Typed below "bread", but a child must stay contiguous with its group.
    expect(ids(items)).toEqual(['produce', 'apples', 'bananas', 'bread']);
    expect(items.map((it) => it.position)).toEqual([0, 1, 2, 3]);
    expect(items[2]!.parentId).toBe('produce');
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

  it('claims the flags it changes, so the save diff leaves them, until the response is reconciled', async () => {
    const { result } = await mountWith(cascadeItems());
    let resolveToggle!: (items: { id: string; completed: boolean }[]) => void;
    mockToggleItemCompleted.mockReturnValue(new Promise((resolve) => { resolveToggle = resolve; }));

    await act(async () => { result.current.editing.listItemHandlers.onToggle('parent', true); });

    expect([...result.current.completedWrites.claimed()].sort()).toEqual(['child', 'parent']);

    await act(async () => { resolveToggle([{ id: 'parent', completed: true }, { id: 'child', completed: true }]); });
    expect(result.current.completedWrites.claimed().size).toBe(0);
  });

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

describe('useListItemEditing — dragging a parent', () => {
  // A parent and its children move as one group: pressing a parent's handle
  // draws its children inside its row (groupedParentId), and the drop moves the
  // parent with normalizeItemOrder re-seating the children right under it.
  const groups = () => [
    item('a'),
    item('a1', { parentId: 'a' }),
    item('a2', { parentId: 'a' }),
    item('b'),
    item('c'),
  ];
  type View = Awaited<ReturnType<typeof mountWith>>;
  const editing = (view: View) => view.result.current.editing;

  // Ungrouping resumes the reflow animation on the next frame; keep that frame
  // from firing outside act() after a test ends.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function grab(view: View, id: string, index: number) {
    await act(async () => {
      editing(view).holdGroupForDrag(id);
      editing(view).markGroupDragStarted(id);
      editing(view).handleListDragStart({ index });
    });
  }

  it('groups a parent with its children from the moment its handle is pressed', async () => {
    const view = await mountWith(groups());
    await act(async () => {
      editing(view).holdGroupForDrag('a');
    });
    expect(editing(view).groupedParentId).toBe('a');
    // The list's data and indices are untouched.
    expect(ids(editing(view).uncheckedItems)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
  });

  it('ungroups when the press ends without a drag', async () => {
    const view = await mountWith(groups());
    await act(async () => {
      editing(view).holdGroupForDrag('a');
    });
    await act(async () => {
      editing(view).releaseGroupHold('a');
    });
    expect(editing(view).groupedParentId).toBeNull();
  });

  it('keeps the group while dragging even if the press ends', async () => {
    const view = await mountWith(groups());
    await grab(view, 'a', 0);
    await act(async () => {
      editing(view).releaseGroupHold('a');
    });
    expect(editing(view).groupedParentId).toBe('a');
  });

  it('does not group a row without children', async () => {
    const view = await mountWith(groups());
    await act(async () => {
      editing(view).holdGroupForDrag('b');
    });
    expect(editing(view).groupedParentId).toBeNull();
  });

  it('moves the children with the parent when it is dropped lower', async () => {
    const view = await mountWith(groups());
    await grab(view, 'a', 0);
    // Drop a after b: from 0 to 3, the slot b occupies.
    await act(async () => {
      editing(view).handleListReorder({ from: 0, to: 3 });
    });
    expect(ids(view.result.current.doc.items)).toEqual(['b', 'a', 'a1', 'a2', 'c']);
    expect(editing(view).groupedParentId).toBeNull();
    expect(markDirty).toHaveBeenCalled();
  });

  it('moves the children with the parent when it is dropped higher', async () => {
    const view = await mountWith([item('b'), item('a'), item('a1', { parentId: 'a' }), item('c')]);
    await grab(view, 'a', 1);
    await act(async () => {
      editing(view).handleListReorder({ from: 1, to: 0 });
    });
    expect(ids(view.result.current.doc.items)).toEqual(['a', 'a1', 'b', 'c']);
  });

  it('leaves the list as it was when the group is dropped onto its own children', async () => {
    const view = await mountWith(groups());
    markDirty.mockClear();
    await grab(view, 'a', 0);
    // The children's cells are empty while grouped, so slot 2 is still in place.
    await act(async () => {
      editing(view).handleListReorder({ from: 0, to: 2 });
    });
    expect(ids(view.result.current.doc.items)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("keeps a new hold when the previous group's drop lands after it", async () => {
    const view = await mountWith([...groups(), item('c1', { parentId: 'c' })]);
    await grab(view, 'a', 0);
    // The finger lifts and presses c's handle before a's drop animation ends.
    await act(async () => {
      editing(view).holdGroupForDrag('c');
    });
    await act(async () => {
      editing(view).handleListReorder({ from: 0, to: 3 });
    });
    expect(editing(view).groupedParentId).toBe('c');
  });

  it('ungroups when the parent is released in place or the drop is discarded', async () => {
    const view = await mountWith(groups());
    markDirty.mockClear();
    await grab(view, 'a', 0);
    await act(async () => {
      editing(view).handleListDragEnd({ from: 0, to: 0 });
    });
    expect(editing(view).groupedParentId).toBeNull();

    await grab(view, 'a', 0);
    await act(async () => {
      editing(view).handleListReorder({ from: 0, to: 9 });
    });
    expect(editing(view).groupedParentId).toBeNull();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('releases the hold when the long-press never turns into a drag', async () => {
    const view = await mountWith(groups());
    await act(async () => {
      editing(view).holdGroupForDrag('a');
      editing(view).markGroupDragStarted('a');
    });
    // The finger lifting no longer releases it — a drag is assumed to be on.
    await act(async () => {
      editing(view).releaseGroupHold('a');
    });
    expect(editing(view).groupedParentId).toBe('a');
    // No onDragStart arrives (the library ignored drag()): the watchdog fires.
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(editing(view).groupedParentId).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(editing(view).groupReflowPaused).toBe(false);
  });

  it('keeps the hold once the drag start is confirmed', async () => {
    const view = await mountWith(groups());
    await grab(view, 'a', 0);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(editing(view).groupedParentId).toBe('a');
  });

  it('re-arms focus on a focused child as it moves into and out of the group', async () => {
    const view = await mountWith(groups());
    editing(view).focusedItemIdRef.current = 'a1';
    await act(async () => {
      editing(view).holdGroupForDrag('a');
    });
    expect(editing(view).autoFocusItemIdRef.current).toBe('a1');
    editing(view).autoFocusItemIdRef.current = null;
    await act(async () => {
      editing(view).releaseGroupHold('a');
    });
    expect(editing(view).autoFocusItemIdRef.current).toBe('a1');
  });
});

describe('useListItemEditing — indent buttons', () => {
  const focus = (result: { current: ReturnType<typeof useHarness> }, id: string) => {
    result.current.editing.focusedItemIdRef.current = id;
  };

  it('indents the focused row under the row above and saves', async () => {
    const { result } = await mountWith([item('a'), item('b')]);
    focus(result, 'b');

    await act(async () => { result.current.editing.handleIndentFocusedItem(1); });

    expect(result.current.doc.items.map((it) => [it.id, it.parentId])).toEqual([['a', null], ['b', 'a']]);
    expect(markDirty).toHaveBeenCalled();
  });

  it('outdents a nested row back to top-level', async () => {
    const { result } = await mountWith([item('a'), item('b', { parentId: 'a' })]);
    focus(result, 'b');

    await act(async () => { result.current.editing.handleIndentFocusedItem(-1); });

    expect(result.current.doc.items.map((it) => it.parentId)).toEqual([null, null]);
  });

  it('does nothing when no row is focused or the move is not allowed', async () => {
    const { result } = await mountWith([item('a'), item('b')]);

    await act(async () => { result.current.editing.handleIndentFocusedItem(1); });
    focus(result, 'a'); // first row: nothing above to nest under
    await act(async () => { result.current.editing.handleIndentFocusedItem(1); });

    expect(result.current.doc.items.map((it) => it.parentId)).toEqual([null, null]);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('still acts on the row the buttons were enabled for after its blur clears the ref', async () => {
    const { result } = await mountWith([item('a'), item('b')]);
    // Focus sets both the ref and the state the buttons follow...
    await act(async () => {
      result.current.editing.listItemHandlers.onFocus('b');
    });
    // ...and a blur nulls the ref at once, while the state holds the id through
    // the settle window.
    result.current.editing.focusedItemIdRef.current = null;
    expect(result.current.editing.focusedItemId).toBe('b');

    await act(async () => { result.current.editing.handleIndentFocusedItem(1); });

    expect(result.current.doc.items.map((it) => [it.id, it.parentId])).toEqual([['a', null], ['b', 'a']]);
  });
});

describe('useListItemEditing — keeping the focused row in view', () => {
  type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

  /**
   * Mounts rows `a` and `p` under a scroll view whose window frame starts at
   * y 160 (under the header) and is `height` tall; rows are 40 tall. `resize`
   * changes the height and fires the scroll view's onLayout, as the keyboard,
   * the formatting bar or a banner would.
   */
  async function setup(height: number, { laidOut = true } = {}) {
    const view = await mountWith([item('a'), item('p')]);
    const { result } = view;
    const frame = { top: 160, height };
    const scrollTo = jest.fn();
    (result.current.scrollViewRef as { current: unknown }).current = {
      measureInWindow: (cb: MeasureCallback) => cb(0, frame.top, 400, frame.height),
      scrollTo,
    };
    const props = () => result.current.editing.editorScrollProps;
    const layOut = async () => {
      await act(async () => {
        props().onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: frame.height } } } as LayoutChangeEvent);
      });
    };
    if (laidOut) await layOut();
    return {
      result,
      scrollTo,
      resize: async (next: number) => { frame.height = next; await layOut(); },
      scrollToOffset: async (y: number) => {
        await act(async () => {
          (props().onScroll as unknown as (e: NativeSyntheticEvent<NativeScrollEvent>) => void)(
            { nativeEvent: { contentOffset: { x: 0, y } } } as NativeSyntheticEvent<NativeScrollEvent>,
          );
        });
      },
      contentChanged: async () => { await act(async () => { props().onContentSizeChange(); }); },
      focus: async (id: string) => { await act(async () => { result.current.editing.listItemHandlers.onFocus(id); }); },
      placeRow: (id: string, top: number, { focused = true, rowHeight = 40 } = {}) => {
        (result.current.editing.getItemRef(id) as { current: unknown }).current = {
          measureInWindow: (cb: MeasureCallback) => cb(0, top, 300, rowHeight),
          isFocused: () => focused,
        };
      },
    };
  }

  it('leaves the list where it is when the tapped row is already visible', async () => {
    const { scrollTo, scrollToOffset, placeRow, focus } = await setup(360);
    await scrollToOffset(500);
    placeRow('p', 440); // bottom at 480, inside the 520 viewport edge

    await focus('p');

    // RN's keyboard helper scrolled here anyway — and too far, hiding the row
    // under the formatting bar.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls a row hidden below the viewport up just far enough to show it', async () => {
    const { scrollTo, scrollToOffset, placeRow, focus } = await setup(360);
    await scrollToOffset(500);
    placeRow('p', 600); // bottom at 640; visible band ends at 520 - 24

    await focus('p');

    expect(scrollTo).toHaveBeenCalledWith({ y: 500 + (640 - 496), animated: true });
  });

  it('re-reveals the focused row when the keyboard covers it after focus', async () => {
    const { scrollTo, scrollToOffset, placeRow, focus, resize } = await setup(700);
    // Set before the focus, so it must survive the re-render the focus causes.
    await scrollToOffset(300);
    placeRow('p', 600);
    await focus('p');
    expect(scrollTo).not.toHaveBeenCalled();

    await resize(360);

    expect(scrollTo).toHaveBeenCalledWith({ y: 300 + (640 - 496), animated: true });
  });

  it('leaves a focused row the user scrolled far away from when a banner resizes the view', async () => {
    const { scrollTo, placeRow, focus, resize } = await setup(360);
    placeRow('p', 440);
    await focus('p');

    placeRow('p', 1400); // scrolled far up; the row is well below the viewport
    await resize(320);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not treat the first layout as a resize', async () => {
    const { scrollTo, placeRow, focus, resize } = await setup(360, { laidOut: false });
    placeRow('p', 500); // covered by the bar
    await focus('p');
    scrollTo.mockClear();

    await resize(360);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing on a resize when no row is focused', async () => {
    const { scrollTo, placeRow, resize } = await setup(700);
    placeRow('a', 600);

    await resize(100);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('ignores a focused id whose row no longer holds the caret', async () => {
    const { scrollTo, placeRow, focus, resize, contentChanged } = await setup(700);
    placeRow('p', 600);
    await focus('p');

    // The row was checked off while focused: its input unmounted without a
    // blur, and the copy in the completed section never took the caret.
    placeRow('p', 600, { focused: false });
    await resize(360);
    await contentChanged();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows the focused row as it grows under the bar', async () => {
    const { scrollTo, placeRow, focus, contentChanged } = await setup(360);
    placeRow('p', 440);
    await focus('p');

    placeRow('p', 440, { rowHeight: 80 }); // bottom at 520, past the 496 band
    await contentChanged();

    expect(scrollTo).toHaveBeenCalledWith({ y: 520 - 496, animated: true });
  });

  it('does not pull the user back to a focused row they scrolled away from when the content grows', async () => {
    const { scrollTo, placeRow, focus, contentChanged } = await setup(360);
    placeRow('p', 440);
    await focus('p');

    placeRow('p', -200); // scrolled down past the row, then expanded the completed section
    await contentChanged();

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
