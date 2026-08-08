import { useState, useEffect, useEffectEvent, useMemo, useRef, useCallback, useId, type ReactElement, type ReactNode } from 'react';
import { X, Plus, Trash2, ChevronDown, Archive, ArchiveX, UserPlus, Check, Tag, Copy, Smartphone, Palette, Image, ArrowLeftRight, Pin, EllipsisVertical, Square, Undo2 } from 'lucide-react';
import { Dialog, DialogBackdrop, DialogPanel, Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, NOTE_COLORS, IMAGE_ALLOWED_TYPES, UPLOAD_MAX_BYTES, buildCollaborators, generateId, textToListItems, listToText, parseTextLineAsListItem, exceedsCodePointLimit, truncateToCodePoints, clampSelection, continueListOnNewline, cycleHeading, toggleBullet, toggleCheckbox, toggleInlineMarker, type EditorText, type Note, type NoteType, type CreateNoteRequest, type ConvertNoteTypeRequest, type ConvertedListItem, type User, type Collaborator } from '@jot/shared';
import { notes } from '@/utils/api';
import { renderMarkdown, inlineMarkdownToText } from '@/utils/markdown';
import LabelPicker from '@/components/LabelPicker';
import NoteImageGallery from '@/components/NoteImageGallery';
import LetterAvatar from '@/components/LetterAvatar';
import SortableItem from '@/components/SortableItem';
import InlineMarkdown from '@/components/InlineMarkdown';
import MarkdownToolbar, { type MarkdownToolbarAction } from '@/components/MarkdownToolbar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { useNoteImages } from '@/hooks/useNoteImages';
import { useCompletedItems } from '@/hooks/useCompletedItems';
import { useNoteDraft, type AutoSaveDraft } from '@/hooks/useNoteDraft';
import { useSizeTransition } from '@/hooks/useSizeTransition';
import { applyTextareaEdit } from '@/utils/textareaEdit';
import { buildShareAvatars } from '@/utils/shareAvatars';
import { buildMobileDeepLink } from '@/utils/deepLink';
import { isEditableElementFocused } from '@/utils/keyboardShortcuts';
import {
  applyCompletedCascade,
  dropTargetParentId,
  indentOf,
  itemHasChildren,
  normalizeItemOrder,
  precedingTopLevelId,
  type ListItem,
} from '@/utils/noteItems';
import type {
  DragEndEvent} from '@dnd-kit/core';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

// Re-exported so the row-reveal styling has a single import site for callers
// that reach for it through the modal rather than the row component.
export { ROW_REVEAL_CLASSES } from '@/components/SortableItem';

// A single label pill shown in the note modal's avatars/labels row.
function LabelChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5 text-xs">
      {name}
    </span>
  );
}

// Keyboard-shortcut hint chip shown at the trailing edge of overflow menu items.
function MenuKbd({ children }: { children: ReactNode }) {
  return (
    <kbd aria-hidden="true" className="ml-2 inline-flex rounded border border-gray-300 dark:border-slate-600 bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
      {children}
    </kbd>
  );
}

// Shared styling for the note-modal overflow menu items. OVERFLOW_ITEM is the
// plain row; the SPLIT variant adds justify-between for rows with a trailing
// MenuKbd chip; DANGER recolors the destructive (delete) row.
const OVERFLOW_ITEM_BASE = 'flex items-center w-full px-4 py-2 text-sm data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700';
const OVERFLOW_ITEM = `${OVERFLOW_ITEM_BASE} text-gray-700 dark:text-gray-200`;
const OVERFLOW_ITEM_SPLIT = `${OVERFLOW_ITEM_BASE} justify-between text-gray-700 dark:text-gray-200`;
const OVERFLOW_ITEM_DANGER = `${OVERFLOW_ITEM_BASE} justify-between text-red-600 dark:text-red-400`;

// Validation functions
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

const validateItemText = (text: string, t: TFunction): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null; // Allow empty items (will be removed on save)
  if (exceedsCodePointLimit(trimmed, VALIDATION.ITEM_TEXT_MAX_LENGTH)) return t('note.itemTooLong', { max: VALIDATION.ITEM_TEXT_MAX_LENGTH });
  if (/[<>]/g.test(trimmed)) return t('note.itemInvalidChars');
  return null;
};

const validateTitle = (title: string, t: TFunction): string | null => {
  if (exceedsCodePointLimit(title, VALIDATION.TITLE_MAX_LENGTH)) return t('note.titleTooLong', { max: VALIDATION.TITLE_MAX_LENGTH });
  return null;
};

const validateContent = (content: string, t: TFunction): string | null => {
  if (exceedsCodePointLimit(content, VALIDATION.CONTENT_MAX_LENGTH)) return t('note.contentTooLong', { max: VALIDATION.CONTENT_MAX_LENGTH });
  return null;
};

// Timeout management now handled via useRef instead of global window property

// Generate IDs for new list items in the server's ID format so the item has a
// stable identity the server accepts on create — this is what lets per-item
// updates target the right row without a create round-trip.
const generateItemId = () => generateId();

const TEXT_NOTE_MIN_HEIGHT_PX = 96;
const TEXT_NOTE_RESIZE_DEBOUNCE_MS = 120;

interface NoteModalProps {
  note?: Note | null;
  onClose: () => void;
  onSave: () => void;
  onRefresh?: () => void;
  onShare?: (note: Note) => void;
  onDelete?: (noteId: string) => void;
  onDuplicate?: (noteId: string) => Promise<void> | void;
  onConvert?: (noteId: string, data: ConvertNoteTypeRequest) => Promise<void> | void;
  // A note in the bin (note.deleted_at set) opens through these instead of
  // the normal edit actions — the modal renders fully read-only, mirroring
  // the mobile app's trashed-note editor.
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  isOwner?: boolean;
  usersById?: Map<string, User>;
  currentUserId?: string;
  // Server-configured image upload cap, fetched via GET /config. Falls back
  // to the shared default so this component still works if a caller (e.g. a
  // test) doesn't pass it.
  uploadMaxBytes?: number;
  // Prefill for a brand-new note (note === null), e.g. from the /new deep
  // link (PWA shortcut or share target). Ignored once a note is being edited.
  initialType?: NoteType;
  initialContent?: string;
}

