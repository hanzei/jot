import { useState, useEffect, useCallback } from 'react';
import { PlusIcon, MagnifyingGlassIcon, UserCircleIcon } from '@heroicons/react/24/outline';
import { notes } from '@/utils/api';
import { removeToken, getUser, isAdmin } from '@/utils/auth';
import { Note } from '@/types';
import { Link } from 'react-router-dom';
import NoteCard from '@/components/NoteCard';
import NoteModal from '@/components/NoteModal';
import ShareModal from '@/components/ShareModal';

interface DashboardProps {
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const [notesList, setNotesList] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [sharingNote, setSharingNote] = useState<Note | null>(null);
  const user = getUser();

  const loadNotes = useCallback(async () => {
    try {
      const notesData = await notes.getAll(showArchived, searchQuery);
      setNotesList(notesData);
    } catch (error) {
      console.error('Failed to load notes:', error);
    } finally {
      setLoading(false);
    }
  }, [showArchived, searchQuery]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleLogout = () => {
    removeToken();
    onLogout();
  };

  const handleCreateNote = () => {
    setEditingNote(null);
    setIsModalOpen(true);
  };

  const handleEditNote = (note: Note) => {
    setEditingNote(note);
    setIsModalOpen(true);
  };

  const handleNoteUpdate = () => {
    loadNotes();
    setIsModalOpen(false);
    setEditingNote(null);
  };

  const handleDeleteNote = async (noteId: number) => {
    try {
      await notes.delete(noteId);
      loadNotes();
    } catch (error) {
      console.error('Failed to delete note:', error);
    }
  };

  const handleShareNote = (note: Note) => {
    setSharingNote(note);
    setIsShareModalOpen(true);
  };

  const handleShareModalClose = () => {
    setIsShareModalOpen(false);
    setSharingNote(null);
    loadNotes(); // Refresh notes to show updated sharing status
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <h1 className="text-2xl font-bold text-gray-900">Keep</h1>
              <div className="hidden sm:flex space-x-4">
                <button
                  onClick={() => setShowArchived(false)}
                  className={`px-3 py-1 rounded-md text-sm font-medium ${
                    !showArchived
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Notes
                </button>
                <button
                  onClick={() => setShowArchived(true)}
                  className={`px-3 py-1 rounded-md text-sm font-medium ${
                    showArchived
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Archive
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="flex-1 max-w-lg mx-4">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search notes..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {/* User menu */}
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2 text-sm text-gray-600">
                <UserCircleIcon className="h-5 w-5" />
                <span>{user?.email}</span>
              </div>
              {isAdmin() && (
                <Link
                  to="/admin"
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  Admin
                </Link>
              )}
              <button
                onClick={handleLogout}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Create note button */}
        <div className="mb-8">
          <button
            onClick={handleCreateNote}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <PlusIcon className="h-5 w-5 mr-2" />
            New Note
          </button>
        </div>

        {/* Notes grid */}
        {!notesList || notesList.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-500 text-lg">
              {showArchived ? 'No archived notes' : 'No notes yet'}
            </div>
            <div className="text-gray-400 text-sm mt-2">
              {!showArchived && 'Click "New Note" to create your first note'}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {notesList.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                onEdit={handleEditNote}
                onDelete={handleDeleteNote}
                onShare={handleShareNote}
                currentUserId={user?.id}
              />
            ))}
          </div>
        )}
      </main>

      {/* Note modal */}
      {isModalOpen && (
        <NoteModal
          note={editingNote}
          onClose={() => setIsModalOpen(false)}
          onSave={handleNoteUpdate}
        />
      )}

      {/* Share modal */}
      {isShareModalOpen && (
        <ShareModal
          note={sharingNote}
          isOpen={isShareModalOpen}
          onClose={handleShareModalClose}
        />
      )}
    </div>
  );
}