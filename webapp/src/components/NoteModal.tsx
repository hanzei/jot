import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon, ChevronDownIcon, ArchiveBoxIcon, ArchiveBoxXMarkIcon, ShareIcon, UserPlusIcon, CheckIcon, TagIcon, DocumentDuplicateIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline';
import { Dialog, DialogPanel } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, NOTE_COLORS, buildCollaborators, type Note, type NoteType, type CreateNoteRequest, type UpdateNoteRequest, type Label, type User, type Collaborator } from '@jot/shared';
import { notes } from '@/utils/api';
import LabelPicker from '@/components/LabelPicker';
import LetterAvatar from '@/components/LetterAvatar';
import AssigneePicker from '@/components/AssigneePicker';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { buildShareAvatars } from '@/utils/shareAvatars';
import { buildMobileDeepLink } from '@/utils/deepLink';
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

const haveTodoItemsChanged = (currentItems: TodoItem[], originalItems: Note['items'] | undefined): boolean => {
  const baseItems = originalItems ?? [];
  if (currentItems.length !== baseItems.length) return true;

  return currentItems.some((item, index) => {
    const baseItem = baseItems[index];
    if (!baseItem) return true;

    return (
      item.text !== baseItem.text ||
      item.completed !== baseItem.completed ||
      item.position !== baseItem.position ||
      item.indentLevel !== (baseItem.indent_level ?? 0) ||
      item.assignedTo !== (baseItem.assigned_to ?? '')
    );
  });
};

// Timeout management now handled via useRef instead of global window property

// Utility function to generate unique IDs for todo items
const generateItemId = () => crypto.randomUUID();
const TEXT_NOTE_MIN_HEIGHT_PX = 96;
const TEXT_NOTE_MAX_HEIGHT_PX = 320;
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

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  indentLevel: number;
  assignedTo: string;
  originalPosition?: number;
}

interface QueuedAutoSaveRequest {
  noteId: string;
  updateData: UpdateNoteRequest;
}

interface SortableItemProps {
  id: string;
  index: number;
  item: TodoItem;
  onUpdateTodoItem: (index: number, field: 'text' | 'completed', value: string | boolean) => Promise<void>;
  onRemoveTodoItem: (itemId: string) => void;
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

function SortableItem({ id, index, item, onUpdateTodoItem, onRemoveTodoItem, isCompleted = false, onKeyDown, onPaste, inputRef, onIndentChange, isShared, collaborators, usersById, onAssignItem, completedItemTexts = [], onAcceptSuggestion }: SortableItemProps) {
  const { t } = useTranslation();
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const todoTextRef = useRef<HTMLTextAreaElement | null>(null);
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
    marginLeft: item.indentLevel * VALIDATION.INDENT_PX_PER_LEVEL,
  };

