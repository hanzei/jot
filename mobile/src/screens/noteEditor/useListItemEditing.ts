import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, type ScrollView, type TextInput as TextInputType } from 'react-native';
import {
  reorderItems,
  type ReorderableListDragEndEvent,
  type ReorderableListDragStartEvent,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { TFunction } from 'i18next';
import {
  VALIDATION,
  applyCompletedValues,
  completedCascadeScope,
  completedPriorById,
  distinctCompletedTexts,
  findSuggestedItem,
  generateId,
  reinsertIds,
  reviveSuggestedItem,
  splitPasteIntoItems,
  truncateToCodePoints,
  type CompletedWriteTracker,
  type ServerCompletedItem,
} from '@jot/shared';
import {
  useDeleteCompletedItems,
  useToggleNoteItemCompleted,
  useUncheckAllItems,
} from '../../hooks/useNotes';
import type { ConfirmOptions } from '../../hooks/useConfirm';
import type { ToastAction, ToastType } from '../../hooks/useToast';
import { animateListReflow } from '../../utils/layoutAnimation';
import type { ListItemSelectionHandle } from '../../components/ListItem';
import {
  applyCompletedCascade,
  changeItemIndent,
  dropTargetParentId,
  indentLevelFromDrag,
  itemHasChildren,
  normalizeItemOrder,
  type ItemSnapshot,
  type LocalItem,
} from './listItemModel';
import type { ListItemHandlers } from './CheckedItemsSection';
import type { EditorDocHandle } from './useEditorDoc';
import { useRevealFocusedInput } from './useRevealFocusedInput';

// How long the Android bar outlives a row's blur before hiding, so tapping from
// one row to the next does not flash it away and back.
const ITEM_BLUR_SETTLE_MS = 150;

export interface UseListItemEditingParams {
  doc: EditorDocHandle;
  /** Current items as render state; the hook derives its lists from these. */
  items: LocalItem[];
  /** Flags the editor dirty and (re)arms the debounced save. */
  markDirtyAndScheduleUpdate: () => void;
  /** Drops a debounced save that would otherwise race a direct item write. */
  cancelScheduledSave: () => void;
  /** Surfaces the in-editor save-failure banner when an item write is rejected. */
  setSaveError: React.Dispatch<React.SetStateAction<string | null>>;
  /** Save baseline, advanced in step with the item writes made here. */
  savedItemsRef: React.RefObject<Map<string, ItemSnapshot>>;
  savedOrderRef: React.RefObject<string[]>;
  /** Surfaces the pending bar while a bulk item write is in flight. */
  withPendingIndicator: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Runs an item write with the editor's refresh effect held off, so a note
   * re-read that resolves mid-write can't apply the pre-write item state over
   * the optimistic one.
   */
  withItemWriteInFlight: <T>(op: () => Promise<T>) => Promise<T>;
  /** The editor's completed-write tracker (owned by useNoteEditorSync). */
  completedWrites: CompletedWriteTracker;
  /** The editor's scroll container, kept scrolled to the focused row. */
  scrollViewRef: React.RefObject<ScrollView | null>;
  /** Opens the assignee picker for a row (the picker's state lives in the screen). */
  openAssigneePicker: (itemId: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  t: TFunction;
}

export interface ListItemEditing {
  /**
   * The rows the reorderable list renders: the active (unchecked) items in
   * order, minus the children of a parent that is being dragged — those are
   * folded into it for the drag and re-seated under it on drop.
   */
  activeListRows: LocalItem[];
  /** Completed rows, for the collapsed section below the list. */
  checkedItems: LocalItem[];
  /** id → index into the full `items` array, so rows don't need an indexOf. */
  itemIndexMap: Map<string, number>;
  itemIndexMapRef: React.RefObject<Map<string, number>>;
  /** Distinct completed texts, offered as suggestions while typing a new row. */
  completedItemTexts: string[];
  /** Id of the row that was just checked off, so it pops on mount. */
  popItemId: string | null;
  /** Whether any row currently holds the caret (drives the Android bar). */
  isEditingItem: boolean;
  /** Id of the row holding the caret (held through the blur-settle window), or null. */
  focusedItemId: string | null;

  getItemRef: (id: string) => React.RefObject<TextInputType | null>;
  getItemSelectionRef: (id: string) => React.RefObject<ListItemSelectionHandle | null>;
  /**
   * The caret handles of the currently rendered rows, keyed by item id. Read
   * (never populated) by the item formatting bar, which acts on whichever row
   * holds the caret.
   */
  itemSelectionRefsMap: React.RefObject<Map<string, React.RefObject<ListItemSelectionHandle | null>>>;
  /** Id of the row that should grab focus as it mounts, if any. */
  autoFocusItemIdRef: React.RefObject<string | null>;
  /** Id of the row that currently holds focus, if any. */
  focusedItemIdRef: React.RefObject<string | null>;
  /** Live horizontal travel of the row being dragged, for drag-to-indent. */
  dragTranslateX: ReturnType<typeof useSharedValue<number>>;

  /** Per-item callbacks, shared by the active list and the completed section. */
  listItemHandlers: ListItemHandlers;
  handleAddItem: () => void;
  handleItemTextChange: (index: number, text: string) => void;
  handleAcceptSuggestion: (itemId: string, suggestionText: string) => void;
  handleAssignItem: (itemId: string, userId: string) => void;
  handleUncheckAllItems: () => Promise<void>;
  handleDeleteCompletedItems: () => Promise<void>;
  /** Enter in the title: focus the first active row, appending one if there is none. */
  focusFirstUncheckedOrAppend: () => void;

  listDragGesture: ReturnType<typeof Gesture.Pan>;
  handleListDragStart: (event: ReorderableListDragStartEvent) => void;
  handleListDragEnd: (event: ReorderableListDragEndEvent) => void;
  handleListReorder: (event: ReorderableListReorderEvent) => void;
  /** Indents (1) or outdents (-1) the row holding the caret by one level. */
  handleIndentFocusedItem: (delta: 1 | -1) => void;
  /** Spread onto the scroll container: keeps the focused row in view as it resizes. */
  editorScrollProps: ReturnType<typeof useRevealFocusedInput>['scrollViewProps'];
}

/**
 * List-item editing: the per-row CRUD the editor exposes (add, split, delete,
 * paste, toggle, assign, bulk uncheck/delete), the focus bookkeeping those
 * operations need, and the drag orchestration that reorders and re-indents
 * rows.
 *
 * Item writes take two different routes to the server, which is why this hook
 * needs both halves of the save engine: ordinary text edits are folded into the
 * debounced diff (`markDirtyAndScheduleUpdate`), while toggles and bulk
 * operations have their own endpoints and go out immediately, advancing the
 * save baseline themselves so the diff engine doesn't re-send what they already
 * applied.
 *
 * Of those, only the toggle cancels a pending debounced save
 * (`cancelScheduledSave`), so that save can't race its API call. The bulk
 * operations leave a scheduled save armed.
 */
export function useListItemEditing({
  doc,
  items,
  markDirtyAndScheduleUpdate,
  cancelScheduledSave,
  setSaveError,
  savedItemsRef,
  savedOrderRef,
  withPendingIndicator,
  withItemWriteInFlight,
  completedWrites,
  scrollViewRef,
  openAssigneePicker,
  confirm,
  showToast,
  t,
}: UseListItemEditingParams): ListItemEditing {
  const { itemsRef, noteIdRef, setItems } = doc;

  const toggleItemCompletedMutation = useToggleNoteItemCompleted();
  const uncheckAllItemsMutation = useUncheckAllItems();
  const deleteCompletedItemsMutation = useDeleteCompletedItems();

  const toggleItemCompletedRef = useRef(toggleItemCompletedMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  toggleItemCompletedRef.current = toggleItemCompletedMutation.mutateAsync;
  const uncheckAllItemsRef = useRef(uncheckAllItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  uncheckAllItemsRef.current = uncheckAllItemsMutation.mutateAsync;
  const deleteCompletedItemsRef = useRef(deleteCompletedItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  deleteCompletedItemsRef.current = deleteCompletedItemsMutation.mutateAsync;

  // Persists a completed-flag change already applied to the editor. `priorById`
  // holds the value each changed item had before it; `request` sends the write
  // and resolves to the note's full item list, or to [] when it was queued
  // offline. Runs inside the item-write in-flight window, so until the
  // reconciled state is set no note re-read is applied over it. Resolves false
  // only when the request failed and the flags were reverted.
  const persistCompletedWrite = useCallback(async (
    priorById: ReadonlyMap<string, boolean>,
    request: () => Promise<ServerCompletedItem[]>,
  ): Promise<boolean> => {
    const applyItems = (completedById: ReadonlyMap<string, boolean>) => {
      const next = applyCompletedValues(itemsRef.current, completedById);
      if (next === itemsRef.current) return;
      itemsRef.current = next;
      setItems(next);
    };
    // Advance the baseline so the diff engine does not re-patch completed
    const syncBaseline = (completedById: ReadonlyMap<string, boolean>) => {
      for (const entry of completedById) {
        const snap = savedItemsRef.current.get(entry[0]);
        if (snap) savedItemsRef.current.set(entry[0], { ...snap, completed: entry[1] });
      }
    };
    const write = completedWrites.begin(priorById);
    try {
      const serverItems = await request();
      if (serverItems.length > 0) {
        // Online: the response is the note's full item list as of this write, so
        // it still reports any row tapped after this one unchecked — apply only
        // what the gate says it may still decide, composing on the latest state
        // so a concurrent write's optimistic change is preserved.
        const completedById = completedWrites.accept(write, serverItems);
        applyItems(completedById);
        syncBaseline(completedById);
      } else {
        // Offline: the local DB already holds the change; advance the baseline
        // for the items no later write has taken over.
        const decided = new Map<string, boolean>();
        for (const entry of priorById) {
          if (completedWrites.decides(write, entry[0])) decided.set(entry[0], !entry[1]);
        }
        syncBaseline(decided);
      }
      return true;
    } catch {
      // Revert only the items no later write has taken over, so a concurrent
      // write's optimistic state survives.
      applyItems(completedWrites.fail(write));
      setSaveError('note.failedSaveChanges');
      return false;
    } finally {
      completedWrites.end(write);
    }
  }, [completedWrites, itemsRef, savedItemsRef, setItems, setSaveError]);

  // Id of the item the user just checked off, so its completed-section row pops
  // on mount. Cleared shortly after so a later collapse/expand doesn't re-pop.
  const [popItemId, setPopItemId] = useState<string | null>(null);
  const popClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (popClearRef.current) clearTimeout(popClearRef.current); }, []);

  // Live horizontal travel of the row currently being dragged. The list pan's
  // onChange writes translationX here; the active row snaps it to an indent step
  // for Keep-style drag-to-indent, and the drop handler reads it to commit.
  const dragTranslateX = useSharedValue(0);

  const itemInputRefsMap = useRef(new Map<string, React.RefObject<TextInputType | null>>());
  const autoFocusItemIdRef = useRef<string | null>(null);
  const autoFocusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // autoFocus is only consumed at mount, so arm it for the row that is about to
  // (re)mount and clear it after a short delay: a later unmount/remount of the
  // same id must not re-open the keyboard. Cancels any pending clear from a
  // previous call before rescheduling.
  const armAutoFocus = useCallback((itemId: string) => {
    autoFocusItemIdRef.current = itemId;
    if (autoFocusClearTimerRef.current !== null) clearTimeout(autoFocusClearTimerRef.current);
    autoFocusClearTimerRef.current = setTimeout(() => { autoFocusItemIdRef.current = null; }, 500);
  }, []);
  // Id of the list item whose input currently has focus, if any. Tracked so a
  // drag-triggered reorder can restore focus to it (see commitDrag) — the
  // reorderable list forces a remount of any row whose slot changes, which
  // otherwise drops the focused TextInput and lets it fall back to whatever
  // the OS picks next (observed: the title input).
  const focusedItemIdRef = useRef<string | null>(null);

  // Whether any row currently holds the caret. A ref drives the formatting
  // bar's *target* (above); this drives whether Android draws the bar at all,
  // which has to be state.
  // The id travels as state, not just the ref, so the bar's indent buttons can
  // enable or disable themselves for whichever row has the caret.
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  // The same id as `focusedItemId`, readable without a dependency: held through
  // the blur-settle window, unlike `focusedItemIdRef`, which blur clears at once.
  const heldFocusedItemIdRef = useRef<string | null>(null);
  const isEditingItem = focusedItemId !== null;
  const clearEditingItemRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clearEditingItemRef.current) clearTimeout(clearEditingItemRef.current);
    },
    [],
  );

  const getItemRef = useCallback((id: string): React.RefObject<TextInputType | null> => {
    if (!itemInputRefsMap.current.has(id)) {
      itemInputRefsMap.current.set(id, React.createRef<TextInputType>());
    }
    return itemInputRefsMap.current.get(id)!;
  }, []);

  // The caret counterpart of itemInputRefsMap: the formatting bar reads and
  // writes the selection of the row it is editing through these.
  const itemSelectionRefsMap = useRef(new Map<string, React.RefObject<ListItemSelectionHandle | null>>());

  const getItemSelectionRef = useCallback(
    (id: string): React.RefObject<ListItemSelectionHandle | null> => {
      if (!itemSelectionRefsMap.current.has(id)) {
        itemSelectionRefsMap.current.set(id, React.createRef<ListItemSelectionHandle>());
      }
      return itemSelectionRefsMap.current.get(id)!;
    },
    [],
  );

  // Keep input refs bounded to currently rendered items.
  useEffect(() => {
    const activeItemIds = new Set(items.map((item) => item.id));
    for (const id of itemInputRefsMap.current.keys()) {
      if (!activeItemIds.has(id)) {
        itemInputRefsMap.current.delete(id);
      }
    }
    for (const id of itemSelectionRefsMap.current.keys()) {
      if (!activeItemIds.has(id)) {
        itemSelectionRefsMap.current.delete(id);
      }
    }
  }, [items]);

  // New list items get a server-format ID up front so they keep a stable
  // identity across granular per-item updates and offline replay.
  function nextTempId(): string {
    return generateId();
  }

  // Resolves false only when the request failed and the flags were reverted.
  const handleItemCompletedToggle = useCallback(
    async (itemId: string, completed: boolean): Promise<boolean> => {
      // itemsRef.current is the authoritative latest state here: each branch
      // below writes the new array back to it synchronously, so a rapid
      // follow-up toggle (fired before React re-renders) composes on the most
      // recent optimistic state rather than a stale render snapshot. Without
      // this, rows flicker back into the active list and an overlapping
      // parent/child toggle captures a stale prior snapshot, corrupting its
      // rollback and save baseline (issue: mobile item flicker).
      const before = itemsRef.current;
      const target = before.find((item) => item.id === itemId);
      if (!target || target.completed === completed) return true;

      // Capture the prior completed state of just the items this toggle changes
      // (the item plus, for a top-level item, its children — or, for a child
      // being unchecked, its parent) from that latest state. Used to advance
      // the save baseline and to revert precisely on failure — without
      // clobbering any other item whose state may change before this async
      // call settles.
      const priorById = completedPriorById(before, completedCascadeScope(before, itemId, completed), completed);

      // Optimistic cascade applied immediately, with a subtle settle as the
      // item moves between the active list and the completed section.
      const optimisticItems = applyCompletedCascade(before, itemId, completed);
      itemsRef.current = optimisticItems;
      animateListReflow();
      // Flag the just-checked item so its completed-section row pops on mount,
      // then clear the flag so a later collapse/expand doesn't replay the pop.
      if (popClearRef.current) clearTimeout(popClearRef.current);
      if (completed) {
        setPopItemId(itemId);
        popClearRef.current = setTimeout(() => setPopItemId(null), 400);
      } else {
        setPopItemId(null);
      }
      setItems(optimisticItems);

      // For unsaved new notes, let the bulk-create carry completed flags
      const currentNoteId = noteIdRef.current;
      if (!currentNoteId) {
        markDirtyAndScheduleUpdate();
        return true;
      }

      // Cancel any pending debounced save to avoid a race with the toggle API call
      cancelScheduledSave();

      // The request and the reconcile that follows it both run inside the
      // in-flight window: until the reconciled state is set, a note re-read
      // still describes this item as it was before the tap.
      return withItemWriteInFlight(() => persistCompletedWrite(priorById, () =>
        toggleItemCompletedRef.current({ noteId: currentNoteId, itemId, completed })));
    },
    [cancelScheduledSave, itemsRef, markDirtyAndScheduleUpdate, noteIdRef, persistCompletedWrite, setItems, withItemWriteInFlight],
  );

  // Unchecks every currently-completed item in one bulk request (overflow
  // menu). Non-destructive and easy to redo by hand, so no confirmation.
  const handleUncheckAllItems = useCallback(async () => {
    const noteId = noteIdRef.current;
    const before = itemsRef.current;
    const completed = before.filter((item) => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map((item) => item.id);

    const optimistic = before.map((item) => (item.completed ? { ...item, completed: false } : item));
    itemsRef.current = optimistic;
    setItems(optimistic);

    if (!noteId) {
      // Unsaved new note: let the bulk-create carry the completed flags.
      markDirtyAndScheduleUpdate();
      return;
    }

    await withItemWriteInFlight(() => withPendingIndicator(() =>
      persistCompletedWrite(new Map(ids.map((id) => [id, true])), () =>
        uncheckAllItemsRef.current({ noteId, itemIds: ids }))));
  }, [itemsRef, markDirtyAndScheduleUpdate, noteIdRef, persistCompletedWrite, setItems, withItemWriteInFlight, withPendingIndicator]);

  // Deletes every currently-completed item after a confirm dialog (overflow
  // menu); mobile has no in-editor undo-bar equivalent to the web's
  // deferred-delete flow, so this confirms up front instead. Deleting exactly
  // the completed set never orphans a child: the completed-cascade invariant
  // (applyCompletedCascade / collectToggleCascade) guarantees a completed
  // parent's children are completed too, so they are always in the same set.
  const handleDeleteCompletedItems = useCallback(async () => {
    const pendingCount = itemsRef.current.filter((item) => item.completed).length;
    if (pendingCount === 0) return;

    const confirmed = await confirm({
      title: t('note.deleteCheckedItems'),
      message: t('note.deleteCheckedItemsConfirm', { count: pendingCount }),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!confirmed) return;

    const before = itemsRef.current;
    const completed = before.filter((item) => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map((item) => item.id);
    const idSet = new Set(ids);
    const remaining = before.filter((item) => !item.completed);
    const beforeSavedItems = new Map(savedItemsRef.current);
    const beforeSavedOrder = [...savedOrderRef.current];

    itemsRef.current = remaining;
    setItems(remaining);
    for (const id of ids) savedItemsRef.current.delete(id);
    savedOrderRef.current = savedOrderRef.current.filter((id) => !idSet.has(id));

    const noteId = noteIdRef.current;
    if (!noteId) {
      // Unsaved new note: let the bulk-create carry what's left in `items`.
      markDirtyAndScheduleUpdate();
      return;
    }

    await withItemWriteInFlight(() => withPendingIndicator(async () => {
      try {
        await deleteCompletedItemsRef.current({ noteId, itemIds: ids });
      } catch {
        // Restore only the deleted items, on top of whatever itemsRef.current
        // has become since — an edit or addition made to another item while
        // the request was in flight must survive the revert, not just the
        // stale `before` snapshot.
        const byId = new Map(before.map((item) => [item.id, item]));
        const revertedIds = reinsertIds(itemsRef.current.map((item) => item.id), before.map((item) => item.id), idSet);
        const currentById = new Map(itemsRef.current.map((item) => [item.id, item]));
        const reverted = revertedIds.map((id) => currentById.get(id) ?? byId.get(id)!);
        itemsRef.current = reverted;
        setItems(reverted);

        for (const id of ids) {
          const snap = beforeSavedItems.get(id);
          if (snap) savedItemsRef.current.set(id, snap);
        }
        savedOrderRef.current = reinsertIds(savedOrderRef.current, beforeSavedOrder, idSet);

        setSaveError('note.failedSaveChanges');
      }
    }));
  }, [confirm, itemsRef, markDirtyAndScheduleUpdate, noteIdRef, savedItemsRef, savedOrderRef, setItems, setSaveError, t, withItemWriteInFlight, withPendingIndicator]);

  const handleItemTextChange = useCallback(
    (index: number, text: string) => {
      if (!text.includes('\n')) {
        // Clamp like the paste paths below: the server rejects longer item text
        // with a 400, which would wedge the save (or dead-letter it offline).
        const clamped = truncateToCodePoints(text, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: clamped } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      // Multi-line paste: split into separate items. React Native reports the
      // row's whole new text rather than the pasted fragment, so the text
      // around the caret is already part of `text` and before/after are empty.
      // The shared helper does the line parsing, truncation, group inheritance
      // and the item-count cap, so this matches the webapp's paste exactly.
      const prepasteItems = [...itemsRef.current];
      const result = splitPasteIntoItems(prepasteItems, index, text, { before: '', after: '' }, nextTempId);
      if (!result) return;
      if ('error' in result) {
        // Over the cap the server rejects the save with a 422, which the sync
        // queue treats as permanent and dead-letters. Refuse the paste instead;
        // leaving items untouched snaps the controlled input back to its text.
        showToast(t('note.tooManyItems', { max: result.max }), 'error');
        return;
      }

      setItems(result.items);
      markDirtyAndScheduleUpdate();

      if (result.insertedIds.length === 0) return;

      showToast(t('note.itemsPasted', { count: result.insertedIds.length }), 'info', {
        label: t('dashboard.undo'),
        onPress: () => {
          setItems(prepasteItems);
          markDirtyAndScheduleUpdate();
        },
      });

      const lastItemRef = getItemRef(result.caretItemId);
      setTimeout(() => lastItemRef.current?.focus(), 50);
    },
    [markDirtyAndScheduleUpdate, getItemRef, itemsRef, setItems, showToast, t],
  );

  const handleDeleteItem = useCallback(
    (index: number) => {
      const removedItemId = itemsRef.current[index]?.id;
      if (removedItemId) {
        if (itemInputRefsMap.current.get(removedItemId)?.current?.isFocused()) {
          Keyboard.dismiss();
        }
        itemInputRefsMap.current.delete(removedItemId);
      }
      // Settle the surrounding rows as this one is removed instead of snapping.
      animateListReflow();
      setItems((prev) => prev.filter((_, i) => i !== index));
      markDirtyAndScheduleUpdate();
    },
    [itemsRef, markDirtyAndScheduleUpdate, setItems],
  );

  const handleAddItem = useCallback(() => {
    const newId = nextTempId();
    // Mark before setItems so the item mounts with autoFocus={true}, which
    // reliably opens the soft keyboard (programmatic focus() doesn't always
    // trigger the IME on Android for newly mounted inputs).
    armAutoFocus(newId);
    // Ease the new row in rather than having the list jump to make room.
    animateListReflow();
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
    ]);
    markDirtyAndScheduleUpdate();
  }, [armAutoFocus, markDirtyAndScheduleUpdate, setItems]);

  // handleItemEnterAtCursor mirrors the webapp's Enter-key handling:
  //  - cursor at the very start of a non-empty item -> insert a blank item
  //    before it (leaving its own text untouched), focus the new item;
  //  - cursor mid-text -> split the item into two at the cursor, focus the
  //    new (second) item with its cursor at the start;
  //  - cursor at the end (or item is empty) -> append a blank item after
  //    (previous default behavior).
  // Newly created items inherit the current item's group (parentId),
  // assignee, and completed state.
  const handleItemEnterAtCursor = useCallback((index: number, cursorPosition: number) => {
    const currentItem = itemsRef.current[index];
    if (!currentItem) return;

    const text = currentItem.text;
    const cursorPos = Math.max(0, Math.min(cursorPosition, text.length));

    if (cursorPos === 0 && text.length > 0) {
      const newId = nextTempId();
      const newItemRef = getItemRef(newId);
      setItems((prev) => {
        const newItem: LocalItem = {
          id: newId,
          text: '',
          completed: prev[index]?.completed ?? false,
          position: index,
          parentId: prev[index]?.parentId ?? null,
          assigned_to: prev[index]?.assigned_to ?? '',
        };
        const next = [...prev.slice(0, index), newItem, ...prev.slice(index)];
        return next.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();
      setTimeout(() => newItemRef.current?.focus(), 50);
      return;
    }

    if (cursorPos > 0 && cursorPos < text.length) {
      const before = text.slice(0, cursorPos);
      const after = text.slice(cursorPos);
      const newId = nextTempId();
      const newItemRef = getItemRef(newId);
      setItems((prev) => {
        const split = prev[index];
        if (!split) return prev;
        const newItem: LocalItem = {
          id: newId,
          text: after,
          completed: split.completed,
          position: index + 1,
          parentId: split.parentId,
          assigned_to: split.assigned_to,
        };
        const next = [
          ...prev.slice(0, index),
          { ...split, text: before },
          newItem,
          ...prev.slice(index + 1),
        ];
        return next.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();
      setTimeout(() => {
        newItemRef.current?.focus();
        // Not all TextInput host implementations (e.g. test mocks) provide
        // this imperative method, so guard the call.
        newItemRef.current?.setSelection?.(0, 0);
      }, 50);
      return;
    }

    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => {
      const newItem: LocalItem = {
        id: newId,
        text: '',
        completed: prev[index]?.completed ?? false,
        position: index + 1,
        parentId: prev[index]?.parentId ?? null,
        assigned_to: '',
      };
      const next = [...prev.slice(0, index + 1), newItem, ...prev.slice(index + 1)];
      return next.map((item, i) => ({ ...item, position: i }));
    });
    markDirtyAndScheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [markDirtyAndScheduleUpdate, getItemRef, itemsRef, setItems]);

  const handleBackspaceOnEmpty = useCallback((index: number) => {
    const currentItems = itemsRef.current;
    const item = currentItems[index];
    if (!item || item.text !== '') {
      return;
    }
    const removedItemId = item.id;
    const focusTargetId = index > 0 ? (currentItems[index - 1]?.id ?? null) : null;
    setItems((prev) => prev.filter((_, i) => i !== index));
    itemInputRefsMap.current.delete(removedItemId);
    markDirtyAndScheduleUpdate();
    setTimeout(() => {
      if (focusTargetId) itemInputRefsMap.current.get(focusTargetId)?.current?.focus();
    }, 50);
  }, [itemsRef, markDirtyAndScheduleUpdate, setItems]);

  const handleAcceptSuggestion = useCallback(
    (itemId: string, suggestionText: string) => {
      const current = itemsRef.current;
      const completedItem = findSuggestedItem(current, suggestionText);

      if (!completedItem) {
        const updated = current.map((item) => (item.id === itemId ? { ...item, text: suggestionText } : item));
        itemsRef.current = updated;
        setItems(updated);
        markDirtyAndScheduleUpdate();
        return;
      }

      void reviveSuggestedItem(itemId, completedItem.id, {
        read: () => itemsRef.current,
        commit: (next) => {
          itemsRef.current = next;
          setItems(next);
        },
        uncheck: (id) => handleItemCompletedToggle(id, false),
        save: markDirtyAndScheduleUpdate,
      });

      setTimeout(() => {
        itemInputRefsMap.current.get(completedItem.id)?.current?.focus();
      }, 50);
    },
    [handleItemCompletedToggle, itemsRef, markDirtyAndScheduleUpdate, setItems],
  );

  const handleAssignItem = useCallback(
    (itemId: string, userId: string) => {
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, assigned_to: userId } : item)),
      );
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate, setItems],
  );

  // Enter in the title jumps into the list: the first active row, or a fresh
  // one appended when every row is checked off.
  const focusFirstUncheckedOrAppend = useCallback(() => {
    const firstUnchecked = itemsRef.current.find((item) => !item.completed);
    if (firstUnchecked) {
      itemInputRefsMap.current.get(firstUnchecked.id)?.current?.focus();
      return;
    }
    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
    ]);
    markDirtyAndScheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [getItemRef, itemsRef, markDirtyAndScheduleUpdate, setItems]);

  // Build index lookup for items to avoid O(n) indexOf per item
  const itemIndexMap = useMemo(
    () => new Map(items.map((item, i) => [item.id, i])),
    [items],
  );
  const itemIndexMapRef = useRef(itemIndexMap);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  itemIndexMapRef.current = itemIndexMap;

  const uncheckedItems = useMemo(() => items.filter((item) => !item.completed), [items]);
  const checkedItems = useMemo(() => items.filter((item) => item.completed), [items]);

  const completedItemTexts = useMemo(() => distinctCompletedTexts(checkedItems), [checkedItems]);

  // Refs to avoid recreating handleListReorder on every items change
  const checkedItemsRef = useRef(checkedItems);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  checkedItemsRef.current = checkedItems;
  const uncheckedItemsRef = useRef(uncheckedItems);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  uncheckedItemsRef.current = uncheckedItems;

  // Id of a parent row being dragged. While set, its active children are left
  // out of the list's data so they travel with it: the library can only move one
  // cell, and leaving them in place would let the parent be dropped between (or
  // after) its own children — normalizeItemOrder then re-seats it before them, so
  // the drop silently did nothing or landed somewhere other than where it was
  // shown. commitDrag puts the children back right under the parent.
  const [draggedParentId, setDraggedParentId] = useState<string | null>(null);
  const activeListRows = useMemo(
    () => (draggedParentId === null ? uncheckedItems : uncheckedItems.filter((item) => item.parentId !== draggedParentId)),
    [uncheckedItems, draggedParentId],
  );
  // The list the library's drag indices refer to.
  const activeListRowsRef = useRef(activeListRows);
  // eslint-disable-next-line react-hooks/refs -- same render-time sync as above, tracked in #777
  activeListRowsRef.current = activeListRows;
  // The ref twin of draggedParentId, so commitDrag sees the collapse its drop
  // was measured against even before React has re-rendered.
  const draggedParentIdRef = useRef<string | null>(null);

  // Id of the row a drag picked up, recorded at onDragStart. commitDrag uses it
  // to tell a drop that still describes the list it was measured against from
  // one whose indices have gone stale — see the guard there. null means "no
  // drag start was observed", in which case only the range check applies.
  const dragOriginIdRef = useRef<string | null>(null);

  const rememberDragOrigin = useCallback((index: number) => {
    const originId = activeListRowsRef.current[index]?.id ?? null;
    dragOriginIdRef.current = originId;
    // Fold a parent's children into it for the drag. The parent keeps its index
    // (its children sit below it), so the drag the library just started stays
    // valid; the rows below re-measure as they slide up.
    if (originId !== null && uncheckedItemsRef.current.some((item) => item.parentId === originId)) {
      draggedParentIdRef.current = originId;
      setDraggedParentId(originId);
    }
  }, []);

  const handleListDragStart = useCallback(
    ({ index }: ReorderableListDragStartEvent) => {
      'worklet';
      runOnJS(rememberDragOrigin)(index);
    },
    [rememberDragOrigin],
  );

  // Commits a finished drag: applies the vertical move (if any) and the indent
  // implied by the horizontal drag distance, then persists. Called from both
  // onReorder (fires only when the row changed slots) and onDragEnd (fires on
  // every drop, which is how a purely sideways indent gets committed at all).
  const commitDrag = useCallback(
    (from: number, to: number) => {
      const current = activeListRowsRef.current;
      const originId = dragOriginIdRef.current;
      dragOriginIdRef.current = null;
      // The children folded into a dragged parent, re-seated under it below.
      // Unfold on every exit, including a discarded or no-op drop.
      const collapsedParentId = draggedParentIdRef.current;
      draggedParentIdRef.current = null;
      setDraggedParentId(null);
      const foldedChildren = collapsedParentId === null
        ? []
        : uncheckedItemsRef.current.filter((item) => item.parentId === collapsedParentId);
      // `from`/`to` were measured when the drag began, and the library hands
      // them back only once its drop animation finishes — ~200ms after the
      // finger lifts. A background note refresh (SSE refetch, catch-up resync
      // on reconnect) landing in that window replaces `items`, so the indices
      // can point past the end of the list, or at a different row than the one
      // that was picked up. Committing either would splice `undefined` into the
      // list or move the wrong row, so drop the gesture instead: the list the
      // user was dragging no longer exists on screen.
      //
      // #821 and #850 tried to hold `data` still for that window and both had
      // to be reverted (#859), so this validates the indices rather than the
      // clock — nothing here depends on a refresh being suppressed or timed.
      if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
      if (originId !== null && current[from]?.id !== originId) return;
      // Apply the move to the unchecked list (a no-op when from === to, e.g. a
      // purely sideways drag that only changed the indent).
      const reorderedUnchecked = reorderItems(current, from, to);
      const moved = reorderedUnchecked[to];
      let changed = from !== to;
      if (moved) {
        const above = to > 0 ? reorderedUnchecked[to - 1] ?? null : null;
        const baseLevel = moved.parentId ? 1 : 0;
        const canIndent = !itemHasChildren(itemsRef.current, moved.id) && !!above;
        const canOutdent = baseLevel === 1;
        const targetLevel = indentLevelFromDrag(dragTranslateX.get(), baseLevel, canIndent, canOutdent);
        let newParentId: string | null;
        if (targetLevel !== baseLevel) {
          // The horizontal drag past a step is an explicit indent intent.
          newParentId = targetLevel === 1 && above ? above.parentId ?? above.id : null;
        } else if (from !== to) {
          // No sideways intent but the row moved: fall back to the position-based
          // reparent so dropping into a group still nests as before.
          newParentId = dropTargetParentId(itemsRef.current, above, moved.id);
        } else {
          // Released in place with no sideways intent: leave the parent untouched.
          newParentId = moved.parentId;
        }
        if (newParentId !== moved.parentId) {
          reorderedUnchecked[to] = { ...moved, parentId: newParentId };
          changed = true;
        }
      }
      // Note: dragTranslateX is intentionally not reset here. Each active row now
      // holds its dropped indent in its own `displayLevel` until the committed
      // re-render lands; zeroing the shared value mid-drop could clobber that hold
      // and reintroduce the snap-back flash. The drag start resets it instead.
      if (!changed) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      // A row whose slot changed gets force-remounted by the reorderable list
      // (new key, to fix a layout glitch), which drops a focused TextInput.
      // Re-arm the same autoFocus-on-mount mechanism handleAddItem uses so the
      // remounted row re-opens the keyboard on itself instead of leaving focus
      // to fall back elsewhere (observed: the title input).
      if (focusedItemIdRef.current) armAutoFocus(focusedItemIdRef.current);
      // Merge with the folded children and existing checked items and normalize
      // so each parent's children stay contiguous — which seats the folded
      // children right under their parent, in their original order.
      setItems(normalizeItemOrder([...reorderedUnchecked, ...foldedChildren, ...checkedItemsRef.current]));
      markDirtyAndScheduleUpdate();
    },
    [armAutoFocus, markDirtyAndScheduleUpdate, dragTranslateX, itemsRef, setItems],
  );

  // The formatting bar's indent / outdent buttons: moves the row holding the
  // caret one level, the tap equivalent of dragging it sideways. A no-op when
  // no row has focus or the move isn't allowed (see changeItemIndent).
  const handleIndentFocusedItem = useCallback(
    (delta: 1 | -1) => {
      // The ref is nulled the instant a row blurs, but the buttons follow the
      // state, which holds the id through the blur-settle window (and while a
      // moved row remounts). Fall back to it so a button that looks enabled in
      // that window still acts on the row it was enabled for.
      const itemId = focusedItemIdRef.current ?? heldFocusedItemIdRef.current;
      if (!itemId) return;
      const next = changeItemIndent(itemsRef.current, itemId, delta);
      if (!next) return;
      // Outdenting a middle child re-seats its later siblings above it, so the
      // row's slot can change and the list remounts it — re-arm focus exactly as
      // commitDrag does so the keyboard stays up on the row being moved.
      armAutoFocus(itemId);
      animateListReflow();
      itemsRef.current = next;
      setItems(next);
      markDirtyAndScheduleUpdate();
    },
    [armAutoFocus, itemsRef, markDirtyAndScheduleUpdate, setItems],
  );

  const handleListReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => commitDrag(from, to),
    [commitDrag],
  );

  // onReorder never fires for a purely sideways drag (the library only calls it
  // when from !== to). onDragEnd fires on every drop — inside a UI-thread
  // worklet — so we hop back to JS to commit the indent for that case. The
  // from !== to drops are already handled by onReorder above.
  const handleListDragEnd = useCallback(
    ({ from, to }: ReorderableListDragEndEvent) => {
      'worklet';
      if (from === to) {
        runOnJS(commitDrag)(from, to);
      }
    },
    [commitDrag],
  );

  // The reorder drag activates on movement along either axis: vertical to
  // reorder, horizontal to indent/outdent (Google Keep style). onChange feeds
  // translationX into dragTranslateX so the lifted row can follow the finger
  // sideways and snap to an indent step as it is dragged. (There is no longer a
  // separate swipe-to-indent gesture competing for the horizontal axis.) The
  // library chains its own onBegin/onUpdate/onEnd/onFinalize handlers onto this
  // gesture; onChange is free for us to use.
  const listDragGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .activeOffsetY([-10, 10])
        .onChange((event) => {
          'worklet';
          dragTranslateX.set(event.translationX);
        }),
    [dragTranslateX],
  );

  // The input of the row holding the caret, or null. `focusedItemIdRef` can
  // outlive the focus itself: a focused row that unmounts — checked off into
  // the completed section, deleted — never delivers its blur, so its id lingers
  // until the next focus. Asking the input keeps a resize from scrolling to a
  // row that no longer has the caret (or creating a ref for a deleted one).
  const focusedInput = useCallback((): TextInputType | null => {
    const itemId = focusedItemIdRef.current;
    const input = itemId ? itemInputRefsMap.current.get(itemId)?.current ?? null : null;
    // Not every TextInput host implementation (e.g. test mocks) has isFocused.
    return input?.isFocused?.() === false ? null : input;
  }, []);

  const { reveal: revealInput, scrollViewProps: editorScrollProps } =
    useRevealFocusedInput(scrollViewRef, focusedInput);

  const handleFocusListItem = useCallback(
    (itemId: string) => {
      focusedItemIdRef.current = itemId;
      if (clearEditingItemRef.current) {
        clearTimeout(clearEditingItemRef.current);
        clearEditingItemRef.current = null;
      }
      heldFocusedItemIdRef.current = itemId;
      setFocusedItemId(itemId);
      revealInput(getItemRef(itemId).current);
    },
    [getItemRef, revealInput],
  );

  const handleBlurListItem = useCallback((itemId: string) => {
    if (focusedItemIdRef.current === itemId) focusedItemIdRef.current = null;
    // Deferred, and cancelled by the focus above: moving between two rows is a
    // blur followed by a focus, and clearing straight from the blur would tear
    // the Android bar down and rebuild it on every row change.
    if (clearEditingItemRef.current) clearTimeout(clearEditingItemRef.current);
    clearEditingItemRef.current = setTimeout(() => {
      clearEditingItemRef.current = null;
      heldFocusedItemIdRef.current = null;
      setFocusedItemId(null);
    }, ITEM_BLUR_SETTLE_MS);
  }, []);

  // Per-item callbacks shared by the active list (renderActiveRow) and the
  // completed-items section, so both wire ListItem the same way.
  const listItemHandlers = useMemo<ListItemHandlers>(
    () => ({
      onToggle: (itemId, completed) => { void handleItemCompletedToggle(itemId, completed); },
      onChangeText: handleItemTextChange,
      onDelete: handleDeleteItem,
      onEnterAtCursor: handleItemEnterAtCursor,
      onBackspaceOnEmpty: handleBackspaceOnEmpty,
      onAssignPress: openAssigneePicker,
      onFocus: handleFocusListItem,
      onBlur: handleBlurListItem,
    }),
    [handleItemCompletedToggle, handleItemTextChange, handleDeleteItem, handleItemEnterAtCursor, handleBackspaceOnEmpty, openAssigneePicker, handleFocusListItem, handleBlurListItem],
  );

  return {
    activeListRows,
    checkedItems,
    itemIndexMap,
    itemIndexMapRef,
    completedItemTexts,
    popItemId,
    isEditingItem,
    focusedItemId,
    getItemRef,
    getItemSelectionRef,
    itemSelectionRefsMap,
    autoFocusItemIdRef,
    focusedItemIdRef,
    dragTranslateX,
    listItemHandlers,
    handleAddItem,
    handleItemTextChange,
    handleAcceptSuggestion,
    handleAssignItem,
    handleUncheckAllItems,
    handleDeleteCompletedItems,
    focusFirstUncheckedOrAppend,
    listDragGesture,
    handleListDragStart,
    handleListDragEnd,
    handleListReorder,
    handleIndentFocusedItem,
    editorScrollProps,
  };
}
