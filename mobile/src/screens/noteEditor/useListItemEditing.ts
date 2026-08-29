import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, type ScrollView, type TextInputProps, type TextInput as TextInputType } from 'react-native';
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
  generateId,
  parseTextLineAsListItem,
  truncateToCodePoints,
  type ConvertedListItem,
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
  dropTargetParentId,
  indentLevelFromDrag,
  itemHasChildren,
  normalizeItemOrder,
  type ItemSnapshot,
  type LocalItem,
} from './listItemModel';
import type { ListItemHandlers } from './CheckedItemsSection';
import type { EditorDocHandle } from './useEditorDoc';

const FOCUSED_INPUT_KEYBOARD_MARGIN = 120;
// How long the Android bar outlives a row's blur before hiding, so tapping from
// one row to the next does not flash it away and back.
const ITEM_BLUR_SETTLE_MS = 150;

// Re-inserts each id in `idsToRestore` back into `currentIds`, anchored right
// after its nearest still-present predecessor in `originalOrder` (or at the
// start, if none precedes it). Used to revert a failed bulk delete: reverting
// to a stale full snapshot would also discard any edit or addition made to
// *other* items while the request was in flight, so instead only the deleted
// ids are restored, on top of whatever `currentIds` has become by the time
// the failure is handled.
function reinsertIds(currentIds: string[], originalOrder: string[], idsToRestore: Set<string>): string[] {
  const present = new Set(currentIds);
  const result = [...currentIds];
  for (const [i, id] of originalOrder.entries()) {
    if (!idsToRestore.has(id)) continue;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = originalOrder[j]!;
      if (present.has(candidate)) {
        anchor = candidate;
        break;
      }
    }
    const insertAt = anchor ? result.indexOf(anchor) + 1 : 0;
    result.splice(insertAt, 0, id);
    present.add(id);
  }
  return result;
}

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
  /** The editor's scroll container, kept scrolled to the focused row. */
  scrollViewRef: React.RefObject<ScrollView | null>;
  /** Opens the assignee picker for a row (the picker's state lives in the screen). */
  openAssigneePicker: (itemId: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  t: TFunction;
}

export interface ListItemEditing {
  /** Active (unchecked) rows, in order. */
  uncheckedItems: LocalItem[];
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
  // Id of the list item whose input currently has focus, if any. Tracked so a
  // drag-triggered reorder can restore focus to it (see commitDrag) — the
  // reorderable list forces a remount of any row whose slot changes, which
  // otherwise drops the focused TextInput and lets it fall back to whatever
  // the OS picks next (observed: the title input).
  const focusedItemIdRef = useRef<string | null>(null);

  // Whether any row currently holds the caret. A ref drives the formatting
  // bar's *target* (above); this drives whether Android draws the bar at all,
  // which has to be state.
  const [isEditingItem, setIsEditingItem] = useState(false);
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

  const handleItemCompletedToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // itemsRef.current is the authoritative latest state here: each branch
      // below writes the new array back to it synchronously, so a rapid
      // follow-up toggle (fired before React re-renders) composes on the most
      // recent optimistic state rather than a stale render snapshot. Without
      // this, rows flicker back into the active list and an overlapping
      // parent/child toggle captures a stale prior snapshot, corrupting its
      // rollback and save baseline (issue: mobile item flicker).
      const before = itemsRef.current;
      const target = before.find((item) => item.id === itemId);
      if (!target || target.completed === completed) return;

