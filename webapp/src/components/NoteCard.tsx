import { useState } from 'react';
import { 
  EllipsisVerticalIcon, 
  TrashIcon, 
  ArchiveBoxIcon,
  ArchiveBoxXMarkIcon,
  ShareIcon,
  UserIcon
} from '@heroicons/react/24/outline';
import { Menu } from '@headlessui/react';
import { Note } from '@/types';
import { notes } from '@/utils/api';

interface NoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onShare?: (note: Note) => void;
  currentUserId?: string;
}

export default function NoteCard({ note, onEdit, onDelete, onShare, currentUserId }: NoteCardProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  
  const isOwner = note.user_id === currentUserId;

  const getColorClass = (color: string) => {
    const colorMap: { [key: string]: string } = {
      '#ffffff': '',
      '#fbbc04': 'yellow',
      '#34a853': 'green',
      '#4285f4': 'blue',
      '#ea4335': 'red',
      '#9aa0a6': 'purple',
    };
    return colorMap[color] || '';
  };

  const handleToggleArchive = async () => {
    setIsUpdating(true);
    try {
      await notes.update(note.id, {
        title: note.title,
        content: note.content,
        pinned: note.pinned,
        archived: !note.archived,
        color: note.color,
        checked_items_collapsed: note.checked_items_collapsed,
      });
      // Refresh will be handled by parent component
      window.location.reload();
    } catch (error) {
      console.error('Failed to toggle archive:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleTogglePin = async () => {
    setIsUpdating(true);
    try {
      await notes.update(note.id, {
        title: note.title,
        content: note.content,
        pinned: !note.pinned,
        archived: note.archived,
        color: note.color,
        checked_items_collapsed: note.checked_items_collapsed,
      });
      window.location.reload();
    } catch (error) {
      console.error('Failed to toggle pin:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = () => {
    if (window.confirm('Are you sure you want to delete this note?')) {
      onDelete(note.id);
    }
  };

  return (
    <div 
      className={`note-card ${getColorClass(note.color)} p-4 relative group ${
        isUpdating ? 'opacity-50' : ''
      }`}
    >
      {/* Indicators */}
      <div className="absolute top-2 left-2 flex gap-1">
        {note.is_shared && (
          <div className="flex items-center bg-blue-100 rounded-full px-2 py-1">
            {isOwner ? (
              <ShareIcon className="h-3 w-3 text-blue-600" />
            ) : (
              <UserIcon className="h-3 w-3 text-green-600" />
            )}
            <span className="text-xs text-blue-600 ml-1">
              {isOwner ? 'Shared' : 'Shared with me'}
            </span>
          </div>
        )}
      </div>
      
      {note.pinned && (
        <div className="absolute top-2 right-8">
          <svg className="h-3 w-3 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
          </svg>
        </div>
      )}

      {/* Menu */}
      <Menu as="div" className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <Menu.Button className="p-1 rounded-full hover:bg-gray-200 transition-colors">
          <EllipsisVerticalIcon className="h-4 w-4 text-gray-600" />
        </Menu.Button>
        <Menu.Items className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none z-10">
          <div className="py-1">
            {isOwner && onShare && (
              <Menu.Item>
                {({ active }) => (
                  <button
                    onClick={() => onShare(note)}
                    className={`${
                      active ? 'bg-gray-100' : ''
                    } flex items-center w-full px-4 py-2 text-sm text-gray-700`}
                  >
                    <ShareIcon className="h-4 w-4 mr-2" />
                    Share
                  </button>
                )}
              </Menu.Item>
            )}
            <Menu.Item>
              {({ active }) => (
                <button
                  onClick={handleTogglePin}
                  className={`${
                    active ? 'bg-gray-100' : ''
                  } flex items-center w-full px-4 py-2 text-sm text-gray-700`}
                >
                  <svg className="h-4 w-4 mr-2" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                  </svg>
                  {note.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
            </Menu.Item>
            <Menu.Item>
              {({ active }) => (
                <button
                  onClick={handleToggleArchive}
                  className={`${
                    active ? 'bg-gray-100' : ''
                  } flex items-center w-full px-4 py-2 text-sm text-gray-700`}
                >
                  {note.archived ? (
                    <>
                      <ArchiveBoxXMarkIcon className="h-4 w-4 mr-2" />
                      Unarchive
                    </>
                  ) : (
                    <>
                      <ArchiveBoxIcon className="h-4 w-4 mr-2" />
                      Archive
                    </>
                  )}
                </button>
              )}
            </Menu.Item>
            {isOwner && (
              <Menu.Item>
                {({ active }) => (
                  <button
                    onClick={handleDelete}
                    className={`${
                      active ? 'bg-gray-100' : ''
                    } flex items-center w-full px-4 py-2 text-sm text-red-600`}
                  >
                    <TrashIcon className="h-4 w-4 mr-2" />
                    Delete
                  </button>
                )}
              </Menu.Item>
            )}
          </div>
        </Menu.Items>
      </Menu>

      {/* Content */}
      <div 
        onClick={() => onEdit(note)} 
        className={`cursor-pointer ${note.is_shared ? 'pt-8' : ''}`}
      >
        {note.title && (
          <h3 className="font-medium text-gray-900 mb-2 line-clamp-2">
            {note.title}
          </h3>
        )}
        
        {note.note_type === 'text' ? (
          <div className="text-sm text-gray-700 line-clamp-6 whitespace-pre-wrap">
            {note.content}
          </div>
        ) : (
          <div className="space-y-1">
            {(() => {
              const uncompletedItems = note.items?.filter(item => !item.completed) || [];
              const completedItems = note.items?.filter(item => item.completed) || [];
              
              return (
                <>
                  {uncompletedItems.map((item) => (
                    <div key={item.id} className="flex items-center text-sm">
                      <input
                        type="checkbox"
                        checked={item.completed}
                        readOnly
                        className="h-4 w-4 text-blue-600 rounded mr-2"
                      />
                      <span className="text-gray-700">
                        {item.text}
                      </span>
                    </div>
                  ))}
                  {completedItems.length > 0 && (
                    <div className="text-xs text-gray-500 mt-2">
                      +{completedItems.length} completed items
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}