import { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon, TrashIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { Note, NoteShare, User } from '@/types';
import { notes, users as usersApi } from '@/utils/api';

interface ShareModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function ShareModal({ note, isOpen, onClose }: ShareModalProps) {
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
      const filtered = users.filter(user => 
        user.username.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !shares.some(share => share.shared_with_user_id === user.id)
      );
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

  const handleShare = async (username: string) => {
    if (!note || !username.trim()) return;

    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      await notes.share(note.id, { username: username.trim() });
      setSearchQuery('');
      setSuccess('Note shared successfully!');
      await loadShares();
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: string } };
      if (axiosError.response?.status === 404) {
        setError('User not found with this username.');
      } else if (axiosError.response?.status === 409) {
        setError('Note is already shared with this user.');
      } else if (axiosError.response?.status === 400 && axiosError.response?.data?.includes('yourself')) {
        setError('You cannot share a note with yourself.');
      } else {
        setError('Failed to share note. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnshare = async (shareUsername: string) => {
    if (!note) return;

    try {
      await notes.unshare(note.id, { username: shareUsername });
      setSuccess('Note unshared successfully!');
      await loadShares();
    } catch {
      setError('Failed to unshare note. Please try again.');
    }
  };

  const handleUserSelect = (user: User) => {
    handleShare(user.username);
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
          <Dialog.Panel className="mx-auto max-w-md rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900 dark:text-white">
                Share "{note.title || 'Untitled Note'}"
              </Dialog.Title>
              <button
                onClick={handleClose}
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
                Share with user:
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
                  placeholder="Search users by username..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={isLoading}
                />
                <ChevronDownIcon className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                
                {showSuggestions && (
                  <div 
                    ref={suggestionsRef}
                    className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto"
                  >
                    {filteredUsers.map((user, index) => (
                      <div
                        key={user.id}
                        className={`px-3 py-2 cursor-pointer text-sm ${
                          index === selectedUserIndex
                            ? 'bg-blue-50 text-blue-900'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                        onClick={() => handleUserSelect(user)}
                        onMouseEnter={() => setSelectedUserIndex(index)}
                      >
                        <div className="font-medium">{user.username}</div>
                        {user.is_admin && (
                          <div className="text-xs text-gray-500">Admin</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {searchQuery && filteredUsers.length === 0 && !isLoading && (
                <p className="text-sm text-gray-500 mt-1">
                  No users found matching "{searchQuery}"
                </p>
              )}
            </div>

            {shares && shares.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3">
                  Shared with ({shares.length}):
                </h4>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {shares.map((share) => (
                    <div key={share.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                      <span className="text-sm text-gray-700">{share.username}</span>
                      <button
                        onClick={() => handleUnshare(share.username || '')}
                        className="text-red-600 hover:text-red-800 p-1"
                        title="Remove access"
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
                This note is not shared with anyone yet.
              </p>
            )}
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
}