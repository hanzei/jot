import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { VALIDATION, type Note } from '@jot/shared';
import { useNoteDraft, type AutoSaveDraft } from '../useNoteDraft';
import type { ListItem } from '@/utils/noteItems';
import { notes } from '@/utils/api';
import { createMockNote } from '@/utils/__tests__/test-helpers';

vi.mock('@/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@/utils/api')>('@/utils/api');
  return {
    ...actual,
    notes: {
      ...actual.notes,
      update: vi.fn(),
      createItem: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
      reorderItems: vi.fn(),
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

type Draft = ReturnType<typeof useNoteDraft>;

// Mirrors NoteModal's note-adoption effect: seeds the hook's editor state and
// diff baseline from a server note, the same way opening a note does.
const adopt = (draft: Draft, note: Note, listItems: ListItem[] = []) => {
  act(() => {
    draft.setNoteType(note.note_type);
    draft.setColor(note.color);
    draft.setPinned(note.pinned);
    draft.setArchived(note.archived);
    let items: ListItem[] = [];
    let scalars: AutoSaveDraft;
    if (note.note_type === 'list') {
      draft.setTitle(note.title);
      draft.setCheckedItemsCollapsed(note.checked_items_collapsed);
      items = listItems;
      draft.commitItems(items);
      scalars = { title: note.title, content: '', pinned: note.pinned, archived: note.archived, color: note.color, checked_items_collapsed: note.checked_items_collapsed };
    } else {
      draft.setContent(note.content);
      draft.commitItems([]);
      scalars = { title: '', content: note.content, pinned: note.pinned, archived: note.archived, color: note.color, checked_items_collapsed: false };
    }
    draft.setSavedBaseline(scalars, items);
  });
};

const renderDraft = (opts: { note?: Note | null; onRefresh?: () => void; showError?: (message: string) => void } = {}) => {
  const note = opts.note ?? null;
  const onRefresh = opts.onRefresh ?? vi.fn();
  const showError = opts.showError ?? vi.fn();
  const hook = renderHook(() => useNoteDraft({ note, onRefresh, showError }));
  return { ...hook, onRefresh, showError };
};

describe('useNoteDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(notes.update).mockResolvedValue({} as Note);
    vi.mocked(notes.createItem).mockImplementation((_noteId, data) => Promise.resolve({ ...data } as never));
    vi.mocked(notes.updateItem).mockImplementation((_noteId, itemId, data) => Promise.resolve({ id: itemId, ...data } as never));
    vi.mocked(notes.deleteItem).mockResolvedValue(undefined);
    vi.mocked(notes.reorderItems).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isDirty / hasUnflushedWork', () => {
    it('is not dirty right after adopting a note', () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      expect(result.current.isDirty()).toBe(false);
      expect(result.current.hasUnflushedWork()).toBe(false);
    });

    it('becomes dirty when a scalar field changes', () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('changed'));

      expect(result.current.isDirty()).toBe(true);
    });

    it('becomes dirty when the item list changes', () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a')]);

      act(() => result.current.commitItems([listItem('a', { text: 'changed' })]));

      expect(result.current.isDirty()).toBe(true);
    });

    it('hasUnflushedWork is true while a debounced save is scheduled', () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => {
        result.current.setContent('changed');
        result.current.scheduleAutoSave();
      });

      expect(result.current.hasUnflushedWork()).toBe(true);
    });
  });

  describe('scalar autosave', () => {
    it('sends only the fields that changed since the baseline', async () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('changed'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.update).toHaveBeenCalledWith('1', { content: 'changed' });
    });

    it('does not autosave when the note has no id (brand-new note)', async () => {
      const { result } = renderDraft({ note: null });

      act(() => result.current.setContent('draft text'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.update).not.toHaveBeenCalled();
    });

    it('sends title and checked_items_collapsed (not content) for list notes', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'Old title' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setTitle('New title'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.update).toHaveBeenCalledWith('1', { title: 'New title' });
    });

    it('debounces rapid scheduleAutoSave calls into a single save of the latest value', async () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => {
        result.current.setContent('a');
        result.current.scheduleAutoSave();
      });
      act(() => {
        result.current.setContent('ab');
        result.current.scheduleAutoSave();
      });
      act(() => {
        result.current.setContent('abc');
        result.current.scheduleAutoSave();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(VALIDATION.AUTO_SAVE_TIMEOUT_MS);
      });

      expect(notes.update).toHaveBeenCalledTimes(1);
      expect(notes.update).toHaveBeenCalledWith('1', { content: 'abc' });
    });

    it('an immediate autoSaveNote cancels a pending debounced save', async () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => {
        result.current.setContent('debounced');
        result.current.scheduleAutoSave();
      });
      act(() => result.current.setColor('#ff0000'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(VALIDATION.AUTO_SAVE_TIMEOUT_MS);
      });

      // Both changes land in the one immediate save; the debounce never fires
      // a second, duplicate request.
      expect(notes.update).toHaveBeenCalledTimes(1);
      expect(notes.update).toHaveBeenCalledWith('1', { content: 'debounced', color: '#ff0000' });
    });

    it('flashes the saved indicator after a successful save and clears it after markDirty', async () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('changed'));
      await act(async () => {
        await result.current.autoSaveNote();
      });
      expect(result.current.showSaved).toBe(true);

      act(() => result.current.markDirty());
      expect(result.current.showSaved).toBe(false);
    });

    it('reports the error and does not throw when the save request fails', async () => {
      vi.mocked(notes.update).mockRejectedValueOnce(new Error('network error'));
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result, showError } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('changed'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(showError).toHaveBeenCalled();
    });

    it('calls onRefresh after a successful save', async () => {
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result, onRefresh } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('changed'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(onRefresh).toHaveBeenCalled();
    });
  });

  describe('item diffing', () => {
    it('creates a new item that has no baseline snapshot', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, []);

      act(() => result.current.commitItems([listItem('new1', { text: 'new item', position: 0 })]));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.createItem).toHaveBeenCalledWith('1', expect.objectContaining({ id: 'new1', text: 'new item' }));
    });

    it('treats a 409 on create as already-created rather than surfacing an error', async () => {
      vi.mocked(notes.createItem).mockRejectedValueOnce({ response: { status: 409 } });
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result, showError } = renderDraft({ note });
      adopt(result.current, note, []);

      act(() => result.current.commitItems([listItem('new1')]));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      // autoSaveNote's own catch swallows every error and calls showError
      // instead of rethrowing, so merely resolving without throwing would
      // pass even if the 409 special-casing regressed — assert the flow
      // actually reached the create call and never fell into the error path.
      expect(notes.createItem).toHaveBeenCalledWith('1', expect.objectContaining({ id: 'new1' }));
      expect(showError).not.toHaveBeenCalled();
    });

    it('patches only the fields that changed on an existing item', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a', { text: 'old' })]);

      act(() => result.current.commitItems([listItem('a', { text: 'new' })]));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.updateItem).toHaveBeenCalledWith('1', 'a', { text: 'new' });
    });

    it('does not patch an item that has not changed', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a')]);

      // No edits — flush should be a no-op for items.
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.updateItem).not.toHaveBeenCalled();
    });

    it('deletes items removed from the local model', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a'), listItem('b')]);

      act(() => result.current.commitItems([listItem('a')]));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.deleteItem).toHaveBeenCalledWith('1', 'b');
    });

    it('reorders items when only their order changed', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a'), listItem('b')]);

      act(() => result.current.commitItems([listItem('b'), listItem('a')]));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.reorderItems).toHaveBeenCalledWith('1', ['b', 'a']);
    });

    it('does not reorder when the order is unchanged', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a'), listItem('b')]);

      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.reorderItems).not.toHaveBeenCalled();
    });
  });

  describe('queued saves while one is in flight', () => {
    it('queues another edit made during an in-flight save and flushes it once the first completes', async () => {
      let resolveUpdate: (value: Note) => void = () => {};
      vi.mocked(notes.update).mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve; }));
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('first'));
      let savePromise!: Promise<void>;
      act(() => {
        savePromise = result.current.autoSaveNote();
      });

      // A second edit arrives while the first save is still in flight.
      act(() => result.current.setContent('second'));
      await act(async () => {
        await result.current.autoSaveNote();
      });

      // Resolve the first request; the queued second pass should then run.
      await act(async () => {
        resolveUpdate({} as Note);
        await savePromise;
      });

      expect(notes.update).toHaveBeenCalledTimes(2);
      expect(notes.update).toHaveBeenNthCalledWith(1, '1', { content: 'first' });
      expect(notes.update).toHaveBeenNthCalledWith(2, '1', { content: 'second' });
    });

    it('requestAnotherSavePass asks a running save loop for one more pass', async () => {
      let resolveUpdate: (value: Note) => void = () => {};
      vi.mocked(notes.update).mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve; }));
      const note = createMockNote({ id: '1', content: 'hello' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      act(() => result.current.setContent('first'));
      let savePromise!: Promise<void>;
      act(() => {
        savePromise = result.current.autoSaveNote();
      });

      act(() => result.current.requestAnotherSavePass());

      await act(async () => {
        resolveUpdate({} as Note);
        await savePromise;
      });

      // No further scalar edit was made, so the second pass has nothing new
      // to send, but the loop must have run again without throwing.
      expect(notes.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('exclusive save lock', () => {
    it('beginExclusiveSave claims the lock and isSaving reflects it', () => {
      const note = createMockNote({ id: '1' });
      const { result } = renderDraft({ note });

      let claimed = false;
      act(() => {
        claimed = result.current.beginExclusiveSave();
      });

      expect(claimed).toBe(true);
      expect(result.current.isSaving()).toBe(true);
    });

    it('beginExclusiveSave fails while another save already holds the lock', () => {
      const note = createMockNote({ id: '1' });
      const { result } = renderDraft({ note });

      act(() => {
        result.current.beginExclusiveSave();
      });

      let claimed = true;
      act(() => {
        claimed = result.current.beginExclusiveSave();
      });

      expect(claimed).toBe(false);
    });

    it('endExclusiveSave releases the lock', () => {
      const note = createMockNote({ id: '1' });
      const { result } = renderDraft({ note });

      act(() => {
        result.current.beginExclusiveSave();
        result.current.endExclusiveSave();
      });

      expect(result.current.isSaving()).toBe(false);
    });
  });

  describe('baseline mutations', () => {
    it('markScalarSaved advances the baseline so the next save does not re-send it', async () => {
      const note = createMockNote({ id: '1', pinned: false });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      // pinned is toggled and persisted directly (its own PATCH), outside the
      // autosave engine — the baseline has to catch up manually.
      act(() => {
        result.current.setPinned(true);
        result.current.markScalarSaved({ pinned: true });
      });

      expect(result.current.isDirty()).toBe(false);

      await act(async () => {
        await result.current.autoSaveNote();
      });
      expect(notes.update).not.toHaveBeenCalled();
    });

    it('applyDraftScalars writes straight into the draft so an immediate save includes it', async () => {
      const note = createMockNote({ id: '1', color: '#ffffff' });
      const { result } = renderDraft({ note });
      adopt(result.current, note);

      // Mirrors the color-swatch handler: setColor + applyDraftScalars +
      // autoSaveNote all happen in the same handler, before the effect that
      // syncs the draft ref from state has had a chance to run.
      act(() => {
        result.current.setColor('#00ff00');
        result.current.applyDraftScalars({ color: '#00ff00' });
      });
      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.update).toHaveBeenCalledWith('1', { color: '#00ff00' });
    });

    it('baseline.syncCompleted advances completed flags without re-patching them', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [listItem('a', { completed: false })]);

      act(() => {
        result.current.commitItems([listItem('a', { completed: true })]);
        result.current.baseline.syncCompleted(new Map([['a', true]]));
      });

      await act(async () => {
        await result.current.autoSaveNote();
      });

      expect(notes.updateItem).not.toHaveBeenCalled();
    });

    it('baseline.applyBulkDeletion drops ids from the baseline and updates parent/completed for survivors', async () => {
      const note = createMockNote({ id: '1', note_type: 'list', title: 'List' });
      const { result } = renderDraft({ note });
      adopt(result.current, note, [
        listItem('parent', { completed: true }),
        listItem('child', { parentId: 'parent', completed: false }),
      ]);

      act(() => {
        const remaining = [listItem('child', { parentId: null, completed: false })];
        result.current.commitItems(remaining);
        result.current.baseline.applyBulkDeletion(new Set(['parent']), remaining);
      });

      await act(async () => {
        await result.current.autoSaveNote();
      });

      // The baseline was told the child is now top-level and its completed
      // flag unchanged, so no patch is needed and 'parent' is gone (nothing
      // to delete for it — it was already removed from the local model).
      expect(notes.updateItem).not.toHaveBeenCalled();
      expect(notes.deleteItem).not.toHaveBeenCalled();
    });
  });
});
