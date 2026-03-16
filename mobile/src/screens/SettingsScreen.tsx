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
import { getBaseUrl } from '../api/client';
import {
  updateMe,
  changePassword,
  uploadProfileIcon,
  deleteProfileIcon,
  getAboutInfo,
} from '../api/settings';
import type { ThemePreference, AboutInfo } from '../types';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System Default' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { user, settings, setUser, setSettings } = useAuth();

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

  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState('');
  const [aboutExpanded, setAboutExpanded] = useState(false);

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
      if (user) {
        setUser({ ...user, has_profile_icon: false, updated_at: new Date().toISOString() });
      }
    } catch {
      setIconError('Failed to remove icon');
    } finally {
      setIconDeleting(false);
    }
  }, [user, setUser]);

  const initials = user
    ? (user.first_name?.[0] ?? user.username?.[0] ?? '').toUpperCase()
    : '';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          testID="settings-back"
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={24} color="#1a1a1a" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
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
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Profile Icon</Text>
            <View style={styles.profileIconRow}>
              <View>
                {hasProfileIcon && user ? (
                  <Image
                    source={{ uri: `${getBaseUrl()}/api/v1/users/${user.id}/profile-icon?v=${iconVersion}` }}
                    style={styles.profileAvatar}
                  />
                ) : (
                  <View style={styles.profileAvatarFallback}>
                    <Text style={styles.profileAvatarText}>{initials}</Text>
                  </View>
                )}
              </View>
              <View style={styles.profileIconActions}>
                <TouchableOpacity
                  style={styles.uploadButton}
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
                    <Text style={styles.removeIconText}>
                      {iconDeleting ? 'Removing...' : 'Remove icon'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            {iconError !== '' && <Text style={styles.errorText}>{iconError}</Text>}
          </View>

          {/* Account */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Account</Text>
            <Text style={styles.label}>First Name</Text>
            <TextInput
              style={styles.input}
              value={firstName}
              onChangeText={setFirstName}
              placeholder="First name"
              placeholderTextColor="#999"
              autoCapitalize="words"
              accessibilityLabel="First Name"
              testID="settings-first-name"
            />
            <Text style={styles.label}>Last Name</Text>
            <TextInput
              style={styles.input}
              value={lastName}
              onChangeText={setLastName}
              placeholder="Last name"
              placeholderTextColor="#999"
              autoCapitalize="words"
              accessibilityLabel="Last Name"
              testID="settings-last-name"
            />
            <Text style={styles.label}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="Username"
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Username"
              testID="settings-username"
            />
            {profileError !== '' && <Text style={styles.errorText}>{profileError}</Text>}
            {profileSuccess !== '' && <Text style={styles.successText}>{profileSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, profileSaving && styles.buttonDisabled]}
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
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Change Password</Text>
            <Text style={styles.label}>Current Password</Text>
            <TextInput
              style={styles.input}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Current Password"
              testID="settings-current-password"
            />
            <Text style={styles.label}>New Password</Text>
            <TextInput
              style={styles.input}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="At least 4 characters"
              placeholderTextColor="#999"
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="New Password"
              testID="settings-new-password"
            />
            <Text style={styles.label}>Confirm New Password</Text>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder=""
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Confirm New Password"
              testID="settings-confirm-password"
            />
            {passwordError !== '' && <Text style={styles.errorText}>{passwordError}</Text>}
            {passwordSuccess !== '' && <Text style={styles.successText}>{passwordSuccess}</Text>}
            <TouchableOpacity
              style={[styles.primaryButton, passwordSaving && styles.buttonDisabled]}
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

          {/* Appearance */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Appearance</Text>
            <Text style={styles.label}>App theme</Text>
            <View style={styles.themeOptions} accessibilityRole="radiogroup" accessibilityLabel="Theme">
              {THEME_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.themeOption,
                    themePref === option.value && styles.themeOptionActive,
                  ]}
                  onPress={() => handleThemeChange(option.value)}
                  testID={`settings-theme-${option.value}`}
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: themePref === option.value }}
                >
                  <Text
                    style={[
                      styles.themeOptionText,
                      themePref === option.value && styles.themeOptionTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {themeError !== '' && <Text style={styles.errorText}>{themeError}</Text>}
          </View>

          {/* About */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
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
              <Text style={styles.aboutToggleText}>About Jot</Text>
              <Ionicons
                name={aboutExpanded ? 'chevron-up' : 'chevron-down'}
                size={20}
                color="#666"
              />
            </TouchableOpacity>
            {aboutExpanded && (
              <View style={styles.aboutContent}>
                {user && (
                  <View style={styles.aboutSection}>
                    <Text style={styles.aboutSectionTitle}>Client Info</Text>
                    <AboutRow label="Username" value={user.username} />
                    <AboutRow label="User ID" value={user.id} />
                    <AboutRow label="Role" value={user.role} />
                    <AboutRow
                      label="Account Created"
                      value={new Date(user.created_at).toLocaleDateString()}
                    />
                  </View>
                )}
                <View style={styles.aboutDivider} />
                <View style={styles.aboutSection}>
                  <Text style={styles.aboutSectionTitle}>Server Info</Text>
                  {aboutLoading && <ActivityIndicator size="small" color="#2563eb" />}
                  {aboutError !== '' && <Text style={styles.errorText}>{aboutError}</Text>}
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
  return (
    <View style={styles.aboutRow}>
      <Text style={styles.aboutLabel}>{label}</Text>
      <Text style={styles.aboutValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
    borderBottomColor: '#f3f4f6',
    backgroundColor: '#f9fafb',
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
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
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#444',
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1a1a1a',
    backgroundColor: '#f9fafb',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
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
    color: '#ef4444',
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
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  profileAvatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#2563eb',
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
    backgroundColor: '#2563eb',
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
    color: '#ef4444',
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
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f9fafb',
  },
  themeOptionActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  themeOptionText: {
    fontSize: 14,
    color: '#444',
    fontWeight: '500',
  },
  themeOptionTextActive: {
    color: '#2563eb',
    fontWeight: '600',
  },
  aboutToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  aboutToggleText: {
    fontSize: 15,
    color: '#444',
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
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  aboutDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
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
    color: '#999',
    flexShrink: 0,
  },
  aboutValue: {
    fontSize: 13,
    color: '#1a1a1a',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flexShrink: 1,
    textAlign: 'right',
  },
});
