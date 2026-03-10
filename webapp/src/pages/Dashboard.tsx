import { useState, useEffect, useCallback } from 'react';
import { PlusIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { notes, auth } from '@/utils/api';
import { removeUser, getUser, isAdmin } from '@/utils/auth';
import { Note } from '@/types';
import { useSSE, SSEEvent } from '@/utils/useSSE';
import { Link, useSearchParams } from 'react-router-dom';
import NavigationHeader from '@/components/NavigationHeader';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [notesList, setNotesList] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(searchParams.get('view') === 'archive');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [sharingNote, setSharingNote] = useState<Note | null>(null);
  const user = getUser();

  const handleViewChange = (archived: boolean) => {
    setShowArchived(archived);
    if (archived) {
      setSearchParams({ view: 'archive' });
    } else {
      setSearchParams({});
    }
  };

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

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    // Ignore events triggered by this user — local state is already up to date.
    if (event.source_user_id === user?.id) return;

    // If the open modal's note was deleted or unshared, close the modal.
    if (editingNote && event.note_id === editingNote.id) {
      if (event.type === 'note_deleted' || event.type === 'note_unshared') {
        setIsModalOpen(false);
        setEditingNote(null);
      }
    }

    loadNotes();
  }, [user?.id, editingNote, loadNotes]);

  useSSE({
    onEvent: handleSSEEvent,
    onConnected: loadNotes,
  });

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Continue with logout even if the server call fails
    }
    removeUser();
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div data-testid="loading-spinner" className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const navigationTabs = [
    {
      label: 'Notes',
      element: (
        <button
          onClick={() => handleViewChange(false)}
          aria-current={!showArchived ? 'page' : undefined}
          className={`px-3 py-1 rounded-md text-sm font-medium ${!showArchived
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
              : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
            }`}
        >
          Notes
        </button>
      ),
      isActive: !showArchived
    },
    {
      label: 'Archive',
      element: (
        <button
          onClick={() => handleViewChange(true)}
          aria-current={showArchived ? 'page' : undefined}
          className={`px-3 py-1 rounded-md text-sm font-medium ${showArchived
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
              : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
            }`}
        >
          Archive
        </button>
      ),
      isActive: showArchived
    },
    ...(isAdmin() ? [{
      label: 'Admin',
      element: (
        <Link
          to="/admin"
          className="px-3 py-1 rounded-md text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
        >
          Admin
        </Link>
      )
    }] : [])
  ];

  const searchBar = (
    <div className="w-full sm:flex-1 sm:max-w-lg sm:mx-4">
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
        <input
          type="text"
          placeholder="Search notes..."
          className="w-full pl-9 sm:pl-10 pr-4 py-2 text-sm sm:text-base border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
      <NavigationHeader
        title="Jot"
        onLogout={handleLogout}
        tabs={navigationTabs}
      >
        {searchBar}
      </NavigationHeader>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Create note button */}
        <div className="mb-8">
          <button
            onClick={handleCreateNote}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
          >
            <PlusIcon className="h-5 w-5 mr-2" />
            New Note
          </button>
        </div>

        {/* Notes grid */}
        {!notesList || notesList.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">
              {showArchived ? 'No archived notes' : 'No notes yet'}
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-sm mt-2">
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
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                    <svg className="h-4 w-4 text-blue-500 dark:text-blue-400 mr-2" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                    </svg>
                    Pinned
                  </h2>
                  <SortableContext
                    items={notesList.filter(note => note.pinned).map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0">
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
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                      Other Notes
                    </h2>
                  )}
                  <SortableContext
                    items={notesList.filter(note => !note.pinned).map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0">
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