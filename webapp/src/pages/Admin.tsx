import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { ROLES, type User, type AdminStatsResponse } from '@jot/shared';
import { useTranslation } from 'react-i18next';
import { admin, auth, isAxiosError } from '@/utils/api';
import { isAdmin, removeUser, getUser } from '@/utils/auth';
import { Navigate, useNavigate } from 'react-router';
import AppLayout from '@/components/AppLayout';
import SearchBar from '@/components/SearchBar';
import SidebarLabels from '@/components/SidebarLabels';
import ConfirmDialog from '@/components/ConfirmDialog';
import CreateUserModal from '@/components/CreateUserModal';
import { useNavigationLinkTabs } from '@/hooks/useNavigationTabs';
import { useSidebarLabelsController } from '@/hooks/useSidebarLabelsController';

interface AdminProps {
  onLogout: () => void;
  passwordMinLength: number;
}

interface StatCardProps {
  title: string;
  value: string;
  valueTestId?: string;
  children?: ReactNode;
}

interface StatLineProps {
  label: string;
  value: string;
  valueTestId?: string;
}

const StatLine = ({ label, value, valueTestId }: StatLineProps) => (
  <div className="flex items-center justify-between gap-4 text-sm">
    <span className="text-gray-500 dark:text-gray-400">{label}</span>
    <span data-testid={valueTestId} className="font-medium text-gray-900 dark:text-white">{value}</span>
  </div>
);

const StatCard = ({ title, value, valueTestId, children }: StatCardProps) => (
  <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
    <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
    <p data-testid={valueTestId} className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{value}</p>
    {children ? <div className="mt-4 space-y-2">{children}</div> : null}
  </div>
);

const StatCardSkeleton = () => (
  <div className="animate-pulse rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
    <div className="h-4 w-24 rounded bg-gray-200 dark:bg-slate-700"></div>
    <div className="mt-3 h-8 w-20 rounded bg-gray-200 dark:bg-slate-700"></div>
    <div className="mt-4 space-y-2">
      <div className="h-4 w-full rounded bg-gray-200 dark:bg-slate-700"></div>
      <div className="h-4 w-5/6 rounded bg-gray-200 dark:bg-slate-700"></div>
      <div className="h-4 w-2/3 rounded bg-gray-200 dark:bg-slate-700"></div>
    </div>
  </div>
);

