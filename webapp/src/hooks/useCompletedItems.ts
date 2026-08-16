import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Note, NoteItem } from '@jot/shared';
import { notes } from '@/utils/api';
import type { ListItem } from '@/utils/noteItems';

// Undo window for the client-deferred "delete checked items" bulk action. The
// single bulk DELETE only fires once this elapses without an undo. The
// "N items unchecked" bar reuses it so both bars linger for the same time.
export const COMPLETED_DELETE_UNDO_MS = 10_000;

// The slice of the autosave engine's diff baseline these bulk actions have to
// advance. Passed in as named operations rather than as the raw refs so the
// engine stays free to move, and so it is obvious from here exactly which two
// mutations the bulk actions make to it.
export interface CompletedItemsBaseline {
  // Advances the baseline's completed flags to what the server just reported,
  // so the diff engine does not re-patch them on the next save.
  syncCompleted: (completedById: Map<string, boolean>) => void;
  // Drops the deleted items from the baseline and advances parent/completed
  // for the survivors the server re-homed, so the diff engine treats the
  // deleted items as gone rather than re-deleting them one by one.
  applyBulkDeletion: (deletedIds: Set<string>, remainingItems: ListItem[]) => void;
}

interface UseCompletedItemsOptions {
  note?: Note | null;
  // Live view of the local item model, read inside deferred callbacks.
  itemsRef: React.RefObject<ListItem[]>;
  commitItems: (items: ListItem[]) => void;
  baseline: CompletedItemsBaseline;
  // Cancels any pending debounced autosave, so a stale write can't race a
  // bulk operation that has already been sent.
  cancelPendingSave: () => void;
  markDirty: () => void;
  flashSaved: () => void;
  showError: (message: string) => void;
  onRefresh?: (() => void) | undefined;
}

