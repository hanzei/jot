import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MagnifyingGlassIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { auth, users, isAxiosError } from '@/utils/api';
import { getUser, setUser, removeUser } from '@/utils/auth';
import NavigationHeader from '@/components/NavigationHeader';
import ImportModal from '@/components/ImportModal';

interface SettingsProps {
  onLogout: () => void;
}

const navigationTabs = [
  {
    label: 'Notes',
    element: (
      <Link
        to="/"
        className="px-3 py-1 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
      >
        Notes
      </Link>
    ),
  },
  {
    label: 'Settings',
    element: (
      <span className="px-3 py-1 rounded-md text-sm font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
        Settings
      </span>
    ),
    isActive: true,
  },
];

const Settings = ({ onLogout }: SettingsProps) => {
  const currentUser = getUser();
  const navigate = useNavigate();
  // currentUsername tracks the persisted value shown in the nav header.
  // draftUsername is the live value bound to the input field.
  const [currentUsername, setCurrentUsername] = useState(currentUser?.username ?? '');
  const [draftUsername, setDraftUsername] = useState(currentUser?.username ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await auth.logout();
      removeUser();
      onLogout();
    } catch {
      setError('Logout failed. Please try again.');
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }

    setPasswordSaving(true);
    try {
      await users.changePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        setPasswordError(err.response?.data || 'Failed to change password.');
      } else {
        setPasswordError('Failed to change password.');
      }
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const updatedUser = await users.updateMe({ username: draftUsername });
      setUser(updatedUser);
      setCurrentUsername(updatedUser.username);
      setDraftUsername(updatedUser.username);
      setSuccess('Username updated successfully.');
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        setError(err.response?.data || 'Failed to update username.');
      } else {
        setError('Failed to update username.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (trimmed) {
      navigate(`/?search=${encodeURIComponent(trimmed)}`);
    } else {
      navigate('/');
    }
  };

  const searchBar = (
    <div className="w-full sm:flex-1 sm:max-w-lg sm:mx-4">
      <form onSubmit={handleSearch}>
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search notes..."
            aria-label="Search notes"
            className="w-full pl-9 sm:pl-10 pr-4 py-2 text-sm sm:text-base border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </form>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
      <NavigationHeader onLogout={handleLogout} tabs={navigationTabs} username={currentUsername}>
        {searchBar}
      </NavigationHeader>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Settings</h1>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Account</h2>
            <form onSubmit={handleSubmit}>
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  required
                  value={draftUsername}
                  onChange={(e) => setDraftUsername(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Username (2-30 characters)"
                />
              </div>

              {error && (
                <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}
              {success && (
                <div aria-live="polite" className="mt-4 text-green-600 dark:text-green-400 text-sm">
                  {success}
                </div>
              )}

              <div className="mt-6">
                <button
                  type="submit"
                  disabled={saving}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Change Password</h2>
            <form onSubmit={handlePasswordChange}>
              <div>
                <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Current Password
                </label>
                <input
                  id="current-password"
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div className="mt-4">
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  New Password
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder="At least 4 characters"
                />
              </div>

              <div className="mt-4">
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Confirm New Password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {passwordError && (
                <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">
                  {passwordError}
                </div>
              )}
              {passwordSuccess && (
                <div aria-live="polite" className="mt-4 text-green-600 dark:text-green-400 text-sm">
                  {passwordSuccess}
                </div>
              )}

              <div className="mt-6">
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  {passwordSaving ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </form>
          </div>
          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Import</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Import notes from Google Keep exports.
            </p>
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              <ArrowUpTrayIcon className="h-5 w-5 mr-2" />
              Import from Google Keep
            </button>
          </div>
        </div>
      </div>

      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={() => {}}
      />
    </div>
  );
};

export default Settings;
