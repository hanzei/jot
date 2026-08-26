import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_NOTE_COLOR, VALIDATION, type Label, type Note, type NoteType, type PatchNoteItemRequest, type UpdateNoteRequest } from '@jot/shared';
import { notes } from '@/utils/api';
import type { ListItem } from '@/utils/noteItems';
import type { CompletedItemsBaseline } from '@/hooks/useCompletedItems';

// The scalar (non-item) fields of a note, as the editor holds them. Every field
// is optional because a text note has no title/collapse state and a list note
// has no content — buildScalarPatch below picks the relevant half by note type.
export interface AutoSaveDraft {
  title?: string;
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
}

// Mergeable fields of a list item, used as the per-item baseline for diffing
// local edits against the last-known server state.
type ItemSnapshot = Pick<ListItem, 'text' | 'completed' | 'parentId' | 'assigned_to'>;

const itemSnapshot = (item: ListItem): ItemSnapshot => ({
  text: item.text,
  completed: item.completed,
  parentId: item.parentId,
  assigned_to: item.assigned_to,
});

const emptyDraft = (): AutoSaveDraft => ({
  title: '',
  content: '',
  pinned: false,
  archived: false,
  color: DEFAULT_NOTE_COLOR,
  checked_items_collapsed: false,
});

interface UseNoteDraftOptions {
  note?: Note | null;
  onRefresh?: (() => void) | undefined;
  showError: (message: string) => void;
}

