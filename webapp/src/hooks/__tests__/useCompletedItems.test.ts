import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Note, NoteItem } from '@jot/shared';
import { useCompletedItems, COMPLETED_DELETE_UNDO_MS, type CompletedItemsBaseline } from '../useCompletedItems';
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
  assignedTo: '',
  ...overrides,
});

interface HarnessOptions {
  note?: Note | null;
  initialItems: ListItem[];
  onRefresh?: () => void;
  showError?: (message: string) => void;
}

// Minimal stand-in for the slice of useNoteDraft that useCompletedItems
// depends on — a live item model plus the two baseline mutations the bulk
// actions advance. Exercises useCompletedItems in isolation from the rest of
// the autosave engine.
const useHarness = ({ note, initialItems, onRefresh, showError = vi.fn() }: HarnessOptions) => {
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

  const completedItems = useCompletedItems({
    note,
    itemsRef,
    commitItems,
    baseline,
    cancelPendingSave: useCallback(() => {}, []),
    markDirty: useCallback(() => {}, []),
    flashSaved: useCallback(() => {}, []),
    showError,
    onRefresh,
  });

  return { items, ...completedItems };
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

    it('clears the uncheck-undo bar, which is note-specific', () => {
      const note = noteWithCheckedItems();
      const { result } = renderHook(() => useHarness({ note, initialItems: activeAndDoneItems() }));

      act(() => {
        void result.current.handleUncheckAllItems();
      });

      act(() => {
        result.current.resetForNoteSwitch();
      });

      expect(result.current.recentlyUnchecked).toBeNull();
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
