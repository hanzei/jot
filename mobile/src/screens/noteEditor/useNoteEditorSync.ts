import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigationAction } from '@react-navigation/native';
import type { TFunction } from 'i18next';
import {
  DEFAULT_NOTE_COLOR,
  VALIDATION,
  type CreateNoteRequest,
  type Note,
  type PatchNoteItemRequest,
  type UpdateListNoteRequest,
  type UpdateNoteRequest,
  type UpdateTextNoteRequest,
} from '@jot/shared';
import {
  useCreateNote,
  useCreateNoteItem,
  useDeleteNoteItem,
  useReorderNoteItems,
  useUpdateNote,
  useUpdateNoteItem,
} from '../../hooks/useNotes';
import { useSSESubscription } from '../../store/SSEContext';
import { isServerReachable } from '../../api/serverReachability';
import { isWhiteHexColor } from '../../utils/colorContrast';
import type { ToastType } from '../../hooks/useToast';
import { itemSnapshot, serializeItems, toLocalItems, type ItemSnapshot, type LocalItem } from './listItemModel';
import type { EditorDocHandle } from './useEditorDoc';
import type { CachedNote, EditorNavProp } from './types';

const MAX_EXIT_SAVE_RETRIES = 3;

/** The prompt shown when a save failed on the way out of the editor. */
interface ExitSavePrompt {
  navAction: NavigationAction;
  wantsZoom: boolean;
  retriesLeft: number;
}

export interface UseNoteEditorSyncParams {
  doc: EditorDocHandle;
  /** Current note id as render state — null for a note not yet created. */
  noteId: string | null;
  /** Note id from the route, which decides whether this editor must hydrate. */
  initialNoteId: string | null;
  /** The note from the offline cache; drives hydration and remote refresh. */
  existingNote: CachedNote;
  navigation: EditorNavProp;
  /** Whether a back navigation should zoom the editor back onto its card. */
  zoomEnabled: boolean;
  /** Plays the zoom-close animation, resolving when it finishes. */
  animateClose: () => Promise<void>;
  t: TFunction;
  showToast: (message: string, type?: ToastType) => void;
}

export interface NoteEditorSync {
  /** Translation key for the in-editor save-failure banner, or null. */
  saveError: string | null;
  setSaveError: React.Dispatch<React.SetStateAction<string | null>>;
  /** Translation key for the "updated by another user" banner, or null. */
  syncToast: string | null;
  setSyncToast: React.Dispatch<React.SetStateAction<string | null>>;

  /** Persists pending edits now. Resolves false when the save failed. */
  flushSave: (unmounting?: boolean) => Promise<boolean>;
  /** Cancels the debounced save, then flushes. */
  flushPendingChanges: () => Promise<boolean>;
  /** Drops any debounced save without flushing it. */
  cancelScheduledSave: () => void;
  /** Flags the editor dirty and (re)arms the debounced save. */
  markDirtyAndScheduleUpdate: () => void;

  /** PATCHes note metadata (pin/archive/color) without touching the body. */
  runMetadataUpdate: (id: string, data: Partial<UpdateNoteRequest>) => Promise<void>;
  /** Advances the save baseline after a metadata PATCH succeeds. */
  commitMetadataBaseline: (overrides: Partial<UpdateNoteRequest>) => void;

  /** Save baseline for the items, so item edits diff instead of re-sending. */
  savedItemsRef: React.RefObject<Map<string, ItemSnapshot>>;
  savedOrderRef: React.RefObject<string[]>;
  /** True while an existing note's data is still loading. */
  isHydratingRef: React.RefObject<boolean>;
  /** True once an exit action owns the exit, so beforeRemove doesn't re-handle it. */
  intentionalExitRef: React.RefObject<boolean>;
  /** True for the duration of a zoom-close, so a concurrent back press is swallowed. */
  isClosingRef: React.RefObject<boolean>;
  /** Resolves once any in-flight save settles; null when none is running. */
  saveInFlightRef: React.RefObject<Promise<boolean> | null>;

  exitSavePrompt: ExitSavePrompt | null;
  isExitRetrying: boolean;
  handleExitRetry: () => Promise<void>;
  handleExitDiscard: () => void;
}

/**
 * The editor's persistence layer: the debounced save engine and its baseline,
 * the reconciliation that keeps the editor in step with the note underneath it,
 * and the save-on-exit flow (including the retry prompt when that save fails).
 *
 * Everything here is about getting editor state to and from the server. The
 * screen owns the state itself (`useEditorDoc`) and the rendering; this hook
 * reads that state through the doc handle's refs so a debounced or awaited save
 * always sees the latest values rather than the ones its closure captured.
 */
