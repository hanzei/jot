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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { getBaseUrl } from '../api/client';
import {
  updateMe,
  changePassword,
  uploadProfileIcon,
  deleteProfileIcon,
  getAboutInfo,
  listSessions,
  revokeSession,
} from '../api/settings';
import type { ThemePreference, AboutInfo, ActiveSession } from '@jot/shared';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System Default' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { user, settings, setUser, setSettings } = useAuth();
  const { colors } = useTheme();

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

  const [themePref, setThemePref] = useState<ThemePreference>(settings?.theme ?? 'system');
  const [themeError, setThemeError] = useState('');

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState('');
  const [aboutExpanded, setAboutExpanded] = useState(false);

  useEffect(() => {
    setSessionsLoading(true);
    listSessions()
      .then(setSessions)
      .catch(() => setSessionsError('Failed to load sessions'))
      .finally(() => setSessionsLoading(false));
  }, []);

  const handleRevokeSession = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      await revokeSession(id);
      setSessionsError('');
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {
      setSessionsError('Failed to revoke session');
    } finally {
      setRevokingId(null);
    }
  }, []);

  useEffect(() => {
    if (aboutExpanded && !aboutInfo && !aboutError) {
      setAboutLoading(true);
      getAboutInfo()
        .then(setAboutInfo)
        .catch(() => setAboutError('Failed to load server info'))
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
      setProfileSuccess('Profile updated');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setProfileError(typeof msg === 'string' ? msg.trim() : 'Failed to update profile');
    } finally {
      setProfileSaving(false);
    }
  }, [username, firstName, lastName, setUser, setSettings]);

  const handleChangePassword = useCallback(async () => {
    setPasswordError('');
    setPasswordSuccess('');

    if (!currentPassword) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    if (newPassword.length < 4) {
      setPasswordError('Password must be at least 4 characters');
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess('Password changed');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setPasswordError(typeof msg === 'string' ? msg.trim() : 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  }, [currentPassword, newPassword, confirmPassword]);

  const handleThemeChange = useCallback(async (theme: ThemePreference) => {
    const prev = themePref;
    setThemeError('');
    setThemePref(theme);
    try {
      const { settings: updatedSettings } = await updateMe({ theme });
      setSettings(updatedSettings);
    } catch (err: unknown) {
      setThemePref(prev);
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setThemeError(typeof msg === 'string' ? msg.trim() : 'Failed to update theme');
    }
  }, [themePref, setSettings]);

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
      setIconError(typeof msg === 'string' ? msg.trim() : 'Failed to upload icon');
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
      setIconError('Failed to remove icon');
    } finally {
      setIconDeleting(false);
    }
  }, [setUser]);

  const initials = user
    ? (user.first_name?.[0] ?? user.username?.[0] ?? '').toUpperCase()
    : '';

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight, backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          testID="settings-back"
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
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
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Profile Icon</Text>
            <View style={styles.profileIconRow}>
              <View>
                {hasProfileIcon && user ? (
                  <Image
                    source={{ uri: `${getBaseUrl()}/api/v1/users/${user.id}/profile-icon?v=${iconVersion}` }}
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
                  accessibilityLabel="Upload icon"
                  accessibilityRole="button"
                >
                  {iconUploading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.uploadButtonText}>Upload icon</Text>
                  )}
                </TouchableOpacity>
                {hasProfileIcon && (
                  <TouchableOpacity
                    style={styles.removeIconButton}
                    onPress={handleDeleteIcon}
                    disabled={iconUploading || iconDeleting}
                    testID="settings-remove-icon"
                    accessibilityLabel="Remove icon"
                    accessibilityRole="button"
                  >
                    <Text style={[styles.removeIconText, { color: colors.error }]}>
                      {iconDeleting ? 'Removing...' : 'Remove icon'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            {iconError !== '' && <Text style={[styles.errorText, { color: colors.error }]}>{iconError}</Text>}
          </View>

          {/* Account */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Account</Text>
            <Text style={[styles.label, { color: colors.icon }]}>First Name</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={firstName}
              onChangeText={setFirstName}
              placeholder="First name"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
              accessibilityLabel="First Name"
              testID="settings-first-name"
            />
            <Text style={[styles.label, { color: colors.icon }]}>Last Name</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={lastName}
              onChangeText={setLastName}
              placeholder="Last name"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
              accessibilityLabel="Last Name"
              testID="settings-last-name"
            />
            <Text style={[styles.label, { color: colors.icon }]}>Username</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={username}
              onChangeText={setUsername}
              placeholder="Username"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Username"
              testID="settings-username"
            />
            {profileError !== '' && <Text style={[styles.errorText, { color: colors.error }]}>{profileError}</Text>}
            {profileSuccess !== '' && <Text style={styles.successText}>{profileSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }, profileSaving && styles.buttonDisabled]}
              onPress={handleSaveProfile}
              disabled={profileSaving}
              testID="settings-save-profile"
              accessibilityLabel="Save Changes"
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {profileSaving ? 'Saving...' : 'Save Changes'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Change Password */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Change Password</Text>
            <Text style={[styles.label, { color: colors.icon }]}>Current Password</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Current Password"
              testID="settings-current-password"
            />
            <Text style={[styles.label, { color: colors.icon }]}>New Password</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="At least 4 characters"
              placeholderTextColor={colors.placeholder}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="New Password"
              testID="settings-new-password"
            />
            <Text style={[styles.label, { color: colors.icon }]}>Confirm New Password</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Confirm New Password"
              testID="settings-confirm-password"
            />
            {passwordError !== '' && <Text style={[styles.errorText, { color: colors.error }]}>{passwordError}</Text>}
            {passwordSuccess !== '' && <Text style={styles.successText}>{passwordSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }, passwordSaving && styles.buttonDisabled]}
              onPress={handleChangePassword}
              disabled={passwordSaving}
              testID="settings-change-password"
              accessibilityLabel="Change Password"
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {passwordSaving ? 'Changing...' : 'Change Password'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Active Sessions */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Active Sessions</Text>
            <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
              Manage your active login sessions across devices.
            </Text>
            {sessionsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} style={styles.sessionsLoader} />
            ) : sessionsError !== '' ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{sessionsError}</Text>
            ) : sessions.length === 0 ? (
              <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
                No active sessions found.
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
                            ? `${session.browser} on ${session.os}`
                            : session.browser}
                        </Text>
                        {session.is_current && (
                          <View style={[styles.currentBadge, { backgroundColor: colors.successLight }]}>
                            <Text style={[styles.currentBadgeText, { color: colors.success }]}>Current</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.sessionDate, { color: colors.textMuted }]}>
                        {new Date(session.created_at).toLocaleDateString(undefined, {
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
                        accessibilityLabel="Revoke session"
                        accessibilityRole="button"
                      >
                        <Text style={[
                          styles.revokeText,
                          { color: colors.error },
                          revokingId === session.id && styles.buttonDisabled,
                        ]}>
                          {revokingId === session.id ? 'Revoking...' : 'Revoke'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Appearance */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Appearance</Text>
            <Text style={[styles.label, { color: colors.icon }]}>App theme</Text>
            <View style={styles.themeOptions} accessibilityRole="radiogroup" accessibilityLabel="Theme">
              {THEME_OPTIONS.map((option) => {
                const isActive = themePref === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.themeOption,
                      { borderColor: colors.border, backgroundColor: colors.inputBackground },
                      isActive && { borderColor: colors.primary, backgroundColor: colors.primaryLight },
                    ]}
                    onPress={() => handleThemeChange(option.value)}
                    testID={`settings-theme-${option.value}`}
                    accessibilityLabel={option.label}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isActive }}
                  >
                    <Text
                      style={[
                        styles.themeOptionText, { color: colors.icon },
                        isActive && { color: colors.primary, fontWeight: '600' },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {themeError !== '' && <Text style={[styles.errorText, { color: colors.error }]}>{themeError}</Text>}
          </View>

          {/* About */}
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>About</Text>
            <TouchableOpacity
              style={styles.aboutToggle}
              onPress={() => {
                if (aboutExpanded) setAboutError('');
                setAboutExpanded(!aboutExpanded);
              }}
              testID="settings-about-toggle"
              accessibilityLabel="About Jot"
              accessibilityRole="button"
            >
              <Text style={[styles.aboutToggleText, { color: colors.icon }]}>About Jot</Text>
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
                    <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>Client Info</Text>
                    <AboutRow label="Username" value={user.username} />
                    <AboutRow label="User ID" value={user.id} />
                    <AboutRow label="Role" value={user.role} />
                    <AboutRow
                      label="Account Created"
                      value={new Date(user.created_at).toLocaleDateString()}
                    />
                  </View>
                )}
                <View style={[styles.aboutDivider, { backgroundColor: colors.divider }]} />
                <View style={styles.aboutSection}>
                  <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>Server Info</Text>
                  {aboutLoading && <ActivityIndicator size="small" color={colors.primary} />}
                  {aboutError !== '' && <Text style={[styles.errorText, { color: colors.error }]}>{aboutError}</Text>}
                  {aboutInfo && (
                    <>
                      <AboutRow label="Version" value={aboutInfo.version} />
                      <AboutRow label="Commit" value={aboutInfo.commit} />
                      {aboutInfo.build_time && (
                        <AboutRow
                          label="Build Time"
                          value={formatDate(aboutInfo.build_time)}
                        />
                      )}
                      {aboutInfo.go_version && (
                        <AboutRow label="Go Version" value={aboutInfo.go_version} />
                      )}
                    </>
                  )}
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function formatDate(iso: string): string {
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleString();
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
  themeOptions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  themeOption: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  themeOptionText: {
    fontSize: 14,
    fontWeight: '500',
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
