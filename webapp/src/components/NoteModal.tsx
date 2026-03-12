import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon, ChevronDownIcon, ArchiveBoxIcon, ArchiveBoxXMarkIcon, ShareIcon } from '@heroicons/react/24/outline';
import { Dialog, DialogPanel } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { Note, NoteType, CreateNoteRequest, UpdateNoteRequest, Label, User } from '@/types';
import { notes } from '@/utils/api';
import LabelPicker from '@/components/LabelPicker';
import LetterAvatar from '@/components/LetterAvatar';
import { buildShareAvatars } from '@/utils/shareAvatars';

// Constants
const AUTO_SAVE_TIMEOUT = 1000; // Save 1 second after user stops typing
const MAX_ITEM_LENGTH = 500; // Maximum length for todo item text
const MAX_TITLE_LENGTH = 200; // Maximum length for note title
const MAX_CONTENT_LENGTH = 10000; // Maximum length for note content

// Validation functions
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

const validateItemText = (text: string, t: TFunction): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null; // Allow empty items (will be removed on save)
  if (trimmed.length > MAX_ITEM_LENGTH) return t('note.itemTooLong', { max: MAX_ITEM_LENGTH });
  if (/[<>]/g.test(trimmed)) return t('note.itemInvalidChars');
  return null;
};

const validateTitle = (title: string, t: TFunction): string | null => {
  if (title.length > MAX_TITLE_LENGTH) return t('note.titleTooLong', { max: MAX_TITLE_LENGTH });
  return null;
};

const validateContent = (content: string, t: TFunction): string | null => {
  if (content.length > MAX_CONTENT_LENGTH) return t('note.contentTooLong', { max: MAX_CONTENT_LENGTH });
  return null;
};

