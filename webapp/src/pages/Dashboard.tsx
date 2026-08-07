import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, FileText, Archive, Trash2, ClipboardCheck, ArrowUpDown, Search, X, Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { notes, users as usersApi } from '@/utils/api';
import { getUser, getSettings, setSettings } from '@/utils/auth';
import {
  UPLOAD_MAX_BYTES,
  NOTE_SORT_OPTIONS,
  normalizeNoteSort,
  sortNotesForDisplay,
  type Note,
  type NoteImage,
  type NoteType,
  type User,
  type SSEEvent,
  type NoteSort,
  type ConvertNoteTypeRequest,
} from '@jot/shared';
import { useSearchParams, useParams, useNavigate, useMatch } from 'react-router';
import PageContent from '@/components/PageContent';
import SearchBar from '@/components/SearchBar';
import AnimatedNoteGrid from '@/components/AnimatedNoteGrid';
import NoteModal from '@/components/NoteModal';
import ShareModal from '@/components/ShareModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { useAuthenticatedLayout } from '@/components/AuthenticatedLayout';
import { isAnyModalDialogOpen, isEditableElementFocused, isOverlayControlFocused } from '@/utils/keyboardShortcuts';
import { isSortWarningDismissed, dismissSortWarning } from '@/utils/sortWarningDismissed';
import { buildSharedContent } from '@/utils/sharedContent';
import type {
  DragEndEvent} from '@dnd-kit/core';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import {
  restrictToWindowEdges,
} from '@dnd-kit/modifiers';

const SEARCH_DEBOUNCE_MS = 300;
const isApplePlatform = () => typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform);

interface DashboardProps {
  // Server-configured upload cap (falls back to the shared default if the
  // parent hasn't fetched /config yet, or the route is used without it).
  uploadMaxBytes?: number;
}

