import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PlusIcon, DocumentTextIcon, ArchiveBoxIcon, TrashIcon, ClipboardDocumentCheckIcon, ArrowsUpDownIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { notes, auth, labels as labelsApi, users as usersApi, isAxiosError } from '@/utils/api';
import { removeUser, getUser, getSettings, setSettings, isAdmin } from '@/utils/auth';
import type { Note, Label, User, SSEEvent, NoteSort } from '@jot/shared';
import { useSSE } from '@/utils/useSSE';
import { useSearchParams, useParams } from 'react-router';
import AppLayout from '@/components/AppLayout';
import SearchBar from '@/components/SearchBar';
import SortableNoteCard from '@/components/SortableNoteCard';
import NoteModal from '@/components/NoteModal';
import ShareModal from '@/components/ShareModal';
import SidebarLabels from '@/components/SidebarLabels';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { isAnyModalDialogOpen, isEditableElementFocused, isOverlayControlFocused } from '@/utils/keyboardShortcuts';
import { NOTE_SORT_OPTIONS, normalizeNoteSort, sortNotesForDisplay } from '@/utils/noteSort';
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

const SEARCH_DEBOUNCE_MS = 300;

export default function Dashboard({ onLogout }: DashboardProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { noteId: noteIdParam } = useParams<{ noteId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notesList, setNotesList] = useState<Note[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>(() => normalizeNoteSort(getSettings()?.note_sort));
  const [loading, setLoading] = useState(true);
  const [trashCount, setTrashCount] = useState(0);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);
  const initialSearchQuery = searchParams.get('search') ?? '';
  const [searchQuery, setSearchQueryState] = useState(initialSearchQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialSearchQuery);
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openNoteIdRef = useRef<string | null>(null);
  const returnPathRef = useRef('/');
  const noteSortUpdateRequestIdRef = useRef(0);
  const loadNotesRequestIdRef = useRef(0);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Sync local state from URL when navigating via links (e.g., logo click).
  // Label takes precedence over view — if both are present, ignore view.
  useEffect(() => {
    const label = searchParams.get('label');
    const nextSearch = searchParams.get('search') ?? '';
    setSearchQueryState(nextSearch);
    // URL-driven navigation should update both states immediately.
    setDebouncedSearchQuery(nextSearch);
    setShowArchived(!label && searchParams.get('view') === 'archive');
    setShowBin(!label && searchParams.get('view') === 'bin');
    setShowMyTodo(!label && searchParams.get('view') === 'my-todo');
    setSelectedLabelId(label);
  }, [searchParams]);

  useEffect(() => {
    if (!showBin) {
      setShowEmptyTrashConfirm(false);
    }
  }, [showBin]);

  useEffect(() => {
    if (searchQuery === debouncedSearchQuery) {
      return;
    }

    if (!searchQuery) {
      setDebouncedSearchQuery('');
      return;
    }

    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [searchQuery, debouncedSearchQuery]);

  useEffect(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (debouncedSearchQuery) {
        next.set('search', debouncedSearchQuery);
      } else {
        next.delete('search');
      }

      return next.toString() === prev.toString() ? prev : next;
    });
  }, [debouncedSearchQuery, setSearchParams]);

  const setSearchQuery = (query: string) => {
    setSearchQueryState(query);
    if (!query) {
      setDebouncedSearchQuery('');
    }
  };

  const handleViewChange = useCallback((view: 'notes' | 'archive' | 'bin' | 'my-todo') => {
    setShowArchived(view === 'archive');
    setShowBin(view === 'bin');
    setShowMyTodo(view === 'my-todo');
    setSearchQueryState('');
    setDebouncedSearchQuery('');
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
  }, [setSearchParams]);

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
    const requestId = ++loadNotesRequestIdRef.current;

    try {
      let notesData: Note[] = [];
      let nextTrashCount = 0;

      if (showBin && debouncedSearchQuery) {
        const [loadedNotes, allTrashedNotes] = await Promise.all([
          notes.getAll(showArchived, debouncedSearchQuery, showBin, selectedLabelId ?? '', showMyTodo),
          notes.getAll(false, '', true),
        ]);
        notesData = loadedNotes;
        nextTrashCount = allTrashedNotes.length;
      } else {
        notesData = await notes.getAll(showArchived, debouncedSearchQuery, showBin, selectedLabelId ?? '', showMyTodo);
        if (showBin) {
          nextTrashCount = notesData.length;
        }
      }

      if (isMountedRef.current && requestId === loadNotesRequestIdRef.current) {
        setNotesList(notesData);
        setTrashCount(nextTrashCount);
      }
    } catch (error) {
      if (isMountedRef.current) console.error('Failed to load notes:', error);
    } finally {
      if (isMountedRef.current && requestId === loadNotesRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [showArchived, showBin, debouncedSearchQuery, selectedLabelId, showMyTodo]);

  useEffect(() => {
    loadLabels();
    loadUsers();
  }, [loadLabels, loadUsers]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const restoreReturnUrl = useCallback(() => {
    if (openNoteIdRef.current) {
      openNoteIdRef.current = null;
      const returnTo = returnPathRef.current;
      returnPathRef.current = '/';
      window.history.replaceState(null, '', returnTo);
    }
  }, []);

  const openNoteFromUrl = useCallback((noteId: string) => {
    openNoteIdRef.current = null;
    setEditingNote(null);
    setIsModalOpen(false);

    openNoteIdRef.current = noteId;
    returnPathRef.current = window.history.state?.returnTo ?? '/';
    notes.getById(noteId)
      .then(note => {
        if (isMountedRef.current && openNoteIdRef.current === noteId) {
          setEditingNote(note);
          setIsModalOpen(true);
        }
      })
      .catch(() => {
        if (openNoteIdRef.current === noteId) {
          openNoteIdRef.current = null;
        }
        if (isMountedRef.current) {
          window.history.replaceState(null, '', '/');
        }
      });
  }, []);

  useEffect(() => {
    if (!noteIdParam) {
      if (openNoteIdRef.current) {
        openNoteIdRef.current = null;
        setIsModalOpen(false);
        setEditingNote(null);
      }
      return;
    }

    if (openNoteIdRef.current === noteIdParam) {
      return;
    }

    openNoteFromUrl(noteIdParam);
  }, [noteIdParam, openNoteFromUrl]);

  useEffect(() => {
    const handlePopState = () => {
      const notePathMatch = window.location.pathname.match(/^\/notes\/(.+)$/);
      if (notePathMatch && !openNoteIdRef.current) {
        openNoteFromUrl(notePathMatch[1]);
      } else if (!notePathMatch && openNoteIdRef.current) {
        openNoteIdRef.current = null;
        setIsModalOpen(false);
        setEditingNote(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [openNoteFromUrl]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    const currentUserLostAccess =
      event.type === 'note_deleted' ||
      (event.type === 'note_unshared' && event.target_user_id === user?.id);

    if (currentUserLostAccess) {
      if (editingNote && event.note_id === editingNote.id) {
        setIsModalOpen(false);
        setEditingNote(null);
        restoreReturnUrl();
      }
      if (sharingNote && event.note_id === sharingNote.id) {
        setIsShareModalOpen(false);
        setSharingNote(null);
      }
    }

    loadNotes();
    if (event.type === 'note_created' || event.type === 'note_updated') {
      loadLabels();
    }
  }, [editingNote, sharingNote, loadNotes, loadLabels, user?.id, restoreReturnUrl]);

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

  const handleCreateNote = useCallback(() => {
    setEditingNote(null);
    setIsModalOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.defaultPrevented) {
        return;
      }

      if (loading) {
        return;
      }

      if (isEditableElementFocused() || isOverlayControlFocused() || isAnyModalDialogOpen()) {
        return;
      }

      const isFocusSearchShortcut =
        event.key.toLowerCase() === 'f' &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey;

      if (isFocusSearchShortcut) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const isNewNoteShortcut =
        event.key.toLowerCase() === 'n' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isNewNoteShortcut) {
        if (showBin) {
          return;
        }
        event.preventDefault();
        handleCreateNote();
        return;
      }

      const isArchiveShortcut =
        event.key.toLowerCase() === 'a' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isArchiveShortcut) {
        event.preventDefault();
        handleViewChange('archive');
        return;
      }

      const isNotesShortcut =
        event.key.toLowerCase() === 'd' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isNotesShortcut) {
        event.preventDefault();
        handleViewChange('notes');
        return;
      }

      const isMyTodoShortcut =
        event.key.toLowerCase() === 't' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isMyTodoShortcut) {
        event.preventDefault();
        handleViewChange('my-todo');
        return;
      }

      const isBinShortcut =
        event.key.toLowerCase() === 'b' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isBinShortcut) {
        event.preventDefault();
        handleViewChange('bin');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreateNote, handleViewChange, loading, showBin]);

  const handleEditNote = (note: Note) => {
    if (openNoteIdRef.current === note.id) return;
    if (!openNoteIdRef.current) {
      returnPathRef.current = window.location.pathname + window.location.search;
    }
    openNoteIdRef.current = note.id;
    setEditingNote(note);
    setIsModalOpen(true);
    window.history.pushState({ returnTo: returnPathRef.current }, '', `/notes/${note.id}`);
  };

  const handleNoteUpdate = () => {
    loadNotes();
    loadLabels();
    setIsModalOpen(false);
    setEditingNote(null);
    restoreReturnUrl();
  };

  const handleNoteRefresh = () => {
    loadNotes();
    loadLabels();
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId);
      loadNotes();
      showToast(t('dashboard.noteDeleted'), 'success', {
        label: t('dashboard.undo'),
        onClick: () => handleRestoreNote(noteId),
      });
    } catch (error) {
      console.error('Failed to delete note:', error);
    }
  };

  const handleRestoreNote = async (noteId: string) => {
    try {
      await notes.restore(noteId);
      loadNotes();
      showToast(t('dashboard.noteRestored'));
    } catch (error) {
      console.error('Failed to restore note:', error);
    }
  };

  const handlePermanentlyDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId, { permanent: true });
      loadNotes();
      showToast(t('dashboard.noteDeletedForever'));
    } catch (error) {
      console.error('Failed to permanently delete note:', error);
    }
  };

  const handleEmptyTrash = async () => {
    setIsEmptyingTrash(true);
    try {
      await notes.emptyTrash();
      if (isMountedRef.current) {
        setNotesList([]);
        setTrashCount(0);
      }
      setShowEmptyTrashConfirm(false);
      showToast(t('dashboard.trashEmptied'));
      void loadNotes();
    } catch (error) {
      console.error('Failed to empty trash:', error);
      showToast(t('dashboard.emptyTrashFailed'), 'error');
    } finally {
      setIsEmptyingTrash(false);
    }
  };

  const handleDuplicateNote = useCallback(async (noteId: string) => {
    try {
      await notes.duplicate(noteId);
      await Promise.all([loadNotes(), loadLabels()]);
      showToast(t('dashboard.noteDuplicated'), 'success');
    } catch (error) {
      console.error('Failed to duplicate note:', error);
      throw error;
    }
  }, [loadLabels, loadNotes, showToast, t]);

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
    setDebouncedSearchQuery('');
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

  const rollbackNoteSortCache = (failedSort: NoteSort, previousSettings: ReturnType<typeof getSettings>): boolean => {
    const cachedSettings = getSettings();
    if (cachedSettings?.note_sort !== failedSort) {
      return false;
    }

    if (previousSettings) {
      setSettings(previousSettings);
    } else {
      localStorage.removeItem('settings');
    }

    return true;
  };

  const handleNoteSortChange = useCallback(async (nextSort: typeof NOTE_SORT_OPTIONS[number]) => {
    if (nextSort === noteSort) {
      return;
    }

    const previousSort = noteSort;
    const previousSettings = getSettings();
    const requestID = ++noteSortUpdateRequestIdRef.current;

    setNoteSort(nextSort);
    if (previousSettings) {
      setSettings({ ...previousSettings, note_sort: nextSort });
    }

    try {
      const { settings: updatedSettings } = await usersApi.updateMe({ note_sort: nextSort });
      if (!isMountedRef.current || requestID !== noteSortUpdateRequestIdRef.current) {
        return;
      }
      if (updatedSettings) {
        setSettings(updatedSettings);
      }
    } catch (error) {
      console.error('Failed to update note sort:', error);

      const restoredSettings = rollbackNoteSortCache(nextSort, previousSettings);

      if (!isMountedRef.current || requestID !== noteSortUpdateRequestIdRef.current) {
        return;
      }

      setNoteSort(previousSort);
      if (!restoredSettings && previousSettings) {
        setSettings(previousSettings);
      }
    }
  }, [noteSort]);

  const handleRenameLabel = useCallback(async (label: Label, newName: string): Promise<boolean> => {
    try {
      await labelsApi.rename(label.id, newName);
      await Promise.all([loadLabels(), loadNotes()]);
      showToast(t('labels.renameSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        showToast(msg || t('labels.renameError'), 'error');
      } else {
        showToast(t('labels.renameError'), 'error');
      }
      return false;
    }
  }, [loadLabels, loadNotes, showToast, t]);

  const handleDeleteLabel = useCallback(async (label: Label): Promise<boolean> => {
    try {
      await labelsApi.delete(label.id);
      await loadLabels();
      if (selectedLabelId === label.id) {
        handleViewChange('notes');
      } else {
        await loadNotes();
      }
      showToast(t('labels.deleteSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        showToast(msg || t('labels.deleteError'), 'error');
      } else {
        showToast(t('labels.deleteError'), 'error');
      }
      return false;
    }
  }, [handleViewChange, loadLabels, loadNotes, selectedLabelId, showToast, t]);

  const handleDragEnd = async (event: DragEndEvent) => {
    if (showArchived || showBin || showMyTodo || noteSort !== 'manual') {
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

  const { pinned: displayedPinned, other: displayedOther } = useMemo(
    () => sortNotesForDisplay(notesList, noteSort),
    [notesList, noteSort],
  );
  const dragReorderingDisabled = showArchived || showBin || showMyTodo || noteSort !== 'manual';
  const activeSortLabel = t(`dashboard.sortOption.${noteSort}`);

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
      title: t('dashboard.myTodoTooltip'),
    },
  ];

  const bottomNavigationTabs = [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('archive'),
      isActive: showArchived,
    },
    {
      label: t('dashboard.tabBin'),
      title: t('dashboard.binTooltip'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      onClick: () => handleViewChange('bin'),
      isActive: showBin,
    },
  ];

  const searchBar = (
    <div className="w-full sm:max-w-7xl flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          inputRef={searchInputRef}
          stopEscapePropagation={true}
        />
      </div>
      <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
        <div className="w-full sm:w-56">
          <label htmlFor="dashboard-sort" className="sr-only">
            {t('dashboard.sortLabel')}
          </label>
          <div className="relative">
            <ArrowsUpDownIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <select
              id="dashboard-sort"
              data-testid="dashboard-sort-select"
              aria-label={t('dashboard.sortLabel')}
              value={noteSort}
              onChange={(event) => void handleNoteSortChange(event.target.value as NoteSort)}
              className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 py-2 pl-9 pr-10 text-sm text-gray-900 dark:text-white focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {NOTE_SORT_OPTIONS.map((sortOption) => (
                <option key={sortOption} value={sortOption}>
                  {t(`dashboard.sortOption.${sortOption}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {showBin && trashCount > 0 && (
          <button
            type="button"
            onClick={() => setShowEmptyTrashConfirm(true)}
            disabled={isEmptyingTrash}
            data-testid="empty-trash-button"
            className="inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60 dark:focus:ring-offset-slate-800"
          >
            {isEmptyingTrash ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t('dashboard.emptyTrash')}
              </span>
            ) : (
              t('dashboard.emptyTrash')
            )}
          </button>
        )}
      </div>
    </div>
  );

  const sidebarChildren = (
    <SidebarLabels
      labels={labelsList}
      selectedLabelId={selectedLabelId}
      onSelect={(labelId) => handleLabelSelect(selectedLabelId === labelId ? null : labelId)}
      onRename={handleRenameLabel}
      onDelete={handleDeleteLabel}
    />
  );

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
            {showMyTodo && (
              <div className="mt-3 px-4 py-2 bg-blue-50 dark:bg-slate-800 border border-blue-100 dark:border-slate-700 rounded-lg text-sm text-blue-800 dark:text-slate-200">
                {t('dashboard.myTodoInfo')}
              </div>
            )}
          </div>
        )}

        {/* Archive info banner */}
        {showArchived && (
          <div className="mb-6 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-800 dark:text-blue-300">
            {t('dashboard.archiveInfo')}
          </div>
        )}

        {/* Bin info banner */}
        {showBin && (
          <div className="mb-6 px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm text-yellow-800 dark:text-yellow-300">
            {t('dashboard.binInfo')}
          </div>
        )}

        {/* Notes grid */}
        {noteSort !== 'manual' && (
          <div
            data-testid="manual-reorder-disabled-notice"
            className="mb-6 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-200"
          >
            <ArrowsUpDownIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <span className="font-medium">{t('dashboard.manualReorderDisabledTitle')}</span>{' '}
              <span>{t('dashboard.manualReorderDisabled', { sort: activeSortLabel })}</span>
            </div>
          </div>
        )}

        {displayedPinned.length === 0 && displayedOther.length === 0 ? (
          <div className="text-center py-12">
            <div className="mx-auto max-w-xl text-gray-500 dark:text-gray-400 text-lg whitespace-normal break-words">
              {debouncedSearchQuery
                ? t('dashboard.noSearchResults', { query: debouncedSearchQuery })
                : showBin ? t('dashboard.noBinnedNotes') : showArchived ? t('dashboard.noArchivedNotes') : showMyTodo ? t('dashboard.noMyTodoNotes') : t('dashboard.noNotesYet')}
            </div>
            {!showArchived && !showBin && !showMyTodo && !debouncedSearchQuery && (
              <div className="mt-4">
                <button
                  onClick={handleCreateNote}
                  className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-800 transition-colors"
                >
                  <PlusIcon className="h-5 w-5 mr-2" />
                  {t('dashboard.createFirstNoteCta')}
                </button>
              </div>
            )}
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
              {displayedPinned.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                    <svg className="h-4 w-4 text-blue-500 dark:text-blue-400 mr-2" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                    </svg>
                    {t('dashboard.pinned')}
                  </h2>
                  <SortableContext
                    items={displayedPinned.map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0">
                      {displayedPinned.map((note) => (
                        <SortableNoteCard
                          key={note.id}
                          note={note}
                          onEdit={handleEditNote}
                          onDelete={handleDeleteNote}
                          onDuplicate={handleDuplicateNote}
                          onShare={handleShareNote}
                          onRestore={handleRestoreNote}
                          onPermanentlyDelete={handlePermanentlyDeleteNote}
                          currentUserId={user?.id}
                          usersById={usersById}
                          disabled={dragReorderingDisabled}
                          inBin={showBin}
                          onRefresh={loadNotes}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>
              )}

              {/* Other notes section */}
              {displayedOther.length > 0 && (
                <div>
                  {displayedPinned.length > 0 && (
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                      {t('dashboard.otherNotes')}
                    </h2>
                  )}
                  <SortableContext
                    items={displayedOther.map(note => note.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0">
                      {displayedOther.map((note) => (
                        <SortableNoteCard
                          key={note.id}
                          note={note}
                          onEdit={handleEditNote}
                          onDelete={handleDeleteNote}
                          onDuplicate={handleDuplicateNote}
                          onShare={handleShareNote}
                          onRestore={handleRestoreNote}
                          onPermanentlyDelete={handlePermanentlyDeleteNote}
                          currentUserId={user?.id}
                          usersById={usersById}
                          disabled={dragReorderingDisabled}
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
        <ConfirmDialog
          open={showEmptyTrashConfirm}
          title={t('dashboard.emptyTrashConfirmTitle')}
          message={t('dashboard.emptyTrashConfirmMessage', { count: trashCount })}
          confirmLabel={t('dashboard.emptyTrash')}
          onConfirm={handleEmptyTrash}
          onCancel={() => {
            if (!isEmptyingTrash) {
              setShowEmptyTrashConfirm(false);
            }
          }}
        />
        {/* Note modal */}
        {isModalOpen && (
          <NoteModal
            note={editingNote}
            onClose={() => {
              setIsModalOpen(false);
              setEditingNote(null);
              restoreReturnUrl();
            }}
            onSave={handleNoteUpdate}
            onRefresh={handleNoteRefresh}
            onShare={handleShareNote}
            onDelete={handleDeleteNote}
            onDuplicate={handleDuplicateNote}
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
