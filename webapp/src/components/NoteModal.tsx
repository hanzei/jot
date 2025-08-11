import { useState, useEffect } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Dialog } from '@headlessui/react';
import { Note, NoteType, CreateNoteRequest, UpdateNoteRequest } from '@/types';
import { notes } from '@/utils/api';
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
}

interface SortableItemProps {
  id: string;
  index: number;
  item: { text: string; completed: boolean; position: number };
  onUpdateTodoItem: (index: number, field: 'text' | 'completed', value: string | boolean) => void;
  onRemoveTodoItem: (index: number) => void;
}

function SortableItem({ id, index, item, onUpdateTodoItem, onRemoveTodoItem }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center space-x-2 ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
    >
      <div
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 text-gray-400 hover:text-gray-600"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 2zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 7 14zm6-8a2 2 0 1 1-.001-4.001A2 2 0 0 1 13 6zm0 2a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 8zm0 6a2 2 0 1 1 .001 4.001A2 2 0 0 1 13 14z" />
        </svg>
      </div>
      <input
        type="checkbox"
        checked={item.completed}
        onChange={(e) => onUpdateTodoItem(index, 'completed', e.target.checked)}
        className="h-4 w-4 text-blue-600 rounded"
      />
      <input
        type="text"
        placeholder="List item..."
        className="flex-1 p-1 bg-transparent border-none outline-none placeholder-gray-500"
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

export default function NoteModal({ note, onClose, onSave }: NoteModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState('#ffffff');
  const [pinned, setPinned] = useState(false);
  const [items, setItems] = useState<{ text: string; completed: boolean; position: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
      setItems([]);
    }
  }, [note]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item, index) => `item-${index}` === active.id);
      const newIndex = items.findIndex((item, index) => `item-${index}` === over.id);

      const newItems = arrayMove(items, oldIndex, newIndex);
      
      const updatedItems = newItems.map((item, index) => ({
        ...item,
        position: index,
      }));
      
      setItems(updatedItems);
    }
  };

  const addTodoItem = () => {
    setItems([...items, { text: '', completed: false, position: items.length }]);
  };

  const removeTodoItem = (index: number) => {
    const newItems = items.filter((_, i) => i !== index);
    const updatedItems = newItems.map((item, idx) => ({
      ...item,
      position: idx,
    }));
    setItems(updatedItems);
  };

  const updateTodoItem = (index: number, field: 'text' | 'completed', value: string | boolean) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
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
          archived: note.archived,
          color,
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
        archived: note.archived,
        color,
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


  const hasUnsavedChanges = () => {
    if (note) {
      return (
        title !== note.title ||
        content !== note.content ||
        color !== note.color ||
        pinned !== note.pinned
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
              <div className="space-y-2">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={items.map((_, index) => `item-${index}`)}
                    strategy={verticalListSortingStrategy}
                  >
                    {items.map((item, index) => (
                      <SortableItem
                        key={`item-${index}`}
                        id={`item-${index}`}
                        index={index}
                        item={item}
                        onUpdateTodoItem={updateTodoItem}
                        onRemoveTodoItem={removeTodoItem}
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