const Admin = ({ onLogout, passwordMinLength }: AdminProps) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const currentUser = getUser();
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [stats, setStats] = useState<AdminStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statsError, setStatsError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleUpdating, setRoleUpdating] = useState<Set<string>>(new Set());
  const [deleteLoading, setDeleteLoading] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; user: User | null }>({ open: false, user: null });

  const userIsAdmin = isAdmin();
  const { tabs: navigationTabs, bottomTabs: bottomNavigationTabs } = useNavigationLinkTabs();
  const {
    labels: labelsList,
    labelCounts,
    loadLabels,
    loadLabelCounts,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
  } = useSidebarLabelsController();

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

  const formatNumber = useCallback((value: number) => {
    return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  }, [i18n.resolvedLanguage]);

  const formatBytes = useCallback((bytes: number) => {
    if (bytes === 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const maximumFractionDigits = size >= 10 || unitIndex === 0 ? 0 : 1;
    return `${new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits }).format(size)} ${units[unitIndex]}`;
  }, [i18n.resolvedLanguage]);

  const fetchUsers = useCallback(async () => {
    try {
      setUsersLoading(true);
      setUsersLoaded(false);
      const response = await admin.getUsers();
      setUsers(response.users || []);
      setUsersLoaded(true);
    } catch (err) {
      setError(t('admin.failedLoadUsers'));
      console.error(err);
    } finally {
      setUsersLoading(false);
    }
  }, [t]);

  const fetchStats = useCallback(async () => {
    try {
      setStatsLoading(true);
      setStatsError('');
      const response = await admin.getStats();
      setStats(response);
    } catch (err) {
      setStatsError(t('admin.failedLoadStats'));
      console.error(err);
    } finally {
      setStatsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (userIsAdmin) {
      void fetchUsers();
      void fetchStats();
    }
  }, [userIsAdmin, fetchUsers, fetchStats]);

  useEffect(() => {
    if (userIsAdmin) {
      void Promise.all([loadLabels(), loadLabelCounts()]);
    }
  }, [userIsAdmin, loadLabels, loadLabelCounts]);

  if (!userIsAdmin) {
    return <Navigate to="/" />;
  }

  const handleCreateUserSuccess = (newUser: User) => {
    setUsers(prev => [newUser, ...prev]);
    void fetchStats();
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
      void fetchStats();
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

  const searchBar = (
    <SearchBar
      value={searchQuery}
      onChange={setSearchQuery}
      onSubmit={handleSearch}
      stopEscapePropagation={true}
    />
  );

  const sidebarChildren = (
    <SidebarLabels
      labels={labelsList}
      labelCounts={labelCounts}
      onSelect={(labelId) => navigate(`/?label=${encodeURIComponent(labelId)}`)}
      onCreate={handleCreateLabel}
      onRename={handleRenameLabel}
      onDelete={handleDeleteLabel}
    />
  );

  return (
    <AppLayout
      onLogout={handleLogout}
      isAdmin={true}
      adminLinkActive={true}
      sidebarTabs={navigationTabs}
      sidebarBottomTabs={bottomNavigationTabs}
      sidebarChildren={sidebarChildren}
      searchBar={searchBar}
    >
      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('admin.pageHeading')}</h1>
          </div>

          {error && (
            <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          <section data-testid="admin-stats-section" className="mb-6">
            <div className="mb-4">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">{t('admin.stats.title')}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.stats.description')}</p>
            </div>

            {statsError ? (
              <div
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
              >
                {statsError}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {statsLoading ? (
                Array.from({ length: 6 }, (_, index) => <StatCardSkeleton key={index} />)
              ) : stats ? (
                <>
                  <StatCard
                    title={t('admin.stats.cards.users')}
                    value={formatNumber(stats.users.total)}
                    valueTestId="admin-stats-users-total"
                  />

                  <StatCard
                    title={t('admin.stats.cards.notes')}
                    value={formatNumber(stats.notes.total)}
                    valueTestId="admin-stats-notes-total"
                  >
                    <StatLine label={t('admin.stats.metrics.text')} value={formatNumber(stats.notes.text)} />
                    <StatLine label={t('admin.stats.metrics.todo')} value={formatNumber(stats.notes.todo)} />
                    <StatLine label={t('admin.stats.metrics.archived')} value={formatNumber(stats.notes.archived)} />
                    <StatLine label={t('admin.stats.metrics.trashed')} value={formatNumber(stats.notes.trashed)} />
                  </StatCard>

                  <StatCard
                    title={t('admin.stats.cards.sharing')}
                    value={formatNumber(stats.sharing.shared_notes)}
                    valueTestId="admin-stats-shared-notes"
                  >
                    <StatLine label={t('admin.stats.metrics.sharedNotes')} value={formatNumber(stats.sharing.shared_notes)} />
                    <StatLine label={t('admin.stats.metrics.shareLinks')} value={formatNumber(stats.sharing.share_links)} />
                  </StatCard>

                  <StatCard
                    title={t('admin.stats.cards.labels')}
                    value={formatNumber(stats.labels.total)}
                    valueTestId="admin-stats-labels-total"
                  >
                    <StatLine label={t('admin.stats.metrics.totalLabels')} value={formatNumber(stats.labels.total)} />
                    <StatLine label={t('admin.stats.metrics.noteAssociations')} value={formatNumber(stats.labels.note_associations)} />
                  </StatCard>

                  <StatCard
                    title={t('admin.stats.cards.todoItems')}
                    value={formatNumber(stats.todo_items.total)}
                    valueTestId="admin-stats-todo-items-total"
                  >
                    <StatLine label={t('admin.stats.metrics.completed')} value={formatNumber(stats.todo_items.completed)} />
                    <StatLine label={t('admin.stats.metrics.assigned')} value={formatNumber(stats.todo_items.assigned)} />
                  </StatCard>

                  <StatCard
                    title={t('admin.stats.cards.storage')}
                    value={formatBytes(stats.storage.database_size_bytes)}
                    valueTestId="admin-stats-database-size"
                  >
                    <StatLine label={t('admin.stats.metrics.databaseSize')} value={formatBytes(stats.storage.database_size_bytes)} />
                  </StatCard>
                </>
              ) : null}
            </div>
          </section>

          <section className="mb-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">{t('admin.title')}</h2>
              <button
                onClick={() => setShowCreateModal(true)}
                className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              >
                {t('admin.createUser')}
              </button>
            </div>

          <div className="bg-white dark:bg-slate-800 shadow overflow-hidden sm:rounded-md border border-gray-200 dark:border-slate-700">
            {usersLoading ? (
              <div className="flex items-center justify-center px-4 py-12 sm:px-6">
                <div data-testid="loading-spinner" className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"></div>
              </div>
            ) : (
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
            )}
          </div>
          </section>

          {usersLoaded && (!users || users.length === 0) && !usersLoading && (
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

          {showCreateModal && (
            <CreateUserModal
              passwordMinLength={passwordMinLength}
              onClose={() => setShowCreateModal(false)}
              onSuccess={handleCreateUserSuccess}
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
};

export default Admin;
