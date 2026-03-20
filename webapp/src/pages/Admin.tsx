import { useState, useEffect, useCallback } from 'react';
import { PASSWORD_MIN_LENGTH, ROLES, VALIDATION, type User, type CreateUserRequest } from '@jot/shared';
import { useTranslation } from 'react-i18next';
import { admin, auth, isAxiosError } from '@/utils/api';
import { isAdmin, removeUser, getUser } from '@/utils/auth';
import { Navigate, useNavigate } from 'react-router';
import AppLayout from '@/components/AppLayout';
import SearchBar from '@/components/SearchBar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useNavigationLinkTabs } from '@/hooks/useNavigationTabs';
import { getUsernameValidationError, isPasswordTooShort } from '@/utils/userValidation';

interface AdminProps {
  onLogout: () => void;
}

type CreateUserField = 'username' | 'password';

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
  const [createTouched, setCreateTouched] = useState<Record<CreateUserField, boolean>>({
    username: false,
    password: false,
  });
  const [showCreateValidationErrors, setShowCreateValidationErrors] = useState(false);
  const [formData, setFormData] = useState<CreateUserRequest>({
    username: '',
    password: '',
    role: ROLES.USER,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [roleUpdating, setRoleUpdating] = useState<Set<string>>(new Set());
  const [deleteLoading, setDeleteLoading] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; user: User | null }>({ open: false, user: null });

  const userIsAdmin = isAdmin();
  const { tabs: navigationTabs, bottomTabs: bottomNavigationTabs } = useNavigationLinkTabs();

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

  const validateUsername = (username: string): string => {
    const errorCode = getUsernameValidationError(username);
    if (!errorCode) {
      return '';
    }
    const translationKeyByError = {
      min: 'admin.usernameMin',
      max: 'admin.usernameMax',
      chars: 'admin.usernameChars',
      edge: 'admin.usernameEdge',
    } as const;
    return t(translationKeyByError[errorCode], {
      min: VALIDATION.USERNAME_MIN_LENGTH,
      max: VALIDATION.USERNAME_MAX_LENGTH,
    });
  };

  const validatePassword = (password: string): string => {
    if (isPasswordTooShort(password)) {
      return t('admin.passwordMin', { min: PASSWORD_MIN_LENGTH });
    }
    return '';
  };

  const validateCreateField = (field: CreateUserField, value: string): string => {
    if (field === 'username') {
      return validateUsername(value);
    }
    return validatePassword(value);
  };

  const usernameValidationError = validateCreateField('username', formData.username);
  const passwordValidationError = validateCreateField('password', formData.password);
  const hasValidationErrors = Boolean(usernameValidationError || passwordValidationError);
  const usernameFieldError = (createTouched.username || showCreateValidationErrors) ? usernameValidationError : '';
  const passwordFieldError = (createTouched.password || showCreateValidationErrors) ? passwordValidationError : '';
  const hasBlockingValidationErrors = Boolean(
    (createTouched.username && usernameValidationError) ||
    (createTouched.password && passwordValidationError) ||
    (showCreateValidationErrors && hasValidationErrors),
  );

  const handleCreateFieldBlur = (field: CreateUserField) => {
    setCreateTouched(prev => ({ ...prev, [field]: true }));
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setShowCreateValidationErrors(true);
    setCreateTouched({ username: true, password: true });

    if (hasValidationErrors) {
      return;
    }

    setCreateLoading(true);

    try {
      const newUser = await admin.createUser(formData);
      setUsers(prev => [newUser, ...prev]);
      setFormData({ username: '', password: '', role: ROLES.USER });
      setCreateTouched({ username: false, password: false });
      setShowCreateValidationErrors(false);
      setShowCreateForm(false);
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setCreateError(msg || t('admin.failedCreateUser'));
      } else {
        setCreateError(t('admin.failedCreateUser'));
      }
    } finally {
      setCreateLoading(false);
    }
  };

  const handleRoleToggle = async (targetUser: User) => {
    const newRole = targetUser.role === ROLES.ADMIN ? ROLES.USER : ROLES.ADMIN;
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

  const handleDeleteUser = (targetUser: User) => {
    setDeleteConfirm({ open: true, user: targetUser });
  };

  const confirmDeleteUser = async () => {
    const targetUser = deleteConfirm.user;
    if (!targetUser) return;
    setDeleteConfirm({ open: false, user: null });
    setError('');
    setDeleteLoading(prev => new Set(prev).add(targetUser.id));
    try {
      await admin.deleteUser(targetUser.id);
      setUsers(prev => prev.filter(u => u.id !== targetUser.id));
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || t('admin.failedDeleteUser'));
      } else {
        setError(t('admin.failedDeleteUser'));
      }
    } finally {
      setDeleteLoading(prev => {
        const next = new Set(prev);
        next.delete(targetUser.id);
        return next;
      });
    }
  };

  const handleSearch = () => {
    const trimmed = searchQuery.trim();
    if (trimmed) {
      navigate(`/?search=${encodeURIComponent(trimmed)}`);
    } else {
      navigate('/');
    }
  };

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div data-testid="loading-spinner" className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const searchBar = (
    <SearchBar
      value={searchQuery}
      onChange={setSearchQuery}
      onSubmit={handleSearch}
    />
  );

  return (
    <AppLayout
      onLogout={handleLogout}
      isAdmin={true}
      adminLinkActive={true}
      sidebarTabs={navigationTabs}
      sidebarBottomTabs={bottomNavigationTabs}
      searchBar={searchBar}
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <div className="flex justify-between items-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('admin.title')}</h1>
              <button
                onClick={() => {
                  setShowCreateForm(!showCreateForm);
                  setCreateError('');
                  setCreateTouched({ username: false, password: false });
                  setShowCreateValidationErrors(false);
                }}
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
                    <label htmlFor="create-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.usernameLabel')}
                    </label>
                    <input
                      id="create-username"
                      type="text"
                      required
                      value={formData.username}
                      onBlur={() => handleCreateFieldBlur('username')}
                      onChange={(e) => {
                        setFormData({ ...formData, username: e.target.value });
                        if (createError) setCreateError('');
                      }}
                      className={`mt-1 block w-full border rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${
                        usernameFieldError
                          ? 'border-red-300 dark:border-red-600'
                          : 'border-gray-300 dark:border-slate-600'
                      }`}
                      placeholder={t('admin.usernamePlaceholder')}
                    />
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <p className="text-gray-500 dark:text-gray-400">
                        {t('admin.usernameHint', {
                          min: VALIDATION.USERNAME_MIN_LENGTH,
                          max: VALIDATION.USERNAME_MAX_LENGTH,
                        })}
                      </p>
                      <span
                        className={formData.username.length > VALIDATION.USERNAME_MAX_LENGTH
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-500 dark:text-gray-400'}
                      >
                        {t('admin.usernameCharacterCount', {
                          current: formData.username.length,
                          max: VALIDATION.USERNAME_MAX_LENGTH,
                        })}
                      </span>
                    </div>
                    {usernameFieldError && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{usernameFieldError}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="create-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.passwordLabel')}
                    </label>
                    <input
                      id="create-password"
                      type="password"
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      value={formData.password}
                      onBlur={() => handleCreateFieldBlur('password')}
                      onChange={(e) => {
                        setFormData({ ...formData, password: e.target.value });
                        if (createError) setCreateError('');
                      }}
                      className={`mt-1 block w-full border rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${
                        passwordFieldError
                          ? 'border-red-300 dark:border-red-600'
                          : 'border-gray-300 dark:border-slate-600'
                      }`}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('admin.passwordHint', { min: PASSWORD_MIN_LENGTH })}
                    </p>
                    {passwordFieldError && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{passwordFieldError}</p>
                    )}
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
                  <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">{createError}</div>
                )}
                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={createLoading || hasBlockingValidationErrors}
                    className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium"
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
            <ul data-testid="users-list" className="divide-y divide-gray-200 dark:divide-slate-700">
              {(users || []).map((user) => (
                <li key={user.id} data-testid={`user-row-${user.username}`}>
                  <div className="px-4 py-4 sm:px-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                              {user.first_name || user.last_name
                                ? `${user.first_name} ${user.last_name}`.trim()
                                : user.username}
                            </p>
                            {(user.first_name || user.last_name) && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">({user.username})</span>
                            )}
                            {user.id === currentUser?.id && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400">{t('admin.youBadge')}</span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400" title={user.id}>
                            {t('admin.userCreated', { date: new Date(user.created_at).toLocaleDateString(i18n.resolvedLanguage) })}
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
                                action: user.role === ROLES.ADMIN ? t('admin.removeAdmin') : t('admin.makeAdmin'),
                                username: user.username,
                              })}
                          className="text-sm px-3 py-1 rounded-md border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {roleUpdating.has(user.id)
                            ? t('admin.updatingRole')
                            : user.role === ROLES.ADMIN
                              ? t('admin.removeAdmin')
                              : t('admin.makeAdmin')}
                        </button>
                        <button
                          disabled={user.id === currentUser?.id || deleteLoading.has(user.id)}
                          onClick={() => handleDeleteUser(user)}
                          aria-label={t('admin.deleteUserLabel', { username: user.username })}
                          className="text-sm px-3 py-1 rounded-md border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 bg-white dark:bg-slate-700 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {deleteLoading.has(user.id) ? t('admin.deleting') : t('admin.deleteUser')}
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

          <ConfirmDialog
            open={deleteConfirm.open}
            title={t('admin.deleteUser')}
            message={deleteConfirm.user ? t('admin.deleteUserConfirm', { username: deleteConfirm.user.username }) : ''}
            confirmLabel={t('admin.deleteUser')}
            onConfirm={confirmDeleteUser}
            onCancel={() => setDeleteConfirm({ open: false, user: null })}
          />
        </div>
      </div>
    </AppLayout>
  );
};

export default Admin;
