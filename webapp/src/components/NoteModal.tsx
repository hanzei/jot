import { useState, useEffect } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon, ChevronDownIcon, ArchiveBoxIcon, ArchiveBoxXMarkIcon } from '@heroicons/react/24/outline';
import { Dialog } from '@headlessui/react';
import { Note, NoteType, CreateNoteRequest, UpdateNoteRequest } from '@/types';
import { notes } from '@/utils/api';

// Extend Window type for timeout
declare global {
  interface Window {
    todoItemSaveTimeout?: number;
  }
}
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
}

interface TodoItem {
  text: string;
  completed: boolean;
  position: number;
  originalPosition?: number;
}

interface SortableItemProps {
  id: string;
  index: number;
  item: TodoItem;
  onUpdateTodoItem: (index: number, field: 'text' | 'completed', value: string | boolean) => Promise<void>;
  onRemoveTodoItem: (index: number) => void;
  isCompleted?: boolean;
}

function SortableItem({ id, index, item, onUpdateTodoItem, onRemoveTodoItem, isCompleted = false }: SortableItemProps) {
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
        placeholder="List item..."
        className={`flex-1 p-1 bg-transparent border-none outline-none placeholder-gray-500 ${
          isCompleted ? 'line-through text-gray-500' : ''
        }`}
        value={item.text}
        onChange={(e) => onUpdateTodoItem(index, 'text', e.target.value)}
      />
      <button
        onClick={() => onRemoveTodoItem(index)}
        className="p-1 text-gray-400 hover:text-gray-600"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function NoteModal({ note, onClose, onSave, onRefresh }: NoteModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState('#ffffff');
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Separate completed and uncompleted items
  const uncompletedItems = items.filter(item => !item.completed);
  const completedItems = items.filter(item => item.completed);

  const colors = [
    { value: '#ffffff', name: 'White', class: 'bg-white border-gray-300' },
    { value: '#fbbc04', name: 'Yellow', class: 'bg-yellow-100 border-yellow-300' },
    { value: '#34a853', name: 'Green', class: 'bg-green-100 border-green-300' },
    { value: '#4285f4', name: 'Blue', class: 'bg-blue-100 border-blue-300' },
    { value: '#ea4335', name: 'Red', class: 'bg-red-100 border-red-300' },
    { value: '#9aa0a6', name: 'Purple', class: 'bg-purple-100 border-purple-300' },
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
        note.items?.map((item) => ({
          text: item.text,
          completed: item.completed,
          position: item.position,
        })) || []
      );
    } else {
      setTitle('');
      setContent('');
      setNoteType('text');
      setColor('#ffffff');
      setPinned(false);
      setArchived(false);
      setItems([]);
    }
  }, [note]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // Only handle reordering of uncompleted items (completed items are disabled)
      const activeIndex = parseInt(active.id.toString().split('-').pop() || '0');
      const overIndex = parseInt(over.id.toString().split('-').pop() || '0');
      
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
      if (note) {
        try {
          const updateData: UpdateNoteRequest = {
            title,
            content,
            pinned,
            archived,
            color,
            checked_items_collapsed: checkedItemsCollapsed,
            items: newItems.map((item, idx) => ({ 
              text: item.text, 
              position: idx, 
              completed: item.completed 
            })),
          };
          await notes.update(note.id, updateData);
          onRefresh?.(); // Refresh the notes list to reflect the changes
        } catch (error) {
          console.error('Failed to auto-save note after reorder:', error);
        }
      }
    }
  };

  const addTodoItem = () => {
    setItems([...items, { text: '', completed: false, position: uncompletedItems.length }]);
  };

  const removeTodoItem = (index: number) => {
    // For uncompleted items, find by position in uncompletedItems array
    if (index < uncompletedItems.length) {
      const itemToRemove = uncompletedItems[index];
      const newItems = items.filter(item => item !== itemToRemove);
      
      // Renumber positions for remaining uncompleted items
      let uncompletedCount = 0;
      const updatedItems = newItems.map((item) => {
        if (!item.completed) {
          return { ...item, position: uncompletedCount++ };
        }
        return item;
      });
      
      setItems(updatedItems);
    } else {
      // For completed items, this is handled in the UI callback above
      const newItems = items.filter((_, i) => i !== index);
      const updatedItems = newItems.map((item, idx) => ({
        ...item,
        position: item.completed ? item.position : idx,
      }));
      setItems(updatedItems);
    }
  };

  const updateTodoItem = async (index: number, field: 'text' | 'completed', value: string | boolean) => {
    if (field === 'completed') {
      const isCompleting = value as boolean;
      
      if (isCompleting) {
        // Checking an item - move to completed section
        if (index < uncompletedItems.length) {
          const itemToComplete = uncompletedItems[index];
          const updatedItems = items.map(item => {
            if (item === itemToComplete) {
              return {
                ...item,
                completed: true,
                originalPosition: item.position, // Store original position
              };
            }
            return item;
          });
          setItems(updatedItems);
          
          // Auto-save if editing an existing note
          if (note) {
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
                  completed: item.completed 
                })),
              };
              await notes.update(note.id, updateData);
              onRefresh?.(); // Refresh the notes list to reflect the changes
            } catch (error) {
              console.error('Failed to auto-save note:', error);
            }
          }
        }
      } else {
        // Unchecking an item - restore to original position
        if (index < completedItems.length) {
          const itemToUncomplete = completedItems[index];
          const updatedItems = [...items];
          const itemIndex = items.findIndex(item => item === itemToUncomplete);
          
          if (itemIndex !== -1) {
            const item = updatedItems[itemIndex];
            let finalItems;
            
            if (item.originalPosition !== undefined) {
              // Remove item from its current position
              const itemToMove = { ...item, completed: false, originalPosition: undefined };
              updatedItems.splice(itemIndex, 1);
              
              // Find the correct insertion point among uncompleted items
              const currentUncompleted = updatedItems.filter(i => !i.completed);
              const insertionIndex = Math.min(item.originalPosition, currentUncompleted.length);
              
              // Insert the item back
              let insertedIndex = 0;
              finalItems = [];
              let uncompletedCount = 0;
              
              for (let i = 0; i < updatedItems.length; i++) {
                if (!updatedItems[i].completed) {
                  if (uncompletedCount === insertionIndex) {
                    finalItems.push({ ...itemToMove, position: uncompletedCount });
                    uncompletedCount++;
                    insertedIndex = finalItems.length - 1;
                  }
                  finalItems.push({ ...updatedItems[i], position: uncompletedCount });
                  uncompletedCount++;
                } else {
                  finalItems.push(updatedItems[i]);
                }
              }
              
              // If we haven't inserted yet (inserting at the end)
              if (insertedIndex === 0 && !finalItems.some(item => item === itemToMove)) {
                finalItems.push({ ...itemToMove, position: uncompletedCount });
              }
            } else {
              // Fallback: just uncheck and add to end of uncompleted items
              updatedItems[itemIndex] = {
                ...item,
                completed: false,
                position: uncompletedItems.length,
              };
              finalItems = updatedItems;
            }
            
            setItems(finalItems);
            
            // Auto-save if editing an existing note
            if (note) {
              try {
                const updateData: UpdateNoteRequest = {
                  title,
                  content,
                  pinned,
                  archived,
                  color,
                  checked_items_collapsed: checkedItemsCollapsed,
                  items: finalItems.map((item, idx) => ({ 
                    text: item.text, 
                    position: item.completed ? item.position : idx, 
                    completed: item.completed 
                  })),
                };
                await notes.update(note.id, updateData);
                onRefresh?.(); // Refresh the notes list to reflect the changes
              } catch (error) {
                console.error('Failed to auto-save note:', error);
              }
            }
          }
        }
      }
    } else {
      // Handle text updates
      let targetItem;
      if (index < uncompletedItems.length) {
        targetItem = uncompletedItems[index];
      } else {
        const completedIndex = index - uncompletedItems.length;
        if (completedIndex < completedItems.length) {
          targetItem = completedItems[completedIndex];
        }
      }
      
      if (targetItem) {
        const updatedItems = items.map(item => {
          if (item === targetItem) {
            if (field === 'text') {
              return { ...item, text: value as string };
            } else if (field === 'completed') {
              return { ...item, completed: value as boolean };
            }
          }
          return item;
        });
        setItems(updatedItems);
        
        // Auto-save text changes if editing an existing note (with debouncing via timeout)
        if (note && field === 'text') {
          // Clear previous timeout if exists
          if (window.todoItemSaveTimeout) {
            clearTimeout(window.todoItemSaveTimeout);
          }
          
          // Set new timeout to save after user stops typing
          window.todoItemSaveTimeout = setTimeout(async () => {
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
                  completed: item.completed 
                })),
              };
              await notes.update(note.id, updateData);
              onRefresh?.(); // Refresh the notes list to reflect the changes
            } catch (error) {
              console.error('Failed to auto-save note:', error);
            }
          }, 1000); // Save 1 second after user stops typing
        }
      }
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
            completed: item.completed 
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
          items: noteType === 'todo' ? items.map((item, idx) => ({ text: item.text, position: idx })) : undefined,
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
          completed: item.completed 
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
          completed: item.completed 
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
          completed: item.completed 
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
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      
      <div className="fixed inset-0 flex items-center justify-center p-2 sm:p-4 overflow-hidden">
        <Dialog.Panel 
          className={`mx-auto w-full max-w-md max-h-[90vh] overflow-hidden rounded-lg shadow-xl ${
            colors.find(c => c.value === color)?.class || 'bg-white border-gray-300'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {note ? 'Edit Note' : 'New Note'}
            </h2>
            <div className="flex items-center space-x-2">
              {note && (
                <>
                  <button
                    onClick={handlePinToggle}
                    className="p-1 rounded-full hover:bg-gray-200 transition-colors"
                    title={pinned ? 'Unpin note' : 'Pin note'}
                  >
                    {pinned ? (
                      <svg className="h-5 w-5 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                      </svg>
                    ) : (
                      <svg className="h-5 w-5 text-gray-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={handleArchiveToggle}
                    className="p-1 rounded-full hover:bg-gray-200 transition-colors"
                    title={archived ? 'Unarchive note' : 'Archive note'}
                  >
                    {archived ? (
                      <ArchiveBoxXMarkIcon className="h-5 w-5 text-blue-500" />
                    ) : (
                      <ArchiveBoxIcon className="h-5 w-5 text-gray-600" />
                    )}
                  </button>
                </>
              )}
              <button
                onClick={handleCloseRequest}
                className="p-1 rounded-full hover:bg-gray-200 transition-colors"
              >
                <XMarkIcon className="h-5 w-5 text-gray-600" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-2 sm:p-4 space-y-4 overflow-y-auto max-h-[calc(90vh-8rem)]">
            {/* Note type selector (only for new notes) */}
            {!note && (
              <div className="flex space-x-2">
                <button
                  onClick={() => setNoteType('text')}
                  className={`px-3 py-1 text-sm rounded-md ${
                    noteType === 'text'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Text
                </button>
                <button
                  onClick={() => setNoteType('todo')}
                  className={`px-3 py-1 text-sm rounded-md ${
                    noteType === 'todo'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Todo List
                </button>
              </div>
            )}

            {/* Title */}
            <input
              type="text"
              placeholder="Note title..."
              className="w-full p-2 text-lg font-medium bg-transparent border-none outline-none placeholder-gray-500"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            {/* Content based on type */}
            {noteType === 'text' ? (
              <textarea
                placeholder="Take a note..."
                rows={4}
                className="w-full p-2 bg-transparent border-none outline-none resize-none placeholder-gray-500 min-h-[6rem]"
                value={content}
                onChange={(e) => setContent(e.target.value)}
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
                      items={uncompletedItems.map((_, index) => `item-${index}`)}
                      strategy={verticalListSortingStrategy}
                    >
                      {uncompletedItems.map((item, index) => (
                        <SortableItem
                          key={`item-${index}`}
                          id={`item-${index}`}
                          index={index}
                          item={item}
                          onUpdateTodoItem={updateTodoItem}
                          onRemoveTodoItem={removeTodoItem}
                          isCompleted={false}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  <button
                    onClick={addTodoItem}
                    className="flex items-center space-x-2 text-sm text-gray-600 hover:text-gray-800 p-1"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span>Add item</span>
                  </button>
                </div>

                {/* Completed items section */}
                {completedItems.length > 0 && (
                  <div className="border-t border-gray-200 pt-3">
                    <button
                      onClick={handleToggleCompleted}
                      className="flex items-center space-x-2 text-sm text-gray-600 hover:text-gray-800 mb-2"
                    >
                      <ChevronDownIcon 
                        className={`h-4 w-4 transition-transform ${checkedItemsCollapsed ? '-rotate-90' : 'rotate-0'}`}
                      />
                      <span>Completed items ({completedItems.length})</span>
                    </button>
                    
                    {!checkedItemsCollapsed && (
                      <div className="space-y-2">
                        {completedItems.map((item, index) => (
                          <SortableItem
                            key={`completed-item-${index}`}
                            id={`completed-item-${index}`}
                            index={index}
                            item={item}
                            onUpdateTodoItem={(idx, field, value) => updateTodoItem(idx, field, value)}
                            onRemoveTodoItem={(idx) => {
                              // Find the actual index in the full items array
                              const actualIndex = items.findIndex(item => item === completedItems[idx]);
                              if (actualIndex !== -1) {
                                removeTodoItem(actualIndex);
                              }
                            }}
                            isCompleted={true}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center p-4 border-t border-gray-200">
            {note && (
              <p className="text-sm text-gray-500">
                Last edited: {new Date(note.updated_at).toLocaleString()}
              </p>
            )}
            <div className="flex items-center ml-auto">
              {loading && (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                  <span>Saving...</span>
                </div>
              )}
            </div>
          </div>
        </Dialog.Panel>
      </div>
      </Dialog>

    </>
  );
}