export function useNoteEditorSync({
  doc,
  noteId,
  initialNoteId,
  existingNote,
  navigation,
  zoomEnabled,
  animateClose,
  t,
  showToast,
}: UseNoteEditorSyncParams): NoteEditorSync {
  const {
    noteIdRef,
    noteTypeRef,
    titleRef,
    contentRef,
    itemsRef,
    checkedItemsCollapsedRef,
    pinnedRef,
    archivedRef,
    colorRef,
  } = doc;

  // saveError and syncToast hold a translation key, not a translated string, so
  // a language switch re-renders them in the new language rather than leaving a
  // stale one on screen.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncToast, setSyncToast] = useState<string | null>(null);

  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const createItemMutation = useCreateNoteItem();
  const updateItemMutation = useUpdateNoteItem();
  const deleteItemMutation = useDeleteNoteItem();
  const reorderItemsMutation = useReorderNoteItems();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  // True for the whole duration of a zoom-close animation, from the moment an
  // exit action commits to closing until it actually dispatches the navigation
  // action. intentionalExitRef is only set at that final instant (not up front)
  // so a concurrent back press mid-animation still hits beforeRemove; it's
  // swallowed via this flag instead of falling through to a second, unguarded
  // pop.
  const isClosingRef = useRef(false);
  const hasPendingChangesRef = useRef(false);
  const [exitSavePrompt, setExitSavePrompt] = useState<ExitSavePrompt | null>(null);
  const [isExitRetrying, setIsExitRetrying] = useState(false);
  // Bumped on every edit (markDirtyAndScheduleUpdate). flushSave snapshots it
  // alongside the state refs so it can tell whether new edits arrived while its
  // network calls were in flight — clearing the dirty flag then would mark
  // those edits clean without ever saving them.
  const editSeqRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  // Guards the metadata PATCH path (pin/archive/color) the same way
  // saveInFlightRef guards the body/items save: those updates go through
  // useUpdateNote directly (not flushSave), so they don't touch saveInFlightRef.
  // While one is in flight the refresh effect must not re-apply a (possibly
  // stale) refetch and revert the optimistic pin/archive/color.
  const metadataUpdateInFlightRef = useRef(false);
  const requiresHydrationRef = useRef(initialNoteId !== null);

  // Auto-dismiss sync toast after 4 seconds
  useEffect(() => {
    if (!syncToast) return;
    const timer = setTimeout(() => setSyncToast(null), 4000);
    return () => clearTimeout(timer);
  }, [syncToast]);

  // Warn when another user updates this note *while we have unsaved edits*.
  // A clean editor auto-applies the remote change (see the refresh effect
  // below), so no warning is needed there; when the editor is dirty that
  // refresh is intentionally suppressed to protect the in-progress edits, so
  // this banner is the only signal that the note has diverged on the server.
  useSSESubscription(noteId, useCallback(() => {
    if (!hasPendingChangesRef.current) return;
    setSyncToast((prev) => prev ?? 'note.updatedByAnotherUser');
  }, []));

  // Baseline of the last-saved state, used to diff local edits into granular
  // per-item operations (and field-only scalar patches) instead of re-sending
  // the whole note — so a save here can't overwrite another device's edits.
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  const savedScalarsRef = useRef({ title: '', content: '', pinned: false, archived: false, color: DEFAULT_NOTE_COLOR, checked_items_collapsed: false });
  const isHydratingRef = useRef(initialNoteId !== null && !existingNote);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isHydratingRef.current = initialNoteId !== null && !existingNote;

  const createMutateRef = useRef(createMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  createMutateRef.current = createMutation.mutateAsync;
  const updateMutateRef = useRef(updateMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  updateMutateRef.current = updateMutation.mutateAsync;
  const createItemRef = useRef(createItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  createItemRef.current = createItemMutation.mutateAsync;
  const updateItemRef = useRef(updateItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  updateItemRef.current = updateItemMutation.mutateAsync;
  const deleteItemRef = useRef(deleteItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  deleteItemRef.current = deleteItemMutation.mutateAsync;
  const reorderItemsRef = useRef(reorderItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  reorderItemsRef.current = reorderItemsMutation.mutateAsync;

  // Applies a note from the offline cache to the editor's local state and
  // re-seeds the save baseline. Used both for the initial hydration and to
  // refresh the editor when the note changes underneath it (see below).
  const applyNoteToState = useCallback((note: Note) => {
    doc.setNoteType(note.note_type);
    doc.setPinned(note.pinned);
    doc.setArchived(note.archived);
    doc.setColor(note.color);
    doc.setLabels(note.labels ?? []);
    let nextItems: LocalItem[] = [];
    if (note.note_type === 'list') {
      doc.setTitle(note.title);
      doc.setCheckedItemsCollapsed(note.checked_items_collapsed);
      nextItems = note.items ? toLocalItems(note.items) : [];
      doc.setItems(nextItems);
    } else {
      doc.setContent(note.content);
    }
    // Seed the save baseline from the note so the next edit diffs against this
    // state rather than re-sending everything.
    savedScalarsRef.current = {
      title: note.note_type === 'list' ? note.title : '',
      content: note.note_type === 'text' ? note.content : '',
      pinned: note.pinned,
      archived: note.archived,
      color: note.color,
      checked_items_collapsed: note.note_type === 'list' ? note.checked_items_collapsed : false,
    };
    savedItemsRef.current = new Map(nextItems.map((it) => [it.id, itemSnapshot(it)]));
    savedOrderRef.current = nextItems.map((it) => it.id);
  }, [doc]);

  // Load existing note data (once, on first hydration).
  useEffect(() => {
    if (existingNote && !isInitializedRef.current) {
      applyNoteToState(existingNote);
      isInitializedRef.current = true;
      requiresHydrationRef.current = false;
    }
  }, [existingNote, applyNoteToState]);

  // Refresh the editor when the note changes underneath it — most visibly when
  // another user edits a shared note, which arrives via SSE → SQLite → this
  // query refetching and surfaces the "updated by another user" banner. Without
  // this, the banner showed but the checklist/content stayed stale.
  //
  // Only refresh when the editor has no unsaved edits and no save (body/items
  // or metadata) is in flight: a clean editor mirrors the last-saved baseline,
  // so replacing it with the newer note loses nothing. When the user has
  // in-progress edits we keep their state intact (the banner alone signals the
  // remote change) rather than risk clobbering them, since there is no
  // field-level merge here.
  useEffect(() => {
    if (
      existingNote
      && isInitializedRef.current
      && !hasPendingChangesRef.current
      && saveInFlightRef.current === null
      && !metadataUpdateInFlightRef.current
    ) {
      applyNoteToState(existingNote);
    }
  }, [existingNote, applyNoteToState]);

  // Keep labels in sync when note data refreshes after label mutations, even
  // while the body has unsaved edits (labels are edited via their own picker
  // and don't participate in the body's save baseline, so the refresh above
  // may be skipped as dirty). Redundant with that refresh when the editor is
  // clean, but idempotent.
  useEffect(() => {
    if (existingNote && isInitializedRef.current) {
      doc.setLabels(existingNote.labels ?? []);
    }
  }, [existingNote?.labels]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the queue drains, OfflineContext sets the React Query cache for the old local
  // ID to hold the server note. Detect this by checking whether the cached note's id
  // now differs from the local ID we hold, and update noteId + route params accordingly.
  useEffect(() => {
    if (existingNote && noteId && existingNote.id !== noteId) {
      doc.setNoteId(existingNote.id);
      navigation.setParams({ noteId: existingNote.id });
    }
  }, [existingNote?.id, noteId, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persists list-item changes as granular create/patch/delete/reorder ops by
  // diffing the current items against the saved baseline.
  const persistItemDiff = useCallback(async (currentNoteId: string, currentItems: LocalItem[]) => {
    const base = savedItemsRef.current;
    const curIds = new Set(currentItems.map((it) => it.id));

    // Advance the baseline incrementally after each successful op so a later
    // failure does not re-send already-applied ops on the next retry (which
    // would re-create items and get stuck on 409 Conflict).
    for (const it of currentItems) {
      const snap = base.get(it.id);
      if (!snap) {
        try {
          await createItemRef.current({
            noteId: currentNoteId,
            item: {
              id: it.id,
              text: it.text,
              position: it.position,
              completed: it.completed,
              parent_id: it.parentId,
              assigned_to: it.assigned_to || undefined,
            },
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
        await updateItemRef.current({ noteId: currentNoteId, itemId: it.id, data });
        base.set(it.id, itemSnapshot(it));
      }
    }

    for (const id of [...base.keys()]) {
      if (!curIds.has(id)) {
        await deleteItemRef.current({ noteId: currentNoteId, itemId: id });
        base.delete(id);
      }
    }

    const curOrder = currentItems.map((it) => it.id);
    const orderChanged = curOrder.length !== savedOrderRef.current.length
      || curOrder.some((id, i) => savedOrderRef.current[i] !== id);
    if (orderChanged && curOrder.length > 0) {
      await reorderItemsRef.current({ noteId: currentNoteId, itemIds: curOrder });
    }
    savedOrderRef.current = curOrder;
  }, []);

  const flushSave = useCallback(async (unmounting = false): Promise<boolean> => {
    if (!hasPendingChangesRef.current) return true;
    // If an existing note has local edits flagged but hasn't hydrated yet,
    // treat this as a failed flush so callers can retry after hydration.
    if (requiresHydrationRef.current && noteIdRef.current && !isInitializedRef.current) return false;

    // Serialize mutations: chain onto any in-flight save to prevent concurrent writes
    const predecessor = saveInFlightRef.current;
    const thisPromise = (async () => {
      if (predecessor) {
        try { await predecessor; } catch { /* handled by prior caller */ }
      }

      const currentNoteId = noteIdRef.current;
      const currentTitle = titleRef.current;
      const currentContent = contentRef.current;
      const currentItems = itemsRef.current;
      const currentCollapsed = checkedItemsCollapsedRef.current;
      const currentNoteType = noteTypeRef.current;
      const currentColor = colorRef.current;
      const currentPinned = pinnedRef.current;
      const currentArchived = archivedRef.current;
      const capturedEditSeq = editSeqRef.current;

      // Clear the dirty flag only if no edit arrived while the awaited network
      // calls below were in flight. A mid-save keystroke re-marks dirty and
      // schedules its own debounced save; unconditionally clearing here would
      // wipe that flag, the debounced flushSave would early-return on "no
      // pending changes", and the mid-save edit would be silently lost on exit.
      const clearPendingUnlessEditedMidSave = () => {
        if (editSeqRef.current === capturedEditSeq) {
          hasPendingChangesRef.current = false;
        }
      };

      const captureBaseline = () => {
        savedScalarsRef.current = {
          title: currentTitle,
          content: currentContent,
          pinned: currentPinned,
          archived: currentArchived,
          color: currentColor,
          checked_items_collapsed: currentCollapsed,
        };
        savedItemsRef.current = new Map(currentItems.map((it) => [it.id, itemSnapshot(it)]));
        savedOrderRef.current = currentItems.map((it) => it.id);
      };

      if (!currentNoteId) {
        const isEmpty = currentNoteType === 'list'
          ? !currentTitle && currentItems.length === 0
          : !currentContent;
        if (isEmpty) {
          hasPendingChangesRef.current = false;
          return true;
        }
        const req: CreateNoteRequest = currentNoteType === 'list'
          ? {
              note_type: 'list',
              title: currentTitle,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
              items: serializeItems(currentItems),
            }
          : {
              note_type: 'text',
              content: currentContent,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
            };
        const newNote = await createMutateRef.current(req);
        clearPendingUnlessEditedMidSave();
        // The server honors the client-supplied item IDs, so the items we just
        // sent become the baseline for subsequent granular edits.
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        noteIdRef.current = newNote.id;
        doc.setNoteId(newNote.id);
        doc.setHasCreated(true);
        setSaveError(null);
      } else {
        // Patch only the scalar fields that changed, so a list-item edit never
        // re-sends the title and vice versa, and another device's concurrent
        // changes to untouched fields are preserved.
        const base = savedScalarsRef.current;
        const scalarData: UpdateNoteRequest = {};
        if (currentNoteType === 'list') {
          if (currentTitle !== base.title) (scalarData as UpdateListNoteRequest).title = currentTitle;
          if (currentCollapsed !== base.checked_items_collapsed) (scalarData as UpdateListNoteRequest).checked_items_collapsed = currentCollapsed;
        } else if (currentContent !== base.content) {
          (scalarData as UpdateTextNoteRequest).content = currentContent;
        }
        if (currentPinned !== base.pinned) scalarData.pinned = currentPinned;
        if (currentArchived !== base.archived) scalarData.archived = currentArchived;
        if (currentColor !== base.color) scalarData.color = currentColor;

        if (Object.keys(scalarData).length > 0) {
          await updateMutateRef.current({ id: currentNoteId, data: scalarData });
        }

        // Items are persisted as granular per-item operations.
        if (currentNoteType === 'list') {
          await persistItemDiff(currentNoteId, currentItems);
        }

        clearPendingUnlessEditedMidSave();
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        setSaveError(null);
      }

      return true;
    })();

    saveInFlightRef.current = thisPromise;
    try {
      await thisPromise;
      return true;
    } catch (err) {
      console.error('Failed to save note:', err);
      if (isMountedRef.current && !unmounting) {
        setSaveError('note.failedSaveChanges');
      }
      return false;
    } finally {
      if (saveInFlightRef.current === thisPromise) {
        saveInFlightRef.current = null;
      }
    }
  }, [doc, persistItemDiff, noteIdRef, noteTypeRef, titleRef, contentRef, itemsRef, checkedItemsCollapsedRef, pinnedRef, archivedRef, colorRef]);

  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      flushSave();
    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
  }, [flushSave]);

  const markDirtyAndScheduleUpdate = useCallback(() => {
    editSeqRef.current += 1;
    hasPendingChangesRef.current = true;
    scheduleUpdate();
  }, [scheduleUpdate]);

  // Drops a debounced save that hasn't fired yet. Callers that are about to
  // write through a different path (a toggle API call, a delete, a redirect)
  // use this so the debounced save can't race them.
  const cancelScheduledSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    cancelScheduledSave();
    return flushSave();
  }, [cancelScheduledSave, flushSave]);

  // Metadata actions (pin/archive/color) flush pending item edits first, then
  // PATCH only the field that changed. Sending just the changed scalar avoids
  // re-sending (and clobbering) items or other fields edited concurrently
  // elsewhere. The caller advances the saved baseline only after the PATCH
  // succeeds (see commitMetadataBaseline).
  //
  // The PATCH is held under metadataUpdateInFlightRef so the refresh effect
  // above won't revert the optimistic change with a stale refetch that lands
  // mid-request.
  const runMetadataUpdate = useCallback(async (id: string, data: Partial<UpdateNoteRequest>) => {
    metadataUpdateInFlightRef.current = true;
    try {
      await updateMutation.mutateAsync({ id, data: data as UpdateNoteRequest });
    } finally {
      metadataUpdateInFlightRef.current = false;
    }
  }, [updateMutation]);

  const commitMetadataBaseline = useCallback((overrides: Partial<UpdateNoteRequest>) => {
    Object.assign(savedScalarsRef.current, overrides);
  }, []);

  // Mark the exit as intentional (so beforeRemove doesn't re-handle it) only
  // once the navigation action is about to dispatch, optionally zooming back
  // onto the originating card first. isClosingRef is set immediately instead,
  // so a back press that lands mid-animation still hits beforeRemove and gets
  // swallowed there rather than falling through to an unguarded second pop.
  const exitWith = useCallback((navAction: NavigationAction, wantsZoom: boolean) => {
    setExitSavePrompt(null);
    const dispatch = () => {
      intentionalExitRef.current = true;
      navigation.dispatch(navAction);
    };
    if (wantsZoom) {
      isClosingRef.current = true;
      void animateClose().then(dispatch);
    } else {
      dispatch();
    }
  }, [animateClose, navigation]);

  // Flush pending edits without blocking navigation — used when we deliberately
  // let the user leave (server known-unreachable) and on an unexpected unmount.
  // flushSave(true) still reports failure via its return value even though its
  // `unmounting` guard suppresses the in-editor error banner (the editor is on
  // its way out), so a genuine background-save failure would otherwise vanish
  // silently. Surface it with a global toast, which outlives this screen.
  //
  // showToast is read through a ref so this callback's identity tracks only
  // flushSave — matching the unmount-flush effect's original `[flushSave]`
  // dependency exactly. (A direct showToast dependency would let an unstable
  // toast identity re-run that effect, and re-fire the flush, on every render.)
  const showToastRef = useRef(showToast);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  showToastRef.current = showToast;
  const flushInBackground = useCallback(() => {
    void flushSave(true)
      .then((saved) => {
        if (!saved) showToastRef.current(t('note.failedSaveChanges'), 'error');
      })
      .catch(() => showToastRef.current(t('note.failedSaveChanges'), 'error'));
  }, [flushSave, t]);

  // Intercept navigation away to flush pending edits before leaving, and to play
  // the zoom-back-onto-the-card animation for back navigation.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      // Programmatic exits (delete/archive/duplicate) already set this and run
      // their own zoom/goBack, so don't re-handle them here.
      if (intentionalExitRef.current) {
        return;
      }
      // A zoom-close animation from this or another exit action is already
      // playing — swallow this concurrent attempt so it doesn't pop an extra
      // screen once that animation finishes and dispatches its own action.
      if (isClosingRef.current) {
        event.preventDefault();
        return;
      }
      const action = event.data.action;
      const isBack = action.type === 'GO_BACK' || action.type === 'POP';
      // Zoom back onto the card for any back navigation (header button or
      // hardware back; the swipe gesture is disabled). Other removals fall
      // through to an instant dispatch.
      const wantsZoom = isBack && zoomEnabled;
      const hasPending = hasPendingChangesRef.current;
      if (!hasPending && !wantsZoom) {
        return;
      }
      cancelScheduledSave();

      // No pending edits: nothing to save. Zoom back onto the card (a non-zoom
      // back nav without pending edits already returned above).
      if (!hasPending) {
        event.preventDefault();
        exitWith(action, wantsZoom);
        return;
      }

      // Server known-unreachable: an online write would only stall for the
      // request timeout before falling back to the local-persist + queue path,
      // so there is nothing to wait for. Flush in the background and let the exit
      // proceed — blocking here is what made leaving a note with unsaved edits
      // feel frozen while the server was down. The edit stays durable: flushSave
      // writes it to the local DB and enqueues it for replay. Mark the exit
      // intentional so the unmount cleanup below doesn't flush a second time; when
      // a zoom-back is wanted we still preventDefault and drive it via exitWith.
      if (!isServerReachable()) {
        intentionalExitRef.current = true;
        flushInBackground();
        if (wantsZoom) {
          event.preventDefault();
          exitWith(action, wantsZoom);
        }
        return;
      }

      // Server reachable: await the save so a genuine, non-queueable failure
      // (validation/conflict) can still prompt Retry/Discard instead of silently
      // dropping the edit. A reachable server responds promptly, so this path no
      // longer reintroduces the long stall.
      event.preventDefault();
      void (async () => {
        const saveSucceeded = await flushSave();
        if (!saveSucceeded) {
          setExitSavePrompt({ navAction: action, wantsZoom, retriesLeft: MAX_EXIT_SAVE_RETRIES });
          return;
        }
        exitWith(action, wantsZoom);
      })();
    });
    return unsubscribe;
  }, [cancelScheduledSave, exitWith, flushSave, flushInBackground, navigation, zoomEnabled]);

  const handleExitDiscard = useCallback(() => {
    if (!exitSavePrompt || isExitRetrying) return;
    exitWith(exitSavePrompt.navAction, exitSavePrompt.wantsZoom);
  }, [exitSavePrompt, exitWith, isExitRetrying]);

  // Guarded by isExitRetrying so a retry in flight can't race a second tap on
  // Retry or Discard into a double dispatch or a stale retriesLeft update —
  // the dialog also disables both buttons via `busy` while this is true.
  const handleExitRetry = useCallback(async () => {
    if (!exitSavePrompt || isExitRetrying) return;
    setIsExitRetrying(true);
    const { navAction, wantsZoom, retriesLeft } = exitSavePrompt;
    const retrySucceeded = await flushSave();
    if (retrySucceeded) {
      exitWith(navAction, wantsZoom);
    } else {
      setExitSavePrompt({ navAction, wantsZoom, retriesLeft: retriesLeft - 1 });
    }
    setIsExitRetrying(false);
  }, [exitSavePrompt, exitWith, flushSave, isExitRetrying]);

  // Flush pending save on unmount (prevent data loss), skip if intentionally exiting
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!intentionalExitRef.current && hasPendingChangesRef.current) {
        flushInBackground();
      }
    };
  }, [flushInBackground]);

  return {
    saveError,
    setSaveError,
    syncToast,
    setSyncToast,
    flushSave,
    flushPendingChanges,
    cancelScheduledSave,
    markDirtyAndScheduleUpdate,
    runMetadataUpdate,
    commitMetadataBaseline,
    savedItemsRef,
    savedOrderRef,
    isHydratingRef,
    intentionalExitRef,
    isClosingRef,
    saveInFlightRef,
    exitSavePrompt,
    isExitRetrying,
    handleExitRetry,
    handleExitDiscard,
  };
}
