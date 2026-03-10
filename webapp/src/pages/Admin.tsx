import { useState, useEffect, useCallback } from 'react';
import { User, CreateUserRequest } from '@/types';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { admin, auth, isAxiosError } from '@/utils/api';
import { isAdmin, removeUser, getUser } from '@/utils/auth';
import { ROLES } from '@/constants/roles';
import { Navigate, Link, useNavigate } from 'react-router-dom';
import NavigationHeader from '@/components/NavigationHeader';

interface AdminProps {
  onLogout: () => void;
}

const Admin = ({ onLogout }: AdminProps) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const currentUser = getUser();
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
  const [searchQuery, setSearchQuery] = useState('');
  const [roleUpdating, setRoleUpdating] = useState<Set<string>>(new Set());

  const userIsAdmin = isAdmin();

  useEffect(() => { document.title = t('pageTitle.admin'); }, [t]);

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Continue with logout even if the server call fails
    }
    removeUser();
    onLogout();
  };

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await admin.getUsers();
      setUsers(response.users || []);
    } catch (err) {
      setError(t('admin.failedLoadUsers'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (userIsAdmin) {
      fetchUsers();
    }
  }, [userIsAdmin, fetchUsers]);

  if (!userIsAdmin) {
    return <Navigate to="/" />;
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    setCreateError('');

    try {
      const newUser = await admin.createUser(formData);
      setUsers(prev => [newUser, ...prev]);
      setFormData({ username: '', password: '', role: ROLES.USER });
      setShowCreateForm(false);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: string } };
      setCreateError(axiosError.response?.data || t('admin.failedCreateUser'));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleRoleToggle = async (targetUser: User) => {
    const newRole = targetUser.role === 'admin' ? 'user' : 'admin';
    setError('');
    setRoleUpdating(prev => new Set(prev).add(targetUser.id));
    try {
      const updated = await admin.updateUserRole(targetUser.id, { role: newRole });
      setUsers(prev => prev.map(u => u.id === updated.id ? updated : u));
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || t('admin.failedUpdateRole'));
      } else {
        setError(t('admin.failedUpdateRole'));
      }
    } finally {
      setRoleUpdating(prev => {
        const next = new Set(prev);
        next.delete(targetUser.id);
        return next;
      });
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const navigationTabs = [
    {
      label: t('admin.tabNotes'),
      element: (
        <Link
          to="/"
          className="px-3 py-1 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
        >
          {t('admin.tabNotes')}
        </Link>
      )
    },
    {
      label: t('admin.tabArchive'),
      element: (
        <Link
          to="/?view=archive"
          className="px-3 py-1 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
        >
          {t('admin.tabArchive')}
        </Link>
      )
    }
  ];

  const searchBar = (
    <div className="w-full sm:flex-1 sm:max-w-lg sm:mx-4">
      <form onSubmit={handleSearch}>
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder={t('dashboard.searchPlaceholder')}
            aria-label={t('dashboard.searchAriaLabel')}
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
      <NavigationHeader
        onLogout={handleLogout}
        tabs={navigationTabs}
        isAdmin={true}
        adminLinkActive={true}
      >
        {searchBar}
      </NavigationHeader>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <div className="flex justify-between items-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('admin.title')}</h1>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              >
                {showCreateForm ? t('admin.cancel') : t('admin.createUser')}
              </button>
            </div>
          </div>

          {showCreateForm && (
            <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 mb-6 border border-gray-200 dark:border-slate-700">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('admin.createNewUser')}</h2>
              <form onSubmit={handleCreateUser}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.usernameLabel')}
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      placeholder={t('admin.usernamePlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.passwordLabel')}
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
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{t('admin.adminUser')}</span>
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
                    {createLoading ? t('admin.creating') : t('admin.createUserButton')}
                  </button>
                </div>
              </form>
            </div>
          )}

          {error && (
            <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-3 rounded mb-4">
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
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                              {user.username}
                            </p>
                            {user.id === currentUser?.id && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400">{t('admin.youBadge')}</span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {t('admin.userIdCreated', { id: user.id, date: new Date(user.created_at).toLocaleDateString(i18n.resolvedLanguage) })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        {user.role === ROLES.ADMIN && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                            {t('admin.adminBadge')}
                          </span>
                        )}
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                          {t('admin.activeBadge')}
                        </span>
                        <button
                          disabled={user.id === currentUser?.id || roleUpdating.has(user.id)}
                          onClick={() => handleRoleToggle(user)}
                          aria-label={roleUpdating.has(user.id)
                            ? t('admin.updatingRole')
                            : t('admin.roleToggleLabel', {
                                action: user.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin'),
                                username: user.username,
                              })}
                          className="text-sm px-3 py-1 rounded-md border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {roleUpdating.has(user.id)
                            ? t('admin.updatingRole')
                            : user.role === 'admin'
                              ? t('admin.removeAdmin')
                              : t('admin.makeAdmin')}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {(!users || users.length === 0) && !loading && (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">{t('admin.noUsersFound')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Admin;
