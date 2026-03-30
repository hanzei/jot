import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
  Platform,
  KeyboardAvoidingView,
  Modal,
  Pressable,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { subscribeToClientActiveServerChanges } from '../api/client';
import { importKeepFile, getNotes } from '../api/notes';
import {
  updateMe,
  changePassword,
  uploadProfileIcon,
  deleteProfileIcon,
  getAboutInfo,
  listSessions,
  revokeSession,
} from '../api/settings';
import type { ThemePreference, AboutInfo, ActiveSession, ImportResponse } from '@jot/shared';
import i18n from '../i18n';
import { SUPPORTED_LANGUAGES, getLanguagePreference, resolveLanguage, type LanguagePreference } from '../i18n/language';
import { displayMessage, getCurrentLocale } from '../i18n/utils';
import { saveNotes } from '../db/noteQueries';
import { notesLocalQueryScopeKey, notesQueryScopeKey } from '../hooks/queryKeys';
import { getActiveServer } from '../store/serverAccounts';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { user, settings, setUser, setSettings } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const activeServerBaseUrl = useActiveServerBaseUrl();

  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  const hasProfileIcon = user?.has_profile_icon ?? false;
  const [iconUploading, setIconUploading] = useState(false);
  const [iconDeleting, setIconDeleting] = useState(false);
  const [iconError, setIconError] = useState('');
  const [iconVersion, setIconVersion] = useState(user?.updated_at ?? '');

  const [languagePref, setLanguagePref] = useState<LanguagePreference>(
    getLanguagePreference(settings?.language),
  );
  const [languageError, setLanguageError] = useState('');
  const [themePref, setThemePref] = useState<ThemePreference>(settings?.theme ?? 'system');
  const [themeError, setThemeError] = useState('');
  const [openDropdown, setOpenDropdown] = useState<'language' | 'theme' | null>(null);

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [selectedImportFile, setSelectedImportFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState('');
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [activeServerUrl, setActiveServerUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadActiveServer = async () => {
      try {
        const activeServer = await getActiveServer();
        if (mounted) {
          setActiveServerUrl(activeServer?.serverUrl ?? null);
        }
      } catch {
        if (mounted) {
          setActiveServerUrl(null);
        }
      }
    };

    void loadActiveServer();
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      void loadActiveServer();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setLanguagePref(getLanguagePreference(settings?.language));
    setThemePref(settings?.theme ?? 'system');
  }, [settings?.language, settings?.theme]);

  useEffect(() => {
    setProfileSuccess('');
    setPasswordSuccess('');
  }, [settings?.language]);

  useEffect(() => {
    setSessionsLoading(true);
    listSessions()
      .then(setSessions)
      .catch(() => setSessionsError('settings.sessionsLoadFailed'))
      .finally(() => setSessionsLoading(false));
  }, []);

  const handleRevokeSession = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      await revokeSession(id);
      setSessionsError('');
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {
      setSessionsError('settings.sessionsRevokeFailed');
    } finally {
      setRevokingId(null);
    }
  }, []);

  const handleSelectImportFile = useCallback(async () => {
    setImportError('');
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'application/zip', 'application/x-zip-compressed'],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const file = result.assets[0];
    const fileName = file.name.toLowerCase();
    const mimeType = file.mimeType?.toLowerCase() ?? '';
    const isJson = fileName.endsWith('.json') || mimeType === 'application/json';
    const isZip = fileName.endsWith('.zip')
      || mimeType === 'application/zip'
      || mimeType === 'application/x-zip-compressed';

    if (!isJson && !isZip) {
      setSelectedImportFile(null);
      setImportResult(null);
      setImportError('import.invalidFileType');
      return;
    }

    setSelectedImportFile(file);
    setImportResult(null);
    setImportError('');
  }, []);

  const handleImportNotes = useCallback(async () => {
    if (!selectedImportFile) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const response = await importKeepFile({
        uri: selectedImportFile.uri,
        name: selectedImportFile.name,
        mimeType: selectedImportFile.mimeType,
      });
      setImportResult(response);
      setSelectedImportFile(null);
      try {
        const latestNotes = await getNotes();
        await saveNotes(db, latestNotes);
      } catch (syncErr) {
        console.warn('Post-import notes sync failed:', syncErr);
      } finally {
        queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
        queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setImportError(typeof msg === 'string' ? msg.trim() : 'import.importFailed');
    } finally {
      setImporting(false);
    }
  }, [db, queryClient, selectedImportFile]);

  useEffect(() => {
    if (aboutExpanded && !aboutInfo && !aboutError) {
      setAboutLoading(true);
      getAboutInfo()
        .then(setAboutInfo)
        .catch(() => setAboutError('about.failedLoad'))
        .finally(() => setAboutLoading(false));
    }
  }, [aboutExpanded, aboutInfo, aboutError]);

  const handleSaveProfile = useCallback(async () => {
    setProfileError('');
    setProfileSuccess('');
    setProfileSaving(true);
    try {
      const { user: updatedUser, settings: updatedSettings } = await updateMe({
        username, first_name: firstName, last_name: lastName,
      });
      setUser(updatedUser);
      setSettings(updatedSettings);
      setProfileSuccess(t('settings.profileUpdated'));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setProfileError(typeof msg === 'string' ? msg.trim() : 'settings.failedUpdateProfile');
    } finally {
      setProfileSaving(false);
    }
  }, [firstName, lastName, setSettings, setUser, t, username]);

  const handleChangePassword = useCallback(async () => {
    setPasswordError('');
    setPasswordSuccess('');

    if (!currentPassword) {
      setPasswordError(t('settings.currentPasswordRequired'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.passwordsNoMatch'));
      return;
    }
    if (newPassword.length < 4) {
      setPasswordError(t('auth.passwordMin'));
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess(t('settings.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setPasswordError(typeof msg === 'string' ? msg.trim() : 'settings.failedChangePassword');
    } finally {
      setPasswordSaving(false);
    }
  }, [confirmPassword, currentPassword, newPassword, t]);

  const handleLanguageChange = useCallback(async (language: LanguagePreference) => {
    const previousLanguage = languagePref;
    const previousSettings = settings;

    setLanguageError('');
    setLanguagePref(language);
    void i18n.changeLanguage(resolveLanguage(language));

    if (previousSettings) {
      setSettings({ ...previousSettings, language });
    }

    try {
      const { settings: updatedSettings } = await updateMe({ language });
      setSettings(updatedSettings);
    } catch (err: unknown) {
      setLanguagePref(previousLanguage);
      void i18n.changeLanguage(resolveLanguage(previousLanguage));
      if (previousSettings) {
        setSettings(previousSettings);
      }
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setLanguageError(typeof msg === 'string' ? msg.trim() : 'settings.failedUpdateLanguage');
    }
  }, [languagePref, settings, setSettings]);

  const handleThemeChange = useCallback(async (theme: ThemePreference) => {
    const prev = themePref;
    const previousSettings = settings;
    setThemeError('');
    setThemePref(theme);

    if (previousSettings) {
      setSettings({ ...previousSettings, theme });
    }

    try {
      const { settings: updatedSettings } = await updateMe({ theme });
      setSettings(updatedSettings);
    } catch (err: unknown) {
      setThemePref(prev);
      if (previousSettings) {
        setSettings(previousSettings);
      }
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setThemeError(typeof msg === 'string' ? msg.trim() : 'settings.failedUpdateTheme');
    }
  }, [settings, setSettings, themePref]);

  const handleUploadIcon = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.[0]) return;

    setIconError('');
    setIconUploading(true);
    try {
      const updatedUser = await uploadProfileIcon(result.assets[0].uri);
      setUser(updatedUser);
      setIconVersion(updatedUser.updated_at);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setIconError(typeof msg === 'string' ? msg.trim() : 'settings.iconUploadFailed');
    } finally {
      setIconUploading(false);
    }
  }, [setUser]);

  const handleDeleteIcon = useCallback(async () => {
    setIconError('');
    setIconDeleting(true);
    try {
      await deleteProfileIcon();
      setUser(prev =>
        prev ? { ...prev, has_profile_icon: false, updated_at: new Date().toISOString() } : prev,
      );
    } catch {
      setIconError('settings.iconDeleteFailed');
    } finally {
      setIconDeleting(false);
    }
  }, [setUser]);

  const initials = user
    ? (user.first_name?.[0] ?? user.username?.[0] ?? '').toUpperCase()
    : '';
  const currentLocale = getCurrentLocale();
  const languageOptions: { value: LanguagePreference; label: string }[] = [
    { value: 'system', label: t('settings.languageSystem') },
    ...SUPPORTED_LANGUAGES.map((language) => ({
      value: language,
      label: t(`settings.language_${language}`),
    })),
  ];
  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];
  const selectedLanguageLabel = languageOptions.find(option => option.value === languagePref)?.label
    ?? t('settings.languageSystem');
  const selectedThemeLabel = themeOptions.find(option => option.value === themePref)?.label
    ?? t('settings.themeSystem');
  const dropdownOptions = openDropdown === 'language' ? languageOptions : themeOptions;
  const selectedDropdownValue = openDropdown === 'language' ? languagePref : themePref;

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight, backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          testID="settings-back"
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('settings.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 24) + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Profile Icon */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.profileIconSection')}</Text>
            <View style={styles.profileIconRow}>
              <View>
                {hasProfileIcon && user ? (
                  <Image
                    source={{ uri: `${activeServerBaseUrl}/api/v1/users/${user.id}/profile-icon?v=${iconVersion}` }}
                    style={styles.profileAvatar}
                  />
                ) : (
                  <View style={[styles.profileAvatarFallback, { backgroundColor: colors.primary }]}>
                    <Text style={styles.profileAvatarText}>{initials}</Text>
                  </View>
                )}
              </View>
              <View style={styles.profileIconActions}>
                <TouchableOpacity
                  style={[styles.uploadButton, { backgroundColor: colors.primary }]}
                  onPress={handleUploadIcon}
                  disabled={iconUploading || iconDeleting}
                  testID="settings-upload-icon"
                  accessibilityLabel={t('settings.uploadIconButton')}
                  accessibilityRole="button"
                >
                  {iconUploading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.uploadButtonText}>{t('settings.uploadIconButton')}</Text>
                  )}
                </TouchableOpacity>
                {hasProfileIcon && (
                  <TouchableOpacity
                    style={styles.removeIconButton}
                    onPress={handleDeleteIcon}
                    disabled={iconUploading || iconDeleting}
                    testID="settings-remove-icon"
                    accessibilityLabel={t('settings.removeIconButton')}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.removeIconText, { color: colors.error }]}>
                      {iconDeleting ? t('settings.iconRemoving') : t('settings.removeIconButton')}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            {iconError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, iconError)}</Text>
            )}
          </View>

          {/* Account */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.accountSection')}</Text>
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.firstNameLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={firstName}
              onChangeText={setFirstName}
              placeholder={t('settings.namePlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
              accessibilityLabel={t('settings.firstNameLabel')}
              testID="settings-first-name"
            />
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.lastNameLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={lastName}
              onChangeText={setLastName}
              placeholder={t('settings.namePlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
              accessibilityLabel={t('settings.lastNameLabel')}
              testID="settings-last-name"
            />
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.usernameLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={username}
              onChangeText={setUsername}
              placeholder={t('settings.usernamePlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t('settings.usernameLabel')}
              testID="settings-username"
            />
            {profileError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, profileError)}</Text>
            )}
            {profileSuccess !== '' && <Text style={styles.successText}>{profileSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }, profileSaving && styles.buttonDisabled]}
              onPress={handleSaveProfile}
              disabled={profileSaving}
              testID="settings-save-profile"
              accessibilityLabel={t('settings.saveChanges')}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {profileSaving ? t('settings.saving') : t('settings.saveChanges')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Change Password */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.changePasswordSection')}</Text>
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.currentPasswordLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel={t('settings.currentPasswordLabel')}
              testID="settings-current-password"
            />
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.newPasswordLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder={t('settings.newPasswordPlaceholder')}
              placeholderTextColor={colors.placeholder}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel={t('settings.newPasswordLabel')}
              testID="settings-new-password"
            />
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.confirmNewPasswordLabel')}</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel={t('settings.confirmNewPasswordLabel')}
              testID="settings-confirm-password"
            />
            {passwordError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, passwordError)}</Text>
            )}
            {passwordSuccess !== '' && <Text style={styles.successText}>{passwordSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }, passwordSaving && styles.buttonDisabled]}
              onPress={handleChangePassword}
              disabled={passwordSaving}
              testID="settings-change-password"
              accessibilityLabel={t('settings.changePassword')}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {passwordSaving ? t('settings.changing') : t('settings.changePassword')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Active Sessions */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.sessionsSection')}</Text>
            <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
              {t('settings.sessionsDescription')}
            </Text>
            {sessionsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} style={styles.sessionsLoader} />
            ) : sessionsError !== '' ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, sessionsError)}</Text>
            ) : sessions.length === 0 ? (
              <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
                {t('settings.sessionsNone')}
              </Text>
            ) : (
              <View style={styles.sessionsList}>
                {sessions.map((session) => (
                  <View
                    key={session.id}
                    style={[styles.sessionItem, { borderColor: colors.border }]}
                  >
                    <View style={styles.sessionInfo}>
                      <View style={styles.sessionHeader}>
                        <Text style={[styles.sessionBrowser, { color: colors.text }]}>
                          {session.os !== 'Unknown'
                            ? t('settings.sessionsBrowserOnOS', { browser: session.browser, os: session.os })
                            : session.browser}
                        </Text>
                        {session.is_current && (
                          <View style={[styles.currentBadge, { backgroundColor: colors.successLight }]}>
                            <Text style={[styles.currentBadgeText, { color: colors.success }]}>{t('settings.sessionsCurrent')}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.sessionDate, { color: colors.textMuted }]}>
                        {new Date(session.created_at).toLocaleDateString(currentLocale, {
                          year: 'numeric', month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </Text>
                    </View>
                    {!session.is_current && (
                      <TouchableOpacity
                        onPress={() => handleRevokeSession(session.id)}
                        disabled={revokingId === session.id}
                        style={styles.revokeButton}
                        accessibilityLabel={t('settings.sessionsRevoke')}
                        accessibilityRole="button"
                      >
                        <Text style={[
                          styles.revokeText,
                          { color: colors.error },
                          revokingId === session.id && styles.buttonDisabled,
                        ]}>
                          {revokingId === session.id ? t('settings.sessionsRevoking') : t('settings.sessionsRevoke')}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Import */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.importSection')}</Text>
            <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
              {t('settings.importDescription')}
            </Text>
            <TouchableOpacity
              style={[styles.primaryButton, styles.importSelectButton, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}
              onPress={handleSelectImportFile}
              disabled={importing}
              testID="settings-import-select-file"
              accessibilityLabel={t('settings.importButton')}
              accessibilityRole="button"
            >
              <Text style={[styles.importSelectButtonText, { color: colors.text }]}>
                {t('settings.importButton')}
              </Text>
            </TouchableOpacity>
            <Text style={[styles.importFileTypesText, { color: colors.textMuted }]}>{t('import.fileTypes')}</Text>
            {selectedImportFile && (
              <Text style={[styles.importFileName, { color: colors.text }]} numberOfLines={1}>
                {selectedImportFile.name}
              </Text>
            )}
            {importError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, importError)}</Text>
            )}
            {importResult && (
              <>
                <Text style={[styles.successText, styles.importResultText]}>
                  {t('import.importedNotes', { count: importResult.imported })}
                  {importResult.skipped > 0 ? ` ${t('import.skipped', { count: importResult.skipped })}` : ''}
                  {importResult.errors?.length ? `, ${t('import.failed', { count: importResult.errors.length })}` : ''}.
                </Text>
                {importResult.errors && importResult.errors.length > 0 && (
                  <View style={styles.importErrorsContainer}>
                    {importResult.errors.map((error, index) => (
                      <Text key={`${index}-${error}`} style={[styles.errorText, styles.importErrorItem, { color: colors.error }]}>
                        • {error}
                      </Text>
                    ))}
                  </View>
                )}
              </>
            )}
            <TouchableOpacity
              style={[
                styles.primaryButton,
                { backgroundColor: colors.primary },
                (importing || !selectedImportFile) && styles.buttonDisabled,
              ]}
              onPress={handleImportNotes}
              disabled={importing || !selectedImportFile}
              testID="settings-import-submit"
              accessibilityLabel={t('import.importButton')}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {importing ? t('import.importing') : t('import.importButton')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Appearance */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.themeSection')}</Text>
            <Text style={[styles.label, { color: colors.icon }]}>{t('settings.languageLabel')}</Text>
            <TouchableOpacity
              style={[
                styles.dropdownTrigger,
                { borderColor: colors.border, backgroundColor: colors.inputBackground },
              ]}
              onPress={() => setOpenDropdown('language')}
              testID="settings-language-dropdown"
              accessibilityLabel={`${t('settings.languageLabel')}, ${selectedLanguageLabel}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: openDropdown === 'language' }}
            >
              <Text style={[styles.dropdownTriggerText, { color: colors.text }]}>{selectedLanguageLabel}</Text>
              <Ionicons
                name={openDropdown === 'language' ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.icon}
                accessible={false}
              />
            </TouchableOpacity>
            {languageError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, languageError)}</Text>
            )}
            <Text style={[styles.label, styles.preferenceLabel, { color: colors.icon }]}>{t('settings.themeLabel')}</Text>
            <TouchableOpacity
              style={[
                styles.dropdownTrigger,
                { borderColor: colors.border, backgroundColor: colors.inputBackground },
              ]}
              onPress={() => setOpenDropdown('theme')}
              testID="settings-theme-dropdown"
              accessibilityLabel={`${t('settings.themeLabel')}, ${selectedThemeLabel}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: openDropdown === 'theme' }}
            >
              <Text style={[styles.dropdownTriggerText, { color: colors.text }]}>{selectedThemeLabel}</Text>
              <Ionicons
                name={openDropdown === 'theme' ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.icon}
                accessible={false}
              />
            </TouchableOpacity>
            {themeError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, themeError)}</Text>
            )}
          </View>

          {/* Server */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.currentServerSection')}</Text>
            <Text style={[styles.label, styles.serverLabel, { color: colors.icon }]}>{t('settings.currentServerLabel')}</Text>
            <Text style={[styles.serverValue, { color: colors.text }]}>
              {activeServerUrl ?? t('settings.noServerConfigured')}
            </Text>
          </View>

          {/* About */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.aboutSection')}</Text>
            <TouchableOpacity
              style={styles.aboutToggle}
              onPress={() => {
                if (aboutExpanded) setAboutError('');
                setAboutExpanded(!aboutExpanded);
              }}
              testID="settings-about-toggle"
              accessibilityLabel={t('settings.aboutButton')}
              accessibilityRole="button"
            >
              <Text style={[styles.aboutToggleText, { color: colors.icon }]}>{t('settings.aboutButton')}</Text>
              <Ionicons
                name={aboutExpanded ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={colors.textSecondary}
              />
            </TouchableOpacity>
            {aboutExpanded && (
              <View style={styles.aboutContent}>
                {user && (
                  <View style={styles.aboutSection}>
                    <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>{t('about.clientInfo')}</Text>
                    <AboutRow label={t('about.username')} value={user.username} />
                    <AboutRow label={t('about.userId')} value={user.id} />
                    <AboutRow label={t('about.role')} value={user.role} />
                    <AboutRow
                      label={t('about.accountCreated')}
                      value={new Date(user.created_at).toLocaleDateString(currentLocale)}
                    />
                  </View>
                )}
                <View style={[styles.aboutDivider, { backgroundColor: colors.divider }]} />
                <View style={styles.aboutSection}>
                  <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>{t('about.serverInfo')}</Text>
                  <AboutRow
                    label={t('about.serverOrigin')}
                    value={activeServerUrl ?? t('settings.noServerConfigured')}
                  />
                  {aboutLoading && <ActivityIndicator size="small" color={colors.primary} />}
                  {aboutError !== '' && (
                    <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, aboutError)}</Text>
                  )}
                  {aboutInfo && (
                    <>
                      <AboutRow label={t('about.appVersion')} value={aboutInfo.version} />
                      <AboutRow label={t('about.commit')} value={aboutInfo.commit} />
                      {aboutInfo.build_time && (
                        <AboutRow
                          label={t('about.buildTime')}
                          value={formatDate(aboutInfo.build_time, currentLocale)}
                        />
                      )}
                      {aboutInfo.go_version && (
                        <AboutRow label={t('about.goVersion')} value={aboutInfo.go_version} />
                      )}
                    </>
                  )}
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal
        visible={openDropdown !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setOpenDropdown(null)}
      >
        <Pressable
          style={[styles.dropdownOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setOpenDropdown(null)}
          testID="settings-dropdown-overlay"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <View
            style={[styles.dropdownMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessibilityRole="menu"
            onStartShouldSetResponder={() => true}
          >
            <ScrollView style={styles.dropdownOptionsList}>
              {dropdownOptions.map((option) => {
                const isSelected = selectedDropdownValue === option.value;
                const optionType = openDropdown === 'language' ? 'language' : 'theme';
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dropdownOption,
                      { borderBottomColor: colors.borderLight },
                      isSelected && { backgroundColor: colors.primaryLight },
                    ]}
                    onPress={() => {
                      if (isSelected) {
                        setOpenDropdown(null);
                        return;
                      }
                      if (optionType === 'language') {
                        void handleLanguageChange(option.value as LanguagePreference);
                      } else {
                        void handleThemeChange(option.value as ThemePreference);
                      }
                      setOpenDropdown(null);
                    }}
                    testID={`settings-${optionType}-${option.value}`}
                    accessibilityRole="menuitem"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.dropdownOptionText,
                        { color: colors.text },
                        isSelected && { color: colors.primary, fontWeight: '600' },
                      ]}
                    >
                      {option.label}
                    </Text>
                    {isSelected && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function formatDate(iso: string, locale?: string): string {
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(locale);
}

function AboutRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.aboutRow}>
      <Text style={[styles.aboutLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.aboutValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 40,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  section: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  importSelectButton: {
    marginTop: 0,
    borderWidth: 1,
  },
  importSelectButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  importFileTypesText: {
    fontSize: 12,
    marginTop: 8,
  },
  importFileName: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
  },
  importResultText: {
    marginTop: 12,
  },
  importErrorsContainer: {
    marginTop: 8,
    gap: 4,
  },
  importErrorItem: {
    marginTop: 0,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    marginTop: 8,
  },
  successText: {
    color: '#22c55e',
    fontSize: 13,
    marginTop: 8,
  },
  profileIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  profileAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  profileAvatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatarText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
  },
  profileIconActions: {
    gap: 8,
  },
  uploadButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  uploadButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  removeIconButton: {
    paddingVertical: 4,
  },
  removeIconText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownTrigger: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownTriggerText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownOverlay: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  dropdownMenu: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: '70%',
  },
  dropdownOptionsList: {
    maxHeight: '100%',
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  dropdownOptionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  preferenceLabel: {
    marginTop: 16,
  },
  serverLabel: {
    marginTop: 0,
  },
  serverValue: {
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  aboutToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  aboutToggleText: {
    fontSize: 15,
    fontWeight: '500',
  },
  aboutContent: {
    marginTop: 12,
  },
  aboutSection: {
    gap: 4,
  },
  aboutSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  aboutDivider: {
    height: 1,
    marginVertical: 12,
  },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    gap: 8,
  },
  aboutLabel: {
    fontSize: 13,
    flexShrink: 0,
  },
  aboutValue: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flexShrink: 1,
    textAlign: 'right',
  },
  sessionsDescription: {
    fontSize: 13,
    marginBottom: 12,
  },
  sessionsLoader: {
    marginVertical: 8,
  },
  sessionsList: {
    gap: 8,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sessionInfo: {
    flex: 1,
    marginRight: 8,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sessionBrowser: {
    fontSize: 14,
    fontWeight: '500',
  },
  currentBadge: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  currentBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  sessionDate: {
    fontSize: 12,
    marginTop: 2,
  },
  revokeButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  revokeText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
