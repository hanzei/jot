import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { createCompletedWriteTracker, type Note, type NoteItem } from '@jot/shared';
import { useCompletedItems, COMPLETED_DELETE_UNDO_MS, COMPLETED_REFRESH_SETTLE_MS, type CompletedItemsBaseline } from '../useCompletedItems';
import type { ListItem } from '@/utils/noteItems';
import { notes } from '@/utils/api';
import { createMockNote } from '@/utils/__tests__/test-helpers';

vi.mock('@/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@/utils/api')>('@/utils/api');
  return {
    ...actual,
    notes: {
      ...actual.notes,
      setItemsCompleted: vi.fn(),
      deleteItems: vi.fn(),
    },
  };
});

const listItem = (id: string, overrides: Partial<ListItem> = {}): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

interface HarnessOptions {
  note?: Note | null;
  initialItems: ListItem[];
  onRefresh?: () => void;
  showError?: (message: string) => void;
  waitForSavedItems?: () => Promise<void>;
  cancelPendingSave?: () => boolean;
  scheduleAutoSave?: () => void;
}

// Minimal stand-in for the slice of useNoteDraft that useCompletedItems
// depends on — a live item model plus the two baseline mutations the bulk
// actions advance. Exercises useCompletedItems in isolation from the rest of
// the autosave engine.
const resolvedWait = () => Promise.resolve();

const noPendingSave = () => false;
const noop = () => {};

