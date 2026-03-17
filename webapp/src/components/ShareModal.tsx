import { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon, TrashIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { ROLES, type Note, type NoteShare, type User } from '@jot/shared';
import { notes, users as usersApi } from '@/utils/api';

interface ShareModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function ShareModal({ note, isOpen, onClose }: ShareModalProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [shares, setShares] = useState<NoteShare[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<User[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedUserIndex, setSelectedUserIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const loadShares = useCallback(async () => {
    if (!note) return;
    
    try {
      const sharesList = await notes.getShares(note.id);
      setShares(sharesList || []);
    } catch (error) {
      console.error('Failed to load shares:', error);
      setShares([]);
    }
  }, [note]);

  useEffect(() => {
    if (note && isOpen) {
      loadShares();
      loadUsers();
    }
  }, [note, isOpen, loadShares]);

  useEffect(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const filtered = users.filter(user => {
        if (shares.some(share => share.shared_with_user_id === user.id)) return false;
        const fullName = `${user.first_name} ${user.last_name}`.toLowerCase();
        return user.username.toLowerCase().includes(q) || fullName.includes(q);
      });
      setFilteredUsers(filtered);
      setShowSuggestions(filtered.length > 0);
      setSelectedUserIndex(-1);
    } else {
      setFilteredUsers([]);
      setShowSuggestions(false);
      setSelectedUserIndex(-1);
    }
  }, [searchQuery, users, shares]);

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

  const loadUsers = async () => {
    try {
      const usersList = await usersApi.search();
      setUsers(usersList || []);
    } catch (error) {
      console.error('Failed to load users:', error);
      setUsers([]);
    }
  };

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
      await notes.unshare(note.id, { user_id: userId });
      setSuccess(t('share.unsharedSuccess'));
      await loadShares();
    } catch {
      setError(t('share.failedUnshare'));
    }
  };

  const handleUserSelect = (user: User) => {
    handleShare(user.id);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || filteredUsers.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedUserIndex(prev => 
          prev < filteredUsers.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedUserIndex(prev => prev > 0 ? prev - 1 : prev);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedUserIndex >= 0 && selectedUserIndex < filteredUsers.length) {
          handleUserSelect(filteredUsers[selectedUserIndex]);
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        setSelectedUserIndex(-1);
        break;
    }
  };

  const handleInputFocus = () => {
    if (searchQuery.trim() && filteredUsers.length > 0) {
      setShowSuggestions(true);
    }
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

  if (!note) return null;

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/25" />
      
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="mx-auto max-w-md rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
                {t('share.title', { noteTitle: note.title || t('share.untitledNote') })}
              </DialogTitle>
              <button
                onClick={handleClose}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600"
              >
                <XMarkIcon className="h-5 w-5" />
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
              <label htmlFor="user-search" className="block text-sm font-medium text-gray-700 mb-2">
                {t('share.shareWithUser')}
              </label>
              <div className="relative">
                <input
                  ref={searchRef}
                  type="text"
                  id="user-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={handleInputFocus}
                  onKeyDown={handleKeyDown}
                  placeholder={t('share.searchUsersPlaceholder')}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={isLoading}
                />
                <ChevronDownIcon className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                
                {showSuggestions && (
                  <div 
                    ref={suggestionsRef}
                    className="absolute z-10 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-md shadow-lg max-h-48 overflow-y-auto"
                  >
                    {filteredUsers.map((user, index) => {
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
                    })}
                  </div>
                )}
              </div>
              
              {searchQuery && filteredUsers.length === 0 && !isLoading && (
                <p className="text-sm text-gray-500 mt-1">
                  {t('share.noUsersFound', { query: searchQuery })}
                </p>
              )}
            </div>

            {shares && shares.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3">
                  {t('share.sharedWith', { count: shares.length })}
                </h4>
                <div className="space-y-2 max-h-40 overflow-y-auto">
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
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(!shares || shares.length === 0) && (
              <p className="text-sm text-gray-500">
                {t('share.notSharedYet')}
              </p>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}