// Utility function to generate unique IDs for todo items
const generateItemId = () => `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Timeout management now handled via useRef instead of global window property
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
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface NoteModalProps {
  note?: Note | null;
  onClose: () => void;
  onSave: () => void;
  onRefresh?: () => void;
  onShare?: (note: Note) => void;
  isOwner?: boolean;
  usersById?: Map<string, User>;
  currentUserId?: string;
}

interface TodoItem {
  id: string; // Add unique ID for reliable tracking
  text: string;
  completed: boolean;
  position: number;
  indentLevel: number;
  originalPosition?: number;
}

interface SortableItemProps {
  id: string;
  index: number;
  item: TodoItem;
  onUpdateTodoItem: (index: number, field: 'text' | 'completed', value: string | boolean) => Promise<void>;
  onRemoveTodoItem: (itemId: string) => void;
  isCompleted?: boolean;
  onKeyDown?: (index: number, e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.RefCallback<HTMLInputElement>;
  onIndentChange?: (itemId: string, delta: 1 | -1) => void;
}

function SortableItem({ id, index, item, onUpdateTodoItem, onRemoveTodoItem, isCompleted = false, onKeyDown, inputRef, onIndentChange }: SortableItemProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: isCompleted // Disable dragging for completed items
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    marginLeft: item.indentLevel * 24,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center space-x-2 ${isDragging ? 'opacity-50' : ''} ${
        isCompleted ? 'opacity-60' : ''
      }`}
      {...attributes}
    >
      {/* Only show drag handle for uncompleted items */}
      {!isCompleted && (
        <div
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-gray-400 hover:text-gray-600"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M7 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 2zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 14zm6-8a2 2 0 1 1-.001-4.001A2 2 0 0 1 13 6zm0 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 14z" />
          </svg>
        </div>
      )}
      {/* Add spacing for completed items to align with uncompleted items */}
      {isCompleted && <div className="w-6 h-4"></div>}
      
      <input
        type="checkbox"
        checked={item.completed}
        onChange={(e) => onUpdateTodoItem(index, 'completed', e.target.checked)}
        className="h-4 w-4 text-blue-600 rounded"
      />
      <input
        type="text"
        placeholder={t('note.itemPlaceholder')}
        className={`flex-1 p-1 bg-transparent border-none outline-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white ${
          isCompleted ? 'line-through text-gray-500 dark:text-gray-400' : ''
        }`}
        value={item.text}
        onChange={(e) => onUpdateTodoItem(index, 'text', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && onIndentChange && !isCompleted) {
            e.preventDefault();
            onIndentChange(item.id, e.shiftKey ? -1 : 1);
            return;
          }
          if (onKeyDown) onKeyDown(index, e);
        }}
        ref={inputRef}
      />
      <button
        onClick={() => onRemoveTodoItem(item.id)}
        className="p-1 text-gray-400 hover:text-gray-600"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function NoteModal({ note, onClose, onSave, onRefresh, onShare, isOwner = true, usersById, currentUserId }: NoteModalProps) {
  const { t, i18n } = useTranslation();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState('#ffffff');
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [noteLabels, setNoteLabels] = useState<Label[]>(note?.labels ?? []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  
  // Use useRef for timeout management instead of global window property
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const itemInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Separate completed and uncompleted items with memoization
  const { uncompletedItems, completedItems } = useMemo(() => ({
    uncompletedItems: items.filter(item => !item.completed),
    completedItems: items.filter(item => item.completed)
  }), [items]);

  const colors = [
    { value: '#ffffff', name: t('note.colorWhite'), class: 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600' },
    { value: '#fbbc04', name: t('note.colorYellow'), class: 'bg-yellow-100 dark:bg-yellow-900 border-yellow-300 dark:border-yellow-700' },
    { value: '#34a853', name: t('note.colorGreen'), class: 'bg-green-100 dark:bg-green-900 border-green-300 dark:border-green-700' },
    { value: '#4285f4', name: t('note.colorBlue'), class: 'bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700' },
    { value: '#ea4335', name: t('note.colorRed'), class: 'bg-red-100 dark:bg-red-900 border-red-300 dark:border-red-700' },
    { value: '#8b5cf6', name: t('note.colorPurple'), class: 'bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700' },
  ];

  useEffect(() => {
    if (note) {
      setTitle(note.title);
      setContent(note.content);
      setNoteType(note.note_type);
      setColor(note.color);
      setPinned(note.pinned);
      setArchived(note.archived);
      setCheckedItemsCollapsed(note.checked_items_collapsed);
      setItems(
        note.items?.map((item, index) => ({
          id: item.id || `existing_${item.position}_${index}`, // Use existing ID or generate fallback
          text: item.text,
          completed: item.completed,
          position: item.position,
          indentLevel: item.indent_level ?? 0,
        })) || []
      );
      setNoteLabels(note.labels ?? []);
    } else {
      setTitle('');
      setContent('');
      setNoteType('text');
      setColor('#ffffff');
      setPinned(false);
      setArchived(false);
      setItems([]);
      setNoteLabels([]);
    }
  }, [note]);

  // Cleanup timeouts on component unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

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
    const updatedItems = items.map(item => {
      if (item.id === itemId) {
        const newLevel = Math.max(0, Math.min(MAX_INDENT, item.indentLevel + delta));
        return { ...item, indentLevel: newLevel };
      }
      return item;
    });
    setItems(updatedItems);
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
      setItems(newItems);

      // Auto-save if editing an existing note
      await autoSaveNote(newItems);
    }
  };

  const addTodoItem = () => {
    const newItem: TodoItem = {
      id: generateItemId(),
      text: '',
      completed: false,
      position: uncompletedItems.length,
      indentLevel: 0,
    };
    const newItems = [...items, newItem];
    setItems(newItems);
    autoSaveNote(newItems);
    return newItem.id;
  };

  const handleItemKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (e.repeat) return;
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    if (index < uncompletedItems.length - 1) {
      // Focus next item
      const nextItem = uncompletedItems[index + 1];
      itemInputRefs.current.get(nextItem.id)?.focus();
    } else {
      // Add a new item and focus it
      const newId = addTodoItem();
      setTimeout(() => {
        itemInputRefs.current.get(newId)?.focus();
      }, 0);
    }
  };

  const removeTodoItem = (itemId: string) => {
    const newItems = items.filter(item => item.id !== itemId);
    
    // Renumber positions for remaining uncompleted items
    let uncompletedCount = 0;
    const updatedItems = newItems.map((item) => {
      if (!item.completed) {
        return { ...item, position: uncompletedCount++ };
      }
      return item;
    });
    
    setItems(updatedItems);
  };

  // Helper function to auto-save note changes
  const autoSaveNote = async (updatedItems: TodoItem[]) => {
    if (!note) return;
    
    try {
      const updateData: UpdateNoteRequest = {
        title,
        content,
        pinned,
        archived,
        color,
        checked_items_collapsed: checkedItemsCollapsed,
        items: updatedItems.map((item, idx) => ({
          text: item.text,
          position: item.completed ? item.position : idx,
          completed: item.completed,
          indent_level: item.indentLevel,
        })),
      };
      await notes.update(note.id, updateData);
      onRefresh?.(); // Refresh the notes list to reflect the changes
    } catch (error) {
      console.error('Failed to auto-save note:', error);
      showError(t('note.failedSaveChanges'));
    }
  };

  // Helper function to handle item completion
  const handleItemCompletion = async (itemId: string) => {
    const itemToComplete = items.find(item => item.id === itemId);
    if (!itemToComplete || itemToComplete.completed) return;
    
    const updatedItems = items.map(item => {
      if (item.id === itemId) {
        return {
          ...item,
          completed: true,
          originalPosition: item.position, // Store original position
        };
      }
      return item;
    });
    
    setItems(updatedItems);
    await autoSaveNote(updatedItems);
  };

  // Helper function to handle item un-completion
  const handleItemUncompletion = async (itemId: string) => {
    const itemToUncomplete = items.find(item => item.id === itemId);
    if (!itemToUncomplete || !itemToUncomplete.completed) return;
    
    const finalItems = restoreItemPosition(items, itemToUncomplete);
    
    setItems(finalItems);
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
    
    const textValue = newText.slice(0, MAX_ITEM_LENGTH);
    const updatedItems = items.map(item => {
      if (item.id === itemId) {
        return { ...item, text: textValue };
      }
      return item;
    });
    
    setItems(updatedItems);
    
    // Auto-save text changes if editing an existing note (with debouncing)
    if (note) {
      // Clear previous timeout if exists
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      
      // Set new timeout to save after user stops typing
      saveTimeoutRef.current = setTimeout(async () => {
        await autoSaveNote(updatedItems);
      }, AUTO_SAVE_TIMEOUT);
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

  const handleSave = async () => {
    setLoading(true);
    try {
      if (note) {
        // Update existing note
        const updateData: UpdateNoteRequest = {
          title,
          content,
          pinned,
          archived,
          color,
          checked_items_collapsed: !checkedItemsCollapsed,
          items: note.note_type === 'todo' ? items.map((item, idx) => ({
            text: item.text,
            position: idx,
            completed: item.completed,
            indent_level: item.indentLevel,
          })) : undefined,
        };
        await notes.update(note.id, updateData);
      } else {
        // Create new note
        const createData: CreateNoteRequest = {
          title,
          content,
          note_type: noteType,
          color,
          items: noteType === 'todo' ? items.map((item, idx) => ({ text: item.text, position: idx, indent_level: item.indentLevel })) : undefined,
        };
        await notes.create(createData);
      }
      onSave();
    } catch (error) {
      console.error('Failed to save note:', error);
    } finally {
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
        checked_items_collapsed: !checkedItemsCollapsed,
        items: note.note_type === 'todo' ? items.map((item, idx) => ({
          text: item.text,
          position: idx,
          completed: item.completed,
          indent_level: item.indentLevel,
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onSave(); // Refresh the notes list to show updated pin status
    } catch (error) {
      console.error('Failed to update pin status:', error);
      // Revert the pin state on error
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
        checked_items_collapsed: !checkedItemsCollapsed,
        items: note.note_type === 'todo' ? items.map((item, idx) => ({
          text: item.text,
          position: idx,
          completed: item.completed,
          indent_level: item.indentLevel,
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onSave(); // Refresh the notes list to show updated archive status
    } catch (error) {
      console.error('Failed to update archive status:', error);
      // Revert the archive state on error
      setArchived(!newArchivedState);
    }
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
        })) : undefined,
      };
      await notes.update(note.id, updateData);
      onRefresh?.(); // Refresh the notes list to reflect the changes
    } catch (error) {
      console.error('Failed to update collapse state:', error);
      // Revert the state on error
      setCheckedItemsCollapsed(checkedItemsCollapsed);
    }
  };

  const hasUnsavedChanges = () => {
    if (note) {
      return (
        title !== note.title ||
        content !== note.content ||
        color !== note.color ||
        pinned !== note.pinned ||
        archived !== note.archived
      );
    } else {
      return (
        title.trim() !== '' ||
        content.trim() !== '' ||
        (noteType === 'todo' && items.some(item => item.text.trim() !== ''))
      );
    }
  };

  const handleCloseRequest = async () => {
    if (hasUnsavedChanges()) {
      // Auto-save before closing if there are unsaved changes
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
                      <ShareIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                    </button>
                  )}
                </>
              )}
              <button
                aria-label={t('import.close')}
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
                className="ml-2 text-red-500 hover:text-red-700"
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
              }}
            />

            {/* Content based on type */}
            {noteType === 'text' ? (
              <textarea
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
                          onIndentChange={indentTodoItem}
                          inputRef={(el) => {
                            if (el) itemInputRefs.current.set(item.id, el);
                            else itemInputRefs.current.delete(item.id);
                          }}
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
                            index={index + uncompletedItems.length} // Adjust index for completed items
                            item={item}
                            onUpdateTodoItem={(idx, field, value) => updateTodoItem(idx, field, value)}
                            onRemoveTodoItem={removeTodoItem}
                            isCompleted={true}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Labels row: badges + add button with popover */}
            {note && (
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
                    className="w-6 h-6 rounded-full border border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                    title={t('labels.addLabels')}
                    aria-label={t('labels.addLabels')}
                  >
                    <PlusIcon className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                  </button>
                  {showLabelPicker && (
                    <LabelPicker note={{...note, labels: noteLabels}} onRefresh={onRefresh} onNoteUpdate={(n) => setNoteLabels(n.labels ?? [])} onError={showError} onClose={() => setShowLabelPicker(false)} />
                  )}
                </div>
              </div>
            )}

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
                />
              ))}
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
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center p-4 border-t border-gray-200 dark:border-slate-600">
            {note && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('note.lastEdited', { date: new Date(note.updated_at).toLocaleString(i18n.resolvedLanguage) })}
              </p>
            )}
            <div className="flex items-center ml-auto">
              {loading && (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                  <span>{t('note.saving')}</span>
                </div>
              )}
            </div>
          </div>
        </DialogPanel>
      </div>
      </Dialog>

    </>
  );
}