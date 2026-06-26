import { useState, useEffect, useMemo, useRef, useCallback, type ReactElement } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon, ChevronDownIcon, ArchiveBoxIcon, ArchiveBoxXMarkIcon, UserPlusIcon, CheckIcon, TagIcon, DocumentDuplicateIcon, DevicePhoneMobileIcon, PaintBrushIcon } from '@heroicons/react/24/outline';
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, NOTE_COLORS, buildCollaborators, generateId, type Note, type NoteItem, type NoteType, type CreateNoteRequest, type UpdateNoteRequest, type PatchNoteItemRequest, type Label, type User, type Collaborator } from '@jot/shared';
import { notes } from '@/utils/api';
import { renderMarkdown } from '@/utils/markdown';
import LabelPicker from '@/components/LabelPicker';
import LetterAvatar from '@/components/LetterAvatar';
import AssigneePicker from '@/components/AssigneePicker';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { useSizeTransition } from '@/hooks/useSizeTransition';
import { buildShareAvatars } from '@/utils/shareAvatars';
import { buildMobileDeepLink } from '@/utils/deepLink';
import { isEditableElementFocused } from '@/utils/keyboardShortcuts';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Validation functions
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

const validateItemText = (text: string, t: TFunction): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null; // Allow empty items (will be removed on save)
  if (trimmed.length > VALIDATION.ITEM_TEXT_MAX_LENGTH) return t('note.itemTooLong', { max: VALIDATION.ITEM_TEXT_MAX_LENGTH });
  if (/[<>]/g.test(trimmed)) return t('note.itemInvalidChars');
  return null;
};

const validateTitle = (title: string, t: TFunction): string | null => {
  if (title.length > VALIDATION.TITLE_MAX_LENGTH) return t('note.titleTooLong', { max: VALIDATION.TITLE_MAX_LENGTH });
  return null;
};

const validateContent = (content: string, t: TFunction): string | null => {
  if (content.length > VALIDATION.CONTENT_MAX_LENGTH) return t('note.contentTooLong', { max: VALIDATION.CONTENT_MAX_LENGTH });
  return null;
};

const haveListItemsChanged = (currentItems: ListItem[], originalItems: NoteItem[] | undefined): boolean => {
  const baseItems = originalItems ?? [];
  if (currentItems.length !== baseItems.length) return true;

  return currentItems.some((item, index) => {
    const baseItem = baseItems[index];
    if (!baseItem) return true;

    return (
      item.text !== baseItem.text ||
      item.completed !== baseItem.completed ||
      item.position !== baseItem.position ||
      item.parentId !== (baseItem.parent_id ?? null) ||
      item.assignedTo !== (baseItem.assigned_to ?? '')
    );
  });
};

// Timeout management now handled via useRef instead of global window property

// Generate IDs for new list items in the server's ID format so the item has a
// stable identity the server accepts on create — this is what lets per-item
// updates target the right row without a create round-trip.
const generateItemId = () => generateId();

// Mergeable fields of a list item, used as the per-item baseline for diffing
// local edits against the last-known server state.
type ItemSnapshot = Pick<ListItem, 'text' | 'completed' | 'parentId' | 'assignedTo'>;
const itemSnapshot = (item: ListItem): ItemSnapshot => ({
  text: item.text,
  completed: item.completed,
  parentId: item.parentId,
  assignedTo: item.assignedTo,
});
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
  isOwner?: boolean;
  usersById?: Map<string, User>;
  currentUserId?: string;
}

interface ListItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  // The item this one is nested under, or null for a top-level item. Source of
  // truth for grouping; the one-level indent shown in the UI is derived from it
  // via indentOf(). Replaces the former indentLevel field.
  parentId: string | null;
  assignedTo: string;
}

// indentOf derives the render indent (0 = top-level, 1 = nested) from parentId.
// Nesting is capped at one level, so a child is always exactly one level in.
const indentOf = (item: { parentId: string | null }): number => (item.parentId ? 1 : 0);

// normalizeItemOrder is the single source of item ordering. It walks top-level
// items in their current order and emits each immediately followed by its
// children (so a group is always contiguous), promotes any orphaned child whose
// parent no longer exists to top-level, then assigns position = 0..N across the
// whole set. Calling it after every structural mutation keeps each group intact
// and keeps a checked item's slot relative to its neighbours, so unchecking
// lands it back where it belongs even after items above were added or removed.
const normalizeItemOrder = (items: ListItem[]): ListItem[] => {
  const childrenByParent = new Map<string, ListItem[]>();
  for (const it of items) {
    if (it.parentId !== null) {
      const siblings = childrenByParent.get(it.parentId) ?? [];
      siblings.push(it);
      childrenByParent.set(it.parentId, siblings);
    }
  }

  const ordered: ListItem[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    if (it.parentId !== null) continue; // children are emitted under their parent
    ordered.push(it);
    placed.add(it.id);
    for (const child of childrenByParent.get(it.id) ?? []) {
      ordered.push(child);
      placed.add(child.id);
    }
  }
  // Any item not placed is an orphan (its parent is missing or is itself a
  // child); promote it to top-level so it is never dropped.
  for (const it of items) {
    if (!placed.has(it.id)) ordered.push({ ...it, parentId: null });
  }

  return ordered.map((it, index) => ({ ...it, position: index }));
};

