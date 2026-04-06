import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { auth, users, sessions as sessionsApi, pats as patsApi, isAxiosError } from '@/utils/api';
import { getUser, setUser, getSettings, setSettings } from '@/utils/auth';
import { getLanguagePreference, resolveLanguage, LanguagePreference } from '@/utils/language';
import { isPasswordTooShort } from '@/utils/userValidation';
import { getThemePreference, applyTheme, ThemePreference } from '@/utils/theme';
import PageContent from '@/components/PageContent';
import ImportModal from '@/components/ImportModal';
import AboutModal from '@/components/AboutModal';
import NewPATModal from '@/components/NewPATModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import type { ActiveSession, PersonalAccessToken } from '@jot/shared';
import { IdentitySecurityColumn, PreferencesInfoColumn } from './settings/SettingsSections';

interface SettingsProps {
  passwordMinLength: number;
}

const Settings = ({ passwordMinLength }: SettingsProps) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  useEffect(() => { document.title = t('pageTitle.settings'); }, [t]);
  const displayMsg = (msg: string) => (i18n.exists(msg) ? t(msg) : msg);
  const currentUser = getUser();
  // currentUsername tracks the persisted value shown in the nav header.
  // draftUsername is the live value bound to the input field.
  const [currentUsername, setCurrentUsername] = useState(currentUser?.username ?? '');
  const [draftUsername, setDraftUsername] = useState(currentUser?.username ?? '');
  const [draftFirstName, setDraftFirstName] = useState(currentUser?.first_name ?? '');
  const [draftLastName, setDraftLastName] = useState(currentUser?.last_name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [hasProfileIcon, setHasProfileIcon] = useState(currentUser?.has_profile_icon ?? false);
  const [iconError, setIconError] = useState('');
  const [iconUploading, setIconUploading] = useState(false);
  const [iconDeleting, setIconDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [languagePref, setLanguagePref] = useState<LanguagePreference>(() => getLanguagePreference());
  const [themePref, setThemePref] = useState<ThemePreference>(() => getThemePreference());
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [sessionPendingRevoke, setSessionPendingRevoke] = useState<ActiveSession | null>(null);
  const [patsList, setPatsList] = useState<PersonalAccessToken[]>([]);
  const [patsLoading, setPatsLoading] = useState(true);
  const [patsError, setPatsError] = useState('');
  const [creatingPAT, setCreatingPAT] = useState(false);
  const [revokingPATIds, setRevokingPATIds] = useState<Set<string>>(new Set());
  const [newlyCreatedPAT, setNewlyCreatedPAT] = useState<PersonalAccessToken | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const data = await sessionsApi.list();
      setActiveSessions(data);
    } catch {
      setSessionsError('settings.sessionsLoadFailed');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    let mounted = true;
    patsApi.list()
      .then((data) => {
        if (mounted) setPatsList(data);
      })
      .catch(() => {
        if (mounted) setPatsError('settings.patsLoadError');
      })
      .finally(() => {
        if (mounted) setPatsLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  const handleCreatePAT = async (name: string) => {
    setCreatingPAT(true);
    setPatsError('');
    try {
      const pat = await patsApi.create({ name });
      setPatsList(prev => [pat, ...prev]);
      setNewlyCreatedPAT(pat);
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setPatsError(msg || 'settings.patsCreateError');
      } else {
        setPatsError('settings.patsCreateError');
      }
    } finally {
      setCreatingPAT(false);
    }
  };

  const handleRevokePAT = async (id: string) => {
    setRevokingPATIds(prev => new Set(prev).add(id));
    try {
      await patsApi.revoke(id);
      setPatsList(prev => prev.filter(p => p.id !== id));
    } catch {
      showToast(t('settings.patsRevokeError'), 'error');
    } finally {
      setRevokingPATIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    setRevokingSessionId(sessionId);
    try {
      await sessionsApi.revoke(sessionId);
      setSessionsError('');
      setActiveSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch {
      setSessionsError('settings.sessionsRevokeFailed');
    } finally {
      setRevokingSessionId(null);
    }
  };

  const handleRequestRevokeSession = (session: ActiveSession) => {
    setSessionPendingRevoke(session);
  };

  const handleConfirmRevokeSession = async () => {
    if (!sessionPendingRevoke) return;
    const sessionID = sessionPendingRevoke.id;
    setSessionPendingRevoke(null);
    await handleRevokeSession(sessionID);
  };

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

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');

    if (isPasswordTooShort(newPassword, passwordMinLength)) {
      setPasswordError(t('auth.passwordMin', { min: passwordMinLength }));
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('settings.passwordsNoMatch');
      return;
    }

    setPasswordSaving(true);
    try {
      await users.changePassword({ current_password: currentPassword, new_password: newPassword });
      showToast(t('settings.passwordChanged'), 'success');
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

    try {
      const { user: updatedUser, settings: updatedSettings } = await users.updateMe({ username: draftUsername, first_name: draftFirstName, last_name: draftLastName });
      setUser(updatedUser);
      if (updatedSettings) setSettings(updatedSettings);
      setCurrentUsername(updatedUser.username);
      setDraftUsername(updatedUser.username);
      setDraftFirstName(updatedUser.first_name ?? '');
      setDraftLastName(updatedUser.last_name ?? '');
      showToast(t('settings.profileUpdated'), 'success');
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
      showToast(t('settings.languageSaved'), 'success');
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
      showToast(t('settings.themeSaved'), 'success');
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
      showToast(t('settings.iconUploaded'), 'success');
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
      showToast(t('settings.iconRemoved'), 'success');
    } catch {
      setIconError(t('settings.iconDeleteFailed'));
    } finally {
      setIconDeleting(false);
    }
  };

  const sessionPendingRevokeLabel = sessionPendingRevoke
    ? (
      sessionPendingRevoke.os !== 'Unknown'
        ? t('settings.sessionsBrowserOnOS', { browser: sessionPendingRevoke.browser, os: sessionPendingRevoke.os })
        : sessionPendingRevoke.browser
    )
    : '';

  return (
    <>
    <PageContent>
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('settings.title')}</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <IdentitySecurityColumn
            t={t}
            currentUser={currentUser}
            currentUsername={currentUsername}
            profileIcon={{
              hasProfileIcon,
              fileInputRef,
              iconUploading,
              iconDeleting,
              iconError,
              onIconUpload: handleIconUpload,
              onIconDelete: handleIconDelete,
            }}
            accountForm={{
              draftFirstName,
              draftLastName,
              draftUsername,
              onDraftFirstNameChange: setDraftFirstName,
              onDraftLastNameChange: setDraftLastName,
              onDraftUsernameChange: setDraftUsername,
              saving,
              error,
              onAccountSubmit: handleSubmit,
            }}
            passwordForm={{
              currentPassword,
              newPassword,
              confirmPassword,
              onCurrentPasswordChange: setCurrentPassword,
              onNewPasswordChange: setNewPassword,
              onConfirmPasswordChange: setConfirmPassword,
              passwordSaving,
              passwordError,
              passwordMinLength,
              onPasswordSubmit: handlePasswordChange,
            }}
            patsSection={{
              pats: patsList,
              patsLoading,
              patsError,
              creatingPAT,
              revokingPATIds,
              onCreatePAT: handleCreatePAT,
              onRevokePAT: handleRevokePAT,
              displayMsg,
            }}
            displayMsg={displayMsg}
          />

          <PreferencesInfoColumn
            t={t}
            sessionsLoading={sessionsLoading}
            sessionsError={sessionsError}
            activeSessions={activeSessions}
            revokingSessionId={revokingSessionId}
            onRequestRevokeSession={handleRequestRevokeSession}
            displayMsg={displayMsg}
            languagePref={languagePref}
            onLanguageChange={handleLanguageChange}
            themePref={themePref}
            onThemeChange={handleThemeChange}
            onOpenImportModal={() => setIsImportModalOpen(true)}
            onOpenAboutModal={() => setIsAboutModalOpen(true)}
          />
        </div>
      </PageContent>

      <ConfirmDialog
        open={Boolean(sessionPendingRevoke)}
        title={t('settings.sessionsRevokeConfirmTitle')}
        message={t('settings.sessionsRevokeConfirmMessage', { session: sessionPendingRevokeLabel })}
        confirmLabel={t('settings.sessionsRevoke')}
        onConfirm={handleConfirmRevokeSession}
        onCancel={() => setSessionPendingRevoke(null)}
      />

      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={() => {}}
      />

      <AboutModal
        isOpen={isAboutModalOpen}
        onClose={() => setIsAboutModalOpen(false)}
      />

      <NewPATModal
        open={Boolean(newlyCreatedPAT)}
        tokenName={newlyCreatedPAT?.name ?? ''}
        token={newlyCreatedPAT?.token ?? ''}
        onClose={() => setNewlyCreatedPAT(null)}
      />
    </>
  );
};

export default Settings;
