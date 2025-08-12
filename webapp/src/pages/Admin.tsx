import { useState, useEffect } from 'react';
import { User, CreateUserRequest } from '@/types';
import { admin } from '@/utils/api';
import { isAdmin, removeToken } from '@/utils/auth';
import { ROLES } from '@/constants/roles';
import { Navigate, Link } from 'react-router-dom';
import NavigationHeader from '@/components/NavigationHeader';

interface AdminProps {
  onLogout: () => void;
}

const Admin = ({ onLogout }: AdminProps) => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [formData, setFormData] = useState<CreateUserRequest>({
    username: '',
    password: '',
    role: ROLES.USER,
  });

  const userIsAdmin = isAdmin();

  const handleLogout = () => {
    removeToken();
    onLogout();
  };

  useEffect(() => {
    if (userIsAdmin) {
      fetchUsers();
    }
  }, [userIsAdmin]);

  if (!userIsAdmin) {
    return <Navigate to="/" />;
  }

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await admin.getUsers();
      setUsers(response.users || []);
    } catch (err) {
      setError('Failed to load users');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    setCreateError('');

    try {
      const newUser = await admin.createUser(formData);
      setUsers([newUser, ...users]);
      setFormData({ username: '', password: '', role: ROLES.USER });
      setShowCreateForm(false);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: string } };
      setCreateError(axiosError.response?.data || 'Failed to create user');
    } finally {
      setCreateLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
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
      )
    },
    {
      label: 'Archive',
      element: (
        <Link
          to="/?view=archive"
          className="px-3 py-1 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
        >
          Archive
        </Link>
      )
    },
    {
      label: 'Admin',
      element: (
        <span className="px-3 py-1 rounded-md text-sm font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
          Admin
        </span>
      ),
      isActive: true
    }
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
      <NavigationHeader
        onLogout={handleLogout}
        tabs={navigationTabs}
      />

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <div className="flex justify-between items-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">User Management</h1>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              >
                {showCreateForm ? 'Cancel' : 'Create User'}
              </button>
            </div>
          </div>

          {showCreateForm && (
            <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 mb-6 border border-gray-200 dark:border-slate-700">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Create New User</h2>
              <form onSubmit={handleCreateUser}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Username
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Username (2-30 characters)"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Password
                    </label>
                    <input
                      type="password"
                      required
                      minLength={4}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.role === ROLES.ADMIN}
                      onChange={(e) => setFormData({ ...formData, role: e.target.checked ? ROLES.ADMIN : ROLES.USER })}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">Admin user</span>
                  </label>
                </div>
                {createError && (
                  <div className="mt-4 text-red-600 dark:text-red-400 text-sm">{createError}</div>
                )}
                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={createLoading}
                    className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
                  >
                    {createLoading ? 'Creating...' : 'Create User'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          <div className="bg-white dark:bg-slate-800 shadow overflow-hidden sm:rounded-md border border-gray-200 dark:border-slate-700">
            <ul className="divide-y divide-gray-200 dark:divide-slate-700">
              {(users || []).map((user) => (
                <li key={user.id}>
                  <div className="px-4 py-4 sm:px-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {user.username}
                          </p>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            ID: {user.id} • Created: {new Date(user.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        {user.role === ROLES.ADMIN && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                            Admin
                          </span>
                        )}
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                          Active
                        </span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {(!users || users.length === 0) && !loading && (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No users found.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Admin;