  const assignedUser = item.assignedTo ? usersById?.get(item.assignedTo) : undefined;
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignItem;
  const placeholder = item.text ? '' : t('note.itemPlaceholder');
  const autoResizeTodoText = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  const setTodoTextRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    todoTextRef.current = textarea;
    autoResizeTodoText(textarea);
    inputRef?.(textarea);
  }, [autoResizeTodoText, inputRef]);

  useEffect(() => {
    autoResizeTodoText(todoTextRef.current);
  }, [item.text, autoResizeTodoText]);

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
      onUpdateTodoItem(index, 'text', text);
    }
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="todo-item-row"
      className={`group/item flex items-start gap-2 ${isDragging ? 'opacity-50' : ''} ${
        isCompleted ? 'opacity-60' : ''
      }`}
      {...attributes}
    >
      {!isCompleted && (
        <div
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
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
        onChange={(e) => onUpdateTodoItem(index, 'completed', e.target.checked)}
        className="h-4 w-4 text-blue-600 rounded mt-0.5 flex-shrink-0"
      />
      <div className="flex flex-1 items-start min-w-0">
        <div className="relative min-w-0 flex-1">
          <textarea
            data-testid="todo-item-input"
            placeholder={placeholder}
            rows={1}
            className={`w-full pt-0 pb-1 pl-1 pr-0 bg-transparent border-none outline-none min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white ${
              isCompleted ? 'line-through text-gray-500 dark:text-gray-400' : ''
            }`}
            value={item.text}
            onInput={(e) => autoResizeTodoText(e.currentTarget)}
            onChange={(e) => {
              onUpdateTodoItem(index, 'text', e.target.value);
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
            ref={setTodoTextRef}
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
                  className="w-5 h-5"
                />
              </button>
            ) : (
              !isCompleted && (
                <button
                  onClick={() => setShowAssigneePicker(true)}
                  className="w-5 h-5 rounded-full border border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors opacity-0 group-hover/item:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 touch-visible"
                  title={t('note.assignItem')}
                  aria-label={t('note.assignItem')}
                >
                  <UserPlusIcon className="h-3 w-3 text-gray-400 dark:text-gray-500" aria-hidden="true" />
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
        onClick={() => onRemoveTodoItem(item.id)}
        className="ml-auto p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
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
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [noteLabels, setNoteLabels] = useState<Label[]>(note?.labels ?? []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  
  // Use useRef for timeout management instead of global window property
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteIdRef = useRef<string | null>(note?.id ?? null);
  const autoSaveDraftRef = useRef<Omit<UpdateNoteRequest, 'items'>>({
    title: '',
    content: '',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
  });
  const itemsRef = useRef<TodoItem[]>([]);
  const pendingAutoSaveRequestRef = useRef<QueuedAutoSaveRequest | null>(null);
  const itemInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const savingRef = useRef(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resizeContentTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(
      Math.max(contentHeight, TEXT_NOTE_MIN_HEIGHT_PX),
      TEXT_NOTE_MAX_HEIGHT_PX
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = contentHeight > nextHeight ? 'auto' : 'hidden';
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const mapItemsForAutoSave = useCallback((sourceItems: TodoItem[]) => sourceItems.map((item) => ({
    text: item.text,
    position: item.position,
    completed: item.completed,
    indent_level: item.indentLevel,
    assigned_to: item.assignedTo,
  })), []);

  const buildAutoSaveRequest = useCallback((sourceItems: TodoItem[]): UpdateNoteRequest => ({
    ...autoSaveDraftRef.current,
    items: mapItemsForAutoSave(sourceItems),
  }), [mapItemsForAutoSave]);

  const commitItems = useCallback((nextItems: TodoItem[]) => {
    itemsRef.current = nextItems;
    setItems(nextItems);
    if (savingRef.current && noteIdRef.current) {
      pendingAutoSaveRequestRef.current = {
        noteId: noteIdRef.current,
        updateData: buildAutoSaveRequest(nextItems),
      };
    }
  }, [buildAutoSaveRequest]);

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
    if (!note?.id) {
      return null;
    }
    return buildMobileDeepLink(`/notes/${note.id}`, window.location.origin);
  }, [note?.id]);

  useEffect(() => {
    if (note) {
      setTitle(note.title);
      setContent(note.content);
      setNoteType(note.note_type);
      setColor(note.color);
      setPinned(note.pinned);
      setArchived(note.archived);
      setCheckedItemsCollapsed(note.checked_items_collapsed);
      const mappedItems = note.items?.map((item, index) => ({
        id: item.id || `existing_${item.position}_${index}`,
        text: item.text,
        completed: item.completed,
        position: item.position,
        indentLevel: item.indent_level ?? 0,
        assignedTo: item.assigned_to ?? '',
      })) || [];
      commitItems(mappedItems);
      setNoteLabels(note.labels ?? []);
    } else {
      setTitle('');
      setContent('');
      setNoteType('text');
      setColor('#ffffff');
      setPinned(false);
      setArchived(false);
      commitItems([]);
      setNoteLabels([]);
    }
  }, [commitItems, note]);

  useEffect(() => {
    noteIdRef.current = note?.id ?? null;
  }, [note?.id]);

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
    if (noteType !== 'text') return;
    resizeContentTextarea(contentRef.current);
  }, [content, noteType, resizeContentTextarea]);

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

  // Simplified position restoration logic using Map for position tracking
  const restoreItemPosition = (items: TodoItem[], itemToRestore: TodoItem): TodoItem[] => {
    // Remove the item to restore from the items array
    const otherItems = items.filter(item => item.id !== itemToRestore.id);
    const uncompletedItems = otherItems.filter(item => !item.completed);
    
    // Determine target position (use stored original position or end)
    const targetPosition = Math.min(
      itemToRestore.originalPosition ?? uncompletedItems.length, 
      uncompletedItems.length
    );
    
    // Create restored item
    const restoredItem: TodoItem = {
      ...itemToRestore,
      completed: false,
      originalPosition: undefined,
      position: targetPosition,
    };
    
    // Insert the restored item and renumber positions
    const uncompletedWithRestored = [
      ...uncompletedItems.slice(0, targetPosition),
      restoredItem,
      ...uncompletedItems.slice(targetPosition),
    ].map((item, index) => ({ ...item, position: index }));
    
    // Combine with completed items (keep their positions unchanged)
    const completedItems = otherItems.filter(item => item.completed);
    return [...uncompletedWithRestored, ...completedItems];
  };

  const INDENT_DRAG_THRESHOLD = 50;
  const MAX_INDENT = 1;

  const indentTodoItem = async (itemId: string, delta: 1 | -1) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    const updatedItems = itemsRef.current.map(item => {
      if (item.id === itemId) {
        const newLevel = Math.max(0, Math.min(MAX_INDENT, item.indentLevel + delta));
        return { ...item, indentLevel: newLevel };
      }
      return item;
    });
    commitItems(updatedItems);
    await autoSaveNote(updatedItems);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over, delta } = event;

    // Horizontal drag → indent or unindent
    if (Math.abs(delta.x) >= INDENT_DRAG_THRESHOLD) {
      const draggedItem = uncompletedItems.find(item => item.id === active.id);
      if (draggedItem) {
        await indentTodoItem(draggedItem.id, delta.x > 0 ? 1 : -1);
      }
      return;
    }

    if (over && active.id !== over.id) {
      // Find the active and over items by their IDs
      const activeIndex = uncompletedItems.findIndex(item => item.id === active.id);
      const overIndex = uncompletedItems.findIndex(item => item.id === over.id);

      if (activeIndex === -1 || overIndex === -1) return;

      const reorderedUncompletedItems = arrayMove(uncompletedItems, activeIndex, overIndex);

      // Update uncompleted items and renumber their positions
      const updatedUncompletedItems = reorderedUncompletedItems.map((item, index) => ({
        ...item,
        position: index,
      }));

      // Combine with completed items to create new items array
      const newItems = [...updatedUncompletedItems, ...completedItems];
      commitItems(newItems);

      // Auto-save if editing an existing note
      await autoSaveNote(newItems);
    }
  };

  const addTodoItem = () => {
    const currentItems = itemsRef.current;
    const uncompletedCount = currentItems.filter(item => !item.completed).length;
    const newItem: TodoItem = {
      id: generateItemId(),
      text: '',
      completed: false,
      position: uncompletedCount,
      indentLevel: 0,
      assignedTo: '',
    };
    const newItems = [...currentItems, newItem];
    commitItems(newItems);
    autoSaveNote(newItems);
    return newItem.id;
  };

  const insertTodoItemAfter = (afterItemId: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    const currentItems = itemsRef.current;
    const afterItemPos = currentItems.findIndex(item => item.id === afterItemId);
    const sourceIndentLevel = afterItemPos >= 0 ? currentItems[afterItemPos].indentLevel : 0;
    const newItem: TodoItem = {
      id: generateItemId(),
      text: '',
      completed: false,
      position: 0,
      indentLevel: Math.max(0, Math.min(MAX_INDENT, sourceIndentLevel)),
      assignedTo: '',
    };
    const insertPos = afterItemPos >= 0 ? afterItemPos + 1 : currentItems.length;
    const newItems = [...currentItems];
    newItems.splice(insertPos, 0, newItem);
    let pos = 0;
    const renumbered = newItems.map(item =>
      item.completed ? item : { ...item, position: pos++ }
    );
    commitItems(renumbered);
    autoSaveNote(renumbered);
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
      const newId = insertTodoItemAfter(currentItem?.id ?? '');
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

      removeTodoItem(currentItem.id);

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
    const newItems: TodoItem[] = remainingLines.map((line, i) => {
      const isLast = i === remainingLines.length - 1;
      const lineText = isLast ? line + after : line;
      return {
        id: generateItemId(),
        text: lineText.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH),
        completed: false,
        position: 0,
        indentLevel: 0,
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

    let pos = 0;
    const renumbered = updatedItems.map(item =>
      item.completed ? item : { ...item, position: pos++ }
    );

    commitItems(renumbered);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    autoSaveNote(renumbered);

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

  const removeTodoItem = (itemId: string) => {
    const newItems = itemsRef.current.filter(item => item.id !== itemId);
    
    let uncompletedCount = 0;
    const updatedItems = newItems.map((item) => {
      if (!item.completed) {
        return { ...item, position: uncompletedCount++ };
      }
      return item;
    });
    
    commitItems(updatedItems);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    autoSaveNote(updatedItems);
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

  const autoSaveNote = async (updatedItems: TodoItem[]) => {
    if (!noteIdRef.current) return;
    // Cancel any pending debounced text-save snapshot so it can't overwrite
    // a newer structural update (indent, insert, reorder, completion, etc.).
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    const nextRequest: QueuedAutoSaveRequest = {
      noteId: noteIdRef.current,
      updateData: buildAutoSaveRequest(updatedItems),
    };
    if (savingRef.current) {
      pendingAutoSaveRequestRef.current = nextRequest;
      return;
    }
    
    savingRef.current = true;
    markDirty();
    try {
      await notes.update(nextRequest.noteId, nextRequest.updateData);
      onRefresh?.();
      flashSaved();
      let pendingRequest = pendingAutoSaveRequestRef.current;
      while (pendingRequest) {
        pendingAutoSaveRequestRef.current = null;
        await notes.update(pendingRequest.noteId, pendingRequest.updateData);
        onRefresh?.();
        flashSaved();
        pendingRequest = pendingAutoSaveRequestRef.current;
      }
    } catch (error) {
      console.error('Failed to auto-save note:', error);
      showError(t('note.failedSaveChanges'));
    } finally {
      savingRef.current = false;
    }
  };

  // Helper function to handle item completion
  const handleItemCompletion = async (itemId: string) => {
    const currentItems = itemsRef.current;
    const itemToComplete = currentItems.find(item => item.id === itemId);
    if (!itemToComplete || itemToComplete.completed) return;
    
    const updatedItems = currentItems.map(item => {
      if (item.id === itemId) {
        return {
          ...item,
          completed: true,
          originalPosition: item.position, // Store original position
        };
      }
      return item;
    });
    
    commitItems(updatedItems);
    await autoSaveNote(updatedItems);
  };

  // Helper function to handle item un-completion
  const handleItemUncompletion = async (itemId: string) => {
    const currentItems = itemsRef.current;
    const itemToUncomplete = currentItems.find(item => item.id === itemId);
    if (!itemToUncomplete || !itemToUncomplete.completed) return;
    
    const finalItems = restoreItemPosition(currentItems, itemToUncomplete);
    
    commitItems(finalItems);
    await autoSaveNote(finalItems);
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
        await autoSaveNote(updatedItems);
      }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
    }
  };

  // Helper function to find target item by index (for backward compatibility)
  const findTargetItem = (index: number): TodoItem | null => {
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

  // Main updateTodoItem function - now much simpler and more reliable
  const updateTodoItem = async (index: number, field: 'text' | 'completed', value: string | boolean) => {
    const targetItem = findTargetItem(index);
    if (!targetItem) return;

    if (field === 'completed') {
      const isCompleting = value as boolean;
      
      if (isCompleting) {
        await handleItemCompletion(targetItem.id);
      } else {
        await handleItemUncompletion(targetItem.id);
      }
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
      autoSaveNote(updatedItems);
      return;
    }

    // Position in uncompleted list where the placeholder lives
    const insertAt = Math.max(
      0,
      uncompletedItems.findIndex(item => item.id === currentItemId)
    );

    // Remove the placeholder and the matched completed item from the full list
    const currentItems = itemsRef.current;
    const filtered = currentItems.filter(
      item => item.id !== currentItemId && item.id !== completedItem.id
    );

    // Restore the completed item: uncompleted, keep assignee and indent
    const restoredItem: TodoItem = {
      ...completedItem,
      completed: false,
      originalPosition: undefined,
    };

    const remainingUncompleted = filtered.filter(item => !item.completed);
    const remainingCompleted = filtered.filter(item => item.completed);

    const newUncompleted = [
      ...remainingUncompleted.slice(0, insertAt),
      restoredItem,
      ...remainingUncompleted.slice(insertAt),
    ].map((item, i) => ({ ...item, position: i }));

    const newItems = [...newUncompleted, ...remainingCompleted];
    commitItems(newItems);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    autoSaveNote(newItems);

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
    await autoSaveNote(updatedItems);
  };

  const persistExistingNote = useCallback(async () => {
    if (!note) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }

    const updateData: UpdateNoteRequest = {
      title,
      content,
      pinned,
      archived,
      color,
      checked_items_collapsed: checkedItemsCollapsed,
      items: noteType === 'todo' ? items.map((item, idx) => ({
        text: item.text,
        position: idx,
        completed: item.completed,
        indent_level: item.indentLevel,
        assigned_to: item.assignedTo,
      })) : undefined,
    };

    await notes.update(note.id, updateData);
    onRefresh?.();
  }, [archived, checkedItemsCollapsed, color, content, items, note, noteType, onRefresh, pinned, title]);

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
        const createData: CreateNoteRequest = {
          title,
          content,
          note_type: noteType,
          color,
          items: noteType === 'todo' ? items.map((item, idx) => ({
            text: item.text,
            position: idx,
            completed: item.completed,
            indent_level: item.indentLevel,
          })) : undefined,
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
      const updateData: UpdateNoteRequest = {
        title,
        content,
        pinned: newPinnedState,
        archived,
        color,
        checked_items_collapsed: checkedItemsCollapsed,
        items: note.note_type === 'todo' ? items.map((item, idx) => ({
          text: item.text,
          position: idx,
          completed: item.completed,
          indent_level: item.indentLevel,
          assigned_to: item.assignedTo,
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onRefresh?.();
      showToast(
        newPinnedState ? t('dashboard.notePinned') : t('dashboard.noteUnpinned'),
        'success'
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
      const updateData: UpdateNoteRequest = {
        title,
        content,
        pinned,
        archived: newArchivedState,
        color,
        checked_items_collapsed: checkedItemsCollapsed,
        items: note.note_type === 'todo' ? items.map((item, idx) => ({
          text: item.text,
          position: idx,
          completed: item.completed,
          indent_level: item.indentLevel,
          assigned_to: item.assignedTo,
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onRefresh?.();
      showToast(
        newArchivedState ? t('dashboard.noteArchived') : t('dashboard.noteUnarchived'),
        'success'
      );
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
      const updateData: UpdateNoteRequest = {
        title,
        content,
        pinned,
        archived,
        color,
        checked_items_collapsed: newCollapsedState,
        items: note.note_type === 'todo' ? items.map((item, idx) => ({
          text: item.text,
          position: idx,
          completed: item.completed,
          indent_level: item.indentLevel,
          assigned_to: item.assignedTo,
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onRefresh?.();
    } catch (error) {
      console.error('Failed to update collapse state:', error);
      // Revert the state on error
      setCheckedItemsCollapsed(checkedItemsCollapsed);
    }
  };

  const hasUnsavedChanges = () => {
    if (note) {
      const todoItemsChanged = note.note_type === 'todo' && haveTodoItemsChanged(items, note.items);
      return (
        title !== note.title ||
        content !== note.content ||
        color !== note.color ||
        pinned !== note.pinned ||
        archived !== note.archived ||
        checkedItemsCollapsed !== note.checked_items_collapsed ||
        todoItemsChanged
      );
    } else {
      return (
        title.trim() !== '' ||
        content.trim() !== '' ||
        (noteType === 'todo' && items.some(item => item.text.trim() !== '')) ||
        noteLabels.length > 0
      );
    }
  };

  const handleCloseRequest = async () => {
    if (hasUnsavedChanges()) {
      if (savingRef.current) {
        // An auto-save is already in flight. Flush any pending debounced
        // text-save into the queue so the in-flight save picks up the latest
        // non-item edits (title, content, color, …) before the component
        // unmounts and the cleanup effect cancels the timer.
        if (saveTimeoutRef.current && noteIdRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = undefined;
          pendingAutoSaveRequestRef.current = {
            noteId: noteIdRef.current,
            updateData: buildAutoSaveRequest(itemsRef.current),
          };
        }
        onClose();
        return;
      }
      await handleSave();
    } else {
      onClose();
    }
  };


  return (
    <>
      <Dialog open={true} onClose={handleCloseRequest} className="relative z-50">
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" />
      
      <div className="fixed inset-0 flex items-center justify-center p-2 sm:p-4 overflow-hidden">
        <DialogPanel
          className={`mx-auto w-full max-w-md max-h-[90vh] overflow-hidden rounded-lg shadow-xl ${
            colors.find(c => c.value === color)?.class || 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-600">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {note ? t('note.editNote') : t('note.newNote')}
            </h2>
            <div className="flex items-center space-x-2">
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
                  {isOwner && onShare && (
                    <button
                      onClick={() => onShare(note)}
                      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                      title={t('note.share')}
                      aria-label={t('note.share')}
                    >
                      <ShareIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                    </button>
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
              <button
                aria-label={t('common.close')}
                onClick={handleCloseRequest}
                className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
              >
                <XMarkIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
              </button>
            </div>
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
          <div className="p-2 sm:p-4 space-y-4 overflow-y-auto max-h-[calc(90vh-8rem)]">
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
                  onClick={() => setNoteType('todo')}
                  className={`px-3 py-1 text-sm rounded-md ${
                    noteType === 'todo'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {t('note.typeTodo')}
                </button>
              </div>
            )}

            {/* Title */}
            <input
              type="text"
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
                if (note) markDirty();
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.repeat) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (noteType === 'text') {
                    const textarea = contentRef.current;
                    if (textarea) {
                      textarea.focus();
                      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
                    }
                  } else {
                    const firstItem = uncompletedItems[0];
                    if (firstItem) {
                      const input = itemInputRefs.current.get(firstItem.id);
                      if (input) {
                        input.focus();
                        input.setSelectionRange(input.value.length, input.value.length);
                      }
                    } else {
                      const newId = addTodoItem();
                      setTimeout(() => itemInputRefs.current.get(newId)?.focus(), 0);
                    }
                  }
                }
              }}
            />

            {/* Content based on type */}
            {noteType === 'text' ? (
              <textarea
                ref={contentRef}
                placeholder={t('note.contentPlaceholder')}
                rows={4}
                className="w-full p-2 bg-transparent border-none outline-none resize-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white min-h-[6rem]"
                value={content}
                onChange={(e) => {
                  const newContent = e.target.value;
                  const validationError = validateContent(newContent, t);
                  if (validationError) {
                    showError(validationError);
                    return;
                  }
                  setContent(newContent);
                  if (note) markDirty();
                }}
              />
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
                          onUpdateTodoItem={updateTodoItem}
                          onRemoveTodoItem={removeTodoItem}
                          isCompleted={false}
                          onKeyDown={handleItemKeyDown}
                          onPaste={handleItemPaste}
                          onIndentChange={indentTodoItem}
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
                    onClick={addTodoItem}
                    className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white p-1"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span>{t('note.addItem')}</span>
                  </button>
                </div>

                {/* Completed items section */}
                {completedItems.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-slate-600 pt-3">
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
                        {completedItems.map((item, index) => (
                          <SortableItem
                            key={item.id}
                            id={item.id}
                            index={index + uncompletedItems.length}
                            item={item}
                            onUpdateTodoItem={(idx, field, value) => updateTodoItem(idx, field, value)}
                            onRemoveTodoItem={removeTodoItem}
                            isCompleted={true}
                            isShared={note?.is_shared}
                            collaborators={collaborators}
                            usersById={usersById}
                            onAssignItem={assignItem}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Labels row: badges + add button with popover */}
            <div className="flex flex-wrap items-center gap-1">
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

            {/* Sharing info */}
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
                        className={`w-6 h-6 ring-2 ring-white dark:ring-slate-800 ${index > 0 ? '-ml-1' : ''}`}
                      />
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Color selector */}
            <div className="flex space-x-2">
              {colors.map((colorOption) => (
                <button
                  key={colorOption.value}
                  onClick={() => setColor(colorOption.value)}
                  className={`w-8 h-8 rounded-full border-2 ${colorOption.class} ${
                    color === colorOption.value ? 'ring-2 ring-blue-500' : ''
                  }`}
                  title={colorOption.name}
                  aria-label={colorOption.name}
                />
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center p-4 border-t border-gray-200 dark:border-slate-600">
            {note && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('note.lastEdited', { date: new Date(note.updated_at).toLocaleString(i18n.resolvedLanguage) })}
              </p>
            )}
            <div className="flex items-center ml-auto" role="status" aria-live="polite">
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
              ) : null}
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