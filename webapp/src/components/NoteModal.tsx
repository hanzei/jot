import { useState, useEffect, useEffectEvent, useMemo, useRef, useCallback, type ReactElement, type ReactNode } from 'react';
import { X, Plus, Trash2, ChevronDown, Archive, ArchiveX, UserPlus, Check, Tag, Copy, Smartphone, Palette, Image, ArrowLeftRight, GripVertical, Pin, EllipsisVertical, Square } from 'lucide-react';
import { Dialog, DialogBackdrop, DialogPanel, Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, NOTE_COLORS, IMAGE_ALLOWED_TYPES, IMAGE_MAX_PER_NOTE, UPLOAD_MAX_BYTES, buildCollaborators, generateId, textToListItems, listToText, type Note, type NoteType, type NoteImage, type CreateNoteRequest, type UpdateNoteRequest, type ConvertNoteTypeRequest, type PatchNoteItemRequest, type NoteItem, type Label, type User, type Collaborator } from '@jot/shared';
import { notes, images as imagesApi } from '@/utils/api';
import { renderMarkdown } from '@/utils/markdown';
import LabelPicker from '@/components/LabelPicker';
import NoteImageGallery, { type PendingImageUpload } from '@/components/NoteImageGallery';
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

// Undo window for a client-deferred note image removal (spec: ~10s).
const IMAGE_REMOVE_UNDO_MS = 10_000;
// Undo window for the client-deferred "delete checked items" bulk action. The
// single bulk DELETE only fires once this elapses without an undo.
const COMPLETED_DELETE_UNDO_MS = 10_000;

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