export default function Dashboard({ uploadMaxBytes = UPLOAD_MAX_BYTES }: DashboardProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { noteId: noteIdParam } = useParams<{ noteId?: string }>();
  const isNewNoteRoute = !!useMatch('/new');
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    labels: labelsList,
    loadLabels,
    loadLabelCounts,
    registerLabelCallbacks,
    registerSSECallbacks,
    setSearchBar,
  } = useAuthenticatedLayout();
  const [notesList, setNotesList] = useState<Note[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>(() => normalizeNoteSort(getSettings()?.note_sort));
  const [sortWarningDismissed, setSortWarningDismissed] = useState<boolean>(() => isSortWarningDismissed(noteSort));
  const [loading, setLoading] = useState(true);
  const [trashCount, setTrashCount] = useState(0);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);
  const urlSearchQuery = searchParams.get('search') ?? '';
  const [searchQuery, setSearchQueryState] = useState(urlSearchQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(urlSearchQuery);
  // The URL is the single source of truth for which view is on screen, so these
  // are derived rather than mirrored into state — every action that changes the
  // view already writes it to the query string.
  // Label takes precedence over view: if both are present, ignore view.
  const selectedLabelId = searchParams.get('label');
  const activeView = selectedLabelId ? null : searchParams.get('view');
  const showArchived = activeView === 'archive';
  const showBin = activeView === 'bin';
  const showMyTasks = activeView === 'my-tasks';
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  // Prefill for a note created via the /new deep link (PWA shortcut or share
  // target) — undefined fields fall back to NoteModal's own defaults.
  const [newNoteDraft, setNewNoteDraft] = useState<{ type: NoteType; content: string } | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [sharingNote, setSharingNote] = useState<Note | null>(null);
  const [usersById, setUsersById] = useState<Map<string, User>>(new Map());
  // Whether each grid section still has cards rendered (live or animating out),
  // so the last card can finish its exit animation before the section unmounts.
  const [sectionActive, setSectionActive] = useState({ pinned: false, other: false, archived: false });
  const user = getUser();
  const isMountedRef = useRef(true);
  const selectedLabelIdRef = useRef<string | null>(selectedLabelId);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastFocusedElementRef = useRef<Element | null>(null);
  const openNoteIdRef = useRef<string | null>(null);
  const returnPathRef = useRef('/');
  const noteSortUpdateRequestIdRef = useRef(0);
  const loadNotesRequestIdRef = useRef(0);
  const editingNoteRefreshRequestIdRef = useRef(0);
  const newNoteHandledRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // The search box can't be derived from the URL — it leads it, and only the
  // debounced value is written back. So adopt the URL value whenever it changes
  // underneath us (logo click, back button, a link with ?search=). Adjusting
  // during render rather than in an effect avoids rendering one frame with the
  // stale query (react-hooks/set-state-in-effect).
  const [lastUrlSearchQuery, setLastUrlSearchQuery] = useState(urlSearchQuery);
  if (lastUrlSearchQuery !== urlSearchQuery) {
    setLastUrlSearchQuery(urlSearchQuery);
    setSearchQueryState(urlSearchQuery);
    // URL-driven navigation should update both states immediately.
    setDebouncedSearchQuery(urlSearchQuery);
  }

  // Leaving the bin cancels a pending empty-trash confirmation. The condition
  // is false again after the update, so this settles in a single re-render.
  if (!showBin && showEmptyTrashConfirm) {
    setShowEmptyTrashConfirm(false);
  }

  useEffect(() => {
    selectedLabelIdRef.current = selectedLabelId;
  }, [selectedLabelId]);

  // Every caller that clears `searchQuery` clears `debouncedSearchQuery` with
  // it, so an empty query never has to wait out the debounce here.
  useEffect(() => {
    if (searchQuery === debouncedSearchQuery) {
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

  const setSearchQuery = useCallback((query: string) => {
    setSearchQueryState(query);
    if (!query) {
      setDebouncedSearchQuery('');
    }
  }, []);

  const handleViewChange = useCallback((view: 'notes' | 'archive' | 'bin' | 'my-tasks') => {
    setSearchQueryState('');
    setDebouncedSearchQuery('');
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('search');
      next.delete('label');
      if (view === 'archive') {
        next.set('view', 'archive');
      } else if (view === 'bin') {
        next.set('view', 'bin');
      } else if (view === 'my-tasks') {
        next.set('view', 'my-tasks');
      } else {
        next.delete('view');
      }
      return next;
    });
  }, [setSearchParams]);

  const handleLabelClick = useCallback((labelId: string) => {
    setSearchQueryState('');
    setDebouncedSearchQuery('');
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('label', labelId);
      next.delete('view');
      next.delete('search');
      return next;
    });
  }, [setSearchParams]);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // The loaders below split fetching from committing: the `async` half only
  // awaits network work and the state updates live in `.then`/`.catch`
  // continuations, so an effect can call them without setting state
  // synchronously (react-hooks/set-state-in-effect).
  const loadUsers = useCallback(() => {
    return usersApi.search()
      .then(usersData => {
        if (!isMountedRef.current) return;
        const map = new Map<string, User>();
        const currentUser = getUser();
        if (currentUser) map.set(currentUser.id, currentUser);
        for (const u of usersData) map.set(u.id, u);
        setUsersById(map);
      })
      .catch(error => {
        if (isMountedRef.current) console.error('Failed to load users:', error);
      });
  }, []);

  const loadNotes = useCallback(() => {
    const requestId = ++loadNotesRequestIdRef.current;

    const fetchNotes = async () => {
      let notesData: Note[] = [];
      let nextTrashCount = 0;

      // When searching or filtering by label outside the bin/archive views,
      // also pull in archived matches so they surface in a separate "Archived"
      // section in the UI. My Tasks already returns archived notes, so it
      // needs no extra request.
      const includeArchivedSplit =
        !showBin && !showArchived && !showMyTasks &&
        (!!debouncedSearchQuery || !!selectedLabelId);

      if (showBin && debouncedSearchQuery) {
        const [loadedNotes, allTrashedNotes] = await Promise.all([
          notes.getAll(showArchived, debouncedSearchQuery, showBin, selectedLabelId ?? '', showMyTasks),
          notes.getAll(false, '', true),
        ]);
        notesData = loadedNotes;
        nextTrashCount = allTrashedNotes.length;
      } else if (includeArchivedSplit) {
        const [activeMatches, archivedMatches] = await Promise.all([
          notes.getAll(false, debouncedSearchQuery, false, selectedLabelId ?? '', false),
          notes.getAll(true, debouncedSearchQuery, false, selectedLabelId ?? '', false),
        ]);
        notesData = [...activeMatches, ...archivedMatches];
      } else {
        notesData = await notes.getAll(showArchived, debouncedSearchQuery, showBin, selectedLabelId ?? '', showMyTasks);
        if (showBin) {
          nextTrashCount = notesData.length;
        }
      }

      return { notesData, nextTrashCount };
    };

    return fetchNotes()
      .then(({ notesData, nextTrashCount }) => {
        if (isMountedRef.current && requestId === loadNotesRequestIdRef.current) {
          setNotesList(notesData);
          setTrashCount(nextTrashCount);
        }
      })
      .catch(error => {
        // Same request-id guard as the success path: a superseded request that
        // fails must not toast over notes a newer request already rendered.
        if (isMountedRef.current && requestId === loadNotesRequestIdRef.current) {
          console.error('Failed to load notes:', error);
          showToast(t('dashboard.failedLoadNotes'), 'error');
        }
      })
      .finally(() => {
        if (isMountedRef.current && requestId === loadNotesRequestIdRef.current) {
          setLoading(false);
        }
      });
  }, [showArchived, showBin, debouncedSearchQuery, selectedLabelId, showMyTasks, showToast, t]);

  // Register Dashboard-specific label callbacks so the layout can notify us
  // after a label rename (note cards need refresh) or delete (may clear selection).
  useEffect(() => {
    registerLabelCallbacks({
      onRenameSuccess: () => { void loadNotes(); },
      onDeleteSuccess: (label) => {
        if (selectedLabelIdRef.current === label.id) {
          handleViewChange('notes');
          return;
        }
        void loadNotes();
      },
    });
  }, [registerLabelCallbacks, loadNotes, handleViewChange]);

  useEffect(() => {
    const editingNoteTitle = editingNote?.note_type === 'list' ? editingNote.title : undefined;
    if (isModalOpen && editingNoteTitle) {
      document.title = t('pageTitle.note', { title: editingNoteTitle });
    } else if (showBin) {
      document.title = t('pageTitle.bin');
    } else if (showArchived) {
      document.title = t('pageTitle.archive');
    } else if (showMyTasks) {
      document.title = t('pageTitle.myTasks');
    } else if (selectedLabelId) {
      const activeLabelName = labelsList.find((label) => label.id === selectedLabelId)?.name ?? '';
      document.title = activeLabelName ? t('pageTitle.label', { name: activeLabelName }) : t('pageTitle.notes');
    } else {
      document.title = t('pageTitle.notes');
    }
  }, [editingNote, isModalOpen, labelsList, selectedLabelId, showArchived, showBin, showMyTasks, t]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const restoreReturnUrl = useCallback(() => {
    if (isNewNoteRoute) {
      // /new is a one-shot deep link (PWA shortcut or share target); once its
      // modal closes there's nothing to "return" to but the dashboard.
      newNoteHandledRef.current = false;
      setNewNoteDraft(null);
      navigate('/', { replace: true });
      return;
    }
    if (openNoteIdRef.current) {
      openNoteIdRef.current = null;
      const returnTo = returnPathRef.current;
      returnPathRef.current = '/';
      navigate(returnTo, { replace: true });
    }
  }, [navigate, isNewNoteRoute]);

  // Deep link entry point: /new?type=text|list opens the create-note modal
  // straight away, optionally prefilled from a Web Share Target payload
  // (title/text/url). Runs once per visit to /new (newNoteHandledRef guards
  // against re-triggering while the route stays matched, e.g. searchParams
  // changing for an unrelated reason).
  useEffect(() => {
    if (!isNewNoteRoute) {
      newNoteHandledRef.current = false;
      return;
    }
    if (newNoteHandledRef.current) {
      return;
    }
    newNoteHandledRef.current = true;

    const type: NoteType = searchParams.get('type') === 'list' ? 'list' : 'text';
    const content = buildSharedContent({
      title: searchParams.get('title'),
      text: searchParams.get('text'),
      url: searchParams.get('url'),
    });

    lastFocusedElementRef.current = document.activeElement;
    setEditingNote(null);
    setNewNoteDraft({ type, content });
    setIsModalOpen(true);
  }, [isNewNoteRoute, searchParams]);

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
        openNoteFromUrl(notePathMatch[1]!);
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
    if (event.type === 'profile_icon_updated') {
      const updatedUser = event.data.user;
      setUsersById(prev => {
        const next = new Map(prev);
        next.set(updatedUser.id, updatedUser);
        return next;
      });
      return;
    }
    if (event.type === 'labels_changed') {
      void (async () => {
        const [updatedLabels] = await Promise.all([loadLabels(), loadLabelCounts()]);
        const currentSelectedLabelId = selectedLabelIdRef.current;
        if (!isMountedRef.current || !currentSelectedLabelId || !updatedLabels) {
          return;
        }

        const selectedLabelStillExists = updatedLabels.some((label) => label.id === currentSelectedLabelId);
        if (selectedLabelStillExists) {
          return;
        }

        setSearchParams((prev) => {
          if (!prev.has('label')) {
            return prev;
          }
          const next = new URLSearchParams(prev);
          next.delete('label');
          return next;
        });
      })();
      return;
    }

    if (event.type === 'note_image_added' || event.type === 'note_image_removed') {
      const { note_id: imageNoteId } = event.data;
      const patchImages = (imgs: NoteImage[] | undefined): NoteImage[] | undefined => {
        if (event.type === 'note_image_added') {
          const image = event.data.image;
          if (!image || imgs?.some(img => img.id === image.id)) return imgs;
          return [...(imgs ?? []), image];
        }
        const imageId = event.data.image_id;
        if (!imageId || !imgs) return imgs;
        return imgs.filter(img => img.id !== imageId);
      };

      setEditingNote(prev => (prev && prev.id === imageNoteId ? { ...prev, images: patchImages(prev.images) } : prev));
      setNotesList(prev => prev.map(n => (n.id === imageNoteId ? { ...n, images: patchImages(n.images) } : n)));
      // Also reconcile via a full reload, same as every other event type below —
      // this is the fallback for a note whose note_created hasn't loaded yet, so
      // an image added just after creation isn't silently dropped from the list.
      loadNotes();
      return;
    }

    const { note_id } = event.data;
    const currentUserLostAccess =
      event.type === 'note_deleted' ||
      (event.type === 'note_unshared' && event.target_user_id === user?.id);

    if (currentUserLostAccess) {
      if (editingNote && note_id === editingNote.id) {
        setIsModalOpen(false);
        setEditingNote(null);
        restoreReturnUrl();
      }
      if (sharingNote && note_id === sharingNote.id) {
        setIsShareModalOpen(false);
        setSharingNote(null);
      }
    }

    if (editingNote && note_id === editingNote.id) {
      if ((event.type === 'note_updated' || event.type === 'note_shared') && event.data.note?.id === note_id) {
        setEditingNote(event.data.note);
      } else if (event.type === 'note_unshared' && !currentUserLostAccess) {
        notes.getById(note_id).then(refreshed => {
          setEditingNote(prev => prev?.id === note_id ? refreshed : prev);
        }).catch(() => {});
      }
    }

    loadNotes();
    loadLabelCounts();
    if (event.type === 'note_created' || event.type === 'note_updated') {
      loadLabels();
    }
  }, [editingNote, sharingNote, loadNotes, loadLabels, loadLabelCounts, setSearchParams, user?.id, restoreReturnUrl]);

  useEffect(() => {
    registerSSECallbacks({ onEvent: handleSSEEvent, onConnected: loadNotes });
    return () => registerSSECallbacks({});
  }, [registerSSECallbacks, handleSSEEvent, loadNotes]);

  const handleCreateNote = useCallback(() => {
    lastFocusedElementRef.current = document.activeElement;
    setEditingNote(null);
    setNewNoteDraft(null);
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

      // Arrow key navigation between note cards (runs before other guards)
      const isArrowKey = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' || event.key === 'ArrowDown';
      if (isArrowKey && document.activeElement?.getAttribute('data-note-card') === 'true') {
        event.preventDefault();
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-note-card="true"]'));
        const currentCard = document.activeElement as HTMLElement;
        const currentIndex = cards.indexOf(currentCard);
        if (event.key === 'ArrowLeft') {
          cards[Math.max(0, currentIndex - 1)]?.focus();
        } else if (event.key === 'ArrowRight') {
          cards[Math.min(cards.length - 1, currentIndex + 1)]?.focus();
        } else {
          // Grid-aware Up/Down: find the nearest card in the target direction
          const currentRect = currentCard.getBoundingClientRect();
          const currentCenterX = currentRect.left + currentRect.width / 2;
          const currentCenterY = currentRect.top + currentRect.height / 2;
          const goingUp = event.key === 'ArrowUp';
          let bestCard: HTMLElement | null = null;
          let bestScore = Infinity;
          for (const card of cards) {
            if (card === currentCard) continue;
            const rect = card.getBoundingClientRect();
            // Require non-overlapping vertical position so multi-line cards that
            // share the same visual row are not treated as up/down candidates.
            if (goingUp ? rect.bottom > currentRect.top : rect.top < currentRect.bottom) continue;
            const centerY = rect.top + rect.height / 2;
            const dy = Math.abs(centerY - currentCenterY);
            const dx = Math.abs(rect.left + rect.width / 2 - currentCenterX);
            // Prefer cards that are more directly above/below (weight vertical distance heavily)
            const score = dy + dx * 0.5;
            if (score < bestScore) { bestScore = score; bestCard = card; }
          }
          (bestCard ?? (goingUp ? cards[Math.max(0, currentIndex - 1)] : cards[Math.min(cards.length - 1, currentIndex + 1)]))?.focus();
        }
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

      const isMyTasksShortcut =
        event.key.toLowerCase() === 't' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;

      if (isMyTasksShortcut) {
        event.preventDefault();
        handleViewChange('my-tasks');
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
    lastFocusedElementRef.current = document.activeElement;
    openNoteIdRef.current = note.id;
    setEditingNote(note);
    setIsModalOpen(true);
    window.history.pushState({ returnTo: returnPathRef.current }, '', `/notes/${note.id}`);
  };

  const handleNoteUpdate = () => {
    void Promise.all([loadNotes(), loadLabelCounts()]);
    loadLabels();
    setIsModalOpen(false);
    setEditingNote(null);
    restoreReturnUrl();
    (lastFocusedElementRef.current as HTMLElement | null)?.focus();
  };

  const handleNoteRefresh = () => {
    void Promise.all([loadNotes(), loadLabelCounts()]);
    loadLabels();
    // loadNotes() only refreshes notesList, not the currently open editingNote,
    // so callers relying on onRefresh to reflect a just-completed server change
    // in the open modal (e.g. a client-deferred image removal past its undo
    // window, whose SSE echo is dropped for the client that triggered it) would
    // otherwise keep showing stale note data until the note is closed and
    // reopened. NoteModal's own adoption effect already guards against
    // clobbering unsaved local edits, so it's safe to always refetch here.
    const currentNoteId = editingNote?.id;
    if (currentNoteId) {
      // Guard against out-of-order responses: several onRefresh calls for the
      // same note can fire in quick succession (e.g. an image removal and a
      // label change within the same second), and nothing guarantees their
      // getById responses land in request order. Only the response to the
      // most recently issued request is applied.
      const requestId = ++editingNoteRefreshRequestIdRef.current;
      notes.getById(currentNoteId).then(refreshed => {
        if (requestId !== editingNoteRefreshRequestIdRef.current) return;
        setEditingNote(prev => (prev?.id === currentNoteId ? refreshed : prev));
      }).catch(() => {});
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId);
      await Promise.all([loadNotes(), loadLabelCounts()]);
      showToast(t('dashboard.noteDeleted'), 'success', {
        label: t('dashboard.undo'),
        onClick: () => handleRestoreNote(noteId),
      });
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast(t('dashboard.failedDeleteNote'), 'error');
    }
  };

  const handleRestoreNote = async (noteId: string) => {
    try {
      await notes.restore(noteId);
      await Promise.all([loadNotes(), loadLabelCounts()]);
      showToast(t('dashboard.noteRestored'), 'success', {
        label: t('dashboard.undo'),
        onClick: async () => {
          try {
            await notes.delete(noteId);
            await Promise.all([loadNotes(), loadLabelCounts()]);
          } catch (undoError) {
            console.error('Failed to undo restore:', undoError);
            showToast(t('dashboard.failedDeleteNote'), 'error');
          }
        },
      });
    } catch (error) {
      console.error('Failed to restore note:', error);
      showToast(t('dashboard.failedRestoreNote'), 'error');
    }
  };

  const handlePermanentlyDeleteNote = async (noteId: string) => {
    try {
      await notes.delete(noteId, { permanent: true });
      await Promise.all([loadNotes(), loadLabelCounts()]);
      showToast(t('dashboard.noteDeletedForever'));
    } catch (error) {
      console.error('Failed to permanently delete note:', error);
      showToast(t('dashboard.failedDeleteNoteForever'), 'error');
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
      void Promise.all([loadNotes(), loadLabelCounts()]);
    } catch (error) {
      console.error('Failed to empty trash:', error);
      showToast(t('dashboard.emptyTrashFailed'), 'error');
    } finally {
      setIsEmptyingTrash(false);
    }
  };

  const handleDuplicateNote = useCallback(async (noteId: string) => {
    try {
      const duplicatedNote = await notes.duplicate(noteId);
      await Promise.all([loadNotes(), loadLabels(), loadLabelCounts()]);
      showToast(t('dashboard.noteDuplicated'), 'success', {
        label: t('dashboard.undo'),
        onClick: async () => {
          try {
            await notes.delete(duplicatedNote.id);
            await Promise.all([loadNotes(), loadLabels(), loadLabelCounts()]);
          } catch (undoError) {
            console.error('Failed to undo duplicate note:', undoError);
            showToast(t('dashboard.failedDeleteNote'), 'error');
          }
        },
      });
    } catch (error) {
      console.error('Failed to duplicate note:', error);
      throw error;
    }
  }, [loadLabelCounts, loadLabels, loadNotes, showToast, t]);

  const handleConvertNote = useCallback(async (noteId: string, data: ConvertNoteTypeRequest) => {
    try {
      await notes.convert(noteId, data);
    } catch (error) {
      console.error('Failed to convert note:', error);
      throw error;
    }
    showToast(t('dashboard.noteConverted'), 'success');
    // The conversion already succeeded — a refresh hiccup here shouldn't be
    // reported to NoteModal as a conversion failure.
    try {
      await Promise.all([loadNotes(), loadLabels(), loadLabelCounts()]);
    } catch (error) {
      console.error('Failed to refresh after converting note:', error);
    }
  }, [loadLabelCounts, loadLabels, loadNotes, showToast, t]);

  const handleShareNote = (note: Note) => {
    setSharingNote(note);
    setIsShareModalOpen(true);
  };

  const handleShareModalClose = async () => {
    const noteId = sharingNote?.id;
    setIsShareModalOpen(false);
    setSharingNote(null);
    loadNotes();
    if (editingNote && noteId === editingNote.id) {
      try {
        const refreshed = await notes.getById(noteId);
        setEditingNote(refreshed);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 403 || status === 404) {
          setIsModalOpen(false);
          setEditingNote(null);
          restoreReturnUrl();
        }
      }
    }
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

      showToast(t('dashboard.failedUpdateSort'), 'error');
      setNoteSort(previousSort);
      if (!restoredSettings && previousSettings) {
        setSettings(previousSettings);
      }
    }
  }, [noteSort, showToast, t]);

  // Dismissal is remembered per sort order, so switching sorts re-reads it.
  // Adjusting during render rather than in an effect avoids showing the warning
  // for a frame under a sort where it was already dismissed
  // (react-hooks/set-state-in-effect).
  const [sortWarningSort, setSortWarningSort] = useState(noteSort);
  if (sortWarningSort !== noteSort) {
    setSortWarningSort(noteSort);
    setSortWarningDismissed(isSortWarningDismissed(noteSort));
  }

  const handleDismissSortWarning = useCallback(() => {
    dismissSortWarning(noteSort);
    setSortWarningDismissed(true);
  }, [noteSort]);

  const handleDragEnd = async (event: DragEndEvent) => {
    if (showArchived || showBin || showMyTasks || debouncedSearchQuery || noteSort !== 'manual') {
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
        showToast(t('dashboard.failedReorderNotes'), 'error');
        loadNotes();
      }
    }
  };

  // While searching or filtering by label outside the bin/archive views,
  // archived matches are mixed into notesList; split them out so they render
  // in their own section.
  const isSearching = !!debouncedSearchQuery;
  const isFilteringByLabel = !!selectedLabelId;
  const showArchivedSplit = (isSearching || isFilteringByLabel) && !showBin && !showArchived;
  const { activeMatches, archivedMatches } = useMemo(() => {
    if (!showArchivedSplit) {
      return { activeMatches: notesList, archivedMatches: [] as Note[] };
    }
    return {
      activeMatches: notesList.filter(note => !note.archived),
      archivedMatches: notesList.filter(note => note.archived),
    };
  }, [notesList, showArchivedSplit]);
  const { pinned: displayedPinned, other: displayedOther } = useMemo(
    () => sortNotesForDisplay(activeMatches, noteSort),
    [activeMatches, noteSort],
  );
  const displayedArchived = useMemo(() => {
    const { pinned, other } = sortNotesForDisplay(archivedMatches, noteSort);
    return [...pinned, ...other];
  }, [archivedMatches, noteSort]);
  // Reordering is manual-position based, so it is disabled in any view that is
  // not the plain manually-sorted grid. Search in particular orders results by
  // full-text relevance rather than position, so a drag would not map to the
  // order on screen.
  const dragReorderingDisabled = showArchived || showBin || showMyTasks || isSearching || isFilteringByLabel || noteSort !== 'manual';
  // Signature of the active view/filter/search. The grids swap instantly when it
  // changes, so only in-view card changes (create, delete, archive, …) animate.
  const viewKey = `${showArchived ? 'archive' : showBin ? 'bin' : showMyTasks ? 'my-tasks' : 'notes'}|${selectedLabelId ?? ''}|${debouncedSearchQuery}`;
  const handlePinnedActive = useCallback((active: boolean) => {
    setSectionActive(prev => (prev.pinned === active ? prev : { ...prev, pinned: active }));
  }, []);
  const handleOtherActive = useCallback((active: boolean) => {
    setSectionActive(prev => (prev.other === active ? prev : { ...prev, other: active }));
  }, []);
  const handleArchivedActive = useCallback((active: boolean) => {
    setSectionActive(prev => (prev.archived === active ? prev : { ...prev, archived: active }));
  }, []);
  // Keep a section (and the grid as a whole) rendered while its last card is
  // still animating out, even though the live note list is already empty.
  const renderPinnedSection = displayedPinned.length > 0 || sectionActive.pinned;
  const renderOtherSection = displayedOther.length > 0 || sectionActive.other;
  const renderArchivedSection = displayedArchived.length > 0 || sectionActive.archived;
  // Every note id currently shown across all sections. Lets each grid tell a
  // genuine removal (animate out) apart from a section move like pin/unpin
  // (drop instantly, since the note re-appears in another section).
  const displayedIds = useMemo(
    () => new Set([...displayedPinned, ...displayedOther, ...displayedArchived].map(note => note.id)),
    [displayedPinned, displayedOther, displayedArchived],
  );
  const activeSortLabel = t(`dashboard.sortOption.${noteSort}`);
  const focusSearchShortcutHint = isApplePlatform() ? '⌘ + F' : t('keyboardShortcuts.focusSearchKey');
  const showCreateFirstNoteCta =
    !showArchived &&
    !showBin &&
    !showMyTasks &&
    !debouncedSearchQuery &&
    !selectedLabelId;
  const emptyState = useMemo(() => {
    if (debouncedSearchQuery) {
      return {
        icon: <Search aria-hidden="true" className="h-8 w-8" />,
        title: t('dashboard.noSearchResults', { query: debouncedSearchQuery }),
        description: t('dashboard.searchEmptyHint'),
      };
    }

    if (showBin) {
      return {
        icon: <Trash2 aria-hidden="true" className="h-8 w-8" />,
        title: t('dashboard.noBinnedNotes'),
        description: t('dashboard.binEmptyHint'),
      };
    }

    if (showArchived) {
      return {
        icon: <Archive aria-hidden="true" className="h-8 w-8" />,
        title: t('dashboard.noArchivedNotes'),
        description: t('dashboard.archiveEmptyHint'),
      };
    }

    if (showMyTasks) {
      return {
        icon: <ClipboardCheck aria-hidden="true" className="h-8 w-8" />,
        title: t('dashboard.noMyTasksNotesTitle'),
        description: t('dashboard.noMyTasksNotes'),
      };
    }

    if (selectedLabelId) {
      return {
        icon: <FileText aria-hidden="true" className="h-8 w-8" />,
        title: t('dashboard.noNotesForThisLabel'),
        description: t('dashboard.labelFilterEmptyHint'),
      };
    }

    return {
      icon: <FileText aria-hidden="true" className="h-8 w-8" />,
      title: t('dashboard.noNotesYet'),
      description: t('dashboard.createFirstNote'),
    };
  }, [debouncedSearchQuery, selectedLabelId, showArchived, showBin, showMyTasks, t]);

  // Inject the search bar into the persistent layout header
  useLayoutEffect(() => {
    setSearchBar(
      <div className="w-full sm:max-w-7xl flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            inputRef={searchInputRef}
            shortcutHint={focusSearchShortcutHint}
            stopEscapePropagation={true}
          />
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          <div className="w-full sm:w-56">
            <label htmlFor="dashboard-sort" className="sr-only">
              {t('dashboard.sortLabel')}
            </label>
            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
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
    return () => setSearchBar(null);
  }, [searchQuery, setSearchQuery, searchInputRef, focusSearchShortcutHint, noteSort, handleNoteSortChange, showBin, trashCount, isEmptyingTrash, setShowEmptyTrashConfirm, t, setSearchBar]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div data-testid="loading-spinner" className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <PageContent>
        {/* Create note button — hidden in bin view */}
        {!showBin && (
          <div className="mb-8">
            <button
              onClick={handleCreateNote}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              <Plus className="h-5 w-5 mr-2" />
              {t('dashboard.newNote')}
            </button>
            {showMyTasks && (
              <div className="mt-3 px-4 py-2 bg-blue-50 dark:bg-slate-800 border border-blue-100 dark:border-slate-700 rounded-lg text-sm text-blue-800 dark:text-slate-200">
                {t('dashboard.myTasksInfo')}
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
        {noteSort !== 'manual' && !sortWarningDismissed && (
          <div
            data-testid="manual-reorder-disabled-notice"
            className="mb-6 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-200 animate-fade-in motion-reduce:animate-none"
          >
            <ArrowUpDown className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <span className="font-medium">{t('dashboard.manualReorderDisabledTitle')}</span>{' '}
              <span>{t('dashboard.manualReorderDisabled', { sort: activeSortLabel })}</span>
            </div>
            <button
              onClick={handleDismissSortWarning}
              aria-label={t('common.close')}
              className="shrink-0 rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-900/50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {!renderPinnedSection && !renderOtherSection && !renderArchivedSection ? (
          <div className="py-12">
            <div
              data-testid="dashboard-empty-state"
              className="mx-auto flex max-w-2xl flex-col items-center rounded-2xl border border-gray-200 bg-white px-6 py-10 text-center shadow-sm dark:border-slate-700 dark:bg-slate-800 animate-pop-in motion-reduce:animate-none"
            >
              <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-200">
                {emptyState.icon}
              </div>
              <h2 className="max-w-xl text-lg font-semibold text-gray-900 dark:text-white whitespace-normal break-words">
                {emptyState.title}
              </h2>
              {emptyState.description && (
                <p className="mt-2 max-w-xl text-sm text-gray-600 dark:text-gray-300 whitespace-normal break-words">
                  {emptyState.description}
                </p>
              )}
              {showCreateFirstNoteCta && (
                <div className="mt-6">
                  <button
                    onClick={handleCreateNote}
                    className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-800 transition-colors"
                  >
                    <Plus className="h-5 w-5 mr-2" />
                    {t('dashboard.createFirstNoteCta')}
                  </button>
                </div>
              )}
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
              {renderPinnedSection && (
                <div>
                  {displayedPinned.length > 0 && (
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                      <Pin className="h-4 w-4 text-blue-500 dark:text-blue-400 mr-2" fill="currentColor" />
                      {t('dashboard.pinned')}
                    </h2>
                  )}
                  <AnimatedNoteGrid
                    key="pinned"
                    viewKey={viewKey}
                    presentElsewhere={displayedIds}
                    onActiveChange={handlePinnedActive}
                    notes={displayedPinned}
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
                    onLabelClick={!showBin ? handleLabelClick : undefined}
                  />
                </div>
              )}

              {/* Other notes section */}
              {renderOtherSection && (
                <div>
                  {displayedOther.length > 0 && displayedPinned.length > 0 && (
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                      {t('dashboard.otherNotes')}
                    </h2>
                  )}
                  <AnimatedNoteGrid
                    key="other"
                    viewKey={viewKey}
                    presentElsewhere={displayedIds}
                    onActiveChange={handleOtherActive}
                    notes={displayedOther}
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
                    onLabelClick={!showBin ? handleLabelClick : undefined}
                  />
                </div>
              )}

              {/* Archived search results section */}
              {renderArchivedSection && (
                <div>
                  {displayedArchived.length > 0 && (
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                      <Archive aria-hidden="true" className="h-4 w-4 text-gray-500 dark:text-gray-400 mr-2" />
                      {t('dashboard.archivedResults')}
                    </h2>
                  )}
                  <AnimatedNoteGrid
                    key="archived"
                    viewKey={viewKey}
                    presentElsewhere={displayedIds}
                    onActiveChange={handleArchivedActive}
                    notes={displayedArchived}
                    onEdit={handleEditNote}
                    onDelete={handleDeleteNote}
                    onDuplicate={handleDuplicateNote}
                    onShare={handleShareNote}
                    onRestore={handleRestoreNote}
                    onPermanentlyDelete={handlePermanentlyDeleteNote}
                    currentUserId={user?.id}
                    usersById={usersById}
                    disabled={true}
                    inBin={showBin}
                    onRefresh={loadNotes}
                    onLabelClick={!showBin ? handleLabelClick : undefined}
                  />
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
              (lastFocusedElementRef.current as HTMLElement | null)?.focus();
            }}
            onSave={handleNoteUpdate}
            onRefresh={handleNoteRefresh}
            onShare={handleShareNote}
            onDelete={handleDeleteNote}
            onDuplicate={handleDuplicateNote}
            onConvert={handleConvertNote}
            onRestore={handleRestoreNote}
            onPermanentlyDelete={handlePermanentlyDeleteNote}
            isOwner={!editingNote || editingNote.user_id === user?.id}
            usersById={usersById}
            currentUserId={user?.id}
            uploadMaxBytes={uploadMaxBytes}
            initialType={newNoteDraft?.type}
            initialContent={newNoteDraft?.content}
          />
        )}

        {/* Share modal */}
        {isShareModalOpen && (
          <ShareModal
            note={sharingNote}
            isOpen={isShareModalOpen}
            onClose={handleShareModalClose}
            notesList={notesList}
            currentUserId={user?.id}
          />
        )}
      </PageContent>
  );
}