export default function NoteModal({ note, onClose, onSave, onRefresh, onShare, onDelete, onDuplicate, onConvert, onRestore, onPermanentlyDelete, isOwner = true, usersById, currentUserId, uploadMaxBytes = UPLOAD_MAX_BYTES, initialType, initialContent }: NoteModalProps) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  const [showPermanentDeleteConfirm, setShowPermanentDeleteConfirm] = useState(false);
  // A note in the bin opens view-only: every editing affordance is disabled
  // and the overflow menu offers only Restore / Delete forever, matching the
  // mobile app's trashed-note editor.
  const isReadOnly = !!note?.deleted_at;
  // New notes start in edit mode; existing notes start in preview mode.
  const [isEditingContent, setIsEditingContent] = useState(!note);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shows an error in the modal's own banner, auto-dismissing after 5s.
  const showError = useCallback((message: string) => {
    setErrorMessage(message);

    // Clear any existing error timeout
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }

    // Auto-dismiss error after 5 seconds
    errorTimeoutRef.current = setTimeout(() => {
      setErrorMessage(null);
    }, 5000);
  }, []);

  // The note's editable state — scalar fields plus list items — and the
  // autosave engine that persists them by diffing against the server baseline.
  const {
    title, setTitle,
    content, setContent,
    noteType, setNoteType,
    color, setColor,
    pinned, setPinned,
    archived, setArchived,
    checkedItemsCollapsed, setCheckedItemsCollapsed,
    items, itemsRef, commitItems,
    noteLabels, setNoteLabels,
    showSaved, flashSaved, markDirty,
    setSavedBaseline, markScalarSaved, applyDraftScalars, isDirty, hasUnflushedWork, baseline,
    autoSaveNote, scheduleAutoSave, cancelPendingSave, flushSave,
    beginExclusiveSave, endExclusiveSave, isSaving, requestAnotherSavePass,
  } = useNoteDraft({ note, onRefresh, showError });

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  // Note image add/remove UI (upload queue, optimistic overlay, deferred
  // removal undo, drag-to-upload). Uploads require an existing note — an id to
  // attach to — so the hook gates all of it on `note` being set.
  const {
    displayedImages,
    imageUploads,
    removedImages,
    isDraggingImage,
    imageFileInputRef,
    handleImageFileInputChange,
    handleImageDragEnter,
    handleImageDragOver,
    handleImageDragLeave,
    handleImageDrop,
    handleModalPaste,
    removeNoteImage,
    undoRemoveImage,
    retryImageUpload,
    removeUploadTile,
    resetForNoteSwitch: resetImagesForNoteSwitch,
  } = useNoteImages({ note, uploadMaxBytes, onRefresh, showError });

  // Tracks the note id whose state we have adopted into local editor state, so
  // we can tell "switched to a different note" (always adopt) apart from "same
  // note refreshed by an SSE event" (only adopt when there are no local edits).
  const adoptedNoteIdRef = useRef<string | null>(note?.id ?? null);
  const itemInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  // Set to true when the backdrop mousedown handler has already handled a dismiss,
  // so Dialog.onClose (which HeadlessUI fires after the mousedown) skips its logic.
  const backdropHandledRef = useRef(false);
  const resizeContentTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.max(textarea.scrollHeight, TEXT_NOTE_MIN_HEIGHT_PX);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = 'hidden';
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Bulk actions on the checked items: deferred delete and uncheck-all, each
  // behind its own in-modal undo bar.
  const {
    removedCompletedItems,
    hiddenCompletedItemIds,
    recentlyUnchecked,
    handleDeleteCompletedItems,
    undoDeleteCompletedItems,
    handleUncheckAllItems,
    undoUncheckAll,
    resetForNoteSwitch: resetCompletedItemsForNoteSwitch,
  } = useCompletedItems({
    note,
    itemsRef,
    commitItems,
    baseline,
    cancelPendingSave,
    markDirty,
    flashSaved,
    showError,
    onRefresh,
  });

  // Separate completed and uncompleted items with memoization
  const { uncompletedItems, completedItems, completedItemTexts } = useMemo(() => {
    const uncompletedItems = items.filter(item => !item.completed);
    // Items mid-undo-window are completed but hidden from view until their
    // deferred bulk delete lands (or is undone), mirroring image removal.
    const completedItems = items.filter(item => item.completed && !hiddenCompletedItemIds.has(item.id));
    const seen = new Set<string>();
    const completedItemTexts: string[] = [];
    for (const item of completedItems) {
      const trimmed = item.text.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        completedItemTexts.push(trimmed);
      }
    }
    return { uncompletedItems, completedItems, completedItemTexts };
  }, [items, hiddenCompletedItemIds]);

  // Softly animate the modal's height when its contents structurally change
  // (an item checked off, added/removed, or the completed section toggled), so
  // the panel resizes smoothly instead of jumping. Keyed on structural counts
  // only, so typing inside an item doesn't trigger a height animation.
  const sizeTransitionKey =
    `${uncompletedItems.length}:${completedItems.length}:${checkedItemsCollapsed}:${noteType}:${isEditingContent}`;
  const panelRef = useSizeTransition<HTMLDivElement>(sizeTransitionKey);

  const colorMeta: Record<string, { name: string; class: string }> = {
    '#ffffff': { name: t('note.colorWhite'), class: 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600' },
    '#f28b82': { name: t('note.colorCoral'), class: 'bg-red-200 dark:bg-red-900 border-red-300 dark:border-red-700' },
    '#fbbc04': { name: t('note.colorYellow'), class: 'bg-yellow-100 dark:bg-yellow-900 border-yellow-300 dark:border-yellow-700' },
    '#ccff90': { name: t('note.colorLime'), class: 'bg-lime-100 dark:bg-lime-900 border-lime-300 dark:border-lime-700' },
    '#a7ffeb': { name: t('note.colorTeal'), class: 'bg-teal-100 dark:bg-teal-900 border-teal-300 dark:border-teal-700' },
    '#aecbfa': { name: t('note.colorPeriwinkle'), class: 'bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700' },
    '#d7aefb': { name: t('note.colorLavender'), class: 'bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700' },
    '#fdcfe8': { name: t('note.colorPink'), class: 'bg-pink-100 dark:bg-pink-900 border-pink-300 dark:border-pink-700' },
    '#e6c9a8': { name: t('note.colorSand'), class: 'bg-amber-100 dark:bg-amber-900 border-amber-300 dark:border-amber-700' },
    '#e8eaed': { name: t('note.colorGray'), class: 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600' },
  };
  const colors = NOTE_COLORS.map(value => ({
    value,
    name: colorMeta[value]?.name ?? value,
    class: colorMeta[value]?.class ?? '',
  }));

  // Only offered on touch devices, where the mobile app can actually be
  // installed. Read once on mount: a pointer type doesn't change under a live
  // modal, and keeping the `window` reads out of render leaves this a plain
  // derivation of note.id.
  const [isCoarsePointer] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const [appOrigin] = useState(() => window.location.origin);
  const noteDeepLinkHref = note?.id && isCoarsePointer
    ? buildMobileDeepLink(`/notes/${note.id}`, appOrigin)
    : null;

  useEffect(() => {
    // Decide whether to adopt the incoming note prop into local editor state.
    // Switching to a different note always adopts. A refresh of the *same* note
    // (e.g. an SSE update from another tab/device) only adopts when the user
    // has no unsaved local edits — otherwise adopting would clobber in-progress
    // changes. Because item edits are persisted granularly, skipping adoption
    // here never loses data; the next idle refresh reconciles.
    const incomingId = note?.id ?? null;
    const sameNote = incomingId !== null && incomingId === adoptedNoteIdRef.current;
    if (sameNote && hasUnflushedWork()) {
      return;
    }
    const previousAdoptedId = adoptedNoteIdRef.current;
    adoptedNoteIdRef.current = incomingId;

    if (previousAdoptedId !== incomingId) {
      // Switching notes (or to/from a brand-new note) drops any in-flight
      // image uploads left over from whichever note we're leaving, and
      // re-derives which removals are still mid-undo-window.
      resetImagesForNoteSwitch();

      // Same for the checked-item undo bars: the deferred bulk delete's timer
      // also keeps running across a note switch.
      resetCompletedItemsForNoteSwitch();
    }

    if (note) {
      setNoteType(note.note_type);
      setColor(note.color);
      setPinned(note.pinned);
      setArchived(note.archived);
      let listItems: ListItem[] = [];
      let draft: AutoSaveDraft;
      if (note.note_type === 'list') {
        setTitle(note.title);
        setCheckedItemsCollapsed(note.checked_items_collapsed);
        // Items arrive ordered by position from the server. normalizeItemOrder
        // keeps each group contiguous and re-sequences positions so all later
        // mutations build on a consistent ordering.
        listItems = normalizeItemOrder((note.items ?? []).map((item, index) => ({
          id: item.id || `existing_${item.position}_${index}`,
          text: item.text,
          completed: item.completed,
          position: item.position,
          parentId: item.parent_id ?? null,
          assignedTo: item.assigned_to ?? '',
        })));
        commitItems(listItems);
        draft = { title: note.title, content: '', pinned: note.pinned, archived: note.archived, color: note.color, checked_items_collapsed: note.checked_items_collapsed };
      } else {
        setContent(note.content);
        commitItems([]);
        draft = { title: '', content: note.content, pinned: note.pinned, archived: note.archived, color: note.color, checked_items_collapsed: false };
      }
      setNoteLabels(note.labels ?? []);
      setSavedBaseline(draft, listItems);
    } else {
      setTitle('');
      setContent(initialContent ?? '');
      setNoteType(initialType ?? 'text');
      setColor('#ffffff');
      setPinned(false);
      setArchived(false);
      commitItems([]);
      setNoteLabels([]);
      setSavedBaseline({ title: '', content: '', pinned: false, archived: false, color: '#ffffff', checked_items_collapsed: false }, []);
    }
  }, [commitItems, note, hasUnflushedWork, resetImagesForNoteSwitch, resetCompletedItemsForNoteSwitch,
      setSavedBaseline, setTitle, setContent, setNoteType, setColor, setPinned, setArchived,
      setCheckedItemsCollapsed, setNoteLabels, initialType, initialContent]);

  useEffect(() => {
    if (!showColorPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showColorPicker]);

  useEffect(() => {
    if (noteType !== 'text' || !isEditingContent) return;
    resizeContentTextarea(contentRef.current);
  }, [content, noteType, isEditingContent, resizeContentTextarea]);

  useEffect(() => {
    if (noteType !== 'text') return;
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    const debouncedHandler = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        resizeContentTextarea(contentRef.current);
      }, TEXT_NOTE_RESIZE_DEBOUNCE_MS);
    };

    window.addEventListener('resize', debouncedHandler);
    return () => {
      window.removeEventListener('resize', debouncedHandler);
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
    };
  }, [noteType, resizeContentTextarea]);

  useEffect(() => {
    if (pendingSelectionRef.current && contentRef.current) {
      const { start, end } = pendingSelectionRef.current;
      contentRef.current.focus();
      contentRef.current.setSelectionRange(start, end);
      pendingSelectionRef.current = null;
    }
  }, [content]);

  // --- Markdown formatting -------------------------------------------------
  //
  // The transforms are shared with the mobile editor (@jot/shared/markdownEdits)
  // so both clients produce identical text for the same input and selection.
  // Only the way the result is written back differs, and that difference
  // matters: see webapp/src/utils/textareaEdit.ts for why the edit is replayed
  // through the DOM instead of straight into state.

  const contentTextareaId = useId();

  /** Commits an edit that textareaEdit could not replay (undo stack is lost). */
  const commitContentDirectly = useCallback((next: EditorText) => {
    setContent(next.text);
    pendingSelectionRef.current = next.selection;
    if (note) {
      markDirty();
      scheduleAutoSave();
    }
  }, [markDirty, note, scheduleAutoSave, setContent]);

  /**
   * Runs a formatting transform against the current text and selection, then
   * writes the result back as an undoable edit.
   *
   * On the happy path this deliberately does not call setContent: the DOM edit
   * fires an input event, so the textarea's own onChange handler picks the text
   * up and runs validation, markDirty and the autosave schedule exactly as it
   * would for a keystroke.
   */
  const applyMarkdownEdit = useCallback((transform: (state: EditorText) => EditorText) => {
    const textarea = contentRef.current;
    if (!textarea) return;

    const previous = textarea.value;
    const next = transform({
      text: previous,
      selection: { start: textarea.selectionStart, end: textarea.selectionEnd },
    });

    // A dropped keystroke at least shows up as a character that never appeared;
    // a dropped button press just looks like a broken button, so say why.
    const validationError = validateContent(next.text, t);
    if (validationError) {
      showError(validationError);
      return;
    }

    const selection = clampSelection(next.selection, next.text);
    if (!applyTextareaEdit(textarea, next.text, selection)) {
      commitContentDirectly({ text: next.text, selection });
    }
  }, [commitContentDirectly, showError, t]);

  const handleToolbarAction = useCallback((action: MarkdownToolbarAction) => {
    switch (action) {
      case 'bold':
        applyMarkdownEdit((state) => toggleInlineMarker(state, '**'));
        break;
      case 'italic':
        applyMarkdownEdit((state) => toggleInlineMarker(state, '*'));
        break;
      case 'strikethrough':
        applyMarkdownEdit((state) => toggleInlineMarker(state, '~~'));
        break;
      case 'heading':
        applyMarkdownEdit(cycleHeading);
        break;
      case 'bullet':
        applyMarkdownEdit(toggleBullet);
        break;
      case 'checkbox':
        applyMarkdownEdit(toggleCheckbox);
        break;
    }
  }, [applyMarkdownEdit]);

  // continueListOnNewline compares the text before the change with the text
  // after it, so the pre-change selection has to be captured before the browser
  // applies the keystroke — by the time onChange runs, the textarea reports the
  // caret's new position. keydown fires first, which makes this exact.
  const selectionBeforeKeyRef = useRef<{ start: number; end: number } | null>(null);

  /**
   * Carries a list marker onto the next line when Enter is pressed at the end of
   * a list item (and clears it on an empty item). Returns true when it handled
   * the change, meaning the caller must not also apply the raw text.
   */
  const handleListContinuation = useCallback((textarea: HTMLTextAreaElement, typed: string) => {
    const before = selectionBeforeKeyRef.current;
    selectionBeforeKeyRef.current = null;
    if (!before) return false;

    const continued = continueListOnNewline({ text: content, selection: before }, typed);
    if (!continued) return false;
    // The marker is characters the user did not type, so at the cap drop the
    // continuation rather than the whole keystroke.
    if (validateContent(continued.text, t)) return false;

    const selection = clampSelection(continued.selection, continued.text);
    if (!applyTextareaEdit(textarea, continued.text, selection)) {
      commitContentDirectly({ text: continued.text, selection });
    }
    return true;
  }, [commitContentDirectly, content, t]);

  // Focus the textarea whenever the content area transitions into edit mode
  // (but not on initial mount to avoid stealing focus from the title input).
  const prevIsEditingContentRef = useRef(isEditingContent);
  useEffect(() => {
    if (isEditingContent && !prevIsEditingContentRef.current) {
      requestAnimationFrame(() => {
        contentRef.current?.focus();
      });
    }
    prevIsEditingContentRef.current = isEditingContent;
  }, [isEditingContent]);

  // Pre-compute the rendered markdown for the preview div.
  // If markdown renders to nothing but content is non-empty (e.g. plain text
  // with HTML-special chars that DOMPurify stripped), fall back to an
  // HTML-escaped version of the raw content so it is never silently hidden.
  const renderedContent = useMemo(() => {
    if (!content?.trim()) return '';
    const md = renderMarkdown(content);
    if (md) return md;
    return content.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] ?? c
    ));
  }, [content]);

  const INDENT_DRAG_THRESHOLD = 50;

  // indentListItem nests (delta 1) or un-nests (delta -1) an item by changing its
  // parentId, the source of truth for grouping. Indenting attaches the item to
  // the nearest preceding top-level item; un-indenting promotes it to top-level.
  // It refuses to nest an item that already has children (that would create a
  // grandchild, which the server rejects) and is a no-op when nothing changes.
  const indentListItem = async (itemId: string, delta: 1 | -1) => {
    if (isReadOnly) return;
    cancelPendingSave();
    const currentItems = itemsRef.current;
    const target = currentItems.find(item => item.id === itemId);
    if (!target) return;

    let newParentId: string | null = target.parentId;
    if (delta === 1) {
      if (target.parentId !== null) return; // already nested (max one level)
      if (itemHasChildren(currentItems, itemId)) return; // would create a grandchild
      const parentId = precedingTopLevelId(currentItems, itemId);
      if (!parentId) return; // nothing to nest under
      newParentId = parentId;
    } else {
      if (target.parentId === null) return; // already top-level
      newParentId = null;
    }

    const updated = normalizeItemOrder(
      currentItems.map(item => (item.id === itemId ? { ...item, parentId: newParentId } : item)),
    );
    commitItems(updated);
    await autoSaveNote();
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    if (isReadOnly) return;
    const { active, over, delta } = event;

    // Horizontal drag → indent or unindent
    if (Math.abs(delta.x) >= INDENT_DRAG_THRESHOLD) {
      const draggedItem = uncompletedItems.find(item => item.id === active.id);
      if (draggedItem) {
        await indentListItem(draggedItem.id, delta.x > 0 ? 1 : -1);
      }
      return;
    }

    if (over && active.id !== over.id) {
      // Move within the single ordered array, then re-parent the dragged item to
      // the group it was dropped into (so an item can be moved between groups),
      // then normalize. Because normalize re-groups each parent's children right
      // after it, dragging a parent carries its whole group along.
      const currentItems = itemsRef.current;
      const fromIndex = currentItems.findIndex(item => item.id === active.id);
      const toIndex = currentItems.findIndex(item => item.id === over.id);
      if (fromIndex === -1 || toIndex === -1) return;

      const moved = arrayMove(currentItems, fromIndex, toIndex);
      const droppedIndex = moved.findIndex(item => item.id === active.id);
      const newParentId = dropTargetParentId(moved, droppedIndex, active.id as string);
      const reparented = moved.map(item =>
        item.id === active.id ? { ...item, parentId: newParentId } : item,
      );
      commitItems(normalizeItemOrder(reparented));
      await autoSaveNote();
    }
  };

  const addListItem = () => {
    if (isReadOnly) return '';
    const currentItems = itemsRef.current;
    const uncompletedItems = currentItems.filter(item => !item.completed);
    const lastUncompletedItem = uncompletedItems[uncompletedItems.length - 1];
    // Inherit the last item's group so appending under a child stays in the group.
    const parentId = lastUncompletedItem ? lastUncompletedItem.parentId : null;
    const newItem: ListItem = {
      id: generateItemId(),
      text: '',
      completed: false,
      position: 0,
      parentId,
      assignedTo: '',
    };
    commitItems(normalizeItemOrder([...currentItems, newItem]));
    autoSaveNote();
    return newItem.id;
  };

  const addListItemAndFocus = () => {
    const newId = addListItem();
    setTimeout(() => itemInputRefs.current.get(newId)?.focus(), 0);
  };

  const insertListItemAfter = (
    afterItemId: string,
    overrides: { text?: string; parentId?: string | null; assignedTo?: string } = {},
  ) => {
    if (isReadOnly) return afterItemId;
    cancelPendingSave();
    const currentItems = itemsRef.current;
    const afterItemPos = currentItems.findIndex(item => item.id === afterItemId);
    const afterItem = afterItemPos >= 0 ? currentItems[afterItemPos] : undefined;
    const newItem: ListItem = {
      id: generateItemId(),
      text: overrides.text ?? '',
      completed: afterItem ? afterItem.completed : false,
      position: 0,
      parentId: overrides.parentId !== undefined ? overrides.parentId : (afterItem ? afterItem.parentId : null),
      assignedTo: overrides.assignedTo ?? '',
    };
    const insertPos = afterItemPos >= 0 ? afterItemPos + 1 : currentItems.length;
    const newItems = [...currentItems];
    newItems.splice(insertPos, 0, newItem);
    commitItems(normalizeItemOrder(newItems));
    autoSaveNote();
    return newItem.id;
  };

  // insertListItemBefore adds a new empty item immediately before beforeItemId,
  // leaving that item's own text untouched (used when Enter is pressed at the
  // very start of a non-empty item).
  const insertListItemBefore = (
    beforeItemId: string,
    overrides: { parentId?: string | null; assignedTo?: string } = {},
  ) => {
    if (isReadOnly) return beforeItemId;
    cancelPendingSave();
    const currentItems = itemsRef.current;
    const beforeItemPos = currentItems.findIndex(item => item.id === beforeItemId);
    const beforeItem = beforeItemPos >= 0 ? currentItems[beforeItemPos] : undefined;
    const newItem: ListItem = {
      id: generateItemId(),
      text: '',
      completed: beforeItem ? beforeItem.completed : false,
      position: 0,
      parentId: overrides.parentId !== undefined ? overrides.parentId : (beforeItem ? beforeItem.parentId : null),
      assignedTo: overrides.assignedTo ?? '',
    };
    const insertPos = beforeItemPos >= 0 ? beforeItemPos : currentItems.length;
    const newItems = [...currentItems];
    newItems.splice(insertPos, 0, newItem);
    commitItems(normalizeItemOrder(newItems));
    autoSaveNote();
    return newItem.id;
  };

  // splitListItem truncates itemId's text to the text before splitPos and
  // inserts a new item directly after it containing the text from splitPos
  // onward, inheriting the same group (parentId) and assignee.
  const splitListItem = (itemId: string, splitPos: number) => {
    if (isReadOnly) return itemId;
    cancelPendingSave();
    const currentItems = itemsRef.current;
    const itemPos = currentItems.findIndex(item => item.id === itemId);
    if (itemPos === -1) return itemId;
    const currentItem = currentItems[itemPos]!;
    const before = currentItem.text.slice(0, splitPos);
    const after = currentItem.text.slice(splitPos);
    const newItem: ListItem = {
      id: generateItemId(),
      text: after,
      completed: currentItem.completed,
      position: 0,
      parentId: currentItem.parentId,
      assignedTo: currentItem.assignedTo,
    };
    const newItems = [...currentItems];
    newItems[itemPos] = { ...currentItem, text: before };
    newItems.splice(itemPos + 1, 0, newItem);
    commitItems(normalizeItemOrder(newItems));
    autoSaveNote();
    return newItem.id;
  };

  const handleItemKeyDown = (index: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Cross-item arrow navigation is only wired up within the uncompleted
      // section; completed items keep default textarea arrow behavior.
      if (index >= uncompletedItems.length) return;
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      const textarea = e.currentTarget;
      if (textarea.value.includes('\n')) return;

      // Treat visually wrapped content as multiline so Arrow keys move caret
      // within the current textarea instead of jumping focus to another row.
      const styles = window.getComputedStyle(textarea);
      const parsedLineHeight = Number.parseFloat(styles.lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : 19.2;
      const verticalPadding =
        (Number.parseFloat(styles.paddingTop) || 0) +
        (Number.parseFloat(styles.paddingBottom) || 0);
      const singleLineHeight = lineHeight + verticalPadding;
      if (textarea.scrollHeight > singleLineHeight + 2) return;

      const targetIndex = e.key === 'ArrowUp' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= uncompletedItems.length) return;

      e.preventDefault();
      const targetItem = uncompletedItems[targetIndex]!;
      const el = itemInputRefs.current.get(targetItem.id);
      if (el) {
        const cursorPos = Math.min(
          (e.target as HTMLTextAreaElement).selectionStart ?? 0,
          el.value.length
        );
        el.focus();
        el.setSelectionRange(cursorPos, cursorPos);
      }
      return;
    }

    if (e.repeat) return;
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

    if (e.key === 'Enter' && e.shiftKey) {
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const currentItem = findTargetItem(index);
      if (!currentItem) return;

      const textarea = e.currentTarget;
      const text = currentItem.text;
      const cursorPos = textarea.selectionStart ?? text.length;

      // Cursor at the very start of a non-empty item: add a blank item
      // before it and move focus there, leaving this item's text untouched.
      if (cursorPos === 0 && text.length > 0) {
        const newId = insertListItemBefore(currentItem.id, {
          parentId: currentItem.parentId,
          assignedTo: currentItem.assignedTo,
        });
        setTimeout(() => itemInputRefs.current.get(newId)?.focus(), 0);
        return;
      }

      // Cursor mid-text: split the item at the cursor into two items.
      if (cursorPos > 0 && cursorPos < text.length) {
        const newId = splitListItem(currentItem.id, cursorPos);
        setTimeout(() => {
          const el = itemInputRefs.current.get(newId);
          if (el) {
            el.focus();
            el.setSelectionRange(0, 0);
          }
        }, 0);
        return;
      }

      // Cursor at the end (or item is empty): append a blank item after.
      const newId = insertListItemAfter(currentItem.id);
      setTimeout(() => {
        itemInputRefs.current.get(newId)?.focus();
      }, 0);
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      // Resolve via findTargetItem: completed rows pass a combined index
      // (uncompletedItems.length + i), so indexing uncompletedItems directly
      // would come up empty there and dead-key the shortcut.
      const currentItem = findTargetItem(index);
      if (!currentItem || currentItem.text.trim() !== '') return;

      e.preventDefault();
      const focusTarget = findTargetItem(e.key === 'Backspace' ? index - 1 : index + 1);

      removeListItem(currentItem.id);

      if (focusTarget) {
        setTimeout(() => {
          const el = itemInputRefs.current.get(focusTarget.id);
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }, 0);
      }
    }
  };

  const handleItemPaste = (index: number, e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    const rawLines = text.split(/\r\n|\r|\n/);
    const nonBlankRawLines = rawLines.filter(l => l.trim().length > 0);

    const currentItem = uncompletedItems[index];
    if (!currentItem) return;

    const input = e.currentTarget;
    const selStart = input.selectionStart ?? input.value.length;
    const selEnd = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, selStart);
    const after = input.value.slice(selEnd);

    // Stripping each line's markdown list/checkbox marker (`- `, `1. `,
    // `[ ]`/`[x]`) and reading its completed state reuses the same line
    // parser the text-note-to-list-note conversion uses, so pasting a
    // markdown checklist behaves the same as converting one.
    const parsedLines = rawLines
      .map(parseTextLineAsListItem)
      .filter((line): line is ConvertedListItem => line !== null);

    if (rawLines.length === 1) {
      // A true single-line paste — the clipboard text contains no newline at
      // all. (A payload with only a *trailing* newline, e.g. "Buy milk\n",
      // still counts as multi-line below: letting native paste run there
      // would insert that raw "\n" into the item's text.) Only intercept it
      // when it actually carried markdown syntax worth stripping — a plain
      // single-line paste (by far the common case) is left to the browser's
      // native paste so undo, IME composition, etc. keep working exactly as
      // they did before.
      const singleLine = parsedLines[0];
      const rawLine = nonBlankRawLines[0];
      if (!singleLine || !rawLine || (singleLine.text === rawLine.trim() && !singleLine.completed)) {
        return;
      }

      e.preventDefault();
      const newText = truncateToCodePoints(before + singleLine.text + after, VALIDATION.ITEM_TEXT_MAX_LENGTH);
      const validationError = validateItemText(newText, t);
      if (validationError) {
        showError(validationError);
        return;
      }

      commitItems(itemsRef.current.map(item =>
        item.id === currentItem.id ? { ...item, text: newText, completed: singleLine.completed } : item
      ));
      cancelPendingSave();
      autoSaveNote();

      const cursorPos = before.length + singleLine.text.length;
      setTimeout(() => {
        const el = itemInputRefs.current.get(currentItem.id);
        if (el) {
          el.focus();
          el.setSelectionRange(cursorPos, cursorPos);
        }
      }, 0);
      return;
    }

    // A genuine multi-line paste: always intercept, even if stripping
    // collapses it down to one (or zero) usable lines — e.g. a bare "#"
    // heading line contributes nothing — since letting the browser's native
    // paste run here would embed a raw newline in the item's text instead.
    e.preventDefault();
    if (parsedLines.length === 0) {
      return;
    }

    const currentItems = itemsRef.current;
    const insertAfterPos = currentItems.findIndex(item => item.id === currentItem.id);

    const firstLine = parsedLines[0]!;
    const firstLineText = truncateToCodePoints(before + firstLine.text, VALIDATION.ITEM_TEXT_MAX_LENGTH);

    const remainingLines = parsedLines.slice(1);

    // Pasting many lines is the one path that can add items in bulk, so it is
    // where the server-side cap is realistically hit. Reject up front instead
    // of letting the save fail with a 422 after the items are already on screen.
    // Checked before building newItems so a huge clipboard payload does not
    // allocate an object and a generated ID per line only to be discarded.
    if (currentItems.length + remainingLines.length > VALIDATION.ITEM_MAX_COUNT) {
      showError(t('note.tooManyItems', { max: VALIDATION.ITEM_MAX_COUNT }));
      return;
    }

    const newItems: ListItem[] = remainingLines.map((line, i) => {
      const isLast = i === remainingLines.length - 1;
      const lineText = isLast ? line.text + after : line.text;
      return {
        id: generateItemId(),
        text: truncateToCodePoints(lineText, VALIDATION.ITEM_TEXT_MAX_LENGTH),
        completed: line.completed,
        position: 0,
        // Pasted lines join the same group as the item they split from.
        parentId: currentItem.parentId,
        assignedTo: '',
      };
    });

    const allLineTexts = [firstLineText, ...newItems.map(item => item.text)];
    for (const lineText of allLineTexts) {
      const validationError = validateItemText(lineText, t);
      if (validationError) {
        showError(validationError);
        return;
      }
    }

    const updatedItems = currentItems.map(item =>
      item.id === currentItem.id ? { ...item, text: firstLineText, completed: firstLine.completed } : item
    );
    updatedItems.splice(insertAfterPos + 1, 0, ...newItems);

    commitItems(normalizeItemOrder(updatedItems));
    cancelPendingSave();
    autoSaveNote();

    if (newItems.length === 0) {
      // Every remaining line stripped to nothing — only the current item's
      // own text changed, so there is nothing new to focus.
      const cursorPos = Math.max(0, firstLineText.length - after.length);
      setTimeout(() => {
        const el = itemInputRefs.current.get(currentItem.id);
        if (el) {
          el.focus();
          el.setSelectionRange(cursorPos, cursorPos);
        }
      }, 0);
      return;
    }

    const lastNewItem = newItems[newItems.length - 1]!;
    setTimeout(() => {
      const el = itemInputRefs.current.get(lastNewItem.id);
      if (el) {
        el.focus();
        const cursorPos = Math.max(0, el.value.length - after.length);
        el.setSelectionRange(cursorPos, cursorPos);
      }
    }, 0);
  };

  const removeListItem = (itemId: string) => {
    if (isReadOnly) return;
    // Removing a parent leaves its children as orphans; normalizeItemOrder
    // promotes them to top-level, mirroring the server's ON DELETE SET NULL.
    const newItems = normalizeItemOrder(itemsRef.current.filter(item => item.id !== itemId));

    commitItems(newItems);
    cancelPendingSave();
    autoSaveNote();
  };

  // handleItemCompletedToggle checks/unchecks an item through the dedicated
  // toggle-completed endpoint so a parent's children cascade atomically in one
  // request. It applies an optimistic local cascade first, then reconciles only
  // the completed flags the server reports — never replacing the whole list, so
  // unsaved edits and not-yet-created items are preserved. Items keep their slot
  // in the single ordered array, so unchecking returns an item to where it was.
  const handleItemCompletedToggle = async (itemId: string, completed: boolean) => {
    if (isReadOnly) return;
    const before = itemsRef.current;
    const target = before.find(item => item.id === itemId);
    if (!target || target.completed === completed) return;

    // Remember the pre-toggle completed state of just the items this toggle
    // touches (the target and, for a parent, its children — or, for a child
    // being unchecked, its parent), so an error reverts only those flags
    // without clobbering edits made to other items meanwhile.
    const revertCompleted = new Map<string, boolean>([[target.id, target.completed]]);
    if (target.parentId === null) {
      for (const item of before) {
        if (item.parentId === itemId) revertCompleted.set(item.id, item.completed);
      }
    } else if (!completed) {
      const parent = before.find(item => item.id === target.parentId);
      if (parent) revertCompleted.set(parent.id, parent.completed);
    }

    commitItems(applyCompletedCascade(before, itemId, completed));

    // A not-yet-persisted note has no server-side item to toggle; the bulk
    // create on save carries the completed flags instead.
    if (!note?.id) return;

    cancelPendingSave();

    try {
      const serverItems = await notes.toggleItemCompleted(note.id, itemId, completed);
      const completedById = new Map(serverItems.map(item => [item.id, item.completed]));
      commitItems(itemsRef.current.map(item => {
        const serverCompleted = completedById.get(item.id);
        return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
      }));
      // Advance the baseline so the diff engine does not re-patch completed.
      baseline.syncCompleted(completedById);
      onRefresh?.();
      flashSaved();
    } catch (error) {
      console.error('Failed to toggle item:', error);
      // Revert only the toggled completed flags; leave any concurrent edits.
      commitItems(itemsRef.current.map(item => {
        const original = revertCompleted.get(item.id);
        return original === undefined ? item : { ...item, completed: original };
      }));
      showError(t('note.failedSaveChanges'));
    }
  };

  // Helper function to handle text updates with debouncing
  const handleTextUpdate = (itemId: string, newText: string) => {
    if (isReadOnly) return;
    // Validate the text input
    const validationError = validateItemText(newText, t);
    if (validationError && newText.trim() !== '') {
      showError(validationError);
      return;
    }
    
    const currentItems = itemsRef.current;
    // Backstop for the gap between this and validateItemText, which measures
    // the trimmed text: whitespace padding can push the stored text over the
    // limit the server enforces on the raw string.
    const textValue = truncateToCodePoints(newText, VALIDATION.ITEM_TEXT_MAX_LENGTH);
    const updatedItems = currentItems.map(item => {
      if (item.id === itemId) {
        return { ...item, text: textValue };
      }
      return item;
    });
    
    commitItems(updatedItems);
    markDirty();
    
    // Auto-save text changes if editing an existing note (with debouncing)
    if (note) {
      scheduleAutoSave();
    }
  };

  // Helper function to find target item by index (for backward compatibility)
  const findTargetItem = (index: number): ListItem | null => {
    if (index < uncompletedItems.length) {
      return uncompletedItems[index] ?? null;
    }
    return completedItems[index - uncompletedItems.length] ?? null;
  };

  // Main updateListItem function - now much simpler and more reliable
  const updateListItem = async (index: number, field: 'text' | 'completed', value: string | boolean) => {
    const targetItem = findTargetItem(index);
    if (!targetItem) return;

    if (field === 'completed') {
      await handleItemCompletedToggle(targetItem.id, value as boolean);
    } else if (field === 'text') {
      handleTextUpdate(targetItem.id, value as string);
    }
  };

  // Restores a completed item at the position of the current (placeholder) item,
  // keeping its assignment, and removes the placeholder.
  const acceptSuggestion = (currentItemId: string, suggestionText: string) => {
    if (isReadOnly) return;
    const completedItem = completedItems.find(
      item => item.text.trim().toLowerCase() === suggestionText.toLowerCase()
    );

    if (!completedItem) {
      // No matching completed item — fall back to just updating the text
      const currentItems = itemsRef.current;
      const updatedItems = currentItems.map(item =>
        item.id === currentItemId ? { ...item, text: suggestionText } : item
      );
      commitItems(updatedItems);
      cancelPendingSave();
      autoSaveNote();
      return;
    }

    // Drop the empty placeholder and re-activate the matched completed item in
    // its place, keeping its assignee and group (parentId). normalizeItemOrder
    // settles it back into its group and re-sequences positions.
    const currentItems = itemsRef.current;
    const placeholderIndex = currentItems.findIndex(item => item.id === currentItemId);
    const withoutBoth = currentItems.filter(
      item => item.id !== currentItemId && item.id !== completedItem.id
    );
    const restoredItem: ListItem = { ...completedItem, completed: false };
    const insertIndex = placeholderIndex >= 0 ? Math.min(placeholderIndex, withoutBoth.length) : withoutBoth.length;
    withoutBoth.splice(insertIndex, 0, restoredItem);

    commitItems(normalizeItemOrder(withoutBoth));

    cancelPendingSave();
    autoSaveNote();

    // Restore focus to the item now sitting at the same position
    setTimeout(() => {
      const el = itemInputRefs.current.get(restoredItem.id);
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  };

  const collaborators = useMemo<Collaborator[]>(() => {
    if (!note?.is_shared) return [];
    return buildCollaborators(note.user_id, note.shared_with, usersById);
  }, [note, usersById]);

  const assignItem = async (itemId: string, userId: string) => {
    if (isReadOnly) return;
    const updatedItems = itemsRef.current.map(item =>
      item.id === itemId ? { ...item, assignedTo: userId } : item,
    );
    commitItems(updatedItems);
    await autoSaveNote();
  };

  const persistExistingNote = useCallback(async () => {
    if (!note) return;

    cancelPendingSave();

    // Flush any pending scalar and item changes as granular operations.
    await flushSave();
    onRefresh?.();
  }, [cancelPendingSave, flushSave, note, onRefresh]);

  const handleSave = async () => {
    if (!beginExclusiveSave()) return;
    // Cancel any pending debounced autosave to avoid a stale write racing
    // with this immediate save.
    cancelPendingSave();
    setLoading(true);
    try {
      if (note) {
        await persistExistingNote();
      } else {
        const createData: CreateNoteRequest = noteType === 'list'
          ? {
              note_type: 'list',
              title,
              color,
              // The bulk create path is positional: it reconstructs parent_id by
              // attaching each indented item to the nearest preceding top-level
              // one. items is kept in normalized order (a parent precedes its
              // children), so deriving indent_level from parentId is sufficient.
              items: items.map((item, idx) => ({
                id: item.id,
                text: item.text,
                position: idx,
                completed: item.completed,
                indent_level: indentOf(item),
              })),
              labels: noteLabels.length > 0 ? noteLabels.map(l => l.name) : undefined,
            }
          : {
              note_type: 'text',
              content,
              color,
              labels: noteLabels.length > 0 ? noteLabels.map(l => l.name) : undefined,
            };
        await notes.create(createData);
      }
      onSave();
    } catch (error) {
      console.error('Failed to save note:', error);
      showError(t('note.failedSaveChanges'));
    } finally {
      endExclusiveSave();
      setLoading(false);
    }
  };

  // List -> text is lossy (assignments, real checkbox/nesting structure), so
  // it's confirmed first; text -> list just reflows lines and runs directly.
  const handleConvertClick = () => {
    if (!note || !onConvert || loading || isSaving() || isReadOnly) return;
    if (noteType === 'list') {
      setShowConvertConfirm(true);
    } else {
      void performConvert();
    }
  };

  const performConvert = async () => {
    if (!note || !onConvert) return;
    const targetType: NoteType = noteType === 'list' ? 'text' : 'list';

    beginExclusiveSave();
    setLoading(true);
    try {
      await persistExistingNote();
    } catch (error) {
      console.error('Failed to save note before conversion:', error);
      showError(t('note.failedSaveChanges'));
      endExclusiveSave();
      setLoading(false);
      setShowConvertConfirm(false);
      return;
    }

    // Refetch the version rather than trusting the `note` prop: persistExistingNote()
    // may have just flushed a scalar edit that bumped it server-side, and a stale
    // value here would make the conversion spuriously conflict with its own flush.
    let baseVersion = note.version;
    try {
      baseVersion = (await notes.getById(note.id)).version;
    } catch (error) {
      console.error('Failed to refetch note version before conversion:', error);
    }

    try {
      const data: ConvertNoteTypeRequest = targetType === 'list'
        ? {
            note_type: 'list',
            base_version: baseVersion,
            items: textToListItems(content).map((item, idx) => ({
              text: item.text,
              position: idx,
              completed: item.completed,
              // The server rebuilds parent_id from this, attaching each indented
              // item to the nearest preceding top-level one.
              indent_level: item.indentLevel,
            })),
          }
        : {
            note_type: 'text',
            base_version: baseVersion,
            content: listToText(title, items.map(item => ({
              id: item.id,
              text: item.text,
              completed: item.completed,
              position: item.position,
              parent_id: item.parentId,
            }))),
          };
      await onConvert(note.id, data);
      // Keep the modal open on the converted note. onRefresh refetches the note
      // into the parent's editingNote state; because it's fire-and-forget, its
      // setState lands after this function's `finally` clears savingRef, so the
      // adoption effect picks up the converted note instead of being skipped.
      onRefresh?.();
    } catch (error) {
      console.error('Failed to convert note:', error);
      showError(t('note.failedConvert'));
    } finally {
      endExclusiveSave();
      setLoading(false);
      setShowConvertConfirm(false);
    }
  };

  const handleDuplicate = async () => {
    if (!note || !onDuplicate || loading || isSaving() || isReadOnly) return;

    beginExclusiveSave();
    setLoading(true);
    try {
      await persistExistingNote();
    } catch (error) {
      console.error('Failed to save note before duplicate:', error);
      showError(t('note.failedSaveChanges'));
      endExclusiveSave();
      setLoading(false);
      return;
    }

    try {
      await onDuplicate(note.id);
      onClose();
    } catch (error) {
      console.error('Failed to duplicate note:', error);
      showError(t('note.failedDuplicate'));
    } finally {
      endExclusiveSave();
      setLoading(false);
    }
  };

  const handlePinToggle = async () => {
    if (!note || isReadOnly) return;

    const newPinnedState = !pinned;
    setPinned(newPinnedState);

    try {
      // Send only the field that changed so concurrent item/title edits made
      // elsewhere are not overwritten.
      await notes.update(note.id, { pinned: newPinnedState });
      markScalarSaved({ pinned: newPinnedState });
      onRefresh?.();
      showToast(
        newPinnedState ? t('dashboard.notePinned') : t('dashboard.noteUnpinned'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { pinned: !newPinnedState });
              markScalarSaved({ pinned: !newPinnedState });
              setPinned(!newPinnedState);
              onRefresh?.();
            } catch (undoError) {
              console.error('Failed to undo pin status update:', undoError);
              showToast(t('note.failedPin'), 'error');
            }
          },
        }
      );
    } catch (error) {
      console.error('Failed to update pin status:', error);
      setPinned(!newPinnedState);
    }
  };

  const handleArchiveToggle = async () => {
    if (!note || isReadOnly) return;

    const newArchivedState = !archived;
    setArchived(newArchivedState);

    try {
      await notes.update(note.id, { archived: newArchivedState });
      markScalarSaved({ archived: newArchivedState });
      showToast(
        newArchivedState ? t('dashboard.noteArchived') : t('dashboard.noteUnarchived'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { archived: !newArchivedState });
              markScalarSaved({ archived: !newArchivedState });
              setArchived(!newArchivedState);
              onRefresh?.();
            } catch (undoError) {
              console.error('Failed to undo archive status update:', undoError);
              showToast(t('note.failedArchive'), 'error');
            }
          },
        }
      );
      if (newArchivedState) {
        onRefresh?.();
        onClose();
      } else {
        onRefresh?.();
      }
    } catch (error) {
      console.error('Failed to update archive status:', error);
      setArchived(!newArchivedState);
    }
  };

  const handleDelete = () => {
    if (!note || !onDelete || isReadOnly) return;
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    if (!note || !onDelete) return;
    onDelete(note.id);
    setShowDeleteConfirm(false);
    onClose();
  };

  const handleRestore = () => {
    if (!note || !onRestore) return;
    onRestore(note.id);
    onClose();
  };

  const handlePermanentlyDelete = () => {
    if (!note || !onPermanentlyDelete) return;
    setShowPermanentDeleteConfirm(true);
  };

  const confirmPermanentlyDelete = () => {
    if (!note || !onPermanentlyDelete) return;
    onPermanentlyDelete(note.id);
    setShowPermanentDeleteConfirm(false);
    onClose();
  };

  const handleToggleCompleted = async () => {
    if (isReadOnly) return;
    if (!note) {
      // If creating a new note, just toggle local state
      setCheckedItemsCollapsed(!checkedItemsCollapsed);
      return;
    }
    
    const newCollapsedState = !checkedItemsCollapsed;
    setCheckedItemsCollapsed(newCollapsedState);

    try {
      await notes.update(note.id, { checked_items_collapsed: newCollapsedState });
      markScalarSaved({ checked_items_collapsed: newCollapsedState });
      onRefresh?.();
    } catch (error) {
      console.error('Failed to update collapse state:', error);
      // Revert the state on error
      setCheckedItemsCollapsed(checkedItemsCollapsed);
    }
  };

  const hasUnsavedChanges = () => {
    if (note) {
      // Compare against the same saved baseline the autosave pipeline uses
      // (savedScalarsRef/savedItemsRef), not the note prop: adoption renumbers
      // item positions and the prop can lag behind granular saves, so a
      // prop-based comparison reports "changes" when there is nothing left to
      // flush and closing then runs a pointless save pass.
      return isDirty();
    } else {
      if (noteType === 'list') {
        return title.trim() !== '' || items.some(item => item.text.trim() !== '') || noteLabels.length > 0;
      } else {
        return content.trim() !== '' || noteLabels.length > 0;
      }
    }
  };

  const handleCloseRequest = async () => {
    if (hasUnsavedChanges()) {
      if (isSaving()) {
        // An auto-save is already in flight. Cancel any pending debounced
        // text-save and request one more pass; the in-flight autoSaveNote loop
        // keeps running after unmount (refs persist in its closure) and flushes
        // the latest edits, so closing now does not drop them.
        cancelPendingSave();
        requestAnotherSavePass();
        onClose();
        return;
      }
      await handleSave();
    } else {
      onClose();
    }
  };

  const toggleColorPicker = () => {
    setShowColorPicker(v => {
      if (!v) {
        requestAnimationFrame(() => {
          colorPickerRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
        });
      }
      return !v;
    });
  };

  // An effect event so the window listener below can be registered once and
  // still see the latest props/state on every keypress.
  const handleModalShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (showDeleteConfirm) return;

    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!note || isReadOnly || isEditableElementFocused()) return;

    const key = e.key === 'Backspace' ? 'backspace' : e.key === 'Delete' ? 'delete' : e.key.toLowerCase();

    if (key === 'a') {
      e.preventDefault();
      handleArchiveToggle();
    } else if (key === 'p') {
      e.preventDefault();
      handlePinToggle();
    } else if (key === 'd') {
      e.preventDefault();
      if (!onDuplicate) return;
      handleDuplicate();
    } else if (key === 's') {
      e.preventDefault();
      if (!onShare || !isOwner) return;
      onShare(note);
    } else if (key === 'l') {
      e.preventDefault();
      setShowLabelPicker(v => !v);
    } else if (key === 'c') {
      e.preventDefault();
      toggleColorPicker();
    } else if (key === 'backspace' || key === 'delete') {
      e.preventDefault();
      if (!onDelete || !isOwner) return;
      handleDelete();
    }
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => handleModalShortcut(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const assignedItemCount = items.filter(item => item.assignedTo).length;
  const convertToTextConfirmMessage = assignedItemCount > 0
    ? `${t('note.convertToTextConfirmMessage')} ${t('note.convertLoseAssignments', { count: assignedItemCount })}`
    : t('note.convertToTextConfirmMessage');

  return (
    <>
      <Dialog
        open={true}
        onClose={() => {
          // If the backdrop mousedown already handled this dismiss, skip.
          if (backdropHandledRef.current) {
            backdropHandledRef.current = false;
            return;
          }
          // Escape key: two-step dismiss — collapse first, then close on second
          // press. Only text notes have an edit/preview mode; for list notes
          // isEditingContent is meaningless (it merely starts out true on new
          // notes), so consuming a press to flip it would make the first
          // Escape silently do nothing.
          if (noteType === 'text' && isEditingContent) {
            setIsEditingContent(false);
          } else {
            handleCloseRequest();
          }
        }}
        className="relative z-50"
      >
        <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/30 dark:bg-black/50 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />

        {/* Backdrop mousedown: two-step dismiss matching Dialog.onClose.
            Using onMouseDown (not onClick) so both this handler and HeadlessUI's
            outside-click detection (which also fires on mousedown) see the same
            isEditingContent value before any React re-render between events.
            target===currentTarget ensures clicks inside the panel that bubble up
            are ignored. */}
        <div
          className="fixed inset-0 flex items-center justify-center p-2 sm:p-4 overflow-hidden"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            // Signal onClose to skip its logic — we're handling this dismiss.
            backdropHandledRef.current = true;
            if (noteType === 'text' && isEditingContent) {
              setIsEditingContent(false);
            } else {
              handleCloseRequest();
            }
          }}
        >
        <DialogPanel
          ref={panelRef}
          transition
          className={`mx-auto w-full max-w-lg max-h-[90vh] overflow-hidden rounded-lg shadow-xl relative transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none ${
            colors.find(c => c.value === color)?.class || 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600'
          }`}
          onDragEnter={isReadOnly ? undefined : handleImageDragEnter}
          onDragOver={isReadOnly ? undefined : handleImageDragOver}
          onDragLeave={isReadOnly ? undefined : handleImageDragLeave}
          onDrop={isReadOnly ? undefined : handleImageDrop}
          onPaste={isReadOnly ? undefined : handleModalPaste}
        >
          {isDraggingImage && (
            <div
              data-testid="note-image-drop-overlay"
              className="absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/90 dark:bg-blue-900/80 pointer-events-none"
            >
              <span className="text-blue-700 dark:text-blue-200 font-medium">{t('images.dropOverlay')}</span>
            </div>
          )}

          {/* Top-right controls — close button, and Done when editing */}
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
            {noteType === 'text' && isEditingContent && (
              <button
                type="button"
                aria-label={t('common.done')}
                onClick={() => setIsEditingContent(false)}
                className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
              >
                <Check className="h-5 w-5 text-blue-500 dark:text-blue-400" />
              </button>
            )}
            <button
              aria-label={t('common.close')}
              onClick={handleCloseRequest}
              className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
            >
              <X className="h-5 w-5 text-gray-600 dark:text-gray-300" />
            </button>
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="mx-4 mt-2 p-3 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 text-sm rounded-md flex items-center justify-between">
              <span>{errorMessage}</span>
              <button
                onClick={() => setErrorMessage(null)}
                className="ml-2 text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              >
                ×
              </button>
            </div>
          )}

          {/* Content */}
          <div className="p-2 sm:p-4 pt-10 space-y-4 overflow-y-auto scrollbar-subtle max-h-[calc(90vh-8rem)]">
            {/* Image gallery, rendered above the title. Persisted images come
                from the note prop so SSE-driven updates from OTHER clients
                render live; displayedImages layers this session's own
                not-yet-confirmed uploads on top (see optimisticImages) and
                removes anything mid-undo-window, since neither of those is
                reflected in note.images on their own. */}
            {(displayedImages.length > 0 || imageUploads.length > 0) && (
              <NoteImageGallery
                images={displayedImages}
                editable={!!note && !isReadOnly}
                uploads={imageUploads}
                onRemove={removeNoteImage}
                onRetryUpload={retryImageUpload}
                onDismissUpload={removeUploadTile}
              />
            )}

            {/* Inline "Image removed — Undo" bars for client-deferred removals. */}
            {removedImages.map(image => (
              <div
                key={image.id}
                className="flex items-center justify-between rounded-md bg-gray-800 dark:bg-slate-900 text-white text-sm px-3 py-2"
              >
                <span>{t('images.removedToast')}</span>
                <button
                  type="button"
                  onClick={() => undoRemoveImage(image.id)}
                  className="ml-3 font-medium text-blue-300 hover:text-blue-200 hover:underline"
                >
                  {t('dashboard.undo')}
                </button>
              </div>
            ))}

            {/* Inline "checked items deleted — Undo" bar for the deferred bulk
                delete (rendered inside the Dialog, not the app-wide toast). */}
            {removedCompletedItems.length > 0 && (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex items-center justify-between rounded-md bg-gray-800 dark:bg-slate-900 text-white text-sm px-3 py-2"
                data-testid="checked-items-removed-bar"
              >
                <span>{t('note.checkedItemsDeleted', { count: removedCompletedItems.length })}</span>
                <button
                  type="button"
                  onClick={undoDeleteCompletedItems}
                  className="ml-3 font-medium text-blue-300 hover:text-blue-200 hover:underline"
                  data-testid="checked-items-undo"
                >
                  {t('dashboard.undo')}
                </button>
              </div>
            )}

            {/* Inline "N items unchecked — Undo" bar. Undo re-checks the snapshot. */}
            {recentlyUnchecked && (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex items-center justify-between rounded-md bg-gray-800 dark:bg-slate-900 text-white text-sm px-3 py-2"
                data-testid="unchecked-items-bar"
              >
                <span>{t('note.itemsUnchecked', { count: recentlyUnchecked.count })}</span>
                <button
                  type="button"
                  onClick={undoUncheckAll}
                  className="ml-3 font-medium text-blue-300 hover:text-blue-200 hover:underline"
                  data-testid="unchecked-items-undo"
                >
                  {t('dashboard.undo')}
                </button>
              </div>
            )}

            {/* Note type selector (only for new notes) */}
            {!note && (
              <div className="flex space-x-2">
                <button
                  onClick={() => setNoteType('text')}
                  className={`px-3 py-1 text-sm rounded-md ${
                    noteType === 'text'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('note.typeText')}
                </button>
                <button
                  onClick={() => setNoteType('list')}
                  className={`px-3 py-1 text-sm rounded-md ${
                    noteType === 'list'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('note.typeList')}
                </button>
              </div>
            )}

            {/* Title (list notes only) */}
            {noteType === 'list' && (
              <input
                type="text"
                autoCapitalize="sentences"
                placeholder={t('note.titlePlaceholder')}
                readOnly={isReadOnly}
                aria-readonly={isReadOnly}
                className="w-full p-2 text-lg font-medium bg-transparent border-none outline-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white"
                value={title}
                onChange={(e) => {
                  if (isReadOnly) return;
                  const newTitle = e.target.value;
                  const validationError = validateTitle(newTitle, t);
                  if (validationError) {
                    showError(validationError);
                    return;
                  }
                  setTitle(newTitle);
                  if (note) {
                    markDirty();
                    scheduleAutoSave();
                  }
                }}
                onKeyDown={isReadOnly ? undefined : (e) => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.repeat) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const firstItem = uncompletedItems[0];
                    if (firstItem) {
                      const input = itemInputRefs.current.get(firstItem.id);
                      if (input) {
                        input.focus();
                        input.setSelectionRange(input.value.length, input.value.length);
                      }
                    } else {
                      addListItemAndFocus();
                    }
                  }
                }}
              />
            )}

            {/* Content based on type */}
            {noteType === 'text' ? (
              <>
                {isEditingContent && !isReadOnly ? (
                  <>
                  <textarea
                    ref={contentRef}
                    id={contentTextareaId}
                    autoCapitalize="sentences"
                    placeholder={t('note.contentPlaceholder')}
                    rows={4}
                    className="w-full p-2 border-none outline-none resize-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white min-h-[6rem] rounded-md bg-gray-50 dark:bg-slate-700/40 transition-colors duration-150"
                    value={content}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsEditingContent(false);
                        return;
                      }
                      // Editor-scoped, so they live here rather than in the
                      // global shortcut registry — which stands down whenever a
                      // text field has focus (isEditableElementFocused).
                      //
                      // Shift and Alt must both be absent, not just Alt: the
                      // combinations they form are the browser's, not ours
                      // (Ctrl+Shift+B toggles the bookmarks bar in Chrome).
                      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
                        const key = e.key.toLowerCase();
                        if (key === 'b' || key === 'i') {
                          e.preventDefault();
                          applyMarkdownEdit((state) => toggleInlineMarker(state, key === 'b' ? '**' : '*'));
                          return;
                        }
                      }
                      // Snapshot the caret before the browser applies the key,
                      // for continueListOnNewline.
                      selectionBeforeKeyRef.current = e.key === 'Enter'
                        ? { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
                        : null;
                    }}
                    onChange={(e) => {
                      const textarea = e.currentTarget;
                      const newContent = textarea.value;
                      const validationError = validateContent(newContent, t);
                      if (validationError) {
                        showError(validationError);
                        return;
                      }
                      // Enter at the end of a list item carries the marker onto
                      // the next line; when it does, it has already written the
                      // text itself.
                      if (handleListContinuation(textarea, newContent)) return;
                      setContent(newContent);
                      if (note) {
                        markDirty();
                        scheduleAutoSave();
                      }
                    }}
                  />
                  <MarkdownToolbar onAction={handleToolbarAction} controlsId={contentTextareaId} />
                  </>
                ) : (
                  <div
                    data-testid="note-content-preview"
                    role="textbox"
                    aria-label={t('note.contentPlaceholder')}
                    aria-multiline="true"
                    aria-readonly={isReadOnly}
                    tabIndex={0}
                    onClick={() => !isReadOnly && setIsEditingContent(true)}
                    onKeyDown={(e) => {
                      if (isReadOnly) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setIsEditingContent(true);
                      }
                    }}
                    className={`w-full p-2 min-h-[6rem] text-gray-900 dark:text-white markdown-content ${isReadOnly ? '' : 'cursor-text'}`}
                    dangerouslySetInnerHTML={{
                      __html: renderedContent ||
                        `<span class="text-gray-400 dark:text-gray-500 pointer-events-none">${t('note.contentPlaceholder')}</span>`,
                    }}
                  />
                )}
              </>
            ) : (
              <div className="space-y-4">
                {/* Uncompleted items section */}
                <div className="space-y-2">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={uncompletedItems.map((item) => item.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {uncompletedItems.map((item, index) => (
                        <SortableItem
                          key={item.id}
                          id={item.id}
                          index={index}
                          item={item}
                          onUpdateListItem={updateListItem}
                          onRemoveListItem={removeListItem}
                          isCompleted={false}
                          readOnly={isReadOnly}
                          onKeyDown={handleItemKeyDown}
                          onPaste={handleItemPaste}
                          onIndentChange={indentListItem}
                          inputRef={(el) => {
                            if (el) itemInputRefs.current.set(item.id, el);
                            else itemInputRefs.current.delete(item.id);
                          }}
                          isShared={note?.is_shared}
                          collaborators={collaborators}
                          usersById={usersById}
                          onAssignItem={assignItem}
                          completedItemTexts={completedItemTexts}
                          onAcceptSuggestion={acceptSuggestion}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  {!isReadOnly && (
                    <button
                      onClick={addListItemAndFocus}
                      className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white p-1"
                    >
                      <Plus className="h-4 w-4" />
                      <span>{t('note.addItem')}</span>
                    </button>
                  )}
                </div>

                {/* Completed items section */}
                {completedItems.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-white/20 pt-3">
                    <button
                      onClick={() => !isReadOnly && handleToggleCompleted()}
                      disabled={isReadOnly}
                      className={`flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 mb-2 ${isReadOnly ? '' : 'hover:text-gray-800 dark:hover:text-white'}`}
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${!isReadOnly && checkedItemsCollapsed ? '-rotate-90' : 'rotate-0'}`}
                      />
                      <span>{t('note.completedItems', { count: completedItems.length })}</span>
                    </button>

                    {(isReadOnly || !checkedItemsCollapsed) && (
                      <div className="space-y-2">
                        {(() => {
                          // Render completed items keeping groups intact. A completed
                          // child whose parent is still active is shown under a
                          // non-interactive "ghost" copy of that parent, so the child
                          // never escapes its group into a flat pile. A parent that was
                          // completed (cascading to its children) renders as a normal
                          // checked parent followed by its children; top-level completed
                          // items render on their own.
                          const completedIds = new Set(completedItems.map(i => i.id));
                          const itemsById = new Map(items.map(i => [i.id, i]));
                          const rows: ReactElement[] = [];
                          let lastGhostParentId: string | null = null;

                          completedItems.forEach((item, completedIndex) => {
                            const parent = item.parentId ? itemsById.get(item.parentId) : undefined;
                            const parentIsCompleted = item.parentId ? completedIds.has(item.parentId) : false;

                            if (parent && !parentIsCompleted) {
                              if (lastGhostParentId !== parent.id) {
                                lastGhostParentId = parent.id;
                                rows.push(
                                  <div
                                    key={`ghost-${parent.id}`}
                                    className="flex items-start gap-2 min-w-0 text-sm opacity-60 select-none"
                                    style={{ marginLeft: indentOf(parent) * VALIDATION.INDENT_PX_PER_LEVEL }}
                                    // The label must match the rendered text below, not the
                                    // source: aria-label replaces the element's content for
                                    // assistive tech, so raw markers would be all it announced.
                                    aria-label={t('note.completedItemGroup', {
                                      title: inlineMarkdownToText(parent.text),
                                    })}
                                  >
                                    <div className="w-6 h-4 flex-shrink-0"></div>
                                    <input
                                      type="checkbox"
                                      checked={false}
                                      disabled
                                      readOnly
                                      aria-hidden="true"
                                      className="h-4 w-4 rounded mt-0.5 flex-shrink-0 cursor-default"
                                    />
                                    <InlineMarkdown
                                      text={parent.text}
                                      className="min-w-0 whitespace-pre-wrap break-words font-semibold text-gray-500 dark:text-gray-400"
                                    />
                                  </div>,
                                );
                              }
                            } else {
                              lastGhostParentId = null;
                            }

                            rows.push(
                              <SortableItem
                                key={item.id}
                                id={item.id}
                                index={uncompletedItems.length + completedIndex}
                                item={item}
                                onUpdateListItem={(idx, field, value) => updateListItem(idx, field, value)}
                                onRemoveListItem={removeListItem}
                                isCompleted={true}
                                readOnly={isReadOnly}
                                onKeyDown={handleItemKeyDown}
                                inputRef={(el) => {
                                  if (el) itemInputRefs.current.set(item.id, el);
                                  else itemInputRefs.current.delete(item.id);
                                }}
                                isShared={note?.is_shared}
                                collaborators={collaborators}
                                usersById={usersById}
                                onAssignItem={assignItem}
                              />,
                            );
                          });

                          return rows;
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Labels + Avatars row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Label picker anchor. Saved notes manage labels via the overflow
                  menu and reopen the picker by clicking their label chips. Unsaved
                  notes have no overflow menu, so they keep the inline chips plus an
                  explicit "Add labels" button. */}
              <div className="relative">
                {note ? (
                  noteLabels.length > 0 && (
                    isReadOnly ? (
                      <div className="-mx-1 inline-flex flex-wrap items-center gap-2 px-1 py-0.5">
                        {noteLabels.map(label => (
                          <LabelChip key={label.id} name={label.name} />
                        ))}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowLabelPicker(v => !v)}
                        onMouseDown={(event) => event.stopPropagation()}
                        className="-mx-1 inline-flex flex-wrap items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                        aria-label={t('labels.title')}
                        aria-expanded={showLabelPicker}
                      >
                        {noteLabels.map(label => (
                          <LabelChip key={label.id} name={label.name} />
                        ))}
                      </button>
                    )
                  )
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {noteLabels.map(label => (
                      <LabelChip key={label.id} name={label.name} />
                    ))}
                    <button
                      onClick={() => setShowLabelPicker(v => !v)}
                      onMouseDown={(event) => event.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-blue-300 dark:border-blue-700 bg-blue-50/80 dark:bg-blue-900/20 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                      title={t('labels.addLabels')}
                      aria-label={t('labels.addLabels')}
                      aria-expanded={showLabelPicker}
                    >
                      <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{t('labels.addLabels')}</span>
                    </button>
                  </div>
                )}
                {showLabelPicker && (
                  note ? (
                    <LabelPicker note={{...note, labels: noteLabels}} onRefresh={onRefresh} onNoteUpdate={(n) => setNoteLabels(n.labels ?? [])} onError={showError} onClose={() => setShowLabelPicker(false)} />
                  ) : (
                    <LabelPicker selectedLabels={noteLabels} onLocalChange={setNoteLabels} onError={showError} onClose={() => setShowLabelPicker(false)} />
                  )
                )}
              </div>
              {/* Share avatars — clicking opens the share modal (owners only) */}
              {note?.is_shared && (() => {
                const avatars = buildShareAvatars(note, currentUserId, usersById);
                if (avatars.length === 0) return null;
                const avatarEls = avatars.map((a) => (
                  <div key={a.key} title={a.displayName}>
                    <LetterAvatar
                      firstName={a.firstName}
                      username={a.username}
                      userId={a.userId}
                      hasProfileIcon={a.hasProfileIcon}
                      iconVersion={a.iconVersion}
                      className="w-6 h-6 ring-2 ring-white dark:ring-slate-800"
                    />
                  </div>
                ));
                return isOwner && onShare && !isReadOnly ? (
                  <button
                    type="button"
                    onClick={() => onShare(note)}
                    onMouseDown={(event) => event.stopPropagation()}
                    className="flex items-center -space-x-1 rounded-full transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    title={t('note.share')}
                    aria-label={t('note.share')}
                  >
                    {avatarEls}
                  </button>
                ) : (
                  <div className="flex items-center -space-x-1">{avatarEls}</div>
                );
              })()}
            </div>

          </div>

          {/* Footer toolbar */}
          <div className="border-t border-gray-200 dark:border-white/20">
            {/* Color picker popover */}
            {showColorPicker && (
              <div
                ref={colorPickerRef}
                role="group"
                aria-label={t('note.colorPickerLabel')}
                className="flex flex-wrap gap-2 p-3 border-b border-gray-100 dark:border-white/10"
                aria-roledescription="color swatches"
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  const currentIndex = colors.findIndex(c => c.value === color);
                  const nextIndex = currentIndex === -1
                    ? (e.key === 'ArrowLeft' ? colors.length - 1 : 0)
                    : e.key === 'ArrowLeft'
                      ? Math.max(0, currentIndex - 1)
                      : Math.min(colors.length - 1, currentIndex + 1);
                  if (nextIndex === currentIndex) return;
                  const nextColor = colors[nextIndex]!.value;
                  setColor(nextColor);
                  if (note) {
                    markDirty();
                    applyDraftScalars({ color: nextColor });
                    autoSaveNote();
                  }
                  colorPickerRef.current?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus();
                }}
              >
                {colors.map((colorOption) => (
                  <button
                    key={colorOption.value}
                    tabIndex={colorOption.value === color ? 0 : -1}
                    onClick={() => {
                      const newColor = colorOption.value;
                      setColor(newColor);
                      setShowColorPicker(false);
                      if (note) {
                        markDirty();
                        applyDraftScalars({ color: newColor });
                        autoSaveNote();
                      }
                    }}
                    className={`w-8 h-8 rounded-full border-2 ${colorOption.class} ${
                      color === colorOption.value ? 'ring-2 ring-blue-500' : ''
                    }`}
                    title={colorOption.name}
                    aria-label={colorOption.name}
                    aria-pressed={color === colorOption.value}
                  />
                ))}
              </div>
            )}

            {/* Action buttons row */}
            <div className="flex items-center justify-between p-2 sm:p-3">
              <div className="flex items-center space-x-1">
                {/* Color picker toggle */}
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => !isReadOnly && toggleColorPicker()}
                  disabled={isReadOnly}
                  className={`p-1 rounded-full transition-colors ${isReadOnly ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-200 dark:hover:bg-slate-700'}`}
                  title={t('note.colorPickerLabel')}
                  aria-label={t('note.colorPickerLabel')}
                  aria-expanded={showColorPicker}
                >
                  <Palette className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                </button>

                {note && (
                  <>
                    <input
                      ref={imageFileInputRef}
                      type="file"
                      accept={IMAGE_ALLOWED_TYPES.join(',')}
                      multiple
                      className="hidden"
                      onChange={handleImageFileInputChange}
                      data-testid="note-image-file-input"
                    />
                    <button
                      type="button"
                      onClick={() => !isReadOnly && imageFileInputRef.current?.click()}
                      disabled={isReadOnly}
                      className={`p-1 rounded-full transition-colors ${isReadOnly ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-200 dark:hover:bg-slate-700'}`}
                      title={t('images.addImage')}
                      aria-label={t('images.addImage')}
                    >
                      <Image className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                    </button>
                    <button
                      onClick={handlePinToggle}
                      disabled={isReadOnly}
                      className={`p-1 rounded-full transition-colors ${isReadOnly ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-200 dark:hover:bg-slate-700'}`}
                      title={pinned ? t('note.unpinNote') : t('note.pinNote')}
                      aria-label={pinned ? t('note.unpinNote') : t('note.pinNote')}
                    >
                      <Pin
                        className={pinned ? 'h-5 w-5 text-blue-500' : 'h-5 w-5 text-gray-600 dark:text-gray-300'}
                        fill={pinned ? 'currentColor' : 'none'}
                      />
                    </button>
                    <button
                      onClick={handleArchiveToggle}
                      disabled={isReadOnly}
                      className={`p-1 rounded-full transition-colors ${isReadOnly ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-200 dark:hover:bg-slate-700'}`}
                      title={archived ? t('note.unarchiveNote') : t('note.archiveNote')}
                      aria-label={archived ? t('note.unarchiveNote') : t('note.archiveNote')}
                    >
                      {archived ? (
                        <ArchiveX className="h-5 w-5 text-blue-500" />
                      ) : (
                        <Archive className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      )}
                    </button>
                    {/* Overflow menu — mirrors the mobile three-dot layout so the
                        toolbar stays uncluttered as more actions are added. Labels
                        is always available, so the menu always renders here. */}
                    <Menu as="div" className="relative">
                        <MenuButton
                          onMouseDown={(e) => e.stopPropagation()}
                          className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                          title={t('note.menuOptions')}
                          aria-label={t('note.menuOptions')}
                        >
                          <EllipsisVertical className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                        </MenuButton>
                        <MenuItems
                          transition
                          anchor={{ to: 'top start', gap: 4 }}
                          className="w-56 origin-bottom-left bg-white dark:bg-slate-800 rounded-md shadow-lg ring-1 ring-black/5 dark:ring-slate-600/20 focus:outline-none z-50 border border-gray-200 dark:border-slate-600 transition duration-100 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none"
                        >
                          <div className="py-1">
                            {noteDeepLinkHref && (
                              <MenuItem>
                                <a
                                  href={noteDeepLinkHref}
                                  className={OVERFLOW_ITEM}
                                  data-testid="note-open-mobile-app-toolbar-link"
                                >
                                  <Smartphone className="h-4 w-4 mr-2" />
                                  {t('nav.openMobileApp')}
                                </a>
                              </MenuItem>
                            )}
                            {isReadOnly ? (
                              <>
                                {onRestore && (
                                  <MenuItem>
                                    <button
                                      onClick={handleRestore}
                                      className={OVERFLOW_ITEM}
                                      data-testid="note-restore"
                                    >
                                      <Undo2 className="h-4 w-4 mr-2" />
                                      {t('note.restore')}
                                    </button>
                                  </MenuItem>
                                )}
                                {onPermanentlyDelete && (
                                  <MenuItem>
                                    <button
                                      onClick={handlePermanentlyDelete}
                                      className={OVERFLOW_ITEM_DANGER}
                                      data-testid="note-delete-forever"
                                    >
                                      <Trash2 className="h-4 w-4 mr-2" />
                                      {t('note.deleteForever')}
                                    </button>
                                  </MenuItem>
                                )}
                              </>
                            ) : (
                              <>
                            {onConvert && (
                              <MenuItem>
                                <button
                                  onClick={handleConvertClick}
                                  className={OVERFLOW_ITEM}
                                >
                                  <ArrowLeftRight className="h-4 w-4 mr-2" />
                                  {noteType === 'list' ? t('note.convertToText') : t('note.convertToList')}
                                </button>
                              </MenuItem>
                            )}
                            {noteType === 'list' && completedItems.length > 0 && (
                              <>
                                <MenuItem>
                                  <button
                                    onClick={handleUncheckAllItems}
                                    className={OVERFLOW_ITEM}
                                    data-testid="note-uncheck-all"
                                  >
                                    <Square className="h-4 w-4 mr-2" />
                                    {t('note.uncheckAllItems')}
                                  </button>
                                </MenuItem>
                                <MenuItem>
                                  <button
                                    onClick={handleDeleteCompletedItems}
                                    className={OVERFLOW_ITEM}
                                    data-testid="note-delete-checked"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    {t('note.deleteCheckedItems')}
                                  </button>
                                </MenuItem>
                              </>
                            )}
                            {isOwner && onShare && (
                              <MenuItem>
                                <button
                                  onClick={() => onShare(note)}
                                  className={OVERFLOW_ITEM_SPLIT}
                                >
                                  <span className="flex items-center">
                                    <UserPlus className="h-4 w-4 mr-2" />
                                    {t('note.share')}
                                  </span>
                                  <MenuKbd>S</MenuKbd>
                                </button>
                              </MenuItem>
                            )}
                            {onDuplicate && (
                              <MenuItem>
                                <button
                                  onClick={handleDuplicate}
                                  className={OVERFLOW_ITEM_SPLIT}
                                >
                                  <span className="flex items-center">
                                    <Copy className="h-4 w-4 mr-2" />
                                    {t('note.duplicate')}
                                  </span>
                                  <MenuKbd>D</MenuKbd>
                                </button>
                              </MenuItem>
                            )}
                            <MenuItem>
                              <button
                                onClick={() => setShowLabelPicker(true)}
                                className={OVERFLOW_ITEM_SPLIT}
                              >
                                <span className="flex items-center">
                                  <Tag className="h-4 w-4 mr-2" />
                                  {t('labels.title')}
                                </span>
                                <MenuKbd>L</MenuKbd>
                              </button>
                            </MenuItem>
                            {isOwner && onDelete && (
                              <MenuItem>
                                <button
                                  onClick={handleDelete}
                                  className={OVERFLOW_ITEM_DANGER}
                                >
                                  <span className="flex items-center">
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    {t('note.delete')}
                                  </span>
                                  <MenuKbd>Del</MenuKbd>
                                </button>
                              </MenuItem>
                            )}
                              </>
                            )}
                          </div>
                        </MenuItems>
                      </Menu>
                  </>
                )}
              </div>

              {/* Right: last edited / save status.
                  Every token in here sits on the note's colour, since that is
                  applied to the whole DialogPanel — so they are chosen against
                  the *worst* swatch (red-200 in light, yellow-900 in dark), not
                  against white. */}
              <div className="flex items-center" role="status" aria-live="polite" data-testid="note-save-status">
                {loading ? (
                  <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                    <span>{t('note.saving')}</span>
                  </div>
                ) : showSaved ? (
                  <div className="flex items-center space-x-1 text-sm text-green-800 dark:text-green-400 transition-opacity">
                    <Check className="h-4 w-4" />
                    <span>{t('note.saved')}</span>
                  </div>
                ) : note ? (
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    {t('note.lastEdited', { date: new Date(note.updated_at).toLocaleString(i18n.resolvedLanguage) })}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </DialogPanel>
      </div>
      </Dialog>

      <ConfirmDialog
        open={showDeleteConfirm}
        title={t('note.deleteConfirmTitle')}
        message={t('note.deleteConfirm')}
        confirmLabel={t('note.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <ConfirmDialog
        open={showPermanentDeleteConfirm}
        title={t('note.deleteForeverTitle')}
        message={t('note.deleteForeverConfirm')}
        confirmLabel={t('note.deleteForever')}
        onConfirm={confirmPermanentlyDelete}
        onCancel={() => setShowPermanentDeleteConfirm(false)}
      />

      <ConfirmDialog
        open={showConvertConfirm}
        title={t('note.convertToTextConfirmTitle')}
        message={convertToTextConfirmMessage}
        confirmLabel={t('note.convertToText')}
        variant="default"
        onConfirm={performConvert}
        onCancel={() => setShowConvertConfirm(false)}
      />
    </>
  );
}