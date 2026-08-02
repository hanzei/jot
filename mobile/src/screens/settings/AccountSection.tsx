import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../../store/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { updateMe } from '../../api/settings';
import { cacheAuthProfile } from '../../api/client';
import { enqueueOperation, isQueueableError } from '../../db/syncQueue';
import { isOnlineWriteAllowed } from '../../api/serverReachability';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { displayMessage, extractApiError } from '../../i18n/utils';
import { styles } from './styles';

export default function AccountSection() {
  const { user, settings, setUser, setSettings, isLocalMode } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [profileSaving, setProfileSaving] = useState(false);
  // Both hold a translation key (or, for errors, a server message that isn't
  // one) and are translated at render, so switching language re-renders them in
  // the new language instead of leaving a stale string on screen.
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
    setFirstName(user?.first_name ?? '');
    setLastName(user?.last_name ?? '');
    setUsername(user?.username ?? '');
  }, [user?.first_name, user?.last_name, user?.username]);

  const handleSaveProfile = useCallback(async () => {
    setProfileError('');
    setProfileSuccess('');
    setProfileSaving(true);
    const profileUpdate = { username, first_name: firstName, last_name: lastName };

    const previousUser = user;
    if (user) {
      const optimisticUser = { ...user, ...profileUpdate };
      setUser(optimisticUser);
      // Only mirror server-backed profiles into the offline auth cache (keyed by
      // active server). In local mode AuthProvider persists the profile to the
      // on-device identity instead, so writing here would pollute a server's cache.
      if (settings && !isLocalMode) void cacheAuthProfile({ user: optimisticUser, settings });
    }

    // In local mode there is no server: the optimistic update is terminal and is
    // persisted to the on-device identity by AuthContext. Skip the `PATCH /users/me`
    // round-trip (and the offline-queue fallback, which never drains in local mode).
    if (isLocalMode) {
      setProfileSuccess('settings.profileUpdated');
      setProfileSaving(false);
      return;
    }

    if (!isOnlineWriteAllowed(isConnected)) {
      // Server known-unreachable: skip the doomed round-trip and enqueue the
      // change for replay, matching the hook-layer gate (#716). The enqueue
      // itself is a local SQLite write and can still fail, so it gets the same
      // try/catch/finally as the network path below rather than escaping as an
      // unhandled rejection out of the void-invoked handler.
      try {
        await enqueueOperation(db, {
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: profileUpdate,
        });
        setProfileSuccess('settings.profileUpdated');
      } catch (err: unknown) {
        if (previousUser) {
          setUser(previousUser);
          if (settings) void cacheAuthProfile({ user: previousUser, settings });
        }
        setProfileError(extractApiError(err) ?? 'settings.failedUpdateProfile');
      } finally {
        setProfileSaving(false);
      }
      return;
    }

    try {
      const { user: updatedUser, settings: updatedSettings } = await updateMe(profileUpdate);
      setUser(updatedUser);
      setSettings(updatedSettings);
      void cacheAuthProfile({ user: updatedUser, settings: updatedSettings });
      setProfileSuccess('settings.profileUpdated');
    } catch (err: unknown) {
      if (isQueueableError(err)) {
        await enqueueOperation(db, {
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: profileUpdate,
        });
        setProfileSuccess('settings.profileUpdated');
      } else {
        if (previousUser) {
          setUser(previousUser);
          if (settings) void cacheAuthProfile({ user: previousUser, settings });
        }
        setProfileError(extractApiError(err) ?? 'settings.failedUpdateProfile');
      }
    } finally {
      setProfileSaving(false);
    }
  }, [firstName, lastName, setSettings, setUser, username, user, settings, db, isLocalMode, isConnected]);

  return (
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
      {profileSuccess !== '' && (
        <Text style={[styles.successText, { color: colors.success }]}>{displayMessage(t, profileSuccess)}</Text>
      )}
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
  );
}
