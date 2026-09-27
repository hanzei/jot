import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_NOTE_COLOR,
  VALIDATION,
  buildScalarPatch,
  diffItems,
  itemSnapshot,
  itemsDiffer,
  patchTouchesSharedContent,
  type ItemSnapshot,
  type Label,
  type Note,
  type NoteScalars,
  type NoteType,
} from '@jot/shared';
import { notes } from '@/utils/api';
import type { ListItem } from '@/utils/noteItems';
import type { CompletedItemsBaseline } from '@/hooks/useCompletedItems';

// The scalar (non-item) fields of a note, as the editor holds them. A text note
// has no title/collapse state and a list note has no content — buildScalarPatch
// (@jot/shared) picks the relevant half by note type.
export type AutoSaveDraft = NoteScalars;

// Thrown by flushSave when the server rejects a title/content write because the
// note changed elsewhere since the version this editor last saw (409 on
// base_version). The hook has already raised its conflict state by then, so
// callers should not report it as a generic save failure.
export class NoteConflictError extends Error {
  constructor() {
    super('note was changed elsewhere');
    this.name = 'NoteConflictError';
  }
}

const httpStatus = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } })?.response?.status;

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
  // True while a title/content save was rejected as stale. The editor keeps the
  // local text and shows a banner offering Reload/Overwrite; autosave is paused
  // until the user picks one (or a fresh note is adopted).
  const [conflict, setConflictState] = useState(false);

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
  // The note version the baseline's title/content correspond to, sent as
  // base_version with every title/content write so a stale tab gets a 409
  // instead of silently overwriting a newer edit from another device (#489).
  // Null for a note not yet created.
  const versionRef = useRef<number | null>(null);
  const conflictRef = useRef(false);
  // False once the editor has unmounted. A save pass requested on close keeps
  // running after unmount, and a conflict it hits then has no banner to show.
  const mountedRef = useRef(true);
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  const setConflict = useCallback((next: boolean) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);

  // Records the given state as the server baseline — called when adopting a
  // note from props, which also settles any open conflict, since the editor
  // now shows the server's copy.
  const setSavedBaseline = useCallback((draft: AutoSaveDraft, listItems: ListItem[], version: number | null) => {
    savedScalarsRef.current = { ...draft };
    versionRef.current = version;
    setConflict(false);
    const map = new Map<string, ItemSnapshot>();
    for (const it of listItems) {
      map.set(it.id, itemSnapshot(it));
    }
    savedItemsRef.current = map;
    savedOrderRef.current = listItems.map(it => it.id);
  }, [setConflict]);

  // Advances the scalar baseline for fields persisted outside the autosave
  // pipeline — the pin, archive and collapse toggles each PATCH their own field
  // directly, so the baseline has to catch up or the next save would re-send it.
  const markScalarSaved = useCallback((patch: Partial<AutoSaveDraft>) => {
    savedScalarsRef.current = { ...savedScalarsRef.current, ...patch };
  }, []);

  // Writes scalar fields straight into the draft the save engine reads. Needed
  // only where a setState is immediately followed by autoSaveNote() in the same
  // handler (the color swatches): the effect that syncs the draft ref hasn't run
  // yet at that point, so the save would otherwise send the previous value.
  const applyDraftScalars = useCallback((patch: Partial<AutoSaveDraft>) => {
    autoSaveDraftRef.current = { ...autoSaveDraftRef.current, ...patch };
  }, []);

  // True when local editor state differs from the server baseline. Used to
  // avoid clobbering unsaved edits when an SSE refresh re-supplies the note.
  const isDirty = useCallback((): boolean =>
    buildScalarPatch(noteTypeRef.current, autoSaveDraftRef.current, savedScalarsRef.current) !== null
    || itemsDiffer(savedItemsRef.current, savedOrderRef.current, itemsRef.current), []);

  // True when a save is running, queued, or still needed — the note-adoption
  // guard, which must not overwrite local edits that haven't reached the server.
  const hasUnflushedWork = useCallback(
    (): boolean => savingRef.current || saveTimeoutRef.current !== undefined || isDirty(),
    [isDirty],
  );

  // Persists item changes as the granular create/patch/delete/reorder
  // operations diffItems computes against the baseline. The baseline is
  // advanced incrementally after each successful op so that if a later op fails
  // (e.g. network error), the already-applied ops are not re-sent on the next
  // retry — which would otherwise re-create items and get stuck on 409 Conflict.
  const persistItemDiff = useCallback(async (noteId: string, listItems: ListItem[]) => {
    const base = savedItemsRef.current;
    for (const op of diffItems(base, savedOrderRef.current, listItems)) {
      switch (op.kind) {
        case 'create':
          try {
            await notes.createItem(noteId, op.request);
          } catch (err) {
            // 409 means a prior attempt already created this item; treat as done.
            if (httpStatus(err) !== 409) throw err;
          }
          base.set(op.itemId, op.snapshot);
          break;
        case 'patch':
          await notes.updateItem(noteId, op.itemId, op.patch);
          base.set(op.itemId, op.snapshot);
          break;
        case 'delete':
          await notes.deleteItem(noteId, op.itemId);
          base.delete(op.itemId);
          break;
        case 'reorder':
          await notes.reorderItems(noteId, op.itemIds);
          break;
      }
    }
    savedOrderRef.current = listItems.map(it => it.id);
  }, []);

  // Flushes all pending scalar and item changes to the server in one pass.
  // Throws NoteConflictError (with the conflict state raised) when the note
  // changed elsewhere; nothing is sent while a conflict is open.
  const flushSave = useCallback(async () => {
    const noteId = noteIdRef.current;
    if (!noteId) return;
    if (conflictRef.current) throw new NoteConflictError();
    // Snapshot the scalar state now, before awaiting, so the baseline reflects
    // exactly what was sent — not any later edits made while the request (or a
    // subsequent failing item op) was in flight.
    const scalarSnapshot = { ...autoSaveDraftRef.current };
    const scalarPatch = buildScalarPatch(noteTypeRef.current, scalarSnapshot, savedScalarsRef.current);
    if (scalarPatch) {
      const baseVersion = versionRef.current;
      const guarded = patchTouchesSharedContent(scalarPatch) && baseVersion !== null;
      let updated: Note;
      try {
        updated = await notes.update(noteId, guarded ? { ...scalarPatch, base_version: baseVersion } : scalarPatch);
      } catch (err) {
        // The whole PATCH is rejected on a version conflict (per-user fields in
        // it included), so the baseline stays where it was and the local edits
        // stay on screen for the user to reload over or re-send.
        if (guarded && httpStatus(err) === 409) {
          setConflict(true);
          throw new NoteConflictError();
        }
        throw err;
      }
      savedScalarsRef.current = scalarSnapshot;
      // Only a content write moves the version this editor's text is based on.
      // A per-user-only PATCH echoes the server's current version, which may
      // include another device's edit we have not adopted — taking it would
      // let the next save overwrite that edit unchecked.
      if (guarded) versionRef.current = updated.version;
    }
    if (noteTypeRef.current === 'list') {
      await persistItemDiff(noteId, itemsRef.current);
    }
  }, [persistItemDiff, setConflict]);

  // Persists local edits to the server as granular operations. The latest state
  // is always read from itemsRef/autoSaveDraftRef, so queued saves pick up the
  // most recent edits.
  const autoSaveNote = useCallback(async () => {
    if (!noteIdRef.current) return;
    // Cancel any pending debounced text-save so it can't fire a duplicate pass.
    cancelPendingSave();
    // Paused until the user resolves the conflict banner.
    if (conflictRef.current) return;
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
      // A conflict is reported by its own banner, not the generic error —
      // unless the editor closed mid-save, when there is no banner left and
      // the unsaved edits would otherwise be dropped silently.
      if (!(error instanceof NoteConflictError) || !mountedRef.current) {
        console.error('Failed to auto-save note:', error);
        showError(t('note.failedSaveChanges'));
      }
    } finally {
      savingRef.current = false;
    }
  }, [cancelPendingSave, flashSaved, flushSave, markDirty, onRefresh, showError, t]);

  // The banner's Overwrite action: re-reads the note's current version and
  // re-sends the local edits against it, knowingly replacing the other change.
  // A failed re-read leaves the banner up so the user can try again.
  const overwriteConflict = useCallback(async () => {
    const noteId = noteIdRef.current;
    if (!noteId || !conflictRef.current) return;
    try {
      versionRef.current = (await notes.getById(noteId)).version;
    } catch (error) {
      console.error('Failed to refetch note version for overwrite:', error);
      showError(t('note.failedSaveChanges'));
      return;
    }
    setConflict(false);
    await autoSaveNote();
  }, [autoSaveNote, setConflict, showError, t]);

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
    // Stale-write conflict (409 on base_version)
    conflict, overwriteConflict,
    // Baseline
    setSavedBaseline, markScalarSaved, applyDraftScalars, isDirty, hasUnflushedWork, baseline,
    // Save pipeline
    autoSaveNote, scheduleAutoSave, cancelPendingSave, flushSave,
    beginExclusiveSave, endExclusiveSave, isSaving, requestAnotherSavePass,
  };
}
