import { useState, useEffect, useCallback } from 'react';
import { PlusIcon, MagnifyingGlassIcon, UserCircleIcon } from '@heroicons/react/24/outline';
import { notes } from '@/utils/api';
import { removeToken, getUser, isAdmin } from '@/utils/auth';
import { Note } from '@/types';
import { Link } from 'react-router-dom';
import SortableNoteCard from '@/components/SortableNoteCard';
import NoteModal from '@/components/NoteModal';
import ShareModal from '@/components/ShareModal';
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
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import {
  restrictToWindowEdges,
} from '@dnd-kit/modifiers';

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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

  const handleNoteRefresh = () => {
    loadNotes(); // Only refresh data, don't close modal
  };

  const handleDeleteNote = async (noteId: string) => {
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

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const activeNote = notesList.find(note => note.id === active.id);
    const overNote = notesList.find(note => note.id === over.id);

    if (!activeNote || !overNote) {
      return;
    }

    // Only allow reordering within the same group (pinned vs unpinned)
    if (activeNote.pinned !== overNote.pinned) {
      return;
    }

    // Filter notes by the same pinned status
    const sameGroupNotes = notesList.filter(note => note.pinned === activeNote.pinned);
    
    const oldIndex = sameGroupNotes.findIndex(note => note.id === active.id);
    const newIndex = sameGroupNotes.findIndex(note => note.id === over.id);

    if (oldIndex !== newIndex) {
      // Reorder the notes in the same group
      const reorderedNotes = arrayMove(sameGroupNotes, oldIndex, newIndex);
      
      // Update local state immediately for better UX
      const updatedNotesList = [...notesList];
      const pinnedNotes = updatedNotesList.filter(note => note.pinned);
      const unpinnedNotes = updatedNotesList.filter(note => !note.pinned);
      
      if (activeNote.pinned) {
        // Replace pinned notes with reordered ones
        setNotesList([...reorderedNotes, ...unpinnedNotes]);
      } else {
        // Replace unpinned notes with reordered ones
        setNotesList([...pinnedNotes, ...reorderedNotes]);
      }

      // Send the reorder request to the backend
      try {
        const noteIDs = reorderedNotes.map(note => note.id);
        await notes.reorder(noteIDs);
      } catch (error) {
        console.error('Failed to reorder notes:', error);
        // Reload notes to revert to server state on error
        loadNotes();
      }
    }
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
          {/* Mobile and Desktop Layout */}
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center py-4 space-y-3 sm:space-y-0">
            {/* Top row on mobile, left side on desktop */}
            <div className="flex items-center justify-between sm:justify-start">
              <div className="flex items-center space-x-2 sm:space-x-4">
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Jot</h1>
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

              {/* Mobile user menu */}
              <div className="flex items-center space-x-2 sm:hidden">
                <div className="flex items-center space-x-1 text-xs text-gray-600">
                  <UserCircleIcon className="h-4 w-4" />
                  <span className="max-w-16 truncate">{user?.username}</span>
                </div>
                {isAdmin() && (
                  <Link
                    to="/admin"
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Admin
                  </Link>
                )}
                <button
                  onClick={handleLogout}
                  className="text-xs text-gray-600 hover:text-gray-900"
                >
                  Logout
                </button>
              </div>
            </div>

            {/* Search - full width on mobile, constrained on desktop */}
            <div className="w-full sm:flex-1 sm:max-w-lg sm:mx-4">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search notes..."
                  className="w-full pl-9 sm:pl-10 pr-4 py-2 text-sm sm:text-base border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {/* Desktop user menu */}
            <div className="hidden sm:flex items-center space-x-4">
              <div className="flex items-center space-x-2 text-sm text-gray-600">
                <UserCircleIcon className="h-5 w-5" />
                <span>{user?.username}</span>
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
            
            {/* Mobile tabs */}
            <div className="flex sm:hidden space-x-4 justify-center">
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToWindowEdges]}
          >
            <div className="space-y-8">
              {/* Pinned notes section */}
              {notesList.some(note => note.pinned) && (
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <svg className="h-4 w-4 text-blue-500 mr-2" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                    </svg>
                    Pinned
                  </h2>
                  <SortableContext
                    items={notesList.filter(note => note.pinned).map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                      {notesList.filter(note => note.pinned).map((note) => (
                        <SortableNoteCard
                          key={note.id}
                          note={note}
                          onEdit={handleEditNote}
                          onDelete={handleDeleteNote}
                          onShare={handleShareNote}
                          currentUserId={user?.id}
                          disabled={showArchived}
                          onRefresh={loadNotes}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>
              )}

              {/* Other notes section */}
              {notesList.some(note => !note.pinned) && (
                <div>
                  {notesList.some(note => note.pinned) && (
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                      Other Notes
                    </h2>
                  )}
                  <SortableContext
                    items={notesList.filter(note => !note.pinned).map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                      {notesList.filter(note => !note.pinned).map((note) => (
                        <SortableNoteCard
                          key={note.id}
                          note={note}
                          onEdit={handleEditNote}
                          onDelete={handleDeleteNote}
                          onShare={handleShareNote}
                          currentUserId={user?.id}
                          disabled={showArchived}
                          onRefresh={loadNotes}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>
              )}
            </div>
          </DndContext>
        )}
      </main>

      {/* Note modal */}
      {isModalOpen && (
        <NoteModal
          note={editingNote}
          onClose={() => setIsModalOpen(false)}
          onSave={handleNoteUpdate}
          onRefresh={handleNoteRefresh}
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