import { useState, useEffect, useCallback, useRef } from 'react';
import { PlusIcon, TagIcon, DocumentTextIcon, ArchiveBoxIcon, TrashIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { notes, auth, labels as labelsApi, users as usersApi } from '@/utils/api';
import { removeUser, getUser, isAdmin } from '@/utils/auth';
import type { Note, Label, User, SSEEvent } from '@jot/shared';
import { useSSE } from '@/utils/useSSE';
import { useSearchParams } from 'react-router';
import AppLayout from '@/components/AppLayout';
import SearchBar from '@/components/SearchBar';
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
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notesList, setNotesList] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQueryState] = useState(searchParams.get('search') ?? '');
  const initialLabel = searchParams.get('label');
  const [showArchived, setShowArchived] = useState(!initialLabel && searchParams.get('view') === 'archive');
  const [showBin, setShowBin] = useState(!initialLabel && searchParams.get('view') === 'bin');
  const [showMyTodo, setShowMyTodo] = useState(!initialLabel && searchParams.get('view') === 'my-todo');
  const [labelsList, setLabelsList] = useState<Label[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(initialLabel);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [sharingNote, setSharingNote] = useState<Note | null>(null);
  const [usersById, setUsersById] = useState<Map<string, User>>(new Map());
  const user = getUser();
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Sync local state from URL when navigating via links (e.g., logo click).
  // Label takes precedence over view — if both are present, ignore view.
  useEffect(() => {
    const label = searchParams.get('label');
    setSearchQueryState(searchParams.get('search') ?? '');
    setShowArchived(!label && searchParams.get('view') === 'archive');
    setShowBin(!label && searchParams.get('view') === 'bin');
    setShowMyTodo(!label && searchParams.get('view') === 'my-todo');
    setSelectedLabelId(label);
  }, [searchParams]);

  const setSearchQuery = (query: string) => {
    setSearchQueryState(query);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (query) {
        next.set('search', query);
      } else {
        next.delete('search');
      }
      return next;
    });
  };

  const handleViewChange = (view: 'notes' | 'archive' | 'bin' | 'my-todo') => {
    setShowArchived(view === 'archive');
    setShowBin(view === 'bin');
    setShowMyTodo(view === 'my-todo');
    setSearchQueryState('');
    setSelectedLabelId(null);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('search');
      next.delete('label');
      if (view === 'archive') {
        next.set('view', 'archive');
      } else if (view === 'bin') {
        next.set('view', 'bin');
      } else if (view === 'my-todo') {
        next.set('view', 'my-todo');
      } else {
        next.delete('view');
      }
      return next;
    });
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

  useEffect(() => {
    if (showBin) {
      document.title = t('pageTitle.bin');
    } else if (showArchived) {
      document.title = t('pageTitle.archive');
    } else if (showMyTodo) {
      document.title = t('pageTitle.myTodo');
    } else {
      document.title = t('pageTitle.notes');
    }
  }, [showArchived, showBin, showMyTodo, t]);

  const loadLabels = useCallback(async () => {
    try {
      const labelsData = await labelsApi.getAll();
      if (isMountedRef.current) setLabelsList(labelsData);
    } catch (error) {
      if (isMountedRef.current) console.error('Failed to load labels:', error);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const usersData = await usersApi.search();
      if (isMountedRef.current) {
        const map = new Map<string, User>();
        const currentUser = getUser();
        if (currentUser) map.set(currentUser.id, currentUser);
        for (const u of usersData) map.set(u.id, u);
        setUsersById(map);
      }
    } catch (error) {
      if (isMountedRef.current) console.error('Failed to load users:', error);
    }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      const notesData = await notes.getAll(showArchived, searchQuery, showBin, selectedLabelId ?? '', showMyTodo);
      if (isMountedRef.current) setNotesList(notesData);
    } catch (error) {
      if (isMountedRef.current) console.error('Failed to load notes:', error);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [showArchived, showBin, searchQuery, selectedLabelId, showMyTodo]);

  useEffect(() => {
    loadLabels();
    loadUsers();
  }, [loadLabels, loadUsers]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    const currentUserLostAccess =
      event.type === 'note_deleted' ||
      (event.type === 'note_unshared' && event.target_user_id === user?.id);

    if (currentUserLostAccess) {
      if (editingNote && event.note_id === editingNote.id) {
        setIsModalOpen(false);
        setEditingNote(null);
      }
      if (sharingNote && event.note_id === sharingNote.id) {
        setIsShareModalOpen(false);
        setSharingNote(null);
      }
    }

    loadNotes();
    if (event.type === 'note_updated') {
      loadLabels();
    }
  }, [editingNote, sharingNote, loadNotes, loadLabels, user?.id]);

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
    loadNotes();
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId);
      loadNotes();
    } catch (error) {
      console.error('Failed to delete note:', error);
    }
  };

  const handleRestoreNote = async (noteId: string) => {
    try {
      await notes.restore(noteId);
      loadNotes();
    } catch (error) {
      console.error('Failed to restore note:', error);
    }
  };

  const handlePermanentlyDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId, { permanent: true });
      loadNotes();
    } catch (error) {
      console.error('Failed to permanently delete note:', error);
    }
  };

  const handleShareNote = (note: Note) => {
    setSharingNote(note);
    setIsShareModalOpen(true);
  };

  const handleShareModalClose = () => {
    setIsShareModalOpen(false);
    setSharingNote(null);
    loadNotes();
  };

  const handleLabelSelect = (labelId: string | null) => {
    setSelectedLabelId(labelId);
    setShowArchived(false);
    setShowBin(false);
    setShowMyTodo(false);
    setSearchQueryState('');
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (labelId) {
        next.set('label', labelId);
      } else {
        next.delete('label');
      }
      next.delete('view');
      next.delete('search');
      return next;
    });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    if (showBin || showMyTodo) {
      return;
    }

    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const activeNote = notesList.find(note => note.id === active.id);
    const overNote = notesList.find(note => note.id === over.id);

    if (!activeNote || !overNote) {
      return;
    }

    if (activeNote.pinned !== overNote.pinned) {
      return;
    }

    const sameGroupNotes = notesList.filter(note => note.pinned === activeNote.pinned);

    const oldIndex = sameGroupNotes.findIndex(note => note.id === active.id);
    const newIndex = sameGroupNotes.findIndex(note => note.id === over.id);

    if (oldIndex !== newIndex) {
      const reorderedNotes = arrayMove(sameGroupNotes, oldIndex, newIndex);

      const updatedNotesList = [...notesList];
      const pinnedNotes = updatedNotesList.filter(note => note.pinned);
      const unpinnedNotes = updatedNotesList.filter(note => !note.pinned);

      if (activeNote.pinned) {
        setNotesList([...reorderedNotes, ...unpinnedNotes]);
      } else {
        setNotesList([...pinnedNotes, ...reorderedNotes]);
      }

      try {
        const noteIDs = reorderedNotes.map(note => note.id);
        await notes.reorder(noteIDs);
      } catch (error) {
        console.error('Failed to reorder notes:', error);
        loadNotes();
      }
    }
  };

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div data-testid="loading-spinner" className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const navigationTabs = [
    {
      label: t('dashboard.tabNotes'),
      icon: <DocumentTextIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('notes'),
      isActive: !showArchived && !showBin && !showMyTodo && !selectedLabelId,
    },
    {
      label: t('dashboard.tabMyTodo'),
      icon: <ClipboardDocumentCheckIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('my-todo'),
      isActive: showMyTodo,
    },
  ];

  const bottomNavigationTabs = [
    {
      label: t('dashboard.tabArchive'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('archive'),
      isActive: showArchived,
    },
    {
      label: t('dashboard.tabBin'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('bin'),
      isActive: showBin,
    },
  ];

  const searchBar = (
    <SearchBar
      value={searchQuery}
      onChange={setSearchQuery}
    />
  );

  const sidebarChildren = labelsList.length > 0 ? (
    <div className="px-2 pb-2">
      <ul className="space-y-0.5">
        {labelsList.map((label) => (
          <li key={label.id}>
            <button
              onClick={() => handleLabelSelect(selectedLabelId === label.id ? null : label.id)}
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm ${
                selectedLabelId === label.id
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700'
              }`}
            >
              <TagIcon className="h-4 w-4 shrink-0" />
              <span className="truncate min-w-0">{label.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : undefined;

  return (
    <AppLayout
      title="Jot"
      onLogout={handleLogout}
      isAdmin={isAdmin()}
      sidebarTabs={navigationTabs}
      sidebarBottomTabs={bottomNavigationTabs}
      sidebarChildren={sidebarChildren}
      searchBar={searchBar}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Create note button — hidden in bin view */}
        {!showBin && (
          <div className="mb-8">
            <button
              onClick={handleCreateNote}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              <PlusIcon className="h-5 w-5 mr-2" />
              {t('dashboard.newNote')}
            </button>
          </div>
        )}

        {/* Bin info banner */}
        {showBin && (
          <div className="mb-6 px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm text-yellow-800 dark:text-yellow-300">
            {t('dashboard.binInfo')}
          </div>
        )}

        {/* Notes grid */}
        {!notesList || notesList.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">
              {searchQuery
                ? t('dashboard.noSearchResults', { query: searchQuery })
                : showBin ? t('dashboard.noBinnedNotes') : showArchived ? t('dashboard.noArchivedNotes') : showMyTodo ? t('dashboard.noMyTodoNotes') : t('dashboard.noNotesYet')}
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-sm mt-2">
              {!showArchived && !showBin && !showMyTodo && !searchQuery && t('dashboard.createFirstNote')}
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
                    {t('dashboard.pinned')}
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
                          onRestore={handleRestoreNote}
                          onPermanentlyDelete={handlePermanentlyDeleteNote}
                          currentUserId={user?.id}
                          usersById={usersById}
                          disabled={showArchived || showBin || showMyTodo}
                          inBin={showBin}
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
                      {t('dashboard.otherNotes')}
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
                          onRestore={handleRestoreNote}
                          onPermanentlyDelete={handlePermanentlyDeleteNote}
                          currentUserId={user?.id}
                          usersById={usersById}
                          disabled={showArchived || showBin || showMyTodo}
                          inBin={showBin}
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
        {/* Note modal */}
        {isModalOpen && (
          <NoteModal
            note={editingNote}
            onClose={() => setIsModalOpen(false)}
            onSave={handleNoteUpdate}
            onRefresh={handleNoteRefresh}
            onShare={handleShareNote}
            onDelete={handleDeleteNote}
            isOwner={!editingNote || editingNote.user_id === user?.id}
            usersById={usersById}
            currentUserId={user?.id}
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
    </AppLayout>
  );
}
