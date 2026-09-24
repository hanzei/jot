import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { changePassword } from '../../api/settings';
import { isPasswordTooShort } from '@jot/shared';
import { displayMessage, extractApiError } from '../../i18n/utils';
import { styles } from './styles';
import { useServerConfig } from '../../hooks/useServerConfig';
import { useAuth } from '../../store/AuthContext';

/**
 * Change Password, or Set Password for an account that has none yet (e.g. one
 * created by SSO sign-in, `has_password` false): that form has no
 * current-password field, and the server accepts it without one.
 */
export default function ChangePasswordSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { password_min_length: passwordMinLength, sso } = useServerConfig();
  const { user, setUser } = useAuth();
  const hasPassword = user?.has_password ?? true;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  // Holds a translation key, translated at render, so switching language
  // re-renders it in the new language instead of leaving a stale string.
  const [passwordSuccess, setPasswordSuccess] = useState('');

  const handleChangePassword = useCallback(async () => {
    setPasswordError('');
    setPasswordSuccess('');

    if (hasPassword && !currentPassword) {
      setPasswordError(t('settings.currentPasswordRequired'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.passwordsNoMatch'));
      return;
    }
    if (isPasswordTooShort(newPassword, passwordMinLength)) {
      setPasswordError(t('auth.passwordMin', { min: passwordMinLength }));
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword(hasPassword
        ? { current_password: currentPassword, new_password: newPassword }
        : { new_password: newPassword });
      setPasswordSuccess(hasPassword ? 'settings.passwordChanged' : 'settings.passwordSet');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (!hasPassword) {
        setUser((prev) => (prev ? { ...prev, has_password: true } : prev));
      }
    } catch (err: unknown) {
      setPasswordError(extractApiError(err) ?? (hasPassword ? 'settings.failedChangePassword' : 'settings.failedSetPassword'));
    } finally {
      setPasswordSaving(false);
    }
  }, [confirmPassword, currentPassword, hasPassword, newPassword, passwordMinLength, setUser, t]);

  // On an SSO-only server a password cannot be used to sign in.
  if (sso?.enabled && !sso.local_login_enabled) {
    return null;
  }

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>
        {t(hasPassword ? 'settings.changePasswordSection' : 'settings.setPasswordSection')}
      </Text>
      {hasPassword ? (
        <>
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
        </>
      ) : (
        <Text style={[styles.label, { color: colors.icon }]}>{t('settings.setPasswordDescription')}</Text>
      )}
      <Text style={[styles.label, { color: colors.icon }]}>{t('settings.newPasswordLabel')}</Text>
      <TextInput
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
        value={newPassword}
        onChangeText={setNewPassword}
        placeholder={t('settings.newPasswordPlaceholder', { min: passwordMinLength })}
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
      {passwordSuccess !== '' && (
        <Text style={[styles.successText, { color: colors.success }]}>{displayMessage(t, passwordSuccess)}</Text>
      )}
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.primary }, passwordSaving && styles.buttonDisabled]}
        onPress={handleChangePassword}
        disabled={passwordSaving}
        testID="settings-change-password"
        accessibilityLabel={t(hasPassword ? 'settings.changePassword' : 'settings.setPassword')}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>
          {passwordSaving
            ? t(hasPassword ? 'settings.changing' : 'settings.saving')
            : t(hasPassword ? 'settings.changePassword' : 'settings.setPassword')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
