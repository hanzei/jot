import type { ChangeEvent, FormEvent, ReactNode, RefObject } from 'react';
import { useState } from 'react';
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import type { TFunction } from 'i18next';
import LetterAvatar from '@/components/LetterAvatar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { SUPPORTED_LANGUAGES, type LanguagePreference } from '@/utils/language';
import type { ThemePreference } from '@/utils/theme';
import { VALIDATION } from '@jot/shared';
import type { ActiveSession, PersonalAccessToken, User } from '@jot/shared';

const CARD_CLASSES = 'bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700';
const SECTION_TITLE_CLASSES = 'text-lg font-medium text-gray-900 dark:text-white mb-4';

type Translate = TFunction;

interface SettingsSectionCardProps {
  title: string;
  children: ReactNode;
}

const SettingsSectionCard = ({ title, children }: SettingsSectionCardProps) => (
  <section className={CARD_CLASSES}>
    <h2 className={SECTION_TITLE_CLASSES}>{title}</h2>
    {children}
  </section>
);

interface PATsSectionProps {
  pats: PersonalAccessToken[];
  patsLoading: boolean;
  patsError: string;
  creatingPAT: boolean;
  revokingPATIds: Set<string>;
  onCreatePAT: (name: string) => void;
  onRevokePAT: (id: string) => void;
  displayMsg: (msg: string) => string;
}

interface IdentitySecurityColumnProps {
  t: Translate;
  currentUser: User | null;
  currentUsername: string;
  profileIcon: ProfileIconProps;
  accountForm: AccountFormProps;
  passwordForm: PasswordFormProps;
  patsSection: PATsSectionProps;
  displayMsg: (msg: string) => string;
}

interface ProfileIconProps {
  hasProfileIcon: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  iconUploading: boolean;
  iconDeleting: boolean;
  iconError: string;
  onIconUpload: (e: ChangeEvent<HTMLInputElement>) => void;
  onIconDelete: () => void | Promise<void>;
}

interface AccountFormProps {
  draftFirstName: string;
  draftLastName: string;
  draftUsername: string;
  onDraftFirstNameChange: (value: string) => void;
  onDraftLastNameChange: (value: string) => void;
  onDraftUsernameChange: (value: string) => void;
  saving: boolean;
  error: string;
  onAccountSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

interface PasswordFormProps {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  passwordSaving: boolean;
  passwordError: string;
  onPasswordSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export const IdentitySecurityColumn = ({
  t,
  currentUser,
  currentUsername,
  profileIcon: {
    hasProfileIcon,
    fileInputRef,
    iconUploading,
    iconDeleting,
    iconError,
    onIconUpload,
    onIconDelete,
  },
  accountForm: {
    draftFirstName,
    draftLastName,
    draftUsername,
    onDraftFirstNameChange,
    onDraftLastNameChange,
    onDraftUsernameChange,
    saving,
    error,
    onAccountSubmit,
  },
  passwordForm: {
    currentPassword,
    newPassword,
    confirmPassword,
    onCurrentPasswordChange,
    onNewPasswordChange,
    onConfirmPasswordChange,
    passwordSaving,
    passwordError,
    onPasswordSubmit,
  },
  patsSection: {
    pats,
    patsLoading,
    patsError,
    creatingPAT,
    revokingPATIds,
    onCreatePAT,
    onRevokePAT,
    displayMsg: patDisplayMsg,
  },
  displayMsg,
}: IdentitySecurityColumnProps) => {
  const [newPATName, setNewPATName] = useState('');
  const [patPendingRevoke, setPATpendingRevoke] = useState<PersonalAccessToken | null>(null);

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    const name = newPATName.trim();
    if (!name || creatingPAT) return;
    onCreatePAT(name);
    setNewPATName('');
  };

