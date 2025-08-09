import { useState, useEffect } from 'react';
import { XMarkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Dialog } from '@headlessui/react';
import { Note, NoteType, CreateNoteRequest, UpdateNoteRequest } from '@/types';
import { notes } from '@/utils/api';

interface NoteModalProps {
  note?: Note | null;
  onClose: () => void;
  onSave: () => void;
}

export default function NoteModal({ note, onClose, onSave }: NoteModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [color, setColor] = useState('#ffffff');
  const [items, setItems] = useState<{ text: string; completed: boolean; position: number }[]>([]);
  const [loading, setLoading] = useState(false);

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
      setItems([]);
    }
  }, [note]);

  const addTodoItem = () => {
    setItems([...items, { text: '', completed: false, position: items.length }]);
  };

  const removeTodoItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
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
          pinned: note.pinned,
          archived: note.archived,
          color,
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

  const canSave = title.trim() || content.trim() || (noteType === 'todo' && items.some(item => item.text.trim()));

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel 
          className={`mx-auto max-w-md w-full rounded-lg shadow-xl p-0 ${
            colors.find(c => c.value === color)?.class || 'bg-white border-gray-300'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {note ? 'Edit Note' : 'New Note'}
            </h2>
            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-gray-200 transition-colors"
            >
              <XMarkIcon className="h-5 w-5 text-gray-600" />
            </button>
          </div>

          {/* Content */}
          <div className="p-4 space-y-4">
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
                rows={6}
                className="w-full p-2 bg-transparent border-none outline-none resize-none placeholder-gray-500"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            ) : (
              <div className="space-y-2">
                {items.map((item, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={item.completed}
                      onChange={(e) => updateTodoItem(index, 'completed', e.target.checked)}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <input
                      type="text"
                      placeholder="List item..."
                      className="flex-1 p-1 bg-transparent border-none outline-none placeholder-gray-500"
                      value={item.text}
                      onChange={(e) => updateTodoItem(index, 'text', e.target.value)}
                    />
                    <button
                      onClick={() => removeTodoItem(index)}
                      className="p-1 text-gray-400 hover:text-gray-600"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                ))}
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
          <div className="flex justify-end space-x-2 p-4 border-t border-gray-200">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || loading}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}