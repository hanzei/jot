import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { MagnifyingGlassIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import LetterAvatar from '@/components/LetterAvatar';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { auth, users, isAxiosError } from '@/utils/api';
import { getUser, setUser, removeUser, getSettings, setSettings, isAdmin } from '@/utils/auth';
import { getLanguagePreference, resolveLanguage, LanguagePreference, SUPPORTED_LANGUAGES } from '@/utils/language';
import { getThemePreference, applyTheme, ThemePreference } from '@/utils/theme';
import NavigationHeader from '@/components/NavigationHeader';
import ImportModal from '@/components/ImportModal';
import AboutModal from '@/components/AboutModal';
import Sidebar from '@/components/Sidebar';
import { useNavigationLinkTabs } from '@/hooks/useNavigationTabs';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

interface SettingsProps {
  onLogout: () => void;
}

const Settings = ({ onLogout }: SettingsProps) => {
  const { t } = useTranslation();
  useEffect(() => { document.title = t('pageTitle.settings'); }, [t]);
  const displayMsg = (msg: string) => (i18n.exists(msg) ? t(msg) : msg);
  const currentUser = getUser();
  const navigate = useNavigate();
  // currentUsername tracks the persisted value shown in the nav header.
  // draftUsername is the live value bound to the input field.
  const [currentUsername, setCurrentUsername] = useState(currentUser?.username ?? '');
  const [draftUsername, setDraftUsername] = useState(currentUser?.username ?? '');
  const [draftFirstName, setDraftFirstName] = useState(currentUser?.first_name ?? '');
  const [draftLastName, setDraftLastName] = useState(currentUser?.last_name ?? '');
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
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [hasProfileIcon, setHasProfileIcon] = useState(currentUser?.has_profile_icon ?? false);
  const [iconError, setIconError] = useState('');
  const [iconUploading, setIconUploading] = useState(false);
  const [iconDeleting, setIconDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [languagePref, setLanguagePref] = useState<LanguagePreference>(() => getLanguagePreference());
  const [themePref, setThemePref] = useState<ThemePreference>(() => getThemePreference());

  useEffect(() => {
    auth.me().then(({ settings: serverSettings }) => {
      setSettings(serverSettings);
      const langPref = serverSettings.language as LanguagePreference;
      setLanguagePref(langPref);
      i18n.changeLanguage(resolveLanguage(langPref));
      const tPref = serverSettings.theme as ThemePreference;
      setThemePref(tPref);
      applyTheme(tPref);
    }).catch(() => { /* keep cached/system default */ });
  }, []);

  const handleLogout = async () => {
    try {
      await auth.logout();
      removeUser();
      onLogout();
    } catch {
      setError('settings.logoutFailed');
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword !== confirmPassword) {
      setPasswordError('settings.passwordsNoMatch');
      return;
    }

    setPasswordSaving(true);
    try {
      await users.changePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess('settings.passwordChanged');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setPasswordError(msg || 'settings.failedChangePassword');
      } else {
        setPasswordError('settings.failedChangePassword');
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
      const { user: updatedUser, settings: updatedSettings } = await users.updateMe({ username: draftUsername, first_name: draftFirstName, last_name: draftLastName });
      setUser(updatedUser);
      if (updatedSettings) setSettings(updatedSettings);
      setCurrentUsername(updatedUser.username);
      setDraftUsername(updatedUser.username);
      setDraftFirstName(updatedUser.first_name ?? '');
      setDraftLastName(updatedUser.last_name ?? '');
      setSuccess('settings.profileUpdated');
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || 'settings.failedUpdateUsername');
      } else {
        setError('settings.failedUpdateUsername');
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

  const handleLanguageChange = async (pref: LanguagePreference) => {
    const prev = languagePref;
    const current = getSettings();
    setLanguagePref(pref);
    i18n.changeLanguage(resolveLanguage(pref));
    if (current) {
      setSettings({ ...current, language: pref });
    }
    try {
      const { settings: updatedSettings } = await users.updateMe({ language: pref });
      if (updatedSettings) setSettings(updatedSettings);
    } catch {
      setLanguagePref(prev);
      i18n.changeLanguage(resolveLanguage(prev));
      if (current) {
        setSettings(current);
      }
    }
  };

  const handleThemeChange = async (pref: ThemePreference) => {
    const prev = themePref;
    const current = getSettings();
    setThemePref(pref);
    applyTheme(pref);
    if (current) {
      setSettings({ ...current, theme: pref });
    }
    try {
      const { settings: updatedSettings } = await users.updateMe({ theme: pref });
      if (updatedSettings) setSettings(updatedSettings);
    } catch {
      setThemePref(prev);
      applyTheme(prev);
      if (current) {
        setSettings(current);
      }
    }
  };

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconError('');
    setIconUploading(true);
    try {
      const updatedUser = await users.uploadProfileIcon(file);
      setUser(updatedUser);
      setHasProfileIcon(true);
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setIconError(msg || t('settings.iconUploadFailed'));
      } else {
        setIconError(t('settings.iconUploadFailed'));
      }
    } finally {
      setIconUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleIconDelete = async () => {
    setIconError('');
    setIconDeleting(true);
    try {
      await users.deleteProfileIcon();
      const user = getUser();
      if (user) {
        setUser({ ...user, has_profile_icon: false, updated_at: new Date().toISOString() });
      }
      setHasProfileIcon(false);
    } catch {
      setIconError(t('settings.iconDeleteFailed'));
    } finally {
      setIconDeleting(false);
    }
  };

  const navigationTabs = useNavigationLinkTabs();
  const { collapsed, toggle: toggleSidebar, collapse: collapseSidebar } = useSidebarCollapsed();

  const searchBar = (
    <div className="w-full sm:max-w-4xl">
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
    <div className="h-dvh bg-gray-50 dark:bg-slate-900 flex flex-col">
      <NavigationHeader onLogout={handleLogout} username={currentUsername} settingsLinkActive={true} isAdmin={isAdmin()} onToggleSidebar={toggleSidebar}>
        {searchBar}
      </NavigationHeader>

      <div className="relative flex flex-1 min-h-0">
        <Sidebar tabs={navigationTabs} collapsed={collapsed} onCollapse={collapseSidebar} />
        <div className="flex-1 overflow-y-auto max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('settings.title')}</h1>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.profileIconSection')}</h2>
            <div className="flex items-center space-x-4">
              <div className="flex-shrink-0">
                {hasProfileIcon && currentUser ? (
                  <img
                    src={`/api/v1/users/${currentUser.id}/profile-icon?v=${currentUser.updated_at}`}
                    alt={currentUsername}
                    className="h-16 w-16 rounded-full object-cover border border-gray-200 dark:border-slate-600"
                  />
                ) : (
                  <LetterAvatar firstName={currentUser?.first_name} username={currentUsername} className="h-16 w-16" />
                )}
              </div>
              <div className="flex flex-col space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleIconUpload}
                  aria-label={t('settings.uploadIconButton')}
                />
                <button
                  type="button"
                  disabled={iconUploading || iconDeleting}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50"
                >
                  {iconUploading ? t('settings.iconUploading') : t('settings.uploadIconButton')}
                </button>
                {hasProfileIcon && (
                  <button
                    type="button"
                    onClick={handleIconDelete}
                    disabled={iconUploading || iconDeleting}
                    className="text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-left"
                  >
                    {t('settings.removeIconButton')}
                  </button>
                )}
              </div>
            </div>
            {iconError && (
              <div role="alert" className="mt-3 text-red-600 dark:text-red-400 text-sm">{iconError}</div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.accountSection')}</h2>
            <form onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="first-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('settings.firstNameLabel')}
                  </label>
                  <input
                    id="first-name"
                    type="text"
                    value={draftFirstName}
                    onChange={(e) => setDraftFirstName(e.target.value)}
                    className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    placeholder={t('settings.namePlaceholder')}
                  />
                </div>
                <div>
                  <label htmlFor="last-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('settings.lastNameLabel')}
                  </label>
                  <input
                    id="last-name"
                    type="text"
                    value={draftLastName}
                    onChange={(e) => setDraftLastName(e.target.value)}
                    className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    placeholder={t('settings.namePlaceholder')}
                  />
                </div>
              </div>
              <div className="mt-4">
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('settings.usernameLabel')}
                </label>
                <input
                  id="username"
                  type="text"
                  required
                  value={draftUsername}
                  onChange={(e) => setDraftUsername(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder={t('settings.usernamePlaceholder')}
                />
              </div>

              {error && (
                <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">
                  {displayMsg(error)}
                </div>
              )}
              {success && (
                <div aria-live="polite" className="mt-4 text-green-600 dark:text-green-400 text-sm">
                  {displayMsg(success)}
                </div>
              )}

              <div className="mt-6">
                <button
                  type="submit"
                  disabled={saving}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  {saving ? t('settings.saving') : t('settings.saveChanges')}
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.changePasswordSection')}</h2>
            <form onSubmit={handlePasswordChange}>
              <div>
                <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('settings.currentPasswordLabel')}
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
                  {t('settings.newPasswordLabel')}
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  placeholder={t('settings.newPasswordPlaceholder')}
                />
              </div>

              <div className="mt-4">
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('settings.confirmNewPasswordLabel')}
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
                  {displayMsg(passwordError)}
                </div>
              )}
              {passwordSuccess && (
                <div aria-live="polite" className="mt-4 text-green-600 dark:text-green-400 text-sm">
                  {displayMsg(passwordSuccess)}
                </div>
              )}

              <div className="mt-6">
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  {passwordSaving ? t('settings.changing') : t('settings.changePassword')}
                </button>
              </div>
            </form>
          </div>
          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.languageSection')}</h2>
            <div>
              <label htmlFor="language-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('settings.languageLabel')}
              </label>
              <select
                id="language-select"
                value={languagePref}
                onChange={(e) => handleLanguageChange(e.target.value as LanguagePreference)}
                className="block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="system">{t('settings.languageSystem')}</option>
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{t(`settings.language_${lang}`, { defaultValue: lang.toUpperCase() })}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.themeSection')}</h2>
            <div>
              <label htmlFor="theme-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('settings.themeLabel')}
              </label>
              <select
                id="theme-select"
                value={themePref}
                onChange={(e) => handleThemeChange(e.target.value as ThemePreference)}
                className="block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="system">{t('settings.themeSystem')}</option>
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
              </select>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.importSection')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t('settings.importDescription')}
            </p>
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              <ArrowUpTrayIcon className="h-5 w-5 mr-2" />
              {t('settings.importButton')}
            </button>
          </div>

          <div className="bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700 max-w-md mt-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{t('settings.aboutSection')}</h2>
            <button
              onClick={() => setIsAboutModalOpen(true)}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              {t('settings.aboutButton')}
            </button>
          </div>

        </div>
        </div>
      </div>

      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={() => {}}
      />

      <AboutModal
        isOpen={isAboutModalOpen}
        onClose={() => setIsAboutModalOpen(false)}
      />
    </div>
  );
};

export default Settings;