  return (
  <div className="space-y-6">
    <SettingsSectionCard title={t('settings.profileIconSection')}>
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
            onChange={onIconUpload}
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
              onClick={onIconDelete}
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
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.accountSection')}>
      <form onSubmit={onAccountSubmit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="first-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('settings.firstNameLabel')}
            </label>
            <input
              id="first-name"
              type="text"
              value={draftFirstName}
              onChange={(e) => onDraftFirstNameChange(e.target.value)}
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
              onChange={(e) => onDraftLastNameChange(e.target.value)}
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
            onChange={(e) => onDraftUsernameChange(e.target.value)}
            className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            placeholder={t('settings.usernamePlaceholder')}
          />
        </div>

        {error && (
          <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">
            {displayMsg(error)}
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
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.changePasswordSection')}>
      <form onSubmit={onPasswordSubmit}>
        <div>
          <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('settings.currentPasswordLabel')}
          </label>
          <input
            id="current-password"
            type="password"
            required
            value={currentPassword}
            onChange={(e) => onCurrentPasswordChange(e.target.value)}
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
            onChange={(e) => onNewPasswordChange(e.target.value)}
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
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {passwordError && (
          <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">
            {displayMsg(passwordError)}
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
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.patsSection')}>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('settings.patsDescription')}
      </p>
      <form onSubmit={handleCreateSubmit} className="flex gap-2 mb-4">
        <input
          type="text"
          value={newPATName}
          onChange={(e) => setNewPATName(e.target.value)}
          placeholder={t('settings.patsNamePlaceholder')}
          maxLength={VALIDATION.PAT_NAME_MAX_LENGTH}
          className="flex-1 min-w-0 border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={creatingPAT || !newPATName.trim()}
          className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium"
        >
          {creatingPAT ? t('settings.patsCreating') : t('settings.patsCreate')}
        </button>
      </form>
      {patsError && (
        <div role="alert" className="mb-3 text-red-600 dark:text-red-400 text-sm">{patDisplayMsg(patsError)}</div>
      )}
      {patsLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.sessionsLoading')}</p>
      ) : pats.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.patsNone')}</p>
      ) : (
        <ul className="space-y-3">
          {pats.map((pat) => (
            <li
              key={pat.id}
              className="flex items-center justify-between rounded-md border border-gray-200 dark:border-slate-600 px-4 py-3"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate block">
                  {pat.name}
                </span>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {new Date(pat.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPATpendingRevoke(pat)}
                disabled={revokingPATIds.has(pat.id)}
                className="ml-4 flex-shrink-0 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
              >
                {revokingPATIds.has(pat.id) ? t('settings.patsRevoking') : t('settings.patsRevoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSectionCard>

    <ConfirmDialog
      open={Boolean(patPendingRevoke)}
      title={t('settings.patsRevokeConfirmTitle')}
      message={t('settings.patsRevokeConfirmMessage', { name: patPendingRevoke?.name ?? '' })}
      confirmLabel={t('settings.patsRevoke')}
      onConfirm={() => {
        if (patPendingRevoke) {
          onRevokePAT(patPendingRevoke.id);
          setPATpendingRevoke(null);
        }
      }}
      onCancel={() => setPATpendingRevoke(null)}
    />
  </div>
  );
};

interface PreferencesInfoColumnProps {
  t: Translate;
  sessionsLoading: boolean;
  sessionsError: string;
  activeSessions: ActiveSession[];
  revokingSessionId: string | null;
  onRequestRevokeSession: (session: ActiveSession) => void;
  displayMsg: (msg: string) => string;
  languagePref: LanguagePreference;
  onLanguageChange: (pref: LanguagePreference) => void;
  themePref: ThemePreference;
  onThemeChange: (pref: ThemePreference) => void;
  onOpenImportModal: () => void;
  onOpenAboutModal: () => void;
}

export const PreferencesInfoColumn = ({
  t,
  sessionsLoading,
  sessionsError,
  activeSessions,
  revokingSessionId,
  onRequestRevokeSession,
  displayMsg,
  languagePref,
  onLanguageChange,
  themePref,
  onThemeChange,
  onOpenImportModal,
  onOpenAboutModal,
}: PreferencesInfoColumnProps) => (
  <div className="space-y-6">
    <SettingsSectionCard title={t('settings.sessionsSection')}>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('settings.sessionsDescription')}
      </p>
      {sessionsLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.sessionsLoading')}</p>
      ) : sessionsError ? (
        <div role="alert" className="text-red-600 dark:text-red-400 text-sm">{displayMsg(sessionsError)}</div>
      ) : activeSessions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.sessionsNone')}</p>
      ) : (
        <ul className="space-y-3">
          {activeSessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between rounded-md border border-gray-200 dark:border-slate-600 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {session.os !== 'Unknown' ? t('settings.sessionsBrowserOnOS', { browser: session.browser, os: session.os }) : session.browser}
                  </span>
                  {session.is_current && (
                    <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900 px-2 py-0.5 text-xs font-medium text-green-800 dark:text-green-200">
                      {t('settings.sessionsCurrent')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {new Date(session.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              {!session.is_current && (
                <button
                  type="button"
                  onClick={() => onRequestRevokeSession(session)}
                  disabled={revokingSessionId !== null}
                  className="ml-4 flex-shrink-0 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
                >
                  {revokingSessionId === session.id ? t('settings.sessionsRevoking') : t('settings.sessionsRevoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.languageSection')}>
      <div>
        <label htmlFor="language-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('settings.languageLabel')}
        </label>
        <select
          id="language-select"
          value={languagePref}
          onChange={(e) => onLanguageChange(e.target.value as LanguagePreference)}
          className="block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="system">{t('settings.languageSystem')}</option>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{t(`settings.language_${lang}`, { defaultValue: lang.toUpperCase() })}</option>
          ))}
        </select>
      </div>
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.themeSection')}>
      <div>
        <label htmlFor="theme-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('settings.themeLabel')}
        </label>
        <select
          id="theme-select"
          value={themePref}
          onChange={(e) => onThemeChange(e.target.value as ThemePreference)}
          className="block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="system">{t('settings.themeSystem')}</option>
          <option value="light">{t('settings.themeLight')}</option>
          <option value="dark">{t('settings.themeDark')}</option>
        </select>
      </div>
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.importSection')}>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('settings.importDescription')}
      </p>
      <button
        type="button"
        onClick={onOpenImportModal}
        className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
      >
        <ArrowUpTrayIcon className="h-5 w-5 mr-2" aria-hidden="true" />
        {t('settings.importButton')}
      </button>
    </SettingsSectionCard>

    <SettingsSectionCard title={t('settings.aboutSection')}>
      <button
        type="button"
        onClick={onOpenAboutModal}
        className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
      >
        {t('settings.aboutButton')}
      </button>
    </SettingsSectionCard>
  </div>
);
