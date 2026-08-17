import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react';
import { X, Trash2, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ROLES,
  buildShareSuggestions,
  recentShareTargets,
  type Note,
  type NoteShare,
  type User,
} from '@jot/shared';
import { notes, users as usersApi } from '@/utils/api';
import { useSizeTransition } from '@/hooks/useSizeTransition';

interface ShareModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  /**
   * The notes currently loaded by the caller, used to derive who the user last
   * shared with. Only their embedded `shared_with` records are read, so the
   * suggestions cost no extra request — but they also only reflect the notes
   * the caller happens to hold (the current view).
   */
  notesList?: Note[];
  currentUserId?: string | undefined;
}

export default function ShareModal({ note, isOpen, onClose, notesList, currentUserId }: ShareModalProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [shares, setShares] = useState<NoteShare[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  // Distinguishes "the directory hasn't arrived yet" from "there is genuinely
  // nobody left to suggest", so the empty dropdown never accuses a populated
  // instance of having no other users.
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedUserIndex, setSelectedUserIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const sharesRequestIdRef = useRef(0);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  const sharedUserIds = useMemo(
    () => new Set(shares.map(share => share.shared_with_user_id)),
    [shares],
  );

  const recentUserIds = useMemo(
    () => recentShareTargets(notesList, currentUserId ?? ''),
    [notesList, currentUserId],
  );

  // Candidate collaborators for the current query, derived during render rather
  // than mirrored into state from an effect. An empty query is not "no
  // candidates" but "everyone": the resting state of the dropdown doubles as a
  // directory, so the common case of sharing with a frequent collaborator never
  // requires recalling and typing their username.
  const suggestions = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    const matches = q
      ? users.filter(user => {
          const fullName = `${user.first_name} ${user.last_name}`.toLowerCase();
          return user.username.toLowerCase().includes(q) || fullName.includes(q);
        })
      : users;
    return buildShareSuggestions(matches, recentUserIds, sharedUserIds);
  }, [trimmedQuery, users, recentUserIds, sharedUserIds]);

  // Render order, flattened. Keyboard selection indexes into this in both
  // presentations — while searching the two groups are rendered as one ranked
  // list, so the flat order and the visual order stay identical either way.
  const orderedSuggestions = useMemo(
    () => [...suggestions.recent, ...suggestions.others],
    [suggestions],
  );

  // Softly animate the modal's height when its contents change (a collaborator
  // added/removed, suggestions toggled, or a status message shown/hidden).
  const sizeTransitionKey =
    `${shares.length}:${showSuggestions}:${orderedSuggestions.length}:${!!error}:${!!success}`;
  const panelRef = useSizeTransition<HTMLDivElement>(sizeTransitionKey);

  // Written as a promise chain rather than an `async` function so state is only
  // ever set from a continuation — an effect may call this without triggering a
  // cascading render (react-hooks/set-state-in-effect).
  //
  // The modal stays mounted across note switches, so a slow response for the
  // note we just left could otherwise land after the new note's and show the
  // wrong collaborators. The request id discards superseded responses wherever
  // this is called from, including the handleShare/handleUnshare refreshes.
  const loadShares = useCallback(() => {
    if (!note) return Promise.resolve();

    const requestId = ++sharesRequestIdRef.current;
    const isCurrent = () => requestId === sharesRequestIdRef.current;

    return notes.getShares(note.id)
      .then(sharesList => { if (isCurrent()) setShares(sharesList || []); })
      .catch(error => {
        console.error('Failed to load shares:', error);
        if (isCurrent()) setShares([]);
      });
  }, [note]);

  useEffect(() => {
    if (!note || !isOpen) return;

    // The user list is only ever fetched here, so an effect-scoped flag is
    // enough to drop a response whose run has been superseded.
    let cancelled = false;

    loadShares();
    usersApi.search()
      .then(usersList => {
        if (cancelled) return;
        setUsers(usersList || []);
        setUsersLoaded(true);
      })
      .catch(error => {
        console.error('Failed to load users:', error);
        if (cancelled) return;
        setUsers([]);
        setUsersLoaded(true);
      });

    return () => { cancelled = true; };
  }, [note, isOpen, loadShares]);

  // Handle click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        searchRef.current &&
        !searchRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
        setSelectedUserIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleShare = async (userId: string) => {
    if (!note || !userId.trim()) return;

    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      await notes.share(note.id, { user_id: userId });
      setSearchQuery('');
      setSuccess(t('share.sharedSuccess'));
      await loadShares();
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: string } };
      if (axiosError.response?.status === 404) {
        setError(t('share.userNotFound'));
      } else if (axiosError.response?.status === 409) {
        setError(t('share.alreadyShared'));
      } else if (axiosError.response?.status === 400 && axiosError.response?.data?.includes('self')) {
        setError(t('share.cannotShareSelf'));
      } else {
        setError(t('share.failedShare'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnshare = async (userId: string) => {
    if (!note) return;

    try {
      await notes.unshare(note.id, userId);
      setSuccess(t('share.unsharedSuccess'));
      await loadShares();
    } catch {
      setError(t('share.failedUnshare'));
    }
  };

  // Suggestion visibility is driven from the event handlers that can change it
  // (typing, focus, selection, Escape, click-outside) instead of an effect that
  // mirrors `searchQuery`. The dropdown additionally renders only when there is
  // something to show, so an empty result set hides it without extra state.
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setShowSuggestions(true);
    setSelectedUserIndex(-1);
  };

  const handleUserSelect = (user: User) => {
    handleShare(user.id);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || orderedSuggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedUserIndex(prev =>
          prev < orderedSuggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedUserIndex(prev => prev > 0 ? prev - 1 : prev);
        break;
      case 'Enter': {
        e.preventDefault();
        const selected = orderedSuggestions[selectedUserIndex];
        if (selected) {
          handleUserSelect(selected);
        }
        break;
      }
      case 'Escape':
        setShowSuggestions(false);
        setSelectedUserIndex(-1);
        break;
    }
  };

  const handleInputFocus = () => {
    setShowSuggestions(true);
  };

  const handleClose = () => {
    setSearchQuery('');
    setError('');
    setSuccess('');
    setShares([]);
    setShowSuggestions(false);
    setSelectedUserIndex(-1);
    onClose();
  };

  // `index` is the row's position in `orderedSuggestions` so that keyboard
  // selection lines up with the rendered order in the grouped presentation too.
  const renderSuggestion = (user: User, index: number) => {
    const hasName = !!(user.first_name || user.last_name);
    const displayName = hasName
      ? `${user.first_name} ${user.last_name}`.trim()
      : user.username;
    const isAdmin = user.role === ROLES.ADMIN;
    const secondaryText = hasName
      ? user.username + (isAdmin ? ' · Admin' : '')
      : (isAdmin ? 'Admin' : '');
    return (
      <div
        key={user.id}
        className={`px-3 py-2 cursor-pointer text-sm ${
          index === selectedUserIndex
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-300'
            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700'
        }`}
        onClick={() => handleUserSelect(user)}
        onMouseEnter={() => setSelectedUserIndex(index)}
      >
        <div className="font-medium">{displayName}</div>
        {secondaryText && (
          <div className="text-xs text-gray-500 dark:text-gray-400">{secondaryText}</div>
        )}
      </div>
    );
  };

  const renderGroupHeading = (label: string) => (
    <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
      {label}
    </div>
  );

  // Only meaningful once the directory has loaded and the user is not searching
  // — a fruitless search keeps its own "no users found" message below the input.
  const emptySuggestionsMessage =
    usersLoaded && !isSearching && orderedSuggestions.length === 0
      ? users.length === 0
        ? t('share.noOtherUsers')
        : t('share.everyoneHasAccess')
      : '';

  if (!note) return null;

  return (
    <Dialog open={isOpen} onClose={handleClose} aria-label={t('note.share')} className="relative z-50">
      <DialogBackdrop transition className="fixed inset-0 bg-black/25 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel ref={panelRef} transition className="mx-auto max-w-md rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700 transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none">
            <div className="flex justify-end mb-4">
              <button
                onClick={handleClose}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
                {error}
              </div>
            )}

            {success && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-600">
                {success}
              </div>
            )}

            <div className="mb-6">
              <label htmlFor="user-search" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('share.shareWithUser')}
              </label>
              <div className="relative">
                <input
                  ref={searchRef}
                  type="text"
                  id="user-search"
                  autoCapitalize="none"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onFocus={handleInputFocus}
                  onKeyDown={handleKeyDown}
                  placeholder={t('share.searchUsersPlaceholder')}
                  className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={isLoading}
                />
                <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                
                {showSuggestions && (orderedSuggestions.length > 0 || emptySuggestionsMessage) && (
                  <div
                    ref={suggestionsRef}
                    data-testid="share-suggestions"
                    className="absolute z-10 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-md shadow-lg max-h-48 overflow-y-auto scrollbar-subtle"
                  >
                    {isSearching ? (
                      // Searching is a "find this person" intent, so the groups
                      // collapse into one ranked list: splitting the matches
                      // could push an exact match below the fold.
                      orderedSuggestions.map(renderSuggestion)
                    ) : (
                      <>
                        {suggestions.recent.length > 0 && (
                          <div data-testid="share-recent-suggestions">
                            {renderGroupHeading(t('share.recentlySharedWith'))}
                            {suggestions.recent.map(renderSuggestion)}
                          </div>
                        )}
                        {suggestions.others.length > 0 && (
                          <div data-testid="share-all-users">
                            {renderGroupHeading(t('share.allUsers'))}
                            {suggestions.others.map((user, index) =>
                              renderSuggestion(user, suggestions.recent.length + index)
                            )}
                          </div>
                        )}
                        {emptySuggestionsMessage && (
                          <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                            {emptySuggestionsMessage}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {isSearching && orderedSuggestions.length === 0 && !isLoading && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {t('share.noUsersFound', { query: searchQuery })}
                </p>
              )}
            </div>

            {shares && shares.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  {t('share.sharedWith', { count: shares.length })}
                </h4>
                <div className="space-y-2 max-h-40 overflow-y-auto scrollbar-subtle">
                  {shares.map((share) => (
                    <div key={share.id} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-slate-700 rounded">
                      <div>
                        <span className="text-sm text-gray-700 dark:text-gray-200">
                          {share.first_name || share.last_name
                            ? `${share.first_name} ${share.last_name}`.trim()
                            : share.username}
                        </span>
                        {(share.first_name || share.last_name) && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">({share.username})</span>
                        )}
                      </div>
                      <button
                        onClick={() => handleUnshare(share.shared_with_user_id)}
                        className="text-red-600 hover:text-red-800 p-1"
                        title={t('share.removeAccess')}
                        aria-label={t('share.removeAccess')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(!shares || shares.length === 0) && (
              <p className="text-sm text-gray-500 dark:text-gray-300">
                {t('share.notSharedYet')}
              </p>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}