// Per-row controls (delete, assign) are hidden until the row is hovered
// (desktop) or a field within it is focused (works on touch). While hidden the
// control is also non-interactive, so an invisible button can't be tapped by
// accident — important on touch devices, where there's no hover to reveal it.
export const ROW_REVEAL_CLASSES =
  'opacity-0 pointer-events-none group-hover/item:opacity-100 group-hover/item:pointer-events-auto group-focus-within/item:opacity-100 group-focus-within/item:pointer-events-auto';

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
  onConvert?: (noteId: string, data: ConvertNoteTypeRequest) => Promise<void> | void;
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
          <GripVertical className="w-4 h-4" />
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
                  // Only accept a suggestion the user explicitly highlighted
                  // (arrow keys or hover). With none highlighted, Enter keeps
                  // its normal add/split behavior below — the dropdown being
                  // merely visible must not hijack creating a new item.
                  if (selectedSuggestionIndex >= 0) {
                    e.preventDefault();
                    selectSuggestion(suggestions[selectedSuggestionIndex]);
                    return;
                  }
                  setShowSuggestions(false);
                  setSelectedSuggestionIndex(-1);
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
              className="absolute z-20 top-full left-0 mt-0.5 min-w-40 max-w-64 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg max-h-36 overflow-y-auto scrollbar-subtle"
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
                  className={`w-5 h-5 rounded-full border border-dashed border-gray-300 dark:border-gray-400 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${ROW_REVEAL_CLASSES}`}
                  title={t('note.assignItem')}
                  aria-label={t('note.assignItem')}
                >
                  <UserPlus className="h-3 w-3 text-gray-400 dark:text-gray-300" aria-hidden="true" />
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
        aria-label={t('note.removeItem')}
        title={t('note.removeItem')}
        data-testid="list-item-delete"
        className={`ml-auto w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100 transition-opacity ${ROW_REVEAL_CLASSES}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function NoteModal({ note, onClose, onSave, onRefresh, onShare, onDelete, onDuplicate, onConvert, isOwner = true, usersById, currentUserId, uploadMaxBytes = UPLOAD_MAX_BYTES, initialType, initialContent }: NoteModalProps) {
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
  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  // New notes start in edit mode; existing notes start in preview mode.
  const [isEditingContent, setIsEditingContent] = useState(!note);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

  // Note image add/remove UI. Uploads require an existing note (an id to
  // attach to), so all of this is gated on `note` being set.
  const [imageUploads, setImageUploads] = useState<PendingImageUpload[]>([]);
  // Images currently showing an inline "Image removed — Undo" bar. Rendered
  // inside the DialogPanel (not the app-wide toast) so clicking Undo is never
  // mistaken by HeadlessUI's Dialog for an outside click that should close it.
  // hiddenImageIds is derived from this below rather than tracked separately
  // — the two must always agree, so there is only one thing to keep in sync.
  const [removedImages, setRemovedImages] = useState<NoteImage[]>([]);
  const hiddenImageIds = useMemo(() => new Set(removedImages.map(img => img.id)), [removedImages]);
  // Images this session has uploaded that note.images may not reflect yet.
  // The server's note_image_added SSE event is dropped for the client that
  // triggered it (self-echo suppression in useSSE, keyed on X-Client-Id —
  // every mutation this modal makes carries that header), so without this
  // local overlay a just-uploaded tile would vanish the moment its upload
  // placeholder is removed and only reappear after an unrelated refresh or a
  // reload. Tagged with the note it was uploaded to (NoteImage itself carries
  // no note_id) so switching notes can't leak one note's optimistic image
  // into another's gallery. Pruned once note.images actually contains it.
  const [optimisticImages, setOptimisticImages] = useState<{ noteId: string; image: NoteImage }[]>([]);
  const optimisticImagesRef = useRef<{ noteId: string; image: NoteImage }[]>([]);
  // The gallery's actual source of truth: note.images plus this session's own
  // not-yet-confirmed uploads for this note, minus anything mid-undo-window.
  const displayedImages = useMemo(() => {
    const base = note?.images ?? [];
    if (!note) return base;
    const baseIds = new Set(base.map(img => img.id));
    const extra = optimisticImages
      .filter(e => e.noteId === note.id && !baseIds.has(e.image.id))
      .map(e => e.image);
    const merged = extra.length > 0 ? [...base, ...extra] : base;
    return hiddenImageIds.size > 0 ? merged.filter(img => !hiddenImageIds.has(img.id)) : merged;
  }, [note, optimisticImages, hiddenImageIds]);
  // Human-readable max upload size for error copy, derived from the
  // server-configured cap (falls back to the shared default) rather than a
  // hardcoded value, so the message matches what the server will actually
  // accept even when an admin has overridden UPLOAD_MAX_BYTES.
  const imageMaxMB = useMemo(() => Math.round(uploadMaxBytes / (1024 * 1024)), [uploadMaxBytes]);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imageUploadsRef = useRef<PendingImageUpload[]>([]);
  const imageUploadFilesRef = useRef<Map<string, File>>(new Map());
  // Upload ids currently in flight, checked synchronously (not via React
  // state) so a rapid double-click on Retry can't start a second concurrent
  // request for the same file before a re-render reflects the first one.
  const activeUploadIdsRef = useRef<Set<string>>(new Set());
  const imageDragCounterRef = useRef(0);
  // Timers for client-deferred image removal (undo window). Stored in a ref
  // (not React state) so they keep running — and the eventual DELETE still
  // fires — even if this component unmounts before the undo window elapses.
  const pendingImageRemovalsRef = useRef<Map<string, { timeoutId: ReturnType<typeof setTimeout> }>>(new Map());

  // Checked list items currently showing the inline "checked items deleted —
  // Undo" bar. Rendered inside the DialogPanel (not the app-wide toast) for the
  // same reason as image removal above. hiddenCompletedItemIds is derived from
  // this so the two never drift. Only id/text are needed for the bar's count;
  // the items themselves stay in the local model (merely hidden) until the
  // deferred bulk delete lands, so the diff engine never re-deletes them.
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
  // Always calls the latest onRefresh, so the unmount flush below doesn't have
  // to re-run (and prematurely fire) on every onRefresh change.
  const notifyRefresh = useEffectEvent(() => {
    onRefresh?.();
  });

  // On unmount (the modal is fully closed — note switches keep it mounted) flush
  // any deferred completed-item deletes immediately. The undo bar is gone once
  // closed, so waiting out the timer only risks a reopen showing stale items
  // that the lingering timer then removes; firing now keeps server and a reopen
  // consistent. Runs once (empty deps) so it triggers on unmount only.
  useEffect(() => {
    const pending = pendingCompletedDeletesRef.current;
    return () => {
      if (pending.size === 0) return;
      for (const [pendingNoteId, entry] of pending) {
        clearTimeout(entry.timeoutId);
        void notes.deleteItems(pendingNoteId, [...entry.ids]).catch(err => {
          console.error('Failed to flush completed-item deletion on close:', err);
        });
      }
      pending.clear();
      notifyRefresh();
    };
  }, []);

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
    if (sameNote && (savingRef.current || saveTimeoutRef.current || isDirty())) {
      return;
    }
    const previousAdoptedId = adoptedNoteIdRef.current;
    adoptedNoteIdRef.current = incomingId;

    if (previousAdoptedId !== incomingId) {
      // Switching notes (or to/from a brand-new note) drops any in-flight
      // image uploads left over from whichever note we're leaving.
      imageUploadsRef.current.forEach(u => URL.revokeObjectURL(u.previewUrl));
      imageUploadFilesRef.current.clear();
      setImageUploads([]);
      // removedImages (and the hiddenImageIds derived from it) is NOT simply
      // cleared here — pendingImageRemovalsRef's timers are keyed by image id
      // and keep running across a note switch (this component doesn't
      // unmount), so a removal whose ~10s undo window is still open must
      // stay hidden (with its undo bar) if the user navigates back to this
      // note before it elapses. Re-derive it from whatever the incoming
      // note's images still have a live timer for, rather than assuming
      // "different note adopted" means "no pending removals" — otherwise the
      // image would reappear with no undo affordance and then vanish once
      // the timer fires, with no explanation. optimisticImages is left
      // alone entirely (not reset here) for the same reason on the upload
      // side — it's pruned per-note by its own effect above as each note is
      // (re-)opened, not cleared on switch.
      const stillPending = (note?.images ?? []).filter(img => pendingImageRemovalsRef.current.has(img.id));
      setRemovedImages(stillPending);

      // Same rationale for the "checked items deleted" undo bar: its deferred
      // bulk-delete timer keeps running across a note switch, so re-derive the
      // hidden set from whichever incoming items are still mid-window.
      const pendingCompleted = note?.id ? pendingCompletedDeletesRef.current.get(note.id) : undefined;
      const incomingItems = note?.note_type === 'list' ? note.items ?? [] : [];
      const stillPendingCompleted = pendingCompleted
        ? incomingItems.filter(it => pendingCompleted.ids.has(it.id)).map(it => ({ id: it.id, text: it.text }))
        : [];
      setRemovedCompletedItems(stillPendingCompleted);

      // The uncheck undo bar is note-specific and its action already persisted,
      // so drop it on a note switch rather than carrying it across.
      if (uncheckUndoTimeoutRef.current) {
        clearTimeout(uncheckUndoTimeoutRef.current);
        uncheckUndoTimeoutRef.current = undefined;
      }
      setRecentlyUnchecked(null);
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
  }, [commitItems, note, isDirty, setSavedBaseline, initialType, initialContent]);

  useEffect(() => {
    noteIdRef.current = note?.id ?? null;
  }, [note?.id]);

  useEffect(() => {
    noteTypeRef.current = noteType;
  }, [noteType]);

  useEffect(() => {
    imageUploadsRef.current = imageUploads;
  }, [imageUploads]);

  useEffect(() => {
    optimisticImagesRef.current = optimisticImages;
  }, [optimisticImages]);

  // Once note.images actually contains an optimistically-added image (a
  // later refresh caught up), drop it from the local overlay so it doesn't
  // grow unbounded across a long session. Only prunes entries for the
  // currently-open note — entries for a note that's no longer open are
  // reconciled the next time that note is reopened. displayedImages already
  // ignores confirmed entries, so this is bookkeeping rather than a visual
  // change; adjusting during render (the pruned result is stable on the next
  // pass) keeps it out of an effect (react-hooks/set-state-in-effect).
  if (optimisticImages.length > 0 && note) {
    const confirmedIds = new Set((note.images ?? []).map(img => img.id));
    const remaining = optimisticImages.filter(e => e.noteId !== note.id || !confirmedIds.has(e.image.id));
    if (remaining.length !== optimisticImages.length) {
      setOptimisticImages(remaining);
    }
  }

  // Revoke any outstanding local preview URLs on unmount. Deliberately does
  // NOT clear pendingImageRemovalsRef's timers — those must keep running so
  // a removal's deferred DELETE still fires after the modal closes.
  useEffect(() => {
    return () => {
      imageUploadsRef.current.forEach(u => URL.revokeObjectURL(u.previewUrl));
    };
  }, []);

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

  // Validates a file client-side before it's queued for upload — a fast,
  // friendly pre-check; the server (§7 of the spec) is the source of truth
  // and re-validates type/size/count regardless.
  const validateImageFile = useCallback((file: File): string | null => {
    if (!(IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      return t('images.errorWrongType');
    }
    if (file.size > uploadMaxBytes) {
      return t('images.errorTooLarge', { maxMB: imageMaxMB });
    }
    return null;
  }, [t, uploadMaxBytes, imageMaxMB]);

  // Removes a completed or dismissed upload tile and revokes its local
  // preview URL so the object URL doesn't leak.
  const removeUploadTile = useCallback((uploadId: string) => {
    setImageUploads(prev => {
      const tile = prev.find(u => u.id === uploadId);
      if (tile) URL.revokeObjectURL(tile.previewUrl);
      return prev.filter(u => u.id !== uploadId);
    });
    imageUploadFilesRef.current.delete(uploadId);
  }, []);

  const runImageUpload = useCallback((uploadId: string, file: File) => {
    const noteId = noteIdRef.current;
    if (!noteId) return;
    // Guard against a duplicate concurrent request for the same upload — a
    // rapid double-click on Retry (or the initial upload racing a fast
    // retry) before React re-renders the tile out of its clickable state.
    if (activeUploadIdsRef.current.has(uploadId)) return;
    activeUploadIdsRef.current.add(uploadId);
    imagesApi.upload(noteId, file, (percent) => {
      setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, progress: percent } : u)));
    }).then((image) => {
      activeUploadIdsRef.current.delete(uploadId);
      // note_image_added's SSE echo is dropped for the client that triggered
      // it (self-echo suppression in useSSE, keyed on the same X-Client-Id
      // header this upload just sent), so note.images won't reflect this
      // upload here on its own — add it to the local overlay so the real
      // tile takes over from the upload placeholder immediately instead of
      // vanishing until an unrelated refresh or reload catches it up.
      setOptimisticImages(prev => (prev.some(e => e.image.id === image.id) ? prev : [...prev, { noteId, image }]));
      removeUploadTile(uploadId);
      // optimisticImages only lives as long as this NoteModal instance does.
      // Closing the modal unmounts it entirely, so without also correcting
      // Dashboard's own note list here, reopening the same note would read
      // the same stale note.images (missing this upload) all over again —
      // the same dropped-SSE-echo gap the deferred delete already guards
      // against below, just on the add side instead of the remove side.
      onRefresh?.();
    }).catch((error) => {
      activeUploadIdsRef.current.delete(uploadId);
      console.error('Failed to upload image:', error);
      const status = (error as { response?: { status?: number } })?.response?.status;
      const message = status === 413
        ? t('images.errorTooLarge', { maxMB: imageMaxMB })
        : t('images.uploadFailed');
      setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, status: 'error', errorMessage: message } : u)));
    });
  }, [removeUploadTile, t, imageMaxMB, onRefresh]);

  const startImageUpload = useCallback((file: File) => {
    const id = generateId();
    const previewUrl = URL.createObjectURL(file);
    imageUploadFilesRef.current.set(id, file);
    setImageUploads(prev => [...prev, { id, filename: file.name, previewUrl, progress: 0, status: 'uploading' }]);
    runImageUpload(id, file);
  }, [runImageUpload]);

  const retryImageUpload = useCallback((uploadId: string) => {
    const file = imageUploadFilesRef.current.get(uploadId);
    if (!file) return;
    setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, status: 'uploading', progress: 0, errorMessage: undefined } : u)));
    runImageUpload(uploadId, file);
  }, [runImageUpload]);

  // Entry point for the toolbar picker, drag & drop, and paste. Validates
  // each file and enforces the per-note image cap client-side (the server
  // enforces it authoritatively) before starting an upload per valid file.
  const queueImageFiles = useCallback((files: File[]) => {
    if (!note || files.length === 0) return;

    const noteImages = note.images ?? [];
    const confirmedIds = new Set(noteImages.map(img => img.id));
    // Images this session already uploaded to this note that note.images
    // doesn't reflect yet (see optimisticImages above) still occupy a slot.
    const unconfirmedOptimisticCount = optimisticImagesRef.current.filter(
      e => e.noteId === note.id && !confirmedIds.has(e.image.id)
    ).length;
    let remainingSlots = IMAGE_MAX_PER_NOTE
      - noteImages.length
      - unconfirmedOptimisticCount
      - imageUploadsRef.current.filter(u => u.status !== 'error').length;

    // Collect distinct error messages across the whole batch instead of
    // showing (and immediately overwriting) one per invalid file — a drop of
    // several invalid files in one action would otherwise only ever surface
    // the last file's error.
    const errors = new Set<string>();
    for (const file of files) {
      const validationError = validateImageFile(file);
      if (validationError) {
        errors.add(validationError);
        continue;
      }
      if (remainingSlots <= 0) {
        errors.add(t('images.errorTooMany', { max: IMAGE_MAX_PER_NOTE }));
        break;
      }
      remainingSlots -= 1;
      startImageUpload(file);
    }
    if (errors.size > 0) showError(Array.from(errors).join(' '));
  }, [note, showError, startImageUpload, t, validateImageFile]);

  const handleImageFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    queueImageFiles(files);
  }, [queueImageFiles]);

  const handleImageDragEnter = useCallback((e: React.DragEvent) => {
    if (!note || !Array.from(e.dataTransfer.items).some(item => item.kind === 'file')) return;
    e.preventDefault();
    imageDragCounterRef.current += 1;
    setIsDraggingImage(true);
  }, [note]);

  const handleImageDragOver = useCallback((e: React.DragEvent) => {
    // Only claim file drags — preventDefault() unconditionally would also
    // suppress the browser's native text drag-and-drop (e.g. repositioning
    // selected text within the note's own textarea), which this handler
    // does nothing with.
    if (!note || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  }, [note]);

  const handleImageDragLeave = useCallback(() => {
    if (!note) return;
    imageDragCounterRef.current = Math.max(0, imageDragCounterRef.current - 1);
    if (imageDragCounterRef.current === 0) setIsDraggingImage(false);
  }, [note]);

  const handleImageDrop = useCallback((e: React.DragEvent) => {
    if (!note) return;
    // Only claim drops that actually carry files — same reasoning as
    // handleImageDragOver: cancelling a file-less drop would also cancel the
    // browser's native text drag-and-drop (e.g. repositioning selected text
    // within the note's own textarea), making that drop silently do nothing.
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    e.preventDefault();
    imageDragCounterRef.current = 0;
    setIsDraggingImage(false);
    queueImageFiles(droppedFiles.filter(f => f.type.startsWith('image/')));
  }, [note, queueImageFiles]);

  const handleModalPaste = useCallback((e: React.ClipboardEvent) => {
    if (!note) return;
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    queueImageFiles(files);
  }, [note, queueImageFiles]);

  // Clears the local "removed, showing undo" state for an image — called
  // either by undo or once the deferred delete actually lands.
  const clearImageRemovalState = useCallback((imageId: string) => {
    setRemovedImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Removal is client-deferred (spec §3.1): the tile hides immediately and an
  // inline "Image removed — Undo" bar appears (rendered inside the modal, not
  // the app-wide toast — HeadlessUI's Dialog treats any click outside its own
  // portal as a request to close it, which would otherwise dismiss the modal
  // the moment Undo is clicked). The DELETE only fires once the undo window
  // elapses with no undo. The timer lives in pendingImageRemovalsRef (a ref,
  // not state) so it keeps running even if this component unmounts first.
  const removeNoteImage = useCallback((image: NoteImage) => {
    setRemovedImages(prev => (prev.some(img => img.id === image.id) ? prev : [...prev, image]));

    const timeoutId = setTimeout(() => {
      const entry = pendingImageRemovalsRef.current.get(image.id);
      pendingImageRemovalsRef.current.delete(image.id);
      // Undo (or a later removal of the same image) deletes the map entry
      // and clears this timer, so reaching here with no entry means it was
      // already cancelled — nothing left to do.
      if (!entry) return;
      imagesApi.delete(image.id).then(() => {
        // note_image_removed's SSE echo is dropped for this client (same
        // self-echo suppression as uploads), and this component may have
        // already unmounted (modal closed) by the time this fires, so
        // Dashboard's note.images can otherwise stay stale — reopening the
        // note would show the just-deleted image again. onRefresh's closure
        // still targets the current Dashboard instance's state setters even
        // if captured before this component unmounted.
        onRefresh?.();
      }).catch((error) => {
        console.error('Failed to delete note image:', error);
      }).finally(() => {
        // Deliberately deferred until the request settles (not run
        // synchronously when the timer fires) — clearing this earlier would
        // un-hide the tile for the gap between "timer fired" and "DELETE
        // actually completed," flashing the about-to-be-deleted image back
        // into view. On failure this correctly restores it since the delete
        // never happened.
        clearImageRemovalState(image.id);
      });
    }, IMAGE_REMOVE_UNDO_MS);
    pendingImageRemovalsRef.current.set(image.id, { timeoutId });
  }, [clearImageRemovalState, onRefresh]);

  const undoRemoveImage = useCallback((imageId: string) => {
    const entry = pendingImageRemovalsRef.current.get(imageId);
    if (entry) {
      clearTimeout(entry.timeoutId);
      pendingImageRemovalsRef.current.delete(imageId);
    }
    clearImageRemovalState(imageId);
  }, [clearImageRemovalState]);

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

  const insertListItemAfter = (
    afterItemId: string,
    overrides: { text?: string; parentId?: string | null; assignedTo?: string } = {},
  ) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
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
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    const currentItems = itemsRef.current;
    const itemPos = currentItems.findIndex(item => item.id === itemId);
    if (itemPos === -1) return itemId;
    const currentItem = currentItems[itemPos];
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

  // Reconciles only the completed flags the server reports (never replacing the
  // whole list, so unsaved edits and not-yet-created items survive) and advances
  // the diff baseline so the autosave engine does not re-patch them.
  const reconcileCompletedFromServer = useCallback((serverItems: NoteItem[]) => {
    const completedById = new Map(serverItems.map(item => [item.id, item.completed]));
    commitItems(itemsRef.current.map(item => {
      const serverCompleted = completedById.get(item.id);
      return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
    }));
    for (const [id, comp] of completedById) {
      const snap = savedItemsRef.current.get(id);
      if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
    }
  }, [commitItems]);

  // Sets completed=false on the given items in one bulk request, applying an
  // optimistic local update first and reverting precisely those flags on error.
  // Mirrors the single-item toggle's reconcile-only-completed-flags approach.
  const setItemsCompletedLocallyAndRemotely = useCallback(async (ids: string[], completed: boolean) => {
    const targets = new Set(ids);
    commitItems(itemsRef.current.map(item => (targets.has(item.id) ? { ...item, completed } : item)));

    const noteId = noteIdRef.current;
    // A not-yet-persisted note has no server-side items; the bulk create on save
    // carries the flags instead.
    if (!noteId) {
      markDirty();
      return;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }

    try {
      const serverItems = await notes.setItemsCompleted(noteId, ids, completed);
      reconcileCompletedFromServer(serverItems);
      onRefresh?.();
      flashSaved();
    } catch (error) {
      console.error('Failed to set items completed:', error);
      commitItems(itemsRef.current.map(item => (targets.has(item.id) ? { ...item, completed: !completed } : item)));
      showError(t('note.failedSaveChanges'));
    }
  }, [commitItems, markDirty, reconcileCompletedFromServer, onRefresh, flashSaved, showError, t]);

  // Unchecks every completed item, then shows a transient "N unchecked — Undo"
  // bar. Undo re-checks exactly that snapshot (the same bulk endpoint with
  // completed=true), restoring the prior state.
  const handleUncheckAllItems = useCallback(async () => {
    const completed = itemsRef.current.filter(item => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map(item => item.id);

    const noteId = noteIdRef.current;
    await setItemsCompletedLocallyAndRemotely(ids, false);

    // Only offer undo for a persisted note (the bar re-checks server-side).
    if (!noteId) return;
    setRecentlyUnchecked({ noteId, ids, count: ids.length });
    if (uncheckUndoTimeoutRef.current) clearTimeout(uncheckUndoTimeoutRef.current);
    uncheckUndoTimeoutRef.current = setTimeout(() => {
      uncheckUndoTimeoutRef.current = undefined;
      setRecentlyUnchecked(null);
    }, COMPLETED_DELETE_UNDO_MS);
  }, [setItemsCompletedLocallyAndRemotely]);

  const undoUncheckAll = useCallback(() => {
    if (uncheckUndoTimeoutRef.current) {
      clearTimeout(uncheckUndoTimeoutRef.current);
      uncheckUndoTimeoutRef.current = undefined;
    }
    const rec = recentlyUnchecked;
    setRecentlyUnchecked(null);
    // Guard against the note having changed under the bar: only re-check if the
    // snapshot still belongs to the note currently open.
    if (rec && rec.noteId === noteIdRef.current) {
      void setItemsCompletedLocallyAndRemotely(rec.ids, true);
    }
  }, [recentlyUnchecked, setItemsCompletedLocallyAndRemotely]);

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
    for (const id of ids) savedItemsRef.current.delete(id);
    // Advance the baseline for any reconciled item so the diff engine does not
    // try to "restore" the pre-delete parent/completed on the next save.
    for (const item of next) {
      const snap = savedItemsRef.current.get(item.id);
      if (snap && (snap.parentId !== item.parentId || snap.completed !== item.completed)) {
        savedItemsRef.current.set(item.id, { ...snap, parentId: item.parentId, completed: item.completed });
      }
    }
    savedOrderRef.current = savedOrderRef.current.filter(id => !ids.has(id));
    setRemovedCompletedItems(prev => prev.filter(item => !ids.has(item.id)));
  }, [commitItems]);

  // Deletes all checked items, client-deferred behind an in-modal undo bar (the
  // app-wide toast lives outside the Dialog portal, so clicking it would close
  // the modal — same constraint as image removal). The items hide immediately;
  // the single bulk DELETE fires only once the undo window elapses. Until then
  // they remain in the local model (merely hidden) so an autosave in the window
  // never per-item-deletes them, and an SSE refresh can't resurrect them.
  const handleDeleteCompletedItems = useCallback(() => {
    const noteId = noteIdRef.current;
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
  }, [finalizeCompletedDeletion, onRefresh, showError, t]);

  const undoDeleteCompletedItems = useCallback(() => {
    const noteId = noteIdRef.current;
    const entry = noteId ? pendingCompletedDeletesRef.current.get(noteId) : undefined;
    if (entry) {
      clearTimeout(entry.timeoutId);
      pendingCompletedDeletesRef.current.delete(noteId!);
      setRemovedCompletedItems(prev => prev.filter(item => !entry.ids.has(item.id)));
    } else {
      setRemovedCompletedItems([]);
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

  // applyCompletedCascade mirrors the server's cascade locally: a top-level
  // item's completed state cascades to all of its children (in either
  // direction), while unchecking a child also un-completes its parent — a
  // parent can never stay "done" with an incomplete child. Completing every
  // child does not auto-complete the parent; that still requires checking it.
  const applyCompletedCascade = (items: ListItem[], itemId: string, completed: boolean): ListItem[] => {
    const target = items.find(item => item.id === itemId);
    if (!target) return items;
    const cascadeToChildren = target.parentId === null;
    const uncompleteParent = target.parentId !== null && !completed;
    return items.map(item => {
      if (item.id === itemId) return { ...item, completed };
      if (cascadeToChildren && item.parentId === itemId) return { ...item, completed };
      if (uncompleteParent && item.id === target.parentId) return { ...item, completed: false };
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
  }, [note, usersById]);

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

  // List -> text is lossy (assignments, real checkbox/nesting structure), so
  // it's confirmed first; text -> list just reflows lines and runs directly.
  const handleConvertClick = () => {
    if (!note || !onConvert || loading || savingRef.current) return;
    if (noteType === 'list') {
      setShowConvertConfirm(true);
    } else {
      void performConvert();
    }
  };

  const performConvert = async () => {
    if (!note || !onConvert) return;
    const targetType: NoteType = noteType === 'list' ? 'text' : 'list';

    savingRef.current = true;
    setLoading(true);
    try {
      await persistExistingNote();
    } catch (error) {
      console.error('Failed to save note before conversion:', error);
      showError(t('note.failedSaveChanges'));
      savingRef.current = false;
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
      savingRef.current = false;
      setLoading(false);
      setShowConvertConfirm(false);
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

  // An effect event so the window listener below can be registered once and
  // still see the latest props/state on every keypress.
  const handleModalShortcut = useEffectEvent((e: KeyboardEvent) => {
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
          onDragEnter={handleImageDragEnter}
          onDragOver={handleImageDragOver}
          onDragLeave={handleImageDragLeave}
          onDrop={handleImageDrop}
          onPaste={handleModalPaste}
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
                editable={!!note}
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
                    <Plus className="h-4 w-4" />
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
                      <ChevronDown 
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
                                    className="flex items-start gap-2 min-w-0 text-sm opacity-60 select-none"
                                    style={{ marginLeft: indentOf(parent) * VALIDATION.INDENT_PX_PER_LEVEL }}
                                    aria-label={t('note.completedItemGroup', { title: parent.text })}
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
                return isOwner && onShare ? (
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
                      onClick={() => imageFileInputRef.current?.click()}
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                      title={t('images.addImage')}
                      aria-label={t('images.addImage')}
                    >
                      <Image className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                    </button>
                    <button
                      onClick={handlePinToggle}
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
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
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
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
                          </div>
                        </MenuItems>
                      </Menu>
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
                    <Check className="h-4 w-4" />
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