// itemHasChildren reports whether any item is nested under itemId. Indenting an
// item that has children would create grandchildren, which the server rejects
// (nesting is capped at one level), so callers must refuse it.
const itemHasChildren = (items: ListItem[], itemId: string): boolean =>
  items.some(it => it.parentId === itemId);

// precedingTopLevelId returns the id of the nearest top-level item before itemId
// in the (normalized) order, or null if there is none — i.e. the item an indent
// gesture should nest itemId under.
const precedingTopLevelId = (items: ListItem[], itemId: string): string | null => {
  let last: string | null = null;
  for (const it of items) {
    if (it.id === itemId) return last;
    if (it.parentId === null) last = it.id;
  }
  return null;
};

// dropTargetParentId decides which group a vertically-dragged item joins, based
// on where it landed in the freshly-moved (not yet normalized) array. This is
// what lets an item be dragged from one group into another:
//   - a parent (item with children) can't become a child, so it stays top-level;
//   - dropped right after a child → joins that child's group (same parent);
//   - dropped between a top-level item and its first child → becomes that item's
//     first child (joins/forms the group);
//   - otherwise → a top-level item.
const dropTargetParentId = (items: ListItem[], index: number, draggedId: string): string | null => {
  if (itemHasChildren(items, draggedId)) return null;
  const prev = items[index - 1];
  if (!prev) return null; // dropped at the very top of the list
  if (prev.parentId !== null) return prev.parentId; // dropped inside prev's group
  const next = items[index + 1];
  if (next && next.parentId === prev.id) return prev.id; // dropped as prev's first child
  return null; // a top-level sibling after prev
};

interface AutoSaveDraft {
  title?: string;
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
}