const useHarness = ({
  note = null, initialItems, onRefresh, showError = vi.fn(), waitForSavedItems = resolvedWait,
  cancelPendingSave = noPendingSave, scheduleAutoSave = noop,
}: HarnessOptions) => {
  const [items, setItems] = useState<ListItem[]>(initialItems);
  const itemsRef = useRef<ListItem[]>(initialItems);
  const commitItems = useCallback((next: ListItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const savedItemsRef = useRef(new Map(initialItems.map(it => [it.id, it])));
  const savedOrderRef = useRef(initialItems.map(it => it.id));

  const baseline = useMemo<CompletedItemsBaseline>(() => ({
    syncCompleted: (completedById) => {
      for (const [id, comp] of completedById) {
        const snap = savedItemsRef.current.get(id);
        if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
      }
    },
    applyBulkDeletion: (deletedIds, remainingItems) => {
      for (const id of deletedIds) savedItemsRef.current.delete(id);
      for (const item of remainingItems) {
        const snap = savedItemsRef.current.get(item.id);
        if (snap) savedItemsRef.current.set(item.id, { ...snap, parentId: item.parentId, completed: item.completed });
      }
      savedOrderRef.current = savedOrderRef.current.filter(id => !deletedIds.has(id));
    },
  }), []);

  const [completedWrites] = useState(createCompletedWriteTracker);
  const completedItems = useCompletedItems({
    note,
    itemsRef,
    commitItems,
    baseline,
    completedWrites,
    cancelPendingSave,
    scheduleAutoSave,
    waitForSavedItems,
    markDirty: useCallback(() => {}, []),
    flashSaved: useCallback(() => {}, []),
    showError,
    onRefresh,
  });

  return { items, completedWrites, ...completedItems };
};

const noteWithCheckedItems = () => createMockNote({
  note_type: 'list',
  items: [
    { id: 'a', note_id: '1', text: 'Active', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z' },
    { id: 'c1', note_id: '1', text: 'Done one', completed: true, position: 1, parent_id: null, assigned_to: '', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z' },
    { id: 'c2', note_id: '1', text: 'Done two', completed: true, position: 2, parent_id: null, assigned_to: '', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z' },
  ],
});

const activeAndDoneItems = () => [
  listItem('a', { text: 'Active' }),
  listItem('c1', { text: 'Done one', completed: true }),
  listItem('c2', { text: 'Done two', completed: true }),
];

describe('useCompletedItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notes.setItemsCompleted).mockImplementation((_noteId, ids: string[], completed: boolean) =>
      Promise.resolve(ids.map(id => ({ id, completed, note_id: '1', text: id, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' }))));
    vi.mocked(notes.deleteItems).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handleUncheckAllItems', () => {
    it('unchecks every completed item and shows an undo bar on success', async () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });

      expect(notes.setItemsCompleted).toHaveBeenCalledWith('1', ['c1', 'c2'], false);
      expect(result.current.items.filter(i => i.completed)).toHaveLength(0);
      expect(result.current.recentlyUnchecked).toEqual({ noteId: '1', ids: ['c1', 'c2'], count: 2 });
    });

    it('does nothing when there are no completed items', async () => {
      const note = createMockNote({ note_type: 'list', items: [] });
      const { result } = renderHook(() => useHarness({ note, initialItems: [listItem('a')] }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });

      expect(notes.setItemsCompleted).not.toHaveBeenCalled();
    });

    it('rolls back and offers no undo when the request fails', async () => {
      vi.mocked(notes.setItemsCompleted).mockRejectedValueOnce(new Error('network error'));
      const showError = vi.fn();
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems(), showError }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });

      // Rolled back to checked — nothing to undo, since offering it would
      // invite re-checking what is already checked.
      expect(result.current.items.filter(i => i.completed)).toHaveLength(2);
      expect(result.current.recentlyUnchecked).toBeNull();
      expect(showError).toHaveBeenCalled();
    });

    it('undo re-checks the same snapshot', async () => {
      vi.useFakeTimers();
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });
      vi.mocked(notes.setItemsCompleted).mockClear();

      await act(async () => {
        result.current.undoUncheckAll();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(notes.setItemsCompleted).toHaveBeenCalledWith('1', ['c1', 'c2'], true);
      expect(result.current.items.filter(i => i.completed)).toHaveLength(2);
      expect(result.current.recentlyUnchecked).toBeNull();
    });

    it('auto-dismisses the undo bar once the undo window elapses', async () => {
      vi.useFakeTimers();
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });
      expect(result.current.recentlyUnchecked).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });

      expect(result.current.recentlyUnchecked).toBeNull();
    });
  });

  describe('handleDeleteCompletedItems', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('hides completed items immediately without deleting them right away', () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });

      expect(result.current.hiddenCompletedItemIds).toEqual(new Set(['c1', 'c2']));
      expect(notes.deleteItems).not.toHaveBeenCalled();
    });

    it('fires the bulk delete once the undo window elapses without an undo', async () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });

      expect(notes.deleteItems).toHaveBeenCalledWith('1', ['c1', 'c2']);
      expect(result.current.items.map(i => i.id)).toEqual(['a']);
    });

    it('undo cancels the deferred delete and restores visibility', async () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      act(() => {
        result.current.handleDeleteCompletedItems();
        result.current.undoDeleteCompletedItems();
      });

      expect(result.current.hiddenCompletedItemIds.size).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });
      expect(notes.deleteItems).not.toHaveBeenCalled();
    });

    it('un-hides the items and reports an error when the deferred delete fails', async () => {
      vi.mocked(notes.deleteItems).mockRejectedValueOnce(new Error('network error'));
      const showError = vi.fn();
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems(), showError }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });

      expect(result.current.hiddenCompletedItemIds.size).toBe(0);
      expect(showError).toHaveBeenCalled();
    });

    it('calls onRefresh only once the deferred delete lands', async () => {
      let resolveDelete: (value: NoteItem[]) => void = () => {};
      vi.mocked(notes.deleteItems).mockImplementationOnce(() => new Promise((resolve) => { resolveDelete = resolve; }));
      const onRefresh = vi.fn();
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems(), onRefresh }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        resolveDelete([]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onRefresh).toHaveBeenCalled();
    });

    it('merges the server-reported parent/completed state for re-homed survivors', async () => {
      const note = createMockNote({
        note_type: 'list',
        items: [
          { id: 'p', note_id: '1', text: 'Parent', completed: true, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
          { id: 'child', note_id: '1', text: 'Child', completed: false, position: 1, parent_id: 'p', assigned_to: '', created_at: '', updated_at: '' },
        ],
      });
      vi.mocked(notes.deleteItems).mockResolvedValue([
        { id: 'child', note_id: '1', text: 'Child', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
      ]);
      const { result } = renderHook(() => useHarness({
        note,
        initialItems: [listItem('p', { text: 'Parent', completed: true }), listItem('child', { text: 'Child', parentId: 'p' })],
      }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS);
      });

      const child = result.current.items.find(i => i.id === 'child');
      expect(child?.parentId).toBeNull();
    });
  });

  describe('resetForNoteSwitch', () => {
    it('carries over a still-pending completed-item deletion for the incoming note', () => {
      vi.useFakeTimers();
      const note = noteWithCheckedItems();
      const { result, rerender } = renderHook(
        (props: { note: Note }) => useHarness({ note: props.note, initialItems: activeAndDoneItems() }),
        { initialProps: { note } },
      );

      act(() => {
        result.current.handleDeleteCompletedItems();
      });
      expect(result.current.hiddenCompletedItemIds.size).toBe(2);

      // Switching notes and back re-derives the hidden set from whichever
      // incoming items are still mid-window, rather than clearing it.
      rerender({ note });
      act(() => {
        result.current.resetForNoteSwitch();
      });

      expect(result.current.hiddenCompletedItemIds).toEqual(new Set(['c1', 'c2']));
    });

    it('clears the uncheck-undo bar, which is note-specific', async () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      await act(async () => {
        await result.current.handleUncheckAllItems();
      });
      expect(result.current.recentlyUnchecked).not.toBeNull();

      act(() => {
        result.current.resetForNoteSwitch();
      });

      expect(result.current.recentlyUnchecked).toBeNull();
    });
  });

  describe('writeCompleted', () => {
    // The server cascades over the children it has, so a re-parent still in
    // the autosave loop must land before the write is sent.
    it('claims the flags, then holds the request until the queued save has landed', async () => {
      let releaseSave: () => void = () => {};
      const saved = new Promise<void>((resolve) => { releaseSave = resolve; });
      const waitForSavedItems = () => saved;
      const { result } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), waitForSavedItems }));

      let done: Promise<boolean> = Promise.resolve(false);
      act(() => {
        done = result.current.writeCompleted(new Map([['a', false]]), id => notes.setItemsCompleted(id, ['a'], true));
      });
      await act(async () => {});

      expect(notes.setItemsCompleted).not.toHaveBeenCalled();
      // Claimed while waiting, so the save pass waited on leaves the flag alone.
      expect(result.current.completedWrites.claimed().has('a')).toBe(true);

      await act(async () => {
        releaseSave();
        await done;
      });
      expect(notes.setItemsCompleted).toHaveBeenCalledWith('1', ['a'], true);
      expect(result.current.completedWrites.claimed().has('a')).toBe(false);
    });

    // Text typed just before a tick has a debounced save pending. The write
    // holds it back until it settles, then re-arms it rather than dropping it.
    it.each([
      ['succeeds', () => Promise.resolve([] as NoteItem[])],
      ['fails', () => Promise.reject(new Error('offline'))],
    ])('re-arms a debounced save it held back once the write %s', async (_label, request) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const scheduleAutoSave = vi.fn();
      let settled = false;
      const { result } = renderHook(() => useHarness({
        note: noteWithCheckedItems(),
        initialItems: activeAndDoneItems(),
        cancelPendingSave: () => true,
        scheduleAutoSave,
      }));

      await act(async () => {
        const done = result.current.writeCompleted(new Map([['a', false]]), () => request());
        expect(scheduleAutoSave).not.toHaveBeenCalled();
        await done;
        settled = true;
      });

      expect(settled).toBe(true);
      expect(scheduleAutoSave).toHaveBeenCalledTimes(1);
    });

    it('does not schedule a save when none was pending', async () => {
      const scheduleAutoSave = vi.fn();
      const { result } = renderHook(() => useHarness({
        note: noteWithCheckedItems(),
        initialItems: activeAndDoneItems(),
        scheduleAutoSave,
      }));

      await act(async () => {
        await result.current.writeCompleted(new Map([['a', false]]), () => Promise.resolve([]));
      });

      expect(scheduleAutoSave).not.toHaveBeenCalled();
    });
  });

  // Every refresh reloads the whole dashboard, so a burst of completed writes
  // owes one refresh once it settles rather than one per write (#1147).
  describe('refresh coalescing', () => {
    const serverItem = (id: string, completed: boolean): NoteItem =>
      ({ id, completed, note_id: '1', text: id, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' });

    // A completed write whose response the test releases.
    const heldWrite = () => {
      let release: () => void = () => {};
      const response = new Promise<NoteItem[]>((resolve) => { release = () => resolve([serverItem('a', true)]); });
      return { request: () => response, release };
    };

    const write = (result: { current: ReturnType<typeof useHarness> }, request: () => Promise<NoteItem[]>) => {
      let done: Promise<boolean> = Promise.resolve(true);
      act(() => {
        done = result.current.writeCompleted(new Map([['a', false]]), request);
      });
      return done;
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('refreshes once after a burst of overlapping writes settles', async () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      const writes = [heldWrite(), heldWrite(), heldWrite()];
      const done = writes.map(w => write(result, w.request));
      // Nothing refreshes while any write of the burst is still in flight.
      for (const w of writes.slice(0, -1)) {
        await act(async () => {
          w.release();
          await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
        });
      }
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        writes[writes.length - 1]!.release();
        await Promise.all(done);
      });
      // The last write settled just now; the refresh waits out the delay.
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('refreshes once for writes spaced closer than the settle delay', async () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await write(result, () => Promise.resolve([serverItem('a', true)]));
          await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS - 1);
        });
      }
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not refresh after a write that failed', async () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      await act(async () => {
        await write(result, () => Promise.reject(new Error('boom')));
        await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
      });
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('runs an owed refresh straight away when the modal closes', async () => {
      const onRefresh = vi.fn();
      const { result, unmount } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      await act(async () => {
        await write(result, () => Promise.resolve([serverItem('a', true)]));
      });
      unmount();
      expect(onRefresh).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('refreshes as soon as a write still in flight at close settles', async () => {
      const onRefresh = vi.fn();
      const { result, unmount } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      const held = heldWrite();
      const done = write(result, held.request);
      unmount();
      expect(onRefresh).not.toHaveBeenCalled();

      held.release();
      await done;
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    // Closing flushes the deferred delete while a write may still be in flight;
    // whichever lands last runs the one refresh, never one mid-delete.
    describe.each([
      { order: 'write first', writeFirst: true },
      { order: 'delete first', writeFirst: false },
    ])('closing with a deferred delete and a write both in flight ($order)', ({ writeFirst }) => {
      it('refreshes once, after both have landed', async () => {
        let resolveDelete: (value: NoteItem[]) => void = () => {};
        vi.mocked(notes.deleteItems).mockImplementationOnce(() => new Promise((resolve) => { resolveDelete = resolve; }));
        const onRefresh = vi.fn();
        const { result, unmount } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

        act(() => {
          result.current.handleDeleteCompletedItems();
        });
        const held = heldWrite();
        const done = write(result, held.request);
        unmount();
        expect(notes.deleteItems).toHaveBeenCalledWith('1', ['c1', 'c2']);

        const landFirst = writeFirst ? () => held.release() : () => resolveDelete([]);
        const landSecond = writeFirst ? () => resolveDelete([]) : () => held.release();
        landFirst();
        await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
        expect(onRefresh).not.toHaveBeenCalled();

        landSecond();
        await done;
        await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
        expect(onRefresh).toHaveBeenCalledTimes(1);
      });
    });

    it('lets a landed deferred delete cover the refresh a write owes', async () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => useHarness({ note: noteWithCheckedItems(), initialItems: activeAndDoneItems(), onRefresh }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_DELETE_UNDO_MS - 1);
        await write(result, () => Promise.resolve([serverItem('a', true)]));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPLETED_REFRESH_SETTLE_MS);
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('unmount flush', () => {
    it('flushes a pending completed-item delete on unmount even though the timer has not elapsed', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const note = noteWithCheckedItems();
      const { result, unmount } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems(), onRefresh }));

      act(() => {
        result.current.handleDeleteCompletedItems();
      });
      onRefresh.mockClear();

      unmount();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(notes.deleteItems).toHaveBeenCalledWith('1', ['c1', 'c2']);
      expect(onRefresh).toHaveBeenCalled();
    });
  });
});