// useNoteDraft owns the editable state of a note — its scalar fields and its
// list items — together with the autosave engine that persists them.
//
// The engine never re-sends the whole note. It keeps a baseline of the
// last-known server state and diffs local edits against it, so a list-item edit
// never clobbers a title edited in another tab and vice versa. Item changes go
// out as granular create/patch/delete/reorder operations; scalar changes go out
// as a patch containing only the fields that actually moved.
//
// Callers drive it three ways: scheduleAutoSave() for debounced typing,
// autoSaveNote() for an immediate flush after a structural edit, and
// markScalarSaved() when a field was persisted by some other request (the pin,
// archive and collapse toggles each PATCH their own field directly) and the
// baseline just needs to catch up.
export function useNoteDraft({ note, onRefresh, showError }: UseNoteDraftOptions) {
  const { t } = useTranslation();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState(DEFAULT_NOTE_COLOR);
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [items, setItems] = useState<ListItem[]>([]);
  const [noteLabels, setNoteLabels] = useState<Label[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteIdRef = useRef<string | null>(note?.id ?? null);
  const noteTypeRef = useRef<NoteType>(note?.note_type ?? 'text');
  const autoSaveDraftRef = useRef<AutoSaveDraft>(emptyDraft());
  const itemsRef = useRef<ListItem[]>([]);
  // Baseline of the last-known server state, used to diff local edits into
  // granular per-item operations (and field-only scalar patches) instead of
  // re-sending the whole note. This is what stops a save in one tab from
  // overwriting concurrent edits made in another.
  const savedScalarsRef = useRef<AutoSaveDraft>(emptyDraft());
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  // Set while a save is in flight to request one more pass once it finishes,
  // so edits made during the save are not lost.
  const pendingSaveRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    noteIdRef.current = note?.id ?? null;
  }, [note?.id]);

  useEffect(() => {
    noteTypeRef.current = noteType;
  }, [noteType]);

  useEffect(() => {
    autoSaveDraftRef.current = {
      title,
      content,
      pinned,
      archived,
      color,
      checked_items_collapsed: checkedItemsCollapsed,
    };
  }, [archived, checkedItemsCollapsed, color, content, pinned, title]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

  const commitItems = useCallback((nextItems: ListItem[]) => {
    itemsRef.current = nextItems;
    setItems(nextItems);
    // If a save is in flight, request another pass so these edits are flushed.
    if (savingRef.current) {
      pendingSaveRef.current = true;
    }
  }, []);

  // Cancels a pending debounced text-save so it can't fire a duplicate pass
  // after an immediate save has already been sent.
  const cancelPendingSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
  }, []);

  const flashSaved = useCallback(() => {
    setShowSaved(true);
    if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    savedTimeoutRef.current = setTimeout(() => setShowSaved(false), 2000);
  }, []);

  const markDirty = useCallback(() => {
    setShowSaved(false);
    if (savedTimeoutRef.current) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = undefined;
    }
  }, []);

  // Records the current local state as the server baseline (called after a
  // successful save and when adopting a fresh note from props).
  const setSavedBaseline = useCallback((draft: AutoSaveDraft, listItems: ListItem[]) => {
    savedScalarsRef.current = { ...draft };
    const map = new Map<string, ItemSnapshot>();
    for (const it of listItems) {
      map.set(it.id, itemSnapshot(it));
    }
    savedItemsRef.current = map;
    savedOrderRef.current = listItems.map(it => it.id);
  }, []);

  // Advances the scalar baseline for fields persisted outside the autosave
  // pipeline — the pin, archive and collapse toggles each PATCH their own field
  // directly, so the baseline has to catch up or the next save would re-send it.
  const markScalarSaved = useCallback((patch: AutoSaveDraft) => {
    savedScalarsRef.current = { ...savedScalarsRef.current, ...patch };
  }, []);

  // Writes scalar fields straight into the draft the save engine reads. Needed
  // only where a setState is immediately followed by autoSaveNote() in the same
  // handler (the color swatches): the effect that syncs the draft ref hasn't run
  // yet at that point, so the save would otherwise send the previous value.
  const applyDraftScalars = useCallback((patch: AutoSaveDraft) => {
    autoSaveDraftRef.current = { ...autoSaveDraftRef.current, ...patch };
  }, []);

  // True when local editor state differs from the server baseline. Used to
  // avoid clobbering unsaved edits when an SSE refresh re-supplies the note.
  const isDirty = useCallback((): boolean => {
    const cur = autoSaveDraftRef.current;
    const base = savedScalarsRef.current;
    if (cur.pinned !== base.pinned || cur.archived !== base.archived || cur.color !== base.color) return true;
    if (noteTypeRef.current === 'list') {
      if (cur.title !== base.title || cur.checked_items_collapsed !== base.checked_items_collapsed) return true;
    } else if (cur.content !== base.content) {
      return true;
    }
    const items = itemsRef.current;
    if (items.length !== savedOrderRef.current.length) return true;
    for (const [i, it] of items.entries()) {
      if (savedOrderRef.current[i] !== it.id) return true;
      const snap = savedItemsRef.current.get(it.id);
      if (!snap || snap.text !== it.text || snap.completed !== it.completed
        || snap.parentId !== it.parentId || snap.assigned_to !== it.assigned_to) {
        return true;
      }
    }
    return false;
  }, []);

  // True when a save is running, queued, or still needed — the note-adoption
  // guard, which must not overwrite local edits that haven't reached the server.
  const hasUnflushedWork = useCallback(
    (): boolean => savingRef.current || saveTimeoutRef.current !== undefined || isDirty(),
    [isDirty],
  );

  // Builds a note patch containing only the scalar fields that changed vs the
  // baseline, so a list-item edit never re-sends (and clobbers) the title, and
  // a title edit never re-sends stale items.
  const buildScalarPatch = useCallback((): UpdateNoteRequest | null => {
    const cur = autoSaveDraftRef.current;
    const base = savedScalarsRef.current;
    const patch: Record<string, unknown> = {};
    if (cur.pinned !== base.pinned) patch.pinned = cur.pinned;
    if (cur.archived !== base.archived) patch.archived = cur.archived;
    if (cur.color !== base.color) patch.color = cur.color;
    if (noteTypeRef.current === 'list') {
      if (cur.title !== base.title) patch.title = cur.title;
      if (cur.checked_items_collapsed !== base.checked_items_collapsed) patch.checked_items_collapsed = cur.checked_items_collapsed;
    } else if (cur.content !== base.content) {
      patch.content = cur.content;
    }
    return Object.keys(patch).length > 0 ? (patch as UpdateNoteRequest) : null;
  }, []);

  // Persists item changes as granular create/patch/delete/reorder operations
  // (diffed against the baseline). The baseline is advanced incrementally after
  // each successful op so that if a later op fails (e.g. network error), the
  // already-applied ops are not re-sent on the next retry — which would
  // otherwise re-create items and get stuck on 409 Conflict.
  const persistItemDiff = useCallback(async (noteId: string, listItems: ListItem[]) => {
    const base = savedItemsRef.current;
    const curIds = new Set(listItems.map(it => it.id));

    for (const it of listItems) {
      const snap = base.get(it.id);
      if (!snap) {
        try {
          await notes.createItem(noteId, {
            id: it.id,
            text: it.text,
            position: it.position,
            completed: it.completed,
            parent_id: it.parentId ?? '',
            ...(it.assigned_to ? { assigned_to: it.assigned_to } : {}),
          });
        } catch (err) {
          // 409 means a prior attempt already created this item; treat as done.
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status !== 409) throw err;
        }
        base.set(it.id, itemSnapshot(it));
        continue;
      }
      const data: PatchNoteItemRequest = {};
      if (it.text !== snap.text) data.text = it.text;
      if (it.completed !== snap.completed) data.completed = it.completed;
      if (it.parentId !== snap.parentId) data.parent_id = it.parentId ?? '';
      if (it.assigned_to !== snap.assigned_to) data.assigned_to = it.assigned_to;
      if (Object.keys(data).length > 0) {
        await notes.updateItem(noteId, it.id, data);
        base.set(it.id, itemSnapshot(it));
      }
    }

    for (const id of [...base.keys()]) {
      if (!curIds.has(id)) {
        await notes.deleteItem(noteId, id);
        base.delete(id);
      }
    }

    const curOrder = listItems.map(it => it.id);
    const orderChanged = curOrder.length !== savedOrderRef.current.length
      || curOrder.some((id, i) => savedOrderRef.current[i] !== id);
    if (orderChanged && curOrder.length > 0) {
      await notes.reorderItems(noteId, curOrder);
    }
    savedOrderRef.current = curOrder;
  }, []);

  // Flushes all pending scalar and item changes to the server in one pass.
  const flushSave = useCallback(async () => {
    const noteId = noteIdRef.current;
    if (!noteId) return;
    const scalarPatch = buildScalarPatch();
    if (scalarPatch) {
      // Snapshot the scalar state now, before awaiting, so the baseline reflects
      // exactly what was sent — not any later edits made while the request (or a
      // subsequent failing item op) was in flight.
      const scalarSnapshot = { ...autoSaveDraftRef.current };
      await notes.update(noteId, scalarPatch);
      savedScalarsRef.current = scalarSnapshot;
    }
    if (noteTypeRef.current === 'list') {
      await persistItemDiff(noteId, itemsRef.current);
    }
  }, [buildScalarPatch, persistItemDiff]);

  // Persists local edits to the server as granular operations. The latest state
  // is always read from itemsRef/autoSaveDraftRef, so queued saves pick up the
  // most recent edits.
  const autoSaveNote = useCallback(async () => {
    if (!noteIdRef.current) return;
    // Cancel any pending debounced text-save so it can't fire a duplicate pass.
    cancelPendingSave();
    if (savingRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    savingRef.current = true;
    markDirty();
    try {
      do {
        pendingSaveRef.current = false;
        await flushSave();
        onRefresh?.();
        flashSaved();
      } while (pendingSaveRef.current);
    } catch (error) {
      console.error('Failed to auto-save note:', error);
      showError(t('note.failedSaveChanges'));
    } finally {
      savingRef.current = false;
    }
  }, [cancelPendingSave, flashSaved, flushSave, markDirty, onRefresh, showError, t]);

  // Debounced save for keystroke-level edits (title, content, item text).
  const scheduleAutoSave = useCallback(() => {
    cancelPendingSave();
    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = undefined;
      await autoSaveNote();
    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
  }, [autoSaveNote, cancelPendingSave]);

  // Claims the save lock for an explicit (non-autosave) save — handleSave,
  // convert and duplicate all persist first and must not race the autosave loop.
  // Returns false when a save is already running, which is the caller's cue to
  // bail out rather than queue behind it.
  const beginExclusiveSave = useCallback((): boolean => {
    if (savingRef.current) return false;
    savingRef.current = true;
    return true;
  }, []);

  const endExclusiveSave = useCallback(() => {
    savingRef.current = false;
  }, []);

  const isSaving = useCallback((): boolean => savingRef.current, []);

  // Asks the in-flight autosave loop for one more pass once it finishes. Used
  // when the modal closes mid-save: the loop keeps running after unmount (its
  // closure holds the refs), so the latest edits still reach the server.
  const requestAnotherSavePass = useCallback(() => {
    pendingSaveRef.current = true;
  }, []);

  // The two baseline mutations the completed-item bulk actions need, handed
  // over as named operations so that hook never touches the diff refs directly.
  const baseline = useMemo<CompletedItemsBaseline>(() => ({
    syncCompleted: (completedById) => {
      for (const [id, comp] of completedById) {
        const snap = savedItemsRef.current.get(id);
        if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
      }
    },
    applyBulkDeletion: (deletedIds, remainingItems) => {
      for (const id of deletedIds) savedItemsRef.current.delete(id);
      // Advance the baseline for any reconciled item so the diff engine does not
      // try to "restore" the pre-delete parent/completed on the next save.
      for (const item of remainingItems) {
        const snap = savedItemsRef.current.get(item.id);
        if (snap && (snap.parentId !== item.parentId || snap.completed !== item.completed)) {
          savedItemsRef.current.set(item.id, { ...snap, parentId: item.parentId, completed: item.completed });
        }
      }
      savedOrderRef.current = savedOrderRef.current.filter(id => !deletedIds.has(id));
    },
  }), []);

  return {
    // Scalar draft fields
    title, setTitle,
    content, setContent,
    noteType, setNoteType,
    color, setColor,
    pinned, setPinned,
    archived, setArchived,
    checkedItemsCollapsed, setCheckedItemsCollapsed,
    // List items
    items, itemsRef, commitItems,
    // Labels — adopted from the note prop alongside the scalar fields, but not
    // part of the autosave engine: LabelPicker mutates the server directly and
    // reports the result back through setNoteLabels, so there is never
    // unflushed local label state to protect.
    noteLabels, setNoteLabels,
    // Save status indicator
    showSaved, flashSaved, markDirty,
    // Baseline
    setSavedBaseline, markScalarSaved, applyDraftScalars, isDirty, hasUnflushedWork, baseline,
    // Save pipeline
    autoSaveNote, scheduleAutoSave, cancelPendingSave, flushSave,
    beginExclusiveSave, endExclusiveSave, isSaving, requestAnotherSavePass,
  };
}