interface SortableItemProps {
  id: string;
  index: number;
  item: ListItem;
  onUpdateListItem: (index: number, field: 'text' | 'completed', value: string | boolean) => Promise<void>;
  onRemoveListItem: (itemId: string) => void;
  isCompleted?: boolean;
  onKeyDown?: (index: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (index: number, e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  inputRef?: React.RefCallback<HTMLTextAreaElement>;
  onIndentChange?: (itemId: string, delta: 1 | -1) => void;
  isShared?: boolean;
  collaborators?: Collaborator[];
  usersById?: Map<string, User>;
  onAssignItem?: (itemId: string, userId: string) => void;
  completedItemTexts?: string[];
  onAcceptSuggestion?: (currentItemId: string, suggestionText: string) => void;
}

function SortableItem({ id, index, item, onUpdateListItem, onRemoveListItem, isCompleted = false, onKeyDown, onPaste, inputRef, onIndentChange, isShared, collaborators, usersById, onAssignItem, completedItemTexts = [], onAcceptSuggestion }: SortableItemProps) {
  const { t } = useTranslation();
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const listItemTextRef = useRef<HTMLTextAreaElement | null>(null);
  const closeAssigneePicker = useCallback(() => setShowAssigneePicker(false), []);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: isCompleted
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    marginLeft: indentOf(item) * VALIDATION.INDENT_PX_PER_LEVEL,
  };

  const assignedUser = item.assignedTo ? usersById?.get(item.assignedTo) : undefined;
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignItem;
  const placeholder = item.text ? '' : t('note.itemPlaceholder');
  const autoResizeListItemText = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  const setListItemTextRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    listItemTextRef.current = textarea;
    autoResizeListItemText(textarea);
    inputRef?.(textarea);
  }, [autoResizeListItemText, inputRef]);

  useEffect(() => {
    autoResizeListItemText(listItemTextRef.current);
  }, [item.text, autoResizeListItemText]);

  const suggestions = useMemo(() => {
    const trimmed = item.text.trim();
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    const results: string[] = [];
    for (const text of completedItemTexts) {
      const lower = text.toLowerCase();
      if (lower.includes(q) && lower !== q) {
        results.push(text);
        if (results.length === 5) break;
      }
    }
    return results;
  }, [item.text, completedItemTexts]);

  const selectSuggestion = (text: string) => {
    if (onAcceptSuggestion) {
      onAcceptSuggestion(item.id, text);
    } else {
      onUpdateListItem(index, 'text', text);
    }
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="list-item-row"
      className={`group/item flex items-start gap-2 ${isDragging ? 'opacity-50' : ''} ${
        isCompleted ? 'opacity-60' : ''
      }`}
      {...attributes}
    >
      {!isCompleted && (
        <div
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M7 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 2zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 14zm6-8a2 2 0 1 1-.001-4.001A2 2 0 0 1 13 6zm0 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 14z" />
          </svg>
        </div>
      )}
      {isCompleted && <div className="w-6 h-4"></div>}
      
      <input
        type="checkbox"
        checked={item.completed}
        onChange={(e) => onUpdateListItem(index, 'completed', e.target.checked)}
        className="h-4 w-4 text-blue-600 rounded mt-0.5 flex-shrink-0"
      />
      <div className="flex flex-1 items-start min-w-0">
        <div className="relative min-w-0 flex-1">
          <textarea
            data-testid="list-item-input"
            placeholder={placeholder}
            rows={1}
            autoCapitalize="sentences"
            className={`w-full pt-0 pb-1 pl-1 pr-0 bg-transparent border-none outline-none min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white ${
              isCompleted ? 'line-through text-gray-500 dark:text-gray-400' : ''
            }`}
            value={item.text}
            onInput={(e) => autoResizeListItemText(e.currentTarget)}
            onChange={(e) => {
              onUpdateListItem(index, 'text', e.target.value);
              if (e.target.value.trim()) setShowSuggestions(true);
              setSelectedSuggestionIndex(-1);
            }}
            onFocus={() => {
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            onBlur={(e) => {
              const related = e.relatedTarget as Node | null;
              if (suggestionsRef.current?.contains(related)) return;
              // Delay to allow touch tap on suggestion to fire click first
              setTimeout(() => {
                setShowSuggestions(false);
                setSelectedSuggestionIndex(-1);
              }, 150);
            }}
            aria-autocomplete="list"
            aria-expanded={showSuggestions && suggestions.length > 0}
            aria-controls={showSuggestions && suggestions.length > 0 ? `suggestions-${id}` : undefined}
            aria-activedescendant={selectedSuggestionIndex >= 0 ? `suggestion-${id}-${selectedSuggestionIndex}` : undefined}
            onKeyDown={(e) => {
              const suggestionsVisible = showSuggestions && suggestions.length > 0;
              if (suggestionsVisible && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedSuggestionIndex(prev => Math.min(prev + 1, suggestions.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedSuggestionIndex(prev => Math.max(prev - 1, -1));
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const idxToAccept = selectedSuggestionIndex >= 0 ? selectedSuggestionIndex : 0;
                  selectSuggestion(suggestions[idxToAccept]);
                  return;
                }
                if (e.key === 'Escape' || e.key === 'Tab') {
                  e.preventDefault();
                  setShowSuggestions(false);
                  setSelectedSuggestionIndex(-1);
                  return;
                }
              }
              if (e.key === 'Tab' && onIndentChange && !isCompleted) {
                e.preventDefault();
                onIndentChange(item.id, e.shiftKey ? -1 : 1);
                return;
              }
              if (onKeyDown) onKeyDown(index, e);
            }}
            onPaste={(e) => onPaste?.(index, e)}
            ref={setListItemTextRef}
          />
          {showSuggestions && suggestions.length > 0 && !isCompleted && (
            <div
              ref={suggestionsRef}
              id={`suggestions-${id}`}
              role="listbox"
              aria-label={t('note.completedSuggestions')}
              className="absolute z-20 top-full left-0 mt-0.5 min-w-40 max-w-64 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg max-h-36 overflow-y-auto"
            >
              {suggestions.map((text, i) => (
                <div
                  key={i}
                  id={`suggestion-${id}-${i}`}
                  role="option"
                  aria-selected={i === selectedSuggestionIndex}
                  className={`px-3 py-1.5 text-sm cursor-pointer truncate ${
                    i === selectedSuggestionIndex
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectSuggestion(text)}
                  onMouseEnter={() => setSelectedSuggestionIndex(i)}
                >
                  {text}
                </div>
              ))}
            </div>
          )}
        </div>

        {showAssignUI && (() => {
          const assigneeDisplayName = assignedUser
            ? [assignedUser.first_name, assignedUser.last_name].filter(Boolean).join(' ') || assignedUser.username
            : '?';
          return (
          <div className={`relative flex-shrink-0 ${item.assignedTo || !isCompleted ? 'ml-1' : ''}`}>
            {item.assignedTo ? (
              <button
                onClick={() => setShowAssigneePicker(true)}
                title={t('note.assignedTo', { name: assigneeDisplayName })}
                aria-label={t('note.assignedTo', { name: assigneeDisplayName })}
                className={`rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800 ${isCompleted ? 'cursor-default' : 'cursor-pointer'}`}
                disabled={isCompleted}
              >
                <LetterAvatar
                  firstName={assignedUser?.first_name}
                  username={assignedUser?.username || '?'}
                  userId={item.assignedTo}
                  hasProfileIcon={assignedUser?.has_profile_icon}
                  iconVersion={assignedUser?.updated_at}
                  className="w-5 h-5"
                />
              </button>
            ) : (
              !isCompleted && (
                <button
                  onClick={() => setShowAssigneePicker(true)}
                  className="w-5 h-5 rounded-full border border-dashed border-gray-300 dark:border-gray-400 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-white/10 transition-colors opacity-0 group-hover/item:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 touch-visible"
                  title={t('note.assignItem')}
                  aria-label={t('note.assignItem')}
                >
                  <UserPlusIcon className="h-3 w-3 text-gray-400 dark:text-gray-300" aria-hidden="true" />
                </button>
              )
            )}
            {showAssigneePicker && (
              <AssigneePicker
                collaborators={collaborators}
                currentAssigneeId={item.assignedTo}
                onAssign={(userId) => onAssignItem(item.id, userId)}
                onClose={closeAssigneePicker}
              />
            )}
          </div>
          );
        })()}
      </div>

      <button
        onClick={() => onRemoveListItem(item.id)}
        className="ml-auto p-1 text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function NoteModal({ note, onClose, onSave, onRefresh, onShare, onDelete, onDuplicate, isOwner = true, usersById, currentUserId }: NoteModalProps) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState('#ffffff');
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [noteLabels, setNoteLabels] = useState<Label[]>(note?.labels ?? []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // New notes start in edit mode; existing notes start in preview mode.
  const [isEditingContent, setIsEditingContent] = useState(!note);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

  // Use useRef for timeout management instead of global window property
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteIdRef = useRef<string | null>(note?.id ?? null);
  const noteTypeRef = useRef<NoteType>(note?.note_type ?? 'text');
  const autoSaveDraftRef = useRef<AutoSaveDraft>({
    title: '',
    content: '',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
  });
  const itemsRef = useRef<ListItem[]>([]);
  // Baseline of the last-known server state, used to diff local edits into
  // granular per-item operations (and field-only scalar patches) instead of
  // re-sending the whole note. This is what stops a save in one tab from
  // overwriting concurrent edits made in another.
  const savedScalarsRef = useRef<AutoSaveDraft>({
    title: '',
    content: '',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
  });
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  // Set while a save is in flight to request one more pass once it finishes,
  // so edits made during the save are not lost.
  const pendingSaveRef = useRef(false);
  // Tracks the note id whose state we have adopted into local editor state, so
  // we can tell "switched to a different note" (always adopt) apart from "same
  // note refreshed by an SSE event" (only adopt when there are no local edits).
  const adoptedNoteIdRef = useRef<string | null>(note?.id ?? null);
  const itemInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  // Set to true when the backdrop mousedown handler has already handled a dismiss,
  // so Dialog.onClose (which HeadlessUI fires after the mousedown) skips its logic.
  const backdropHandledRef = useRef(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  const commitItems = useCallback((nextItems: ListItem[]) => {
    itemsRef.current = nextItems;
    setItems(nextItems);
    // If a save is in flight, request another pass so these edits are flushed.
    if (savingRef.current) {
      pendingSaveRef.current = true;
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
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (savedOrderRef.current[i] !== it.id) return true;
      const snap = savedItemsRef.current.get(it.id);
      if (!snap || snap.text !== it.text || snap.completed !== it.completed
        || snap.parentId !== it.parentId || snap.assignedTo !== it.assignedTo) {
        return true;
      }
    }
    return false;
  }, []);

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
            ...(it.assignedTo ? { assigned_to: it.assignedTo } : {}),
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
      if (it.assignedTo !== snap.assignedTo) data.assigned_to = it.assignedTo;
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

  // Separate completed and uncompleted items with memoization
  const { uncompletedItems, completedItems, completedItemTexts } = useMemo(() => {
    const uncompletedItems = items.filter(item => !item.completed);
    const completedItems = items.filter(item => item.completed);
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
  }, [items]);

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

  const noteDeepLinkHref = useMemo(() => {
    if (!note?.id || !window.matchMedia('(pointer: coarse)').matches) {
      return null;
    }
    return buildMobileDeepLink(`/notes/${note.id}`, window.location.origin);
  }, [note?.id]);

  useEffect(() => {
    // Decide whether to adopt the incoming note prop into local editor state.
    // Switching to a different note always adopts. A refresh of the *same* note
    // (e.g. an SSE update from another tab/device) only adopts when the user
    // has no unsaved local edits — otherwise adopting would clobber in-progress
    // changes. Because item edits are persisted granularly, skipping adoption
    // here never loses data; the next idle refresh reconciles.
    const incomingId = note?.id ?? null;
    const sameNote = incomingId !== null && incomingId === adoptedNoteIdRef.current;
    if (sameNote && (savingRef.current || saveTimeoutRef.current || isDirty())) {
      return;
    }
    adoptedNoteIdRef.current = incomingId;

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
      setContent('');
      setNoteType('text');
      setColor('#ffffff');
      setPinned(false);
      setArchived(false);
      commitItems([]);
      setNoteLabels([]);
      setSavedBaseline({ title: '', content: '', pinned: false, archived: false, color: '#ffffff', checked_items_collapsed: false }, []);
    }
  }, [commitItems, note, isDirty, setSavedBaseline]);

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
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

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

  // Helper function to show error messages with auto-dismiss
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

  const INDENT_DRAG_THRESHOLD = 50;

  // indentListItem nests (delta 1) or un-nests (delta -1) an item by changing its
  // parentId, the source of truth for grouping. Indenting attaches the item to
  // the nearest preceding top-level item; un-indenting promotes it to top-level.
  // It refuses to nest an item that already has children (that would create a
  // grandchild, which the server rejects) and is a no-op when nothing changes.
  const indentListItem = async (itemId: string, delta: 1 | -1) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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

  const insertListItemAfter = (afterItemId: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    const currentItems = itemsRef.current;
    const afterItemPos = currentItems.findIndex(item => item.id === afterItemId);
    const afterItem = afterItemPos >= 0 ? currentItems[afterItemPos] : undefined;
    const newItem: ListItem = {
      id: generateItemId(),
      text: '',
      completed: false,
      position: 0,
      parentId: afterItem ? afterItem.parentId : null,
      assignedTo: '',
    };
    const insertPos = afterItemPos >= 0 ? afterItemPos + 1 : currentItems.length;
    const newItems = [...currentItems];
    newItems.splice(insertPos, 0, newItem);
    commitItems(normalizeItemOrder(newItems));
    autoSaveNote();
    return newItem.id;
  };

  const handleItemKeyDown = (index: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
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
      const targetItem = uncompletedItems[targetIndex];
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
      const currentItem = uncompletedItems[index];
      const newId = insertListItemAfter(currentItem?.id ?? '');
      setTimeout(() => {
        itemInputRefs.current.get(newId)?.focus();
      }, 0);
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      const currentItem = uncompletedItems[index];
      if (!currentItem || currentItem.text.trim() !== '') return;

      e.preventDefault();
      const focusTarget = e.key === 'Backspace'
        ? uncompletedItems[index - 1]
        : uncompletedItems[index + 1];

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
    const lines = rawLines.filter(l => l.trim().length > 0);

    if (lines.length <= 1) {
      return;
    }

    e.preventDefault();

    const input = e.currentTarget;
    const selStart = input.selectionStart ?? input.value.length;
    const selEnd = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, selStart);
    const after = input.value.slice(selEnd);

    const currentItem = uncompletedItems[index];
    if (!currentItem) return;

    const currentItems = itemsRef.current;
    const insertAfterPos = currentItems.findIndex(item => item.id === currentItem.id);

    const firstLineText = (before + lines[0]).slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);

    const remainingLines = lines.slice(1);
    const newItems: ListItem[] = remainingLines.map((line, i) => {
      const isLast = i === remainingLines.length - 1;
      const lineText = isLast ? line + after : line;
      return {
        id: generateItemId(),
        text: lineText.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH),
        completed: false,
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
      item.id === currentItem.id ? { ...item, text: firstLineText } : item
    );
    updatedItems.splice(insertAfterPos + 1, 0, ...newItems);

    commitItems(normalizeItemOrder(updatedItems));
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    autoSaveNote();

    const lastNewItem = newItems[newItems.length - 1];
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
    // Removing a parent leaves its children as orphans; normalizeItemOrder
    // promotes them to top-level, mirroring the server's ON DELETE SET NULL.
    const newItems = normalizeItemOrder(itemsRef.current.filter(item => item.id !== itemId));

    commitItems(newItems);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    autoSaveNote();
  };

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

  // Persists local edits to the server as granular operations. The optional
  // argument is ignored (kept for call-site compatibility); the latest state is
  // always read from itemsRef/autoSaveDraftRef so queued saves pick up the most
  // recent edits.
  const autoSaveNote = async () => {
    if (!noteIdRef.current) return;
    // Cancel any pending debounced text-save so it can't fire a duplicate pass.
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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
  };

  // applyCompletedCascade mirrors the server's cascade locally: toggling a
  // top-level item also toggles its children; toggling a child touches only it.
  const applyCompletedCascade = (items: ListItem[], itemId: string, completed: boolean): ListItem[] => {
    const target = items.find(item => item.id === itemId);
    if (!target) return items;
    const cascadeToChildren = target.parentId === null;
    return items.map(item => {
      if (item.id === itemId) return { ...item, completed };
      if (cascadeToChildren && item.parentId === itemId) return { ...item, completed };
      return item;
    });
  };

  // handleItemCompletedToggle checks/unchecks an item through the dedicated
  // toggle-completed endpoint so a parent's children cascade atomically in one
  // request. It applies an optimistic local cascade first, then reconciles only
  // the completed flags the server reports — never replacing the whole list, so
  // unsaved edits and not-yet-created items are preserved. Items keep their slot
  // in the single ordered array, so unchecking returns an item to where it was.
  const handleItemCompletedToggle = async (itemId: string, completed: boolean) => {
    const before = itemsRef.current;
    const target = before.find(item => item.id === itemId);
    if (!target || target.completed === completed) return;

    // Remember the pre-toggle completed state of just the items this toggle
    // touches (the target and, for a parent, its children), so an error reverts
    // only those flags without clobbering edits made to other items meanwhile.
    const revertCompleted = new Map<string, boolean>([[target.id, target.completed]]);
    if (target.parentId === null) {
      for (const item of before) {
        if (item.parentId === itemId) revertCompleted.set(item.id, item.completed);
      }
    }

    commitItems(applyCompletedCascade(before, itemId, completed));

    // A not-yet-persisted note has no server-side item to toggle; the bulk
    // create on save carries the completed flags instead.
    if (!noteIdRef.current) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }

    try {
      const serverItems = await notes.toggleItemCompleted(noteIdRef.current, itemId, completed);
      const completedById = new Map(serverItems.map(item => [item.id, item.completed]));
      commitItems(itemsRef.current.map(item => {
        const serverCompleted = completedById.get(item.id);
        return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
      }));
      // Advance the baseline so the diff engine does not re-patch completed.
      for (const [id, comp] of completedById) {
        const snap = savedItemsRef.current.get(id);
        if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
      }
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
    // Validate the text input
    const validationError = validateItemText(newText, t);
    if (validationError && newText.trim() !== '') {
      showError(validationError);
      return;
    }
    
    const currentItems = itemsRef.current;
    const textValue = newText.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);
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
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      
      saveTimeoutRef.current = setTimeout(async () => {
        saveTimeoutRef.current = undefined;
        await autoSaveNote();
      }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
    }
  };

  // Helper function to find target item by index (for backward compatibility)
  const findTargetItem = (index: number): ListItem | null => {
    if (index < uncompletedItems.length) {
      return uncompletedItems[index];
    } else {
      const completedIndex = index - uncompletedItems.length;
      if (completedIndex < completedItems.length) {
        return completedItems[completedIndex];
      }
    }
    return null;
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
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }
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

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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
  }, [note?.is_shared, note?.user_id, note?.shared_with, usersById]);

  const assignItem = async (itemId: string, userId: string) => {
    const updatedItems = itemsRef.current.map(item =>
      item.id === itemId ? { ...item, assignedTo: userId } : item,
    );
    commitItems(updatedItems);
    await autoSaveNote();
  };

  const persistExistingNote = useCallback(async () => {
    if (!note) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }

    // Flush any pending scalar and item changes as granular operations.
    await flushSave();
    onRefresh?.();
  }, [flushSave, note, onRefresh]);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    // Cancel any pending debounced autosave to avoid a stale write racing
    // with this immediate save.
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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
      savingRef.current = false;
      setLoading(false);
    }
  };

  const handleDuplicate = async () => {
    if (!note || !onDuplicate || loading || savingRef.current) return;

    savingRef.current = true;
    setLoading(true);
    try {
      await persistExistingNote();
    } catch (error) {
      console.error('Failed to save note before duplicate:', error);
      showError(t('note.failedSaveChanges'));
      savingRef.current = false;
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
      savingRef.current = false;
      setLoading(false);
    }
  };

  const handlePinToggle = async () => {
    if (!note) return;

    const newPinnedState = !pinned;
    setPinned(newPinnedState);

    try {
      // Send only the field that changed so concurrent item/title edits made
      // elsewhere are not overwritten.
      await notes.update(note.id, { pinned: newPinnedState });
      savedScalarsRef.current.pinned = newPinnedState;
      onRefresh?.();
      showToast(
        newPinnedState ? t('dashboard.notePinned') : t('dashboard.noteUnpinned'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { pinned: !newPinnedState });
              savedScalarsRef.current.pinned = !newPinnedState;
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
    if (!note) return;
    
    const newArchivedState = !archived;
    setArchived(newArchivedState);

    try {
      await notes.update(note.id, { archived: newArchivedState });
      savedScalarsRef.current.archived = newArchivedState;
      showToast(
        newArchivedState ? t('dashboard.noteArchived') : t('dashboard.noteUnarchived'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { archived: !newArchivedState });
              savedScalarsRef.current.archived = !newArchivedState;
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
    if (!note || !onDelete) return;
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    if (!note || !onDelete) return;
    onDelete(note.id);
    setShowDeleteConfirm(false);
    onClose();
  };

  const handleToggleCompleted = async () => {
    if (!note) {
      // If creating a new note, just toggle local state
      setCheckedItemsCollapsed(!checkedItemsCollapsed);
      return;
    }
    
    const newCollapsedState = !checkedItemsCollapsed;
    setCheckedItemsCollapsed(newCollapsedState);

    try {
      await notes.update(note.id, { checked_items_collapsed: newCollapsedState });
      savedScalarsRef.current.checked_items_collapsed = newCollapsedState;
      onRefresh?.();
    } catch (error) {
      console.error('Failed to update collapse state:', error);
      // Revert the state on error
      setCheckedItemsCollapsed(checkedItemsCollapsed);
    }
  };

  const hasUnsavedChanges = () => {
    if (note) {
      if (note.note_type === 'list') {
        return (
          title !== note.title ||
          color !== note.color ||
          pinned !== note.pinned ||
          archived !== note.archived ||
          checkedItemsCollapsed !== note.checked_items_collapsed ||
          haveListItemsChanged(items, note.items)
        );
      } else {
        return (
          content !== note.content ||
          color !== note.color ||
          pinned !== note.pinned ||
          archived !== note.archived
        );
      }
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
      if (savingRef.current) {
        // An auto-save is already in flight. Cancel any pending debounced
        // text-save and request one more pass; the in-flight autoSaveNote loop
        // keeps running after unmount (refs persist in its closure) and flushes
        // the latest edits, so closing now does not drop them.
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = undefined;
        }
        pendingSaveRef.current = true;
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

  // Stable ref always holds the latest handler so the listener never goes stale.
  const modalShortcutRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  modalShortcutRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (showDeleteConfirm) return;

    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!note || isEditableElementFocused()) return;

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
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => modalShortcutRef.current?.(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);


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
          // Escape key: two-step dismiss — collapse first, then close on second press.
          if (isEditingContent) {
            setIsEditingContent(false);
          } else {
            handleCloseRequest();
          }
        }}
        className="relative z-50"
      >
        <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/30 dark:bg-black/50 duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />

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
            if (isEditingContent) {
              setIsEditingContent(false);
            } else {
              handleCloseRequest();
            }
          }}
        >
        <DialogPanel
          ref={panelRef}
          transition
          className={`mx-auto w-full max-w-lg max-h-[90vh] overflow-hidden rounded-lg shadow-xl relative duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none ${
            colors.find(c => c.value === color)?.class || 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600'
          }`}
        >
          {/* Top-right controls — close button, and Done when editing */}
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
            {noteType === 'text' && isEditingContent && (
              <button
                type="button"
                aria-label={t('common.done')}
                onClick={() => setIsEditingContent(false)}
                className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
              >
                <CheckIcon className="h-5 w-5 text-blue-500 dark:text-blue-400" />
              </button>
            )}
            <button
              aria-label={t('common.close')}
              onClick={handleCloseRequest}
              className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
            >
              <XMarkIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
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
          <div className="p-2 sm:p-4 pt-10 space-y-4 overflow-y-auto max-h-[calc(90vh-8rem)]">
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
                className="w-full p-2 text-lg font-medium bg-transparent border-none outline-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white"
                value={title}
                onChange={(e) => {
                  const newTitle = e.target.value;
                  const validationError = validateTitle(newTitle, t);
                  if (validationError) {
                    showError(validationError);
                    return;
                  }
                  setTitle(newTitle);
                  if (note) {
                    markDirty();
                    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
                    saveTimeoutRef.current = setTimeout(async () => {
                      saveTimeoutRef.current = undefined;
                      await autoSaveNote();
                    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
                  }
                }}
                onKeyDown={(e) => {
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
                {isEditingContent ? (
                  <textarea
                    ref={contentRef}
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
                      }
                    }}
                    onChange={(e) => {
                      const newContent = e.target.value;
                      const validationError = validateContent(newContent, t);
                      if (validationError) {
                        showError(validationError);
                        return;
                      }
                      setContent(newContent);
                      if (note) {
                        markDirty();
                        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
                        saveTimeoutRef.current = setTimeout(async () => {
                          saveTimeoutRef.current = undefined;
                          await autoSaveNote();
                        }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
                      }
                    }}
                  />
                ) : (
                  <div
                    data-testid="note-content-preview"
                    role="textbox"
                    aria-label={t('note.contentPlaceholder')}
                    aria-multiline="true"
                    tabIndex={0}
                    onClick={() => setIsEditingContent(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setIsEditingContent(true);
                      }
                    }}
                    className="w-full p-2 min-h-[6rem] cursor-text text-gray-900 dark:text-white markdown-content"
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
                  <button
                    onClick={addListItemAndFocus}
                    className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white p-1"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span>{t('note.addItem')}</span>
                  </button>
                </div>

                {/* Completed items section */}
                {completedItems.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-white/20 pt-3">
                    <button
                      onClick={handleToggleCompleted}
                      className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white mb-2"
                    >
                      <ChevronDownIcon 
                        className={`h-4 w-4 transition-transform ${checkedItemsCollapsed ? '-rotate-90' : 'rotate-0'}`}
                      />
                      <span>{t('note.completedItems', { count: completedItems.length })}</span>
                    </button>
                    
                    {!checkedItemsCollapsed && (
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
                                    className="flex items-start min-w-0 text-sm opacity-60 select-none"
                                    aria-label={t('note.completedItemGroup', { title: parent.text })}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={false}
                                      disabled
                                      readOnly
                                      aria-hidden="true"
                                      className="h-4 w-4 rounded mr-2 mt-0.5 flex-shrink-0 cursor-default"
                                    />
                                    <span className="min-w-0 whitespace-pre-wrap break-words font-semibold text-gray-500 dark:text-gray-400">
                                      {parent.text}
                                    </span>
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

            {/* Avatars + Labels row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Share avatars */}
              {note?.is_shared && (() => {
                const avatars = buildShareAvatars(note, currentUserId, usersById);
                if (avatars.length === 0) return null;
                return (
                  <div className="flex items-center">
                    {avatars.map((a, index) => (
                      <div key={a.key} title={a.displayName}>
                        <LetterAvatar
                          firstName={a.firstName}
                          username={a.username}
                          userId={a.userId}
                          hasProfileIcon={a.hasProfileIcon}
                          iconVersion={a.iconVersion}
                          className={`w-6 h-6 ring-2 ring-white dark:ring-slate-800 ${index > 0 ? '-ml-1' : ''}`}
                        />
                      </div>
                    ))}
                  </div>
                );
              })()}
              {/* Label badges + add button */}
              {noteLabels.map(label => (
                <span
                  key={label.id}
                  className="inline-flex items-center bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5 text-xs"
                >
                  {label.name}
                </span>
              ))}
              <div className="relative">
                <button
                  onClick={() => setShowLabelPicker(v => !v)}
                  onMouseDown={(event) => event.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-blue-300 dark:border-blue-700 bg-blue-50/80 dark:bg-blue-900/20 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                  title={t('labels.addLabels')}
                  aria-label={t('labels.addLabels')}
                  aria-expanded={showLabelPicker}
                >
                  <TagIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('labels.addLabels')}</span>
                </button>
                {showLabelPicker && (
                  note ? (
                    <LabelPicker note={{...note, labels: noteLabels}} onRefresh={onRefresh} onNoteUpdate={(n) => setNoteLabels(n.labels ?? [])} onError={showError} onClose={() => setShowLabelPicker(false)} />
                  ) : (
                    <LabelPicker selectedLabels={noteLabels} onLocalChange={setNoteLabels} onError={showError} onClose={() => setShowLabelPicker(false)} />
                  )
                )}
              </div>
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
                  const nextColor = colors[nextIndex].value;
                  setColor(nextColor);
                  if (note) {
                    markDirty();
                    autoSaveDraftRef.current = { ...autoSaveDraftRef.current, color: nextColor };
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
                        autoSaveDraftRef.current = { ...autoSaveDraftRef.current, color: newColor };
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
                  onClick={() => toggleColorPicker()}
                  className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                  title={t('note.colorPickerLabel')}
                  aria-label={t('note.colorPickerLabel')}
                  aria-expanded={showColorPicker}
                >
                  <PaintBrushIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                </button>

                {note && (
                  <>
                    {noteDeepLinkHref && (
                      <a
                        href={noteDeepLinkHref}
                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                        title={t('nav.openMobileApp')}
                        aria-label={t('nav.openMobileApp')}
                        data-testid="note-open-mobile-app-toolbar-link"
                      >
                        <DevicePhoneMobileIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      </a>
                    )}
                    <button
                      onClick={handlePinToggle}
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                      title={pinned ? t('note.unpinNote') : t('note.pinNote')}
                      aria-label={pinned ? t('note.unpinNote') : t('note.pinNote')}
                    >
                      {pinned ? (
                        <svg className="h-5 w-5 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                        </svg>
                      ) : (
                        <svg className="h-5 w-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={handleArchiveToggle}
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                      title={archived ? t('note.unarchiveNote') : t('note.archiveNote')}
                      aria-label={archived ? t('note.unarchiveNote') : t('note.archiveNote')}
                    >
                      {archived ? (
                        <ArchiveBoxXMarkIcon className="h-5 w-5 text-blue-500" />
                      ) : (
                        <ArchiveBoxIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      )}
                    </button>
                    {isOwner && onShare && (
                      <button
                        onClick={() => onShare(note)}
                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                        title={t('note.share')}
                        aria-label={t('note.share')}
                      >
                        <UserPlusIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      </button>
                    )}
                    {onDuplicate && (
                      <button
                        onClick={handleDuplicate}
                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                        title={t('note.duplicate')}
                        aria-label={t('note.duplicate')}
                      >
                        <DocumentDuplicateIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      </button>
                    )}
                    {isOwner && onDelete && (
                      <button
                        onClick={handleDelete}
                        className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                        title={t('note.delete')}
                        aria-label={t('note.delete')}
                      >
                        <TrashIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Right: last edited / save status */}
              <div className="flex items-center" role="status" aria-live="polite">
                {loading ? (
                  <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                    <span>{t('note.saving')}</span>
                  </div>
                ) : showSaved ? (
                  <div className="flex items-center space-x-1 text-sm text-green-600 dark:text-green-400 transition-opacity">
                    <CheckIcon className="h-4 w-4" />
                    <span>{t('note.saved')}</span>
                  </div>
                ) : note ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500">
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
    </>
  );
}