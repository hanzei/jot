import { useRef, useState } from 'react';
import type { ScrollView } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import type { TFunction } from 'i18next';
import { useSharedValue } from 'react-native-reanimated';
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
  const scrollOffsetY = useSharedValue(0);
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
    scrollOffsetY,
    openAssigneePicker,
    confirm: mockConfirm,
    showToast: mockShowToast,
    t,
  });
  return { doc, editing, savedItemsRef, savedOrderRef, completedWrites, scrollViewRef, scrollOffsetY };
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
  type Harness = Awaited<ReturnType<typeof mountWith>>['result'];

  // The editor's scroll view sits under the header (window y 160) and ends at
  // the formatting bar above the keyboard; rows are 40 tall.
  function attachScrollView(result: Harness, frame: { top: number; height: number }) {
    const scrollTo = jest.fn();
    const scrollView = {
      measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, frame.top, 400, frame.height),
      scrollTo,
    };
    (result.current.scrollViewRef as { current: unknown }).current = scrollView;
    return scrollTo;
  }

  function placeRow(result: Harness, id: string, top: number, { focused = true, height = 40 } = {}) {
    (result.current.editing.getItemRef(id) as { current: unknown }).current = {
      measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, top, 300, height),
      isFocused: () => focused,
    };
  }

  it('leaves the list where it is when the tapped row is already visible', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const scrollTo = attachScrollView(result, { top: 160, height: 360 });
    result.current.scrollOffsetY.set(500);
    placeRow(result, 'p', 440); // bottom at 480, inside the 520 viewport edge

    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });

    // RN's keyboard helper scrolled here anyway — and too far, hiding the row
    // under the formatting bar.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls a row hidden below the viewport up just far enough to show it', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const scrollTo = attachScrollView(result, { top: 160, height: 360 });
    result.current.scrollOffsetY.set(500);
    placeRow(result, 'p', 600); // bottom at 640; visible band ends at 520 - 24

    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });

    expect(scrollTo).toHaveBeenCalledWith({ y: 500 + (640 - 496), animated: true });
  });

  it('re-reveals the focused row when the keyboard shrinks the viewport after focus', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const frame = { top: 160, height: 700 };
    const scrollTo = attachScrollView(result, frame);
    placeRow(result, 'p', 600);

    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });
    expect(scrollTo).not.toHaveBeenCalled();

    // The keyboard and formatting bar arrive; the screen's onLayout calls in.
    frame.height = 360;
    await act(async () => { result.current.editing.revealFocusedItem(); });

    expect(scrollTo).toHaveBeenCalledWith({ y: 640 - 496, animated: true });
  });

  it('does nothing on a resize when no row is focused', async () => {
    const { result } = await mountWith([item('a')]);
    const scrollTo = attachScrollView(result, { top: 160, height: 100 });
    placeRow(result, 'a', 600);

    await act(async () => { result.current.editing.revealFocusedItem(); });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('ignores a focused id whose row no longer holds the caret', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const frame = { top: 160, height: 700 };
    const scrollTo = attachScrollView(result, frame);
    placeRow(result, 'p', 600);
    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });

    // The row was checked off while focused: its input unmounted without a
    // blur, and the copy in the completed section never took the caret.
    placeRow(result, 'p', 900, { focused: false });
    frame.height = 360;
    await act(async () => { result.current.editing.revealFocusedItem(); });
    await act(async () => { result.current.editing.followFocusedItem(); });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows the focused row as it grows under the bar', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const scrollTo = attachScrollView(result, { top: 160, height: 360 });
    placeRow(result, 'p', 440);
    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });

    placeRow(result, 'p', 440, { height: 80 }); // bottom at 520, past the 496 band
    await act(async () => { result.current.editing.followFocusedItem(); });

    expect(scrollTo).toHaveBeenCalledWith({ y: 520 - 496, animated: true });
  });

  it('does not pull the user back to a focused row they scrolled away from when the content grows', async () => {
    const { result } = await mountWith([item('a'), item('p')]);
    const scrollTo = attachScrollView(result, { top: 160, height: 360 });
    placeRow(result, 'p', 440);
    await act(async () => { result.current.editing.listItemHandlers.onFocus('p'); });

    // Scrolled down past the row, then expanded the completed section.
    placeRow(result, 'p', -200);
    await act(async () => { result.current.editing.followFocusedItem(); });

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