      // Capture the prior completed state of just the items this toggle touches
      // (the item plus, for a top-level item, its children — or, for a child
      // being unchecked, its parent) from that latest state. Used to advance
      // the save baseline and to revert precisely on failure — without
      // clobbering any other item whose state may change before this async
      // call settles.
      const cascadeToChildren = target.parentId === null;
      const uncompleteParent = target.parentId !== null && !completed;
      const priorCompletedById = new Map(
        before
          .filter(
            (item) =>
              item.id === itemId ||
              (cascadeToChildren && item.parentId === itemId) ||
              (uncompleteParent && item.id === target.parentId),
          )
          .map((item) => [item.id, item.completed]),
      );

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
        return;
      }

      // Cancel any pending debounced save to avoid a race with the toggle API call
      cancelScheduledSave();

      // The request and the reconcile that follows it both run inside the
      // in-flight window: until the reconciled state is set, a note re-read
      // still describes this item as it was before the tap.
      await withItemWriteInFlight(async () => {
        try {
          const serverItems = await toggleItemCompletedRef.current({
            noteId: currentNoteId,
            itemId,
            completed,
          });
          if (serverItems.length > 0) {
            // Online: reconcile only completed flags from server response,
            // composing on (and writing back) the latest state so a concurrent
            // toggle's optimistic change is preserved.
            const completedById = new Map(serverItems.map((item) => [item.id, item.completed]));
            const reconciled = itemsRef.current.map((item) => {
              const serverCompleted = completedById.get(item.id);
              return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
            });
            itemsRef.current = reconciled;
            setItems(reconciled);
            // Advance the baseline so the diff engine does not re-patch completed
            for (const [id, comp] of completedById) {
              const snap = savedItemsRef.current.get(id);
              if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
            }
          } else {
            // Offline: cascade was applied to local DB; advance baseline here too
            for (const [id, prior] of priorCompletedById) {
              if (prior === completed) continue;
              const snap = savedItemsRef.current.get(id);
              if (snap) savedItemsRef.current.set(id, { ...snap, completed });
            }
          }
        } catch {
          // Revert only the items this toggle changed, restoring their prior
          // completed values, so a concurrent toggle's optimistic state survives.
          const reverted = itemsRef.current.map((item) =>
            priorCompletedById.has(item.id)
              ? { ...item, completed: priorCompletedById.get(item.id)! }
              : item,
          );
          itemsRef.current = reverted;
          setItems(reverted);
          setSaveError('note.failedSaveChanges');
        }
      });
    },
    [cancelScheduledSave, itemsRef, markDirtyAndScheduleUpdate, noteIdRef, savedItemsRef, setItems, setSaveError, withItemWriteInFlight],
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

    await withItemWriteInFlight(() => withPendingIndicator(async () => {
      try {
        const serverItems = await uncheckAllItemsRef.current({ noteId, itemIds: ids });
        if (serverItems.length > 0) {
          const completedById = new Map(serverItems.map((item) => [item.id, item.completed]));
          const reconciled = itemsRef.current.map((item) => {
            const c = completedById.get(item.id);
            return c === undefined ? item : { ...item, completed: c };
          });
          itemsRef.current = reconciled;
          setItems(reconciled);
          for (const [id, comp] of completedById) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
          }
        } else {
          // Offline: the local write already applied the uncheck; advance the
          // save baseline so the diff engine does not re-patch it later.
          for (const id of ids) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: false });
          }
        }
      } catch {
        const reverted = itemsRef.current.map((item) => (ids.includes(item.id) ? { ...item, completed: true } : item));
        itemsRef.current = reverted;
        setItems(reverted);
        setSaveError('note.failedSaveChanges');
      }
    }));
  }, [itemsRef, markDirtyAndScheduleUpdate, noteIdRef, savedItemsRef, setItems, setSaveError, withItemWriteInFlight, withPendingIndicator]);

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

      // Multi-line paste: split into separate items
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      if (lines.length <= 1) {
        const singleText = truncateToCodePoints(lines[0] ?? '', VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: singleText } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      // Stripping each line's markdown list/checkbox marker (`- `, `1. `,
      // `[ ]`/`[x]`) and reading its completed state reuses the same line
      // parser the text-note-to-list-note conversion uses, so pasting a
      // markdown checklist behaves the same as converting one.
      const parsedLines = lines
        .map(parseTextLineAsListItem)
        .filter((line): line is ConvertedListItem => line !== null);

      const isCompleted = itemsRef.current[index]?.completed ?? false;

      if (isCompleted) {
        const joinedText = parsedLines.map((line) => line.text).join(' ');
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: truncateToCodePoints(joinedText, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
          ),
        );
        markDirtyAndScheduleUpdate();
        return;
      }

      // A multi-line paste can still collapse to one usable item once block
      // markers strip to nothing (e.g. a bare "#" line) — fall back to the
      // single-item update rather than splitting into an empty remainder.
      if (parsedLines.length <= 1) {
        const singleLine = parsedLines[0];
        const singleText = truncateToCodePoints(singleLine?.text ?? '', VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: singleText, completed: singleLine?.completed ?? item.completed } : item,
          ),
        );
        markDirtyAndScheduleUpdate();
        return;
      }

      const prepasteItems = [...itemsRef.current];
      const firstLine = parsedLines[0]!;
      const remainingLines = parsedLines.slice(1);
      const newIds = remainingLines.map(() => nextTempId());

      setItems((prev) => {
        const sourceParentId = prev[index]?.parentId ?? null;
        const newItems: LocalItem[] = remainingLines.map((line, i) => ({
          id: newIds[i]!,
          text: truncateToCodePoints(line.text, VALIDATION.ITEM_TEXT_MAX_LENGTH),
          completed: line.completed,
          position: 0,
          parentId: sourceParentId,
          assigned_to: '',
        }));
        const updated = prev.map((item, i) =>
          i === index
            ? {
                ...item,
                text: truncateToCodePoints(firstLine.text, VALIDATION.ITEM_TEXT_MAX_LENGTH),
                completed: firstLine.completed,
              }
            : item,
        );
        updated.splice(index + 1, 0, ...newItems);
        return updated.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();

      showToast(t('note.itemsPasted', { count: remainingLines.length }), 'info', {
        label: t('dashboard.undo'),
        onPress: () => {
          setItems(prepasteItems);
          markDirtyAndScheduleUpdate();
        },
      });

      // lines.length > 1 above, so remainingLines and newIds are non-empty.
      const lastId = newIds[newIds.length - 1]!;
      const lastItemRef = getItemRef(lastId);
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
    autoFocusItemIdRef.current = newId;
    // Ease the new row in rather than having the list jump to make room.
    animateListReflow();
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
    ]);
    markDirtyAndScheduleUpdate();
    // autoFocus is only consumed at mount; clear after a short delay so a
    // later unmount/remount of the same ID doesn't re-open the keyboard.
    // Cancel any pending clear from a previous rapid tap before rescheduling.
    if (autoFocusClearTimerRef.current !== null) clearTimeout(autoFocusClearTimerRef.current);
    autoFocusClearTimerRef.current = setTimeout(() => { autoFocusItemIdRef.current = null; }, 500);
  }, [markDirtyAndScheduleUpdate, setItems]);

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
      // Capture the completed item ID from the ref snapshot so we can focus it after setItems
      const restoredId = itemsRef.current.find(
        (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
      )?.id;

      setItems((prev) => {
        const completedItem = prev.find(
          (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
        );

        if (!completedItem) {
          return prev.map((item) => (item.id === itemId ? { ...item, text: suggestionText } : item));
        }

        const currentUnchecked = prev.filter((item) => !item.completed);
        // itemId is always an unchecked item so findIndex should never return -1; Math.max guards against stale ref races
        const insertAt = Math.max(0, currentUnchecked.findIndex((item) => item.id === itemId));

        const filtered = prev.filter(
          (item) => item.id !== itemId && item.id !== completedItem.id,
        );

        const restoredItem: LocalItem = { ...completedItem, completed: false };
        const remainingUncompleted = filtered.filter((item) => !item.completed);
        const remainingCompleted = filtered.filter((item) => item.completed);

        const newUncompleted = [
          ...remainingUncompleted.slice(0, insertAt),
          restoredItem,
          ...remainingUncompleted.slice(insertAt),
        ].map((item, i) => ({ ...item, position: i }));

        return [
          ...newUncompleted,
          ...remainingCompleted.map((item, i) => ({ ...item, position: newUncompleted.length + i })),
        ];
      });

      markDirtyAndScheduleUpdate();

      if (restoredId) {
        setTimeout(() => {
          itemInputRefsMap.current.get(restoredId)?.current?.focus();
        }, 50);
      }
    },
    [itemsRef, markDirtyAndScheduleUpdate, setItems],
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

  const completedItemTexts = useMemo(() => {
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const item of checkedItems) {
      const trimmed = item.text.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        texts.push(trimmed);
      }
    }
    return texts;
  }, [checkedItems]);

  // Refs to avoid recreating handleListReorder on every items change
  const checkedItemsRef = useRef(checkedItems);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  checkedItemsRef.current = checkedItems;
  const uncheckedItemsRef = useRef(uncheckedItems);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  uncheckedItemsRef.current = uncheckedItems;

  // Id of the row a drag picked up, recorded at onDragStart. commitDrag uses it
  // to tell a drop that still describes the list it was measured against from
  // one whose indices have gone stale — see the guard there. null means "no
  // drag start was observed", in which case only the range check applies.
  const dragOriginIdRef = useRef<string | null>(null);

  const rememberDragOrigin = useCallback((index: number) => {
    dragOriginIdRef.current = uncheckedItemsRef.current[index]?.id ?? null;
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
      const current = uncheckedItemsRef.current;
      const originId = dragOriginIdRef.current;
      dragOriginIdRef.current = null;
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
      if (focusedItemIdRef.current) {
        autoFocusItemIdRef.current = focusedItemIdRef.current;
        if (autoFocusClearTimerRef.current !== null) clearTimeout(autoFocusClearTimerRef.current);
        autoFocusClearTimerRef.current = setTimeout(() => { autoFocusItemIdRef.current = null; }, 500);
      }
      // Merge with existing checked items and normalize so each parent's
      // children stay contiguous.
      setItems(normalizeItemOrder([...reorderedUnchecked, ...checkedItemsRef.current]));
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate, dragTranslateX, itemsRef, setItems],
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

  const handleListItemFocus = useCallback<NonNullable<TextInputProps['onFocus']>>((event) => {
    const nativeTarget = event.nativeEvent.target;
    if (nativeTarget == null) return;

    // Use ScrollView's native keyboard helper so focused list item inputs stay
    // visible. scrollViewRef now points at the library's ScrollViewContainer
    // (a Reanimated ScrollView); if its forwarded ref doesn't expose
    // getScrollResponder this degrades to a no-op rather than crashing.
    const responder = scrollViewRef.current?.getScrollResponder?.();
    if (
      responder &&
      typeof responder.scrollResponderScrollNativeHandleToKeyboard === 'function'
    ) {
      responder.scrollResponderScrollNativeHandleToKeyboard(
        nativeTarget,
        FOCUSED_INPUT_KEYBOARD_MARGIN,
        true,
      );
      return;
    }
  }, [scrollViewRef]);

  const handleFocusListItem = useCallback(
    (itemId: string, event: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      focusedItemIdRef.current = itemId;
      if (clearEditingItemRef.current) {
        clearTimeout(clearEditingItemRef.current);
        clearEditingItemRef.current = null;
      }
      setIsEditingItem(true);
      handleListItemFocus(event);
    },
    [handleListItemFocus],
  );

  const handleBlurListItem = useCallback((itemId: string) => {
    if (focusedItemIdRef.current === itemId) focusedItemIdRef.current = null;
    // Deferred, and cancelled by the focus above: moving between two rows is a
    // blur followed by a focus, and clearing straight from the blur would tear
    // the Android bar down and rebuild it on every row change.
    if (clearEditingItemRef.current) clearTimeout(clearEditingItemRef.current);
    clearEditingItemRef.current = setTimeout(() => {
      clearEditingItemRef.current = null;
      setIsEditingItem(false);
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
    uncheckedItems,
    checkedItems,
    itemIndexMap,
    itemIndexMapRef,
    completedItemTexts,
    popItemId,
    isEditingItem,
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
  };
}