// useCompletedItems owns the bulk actions on a list note's checked items:
// deleting them behind a client-deferred undo window, and unchecking them all
// with an undo that re-checks the same snapshot. Both are rendered as inline
// bars inside the DialogPanel rather than the app-wide toast, because
// HeadlessUI's Dialog treats a click anywhere outside its own portal as a
// request to close — clicking Undo in a toast would dismiss the modal.
//
// Their timers live in refs, not state, so they keep running (and the eventual
// request still fires) even if the modal unmounts or switches notes first.
export function useCompletedItems({
  note,
  itemsRef,
  commitItems,
  baseline,
  cancelPendingSave,
  markDirty,
  flashSaved,
  showError,
  onRefresh,
}: UseCompletedItemsOptions) {
  const { t } = useTranslation();
  const noteId = note?.id ?? null;

  // Checked list items currently showing the inline "checked items deleted —
  // Undo" bar. hiddenCompletedItemIds is derived from this so the two never
  // drift. Only id/text are needed for the bar's count; the items themselves
  // stay in the local model (merely hidden) until the deferred bulk delete
  // lands, so the diff engine never re-deletes them.
  const [removedCompletedItems, setRemovedCompletedItems] = useState<{ id: string; text: string }[]>([]);
  const hiddenCompletedItemIds = useMemo(() => new Set(removedCompletedItems.map(i => i.id)), [removedCompletedItems]);
  // Pending deferred bulk deletes, keyed by note ID (ref, not state, so timers
  // keep running and each DELETE still fires even if the modal unmounts or
  // switches to another note first). Keyed per note — like the image-removal
  // bookkeeping — so a delete started on one note can't cancel another's.
  const pendingCompletedDeletesRef = useRef<Map<string, { ids: Set<string>; timeoutId: ReturnType<typeof setTimeout> }>>(new Map());
  // The most recent "uncheck all" for the open note, shown as a transient
  // "N items unchecked — Undo" bar. Unlike delete this is not deferred: the
  // uncheck already persisted, so Undo simply re-checks the same snapshot. The
  // bar auto-dismisses; it belongs to the current note and is cleared on switch.
  const [recentlyUnchecked, setRecentlyUnchecked] = useState<{ noteId: string; ids: string[]; count: number } | null>(null);
  const uncheckUndoTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Holds the latest onRefresh so the unmount flush below doesn't have to
  // re-run (and prematurely fire) on every onRefresh change. A ref rather than
  // useEffectEvent because the flush calls it once its requests settle, which
  // is after unmount — effect events may only be called from a live effect.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // On unmount (the modal is fully closed — note switches keep it mounted) flush
  // any deferred completed-item deletes immediately. The undo bar is gone once
  // closed, so waiting out the timer only risks a reopen showing stale items
  // that the lingering timer then removes; firing now keeps server and a reopen
  // consistent. Runs once (empty deps) so it triggers on unmount only.
  useEffect(() => {
    const pending = pendingCompletedDeletesRef.current;
    return () => {
      if (pending.size === 0) return;
      // Snapshot the callback while still mounted, then refresh only once every
      // DELETE has settled — refreshing while they are still in flight makes the
      // note list refetch the very items being deleted and render them back.
      const refresh = onRefreshRef.current;
      const flushes: Promise<unknown>[] = [];
      for (const [pendingNoteId, entry] of pending) {
        clearTimeout(entry.timeoutId);
        flushes.push(notes.deleteItems(pendingNoteId, [...entry.ids]).catch(err => {
          console.error('Failed to flush completed-item deletion on close:', err);
        }));
      }
      pending.clear();
      // Each flush swallows its own rejection, so this never rejects.
      void Promise.all(flushes).then(() => refresh?.());
    };
  }, []);

  // Reconciles only the completed flags the server reports (never replacing the
  // whole list, so unsaved edits and not-yet-created items survive) and advances
  // the diff baseline so the autosave engine does not re-patch them.
  const reconcileCompletedFromServer = useCallback((serverItems: NoteItem[]) => {
    const completedById = new Map(serverItems.map(item => [item.id, item.completed]));
    commitItems(itemsRef.current.map(item => {
      const serverCompleted = completedById.get(item.id);
      return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
    }));
    baseline.syncCompleted(completedById);
  }, [baseline, commitItems, itemsRef]);

  // Sets completed on the given items in one bulk request, applying an
  // optimistic local update first and reverting precisely those flags on error.
  // Mirrors the single-item toggle's reconcile-only-completed-flags approach.
  // Resolves false when the request failed and the local state was rolled back,
  // so callers don't offer an undo for something that never happened.
  const setItemsCompletedLocallyAndRemotely = useCallback(async (ids: string[], completed: boolean): Promise<boolean> => {
    const targets = new Set(ids);
    commitItems(itemsRef.current.map(item => (targets.has(item.id) ? { ...item, completed } : item)));

    // A not-yet-persisted note has no server-side items; the bulk create on save
    // carries the flags instead.
    if (!noteId) {
      markDirty();
      return true;
    }
    cancelPendingSave();

    try {
      const serverItems = await notes.setItemsCompleted(noteId, ids, completed);
      reconcileCompletedFromServer(serverItems);
      onRefresh?.();
      flashSaved();
      return true;
    } catch (error) {
      console.error('Failed to set items completed:', error);
      commitItems(itemsRef.current.map(item => (targets.has(item.id) ? { ...item, completed: !completed } : item)));
      showError(t('note.failedSaveChanges'));
      return false;
    }
  }, [cancelPendingSave, commitItems, itemsRef, markDirty, noteId, reconcileCompletedFromServer, onRefresh, flashSaved, showError, t]);

  // Unchecks every completed item, then shows a transient "N unchecked — Undo"
  // bar. Undo re-checks exactly that snapshot (the same bulk endpoint with
  // completed=true), restoring the prior state.
  const handleUncheckAllItems = useCallback(async () => {
    const completed = itemsRef.current.filter(item => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map(item => item.id);

    const unchecked = await setItemsCompletedLocallyAndRemotely(ids, false);

    // The request failed and the items were rolled back to checked, so there is
    // nothing to undo — showing the bar would invite re-checking what is
    // already checked.
    if (!unchecked) return;

    // Only offer undo for a persisted note (the bar re-checks server-side).
    if (!noteId) return;
    setRecentlyUnchecked({ noteId, ids, count: ids.length });
    if (uncheckUndoTimeoutRef.current) clearTimeout(uncheckUndoTimeoutRef.current);
    uncheckUndoTimeoutRef.current = setTimeout(() => {
      uncheckUndoTimeoutRef.current = undefined;
      setRecentlyUnchecked(null);
    }, COMPLETED_DELETE_UNDO_MS);
  }, [itemsRef, noteId, setItemsCompletedLocallyAndRemotely]);

  const undoUncheckAll = useCallback(() => {
    if (uncheckUndoTimeoutRef.current) {
      clearTimeout(uncheckUndoTimeoutRef.current);
      uncheckUndoTimeoutRef.current = undefined;
    }
    const rec = recentlyUnchecked;
    setRecentlyUnchecked(null);
    // Guard against the note having changed under the bar: only re-check if the
    // snapshot still belongs to the note currently open.
    if (rec && rec.noteId === noteId) {
      void setItemsCompletedLocallyAndRemotely(rec.ids, true);
    }
  }, [noteId, recentlyUnchecked, setItemsCompletedLocallyAndRemotely]);

  // Removes the given items from the local model and diff baseline once their
  // deferred delete has actually landed, so the diff engine treats them as gone
  // rather than re-deleting them per-item. When the server returns the remaining
  // items (it re-homes children orphaned by deleting their parent), their
  // authoritative parent/completed state is merged in — otherwise a surviving
  // child would keep a parentId pointing at a now-deleted parent, since this
  // client suppresses its own SSE echo. Local text edits are preserved.
  const finalizeCompletedDeletion = useCallback((ids: Set<string>, serverItems?: NoteItem[]) => {
    const serverById = new Map((serverItems ?? []).map(item => [item.id, item]));
    const next = itemsRef.current
      .filter(item => !ids.has(item.id))
      .map(item => {
        const server = serverById.get(item.id);
        if (!server) return item;
        const parentId = server.parent_id ?? null;
        if (parentId === item.parentId && server.completed === item.completed) return item;
        return { ...item, parentId, completed: server.completed };
      });
    commitItems(next);
    baseline.applyBulkDeletion(ids, next);
    setRemovedCompletedItems(prev => prev.filter(item => !ids.has(item.id)));
  }, [baseline, commitItems, itemsRef]);

  // Deletes all checked items, client-deferred behind an in-modal undo bar. The
  // items hide immediately; the single bulk DELETE fires only once the undo
  // window elapses. Until then they remain in the local model (merely hidden) so
  // an autosave in the window never per-item-deletes them, and an SSE refresh
  // can't resurrect them.
  const handleDeleteCompletedItems = useCallback(() => {
    if (!noteId) return;
    const existing = pendingCompletedDeletesRef.current.get(noteId);
    const pendingIds = existing?.ids ?? new Set<string>();
    const toRemove = itemsRef.current.filter(item => item.completed && !pendingIds.has(item.id));
    if (toRemove.length === 0) return;

    setRemovedCompletedItems(prev => [...prev, ...toRemove.map(item => ({ id: item.id, text: item.text }))]);
    const ids = new Set<string>([...pendingIds, ...toRemove.map(item => item.id)]);
    if (existing) clearTimeout(existing.timeoutId);

    const timeoutId = setTimeout(() => {
      pendingCompletedDeletesRef.current.delete(noteId);
      notes.deleteItems(noteId, [...ids])
        .then((remaining) => {
          finalizeCompletedDeletion(ids, remaining);
          onRefresh?.();
        })
        .catch((error) => {
          console.error('Failed to delete completed items:', error);
          // The delete never happened — un-hide so nothing silently disappears.
          setRemovedCompletedItems(prev => prev.filter(item => !ids.has(item.id)));
          showError(t('note.failedSaveChanges'));
        });
    }, COMPLETED_DELETE_UNDO_MS);
    pendingCompletedDeletesRef.current.set(noteId, { ids, timeoutId });
  }, [finalizeCompletedDeletion, itemsRef, noteId, onRefresh, showError, t]);

  const undoDeleteCompletedItems = useCallback(() => {
    const entry = noteId ? pendingCompletedDeletesRef.current.get(noteId) : undefined;
    if (entry) {
      clearTimeout(entry.timeoutId);
      pendingCompletedDeletesRef.current.delete(noteId!);
      setRemovedCompletedItems(prev => prev.filter(item => !entry.ids.has(item.id)));
    } else {
      setRemovedCompletedItems([]);
    }
  }, [noteId]);

  // Called by the modal's adoption effect when it switches to a different note.
  //
  // The deferred bulk-delete timer keeps running across a note switch (the modal
  // doesn't unmount), so the hidden set is re-derived from whichever incoming
  // items are still mid-window rather than simply cleared — same rationale as
  // the image-removal undo bar. The uncheck bar, by contrast, is note-specific
  // and its action already persisted, so it is dropped rather than carried over.
  const resetForNoteSwitch = useCallback(() => {
    const pendingCompleted = noteId ? pendingCompletedDeletesRef.current.get(noteId) : undefined;
    const incomingItems = note?.note_type === 'list' ? note.items ?? [] : [];
    const stillPendingCompleted = pendingCompleted
      ? incomingItems.filter(it => pendingCompleted.ids.has(it.id)).map(it => ({ id: it.id, text: it.text }))
      : [];
    setRemovedCompletedItems(stillPendingCompleted);

    if (uncheckUndoTimeoutRef.current) {
      clearTimeout(uncheckUndoTimeoutRef.current);
      uncheckUndoTimeoutRef.current = undefined;
    }
    setRecentlyUnchecked(null);
  }, [note, noteId]);

  return {
    removedCompletedItems,
    hiddenCompletedItemIds,
    recentlyUnchecked,
    handleDeleteCompletedItems,
    undoDeleteCompletedItems,
    handleUncheckAllItems,
    undoUncheckAll,
    resetForNoteSwitch,
  };
}
