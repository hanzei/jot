import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { auth, users } from '@/utils/api';
import { getUser, setUser, removeUser } from '@/utils/auth';
import NavigationHeader from '@/components/NavigationHeader';

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
  const [username, setUsername] = useState(currentUser?.username ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Continue with logout even if the server call fails
    }
    removeUser();
    onLogout();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const updatedUser = await users.updateMe({ username });
      setUser(updatedUser);
      setSuccess('Username updated successfully.');
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data || 'Failed to update username.');
      } else {
        setError('Failed to update username.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
      <NavigationHeader onLogout={handleLogout} tabs={navigationTabs} username={username} />

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
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Username (2-30 characters)"
                />
              </div>

              {error && (
                <div className="mt-4 text-red-600 dark:text-red-400 text-sm">{error}</div>
              )}
              {success && (
                <div className="mt-4 text-green-600 dark:text-green-400 text-sm">{success}</div>
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
        </div>
      </div>
    </div>
  );
};

export default Settings;
