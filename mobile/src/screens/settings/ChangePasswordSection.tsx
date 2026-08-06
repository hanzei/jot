import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { changePassword } from '../../api/settings';
import { VALIDATION } from '@jot/shared';
import { displayMessage, extractApiError } from '../../i18n/utils';
import { styles } from './styles';

export default function ChangePasswordSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();

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

    if (!currentPassword) {
      setPasswordError(t('settings.currentPasswordRequired'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.passwordsNoMatch'));
      return;
    }
    if ([...newPassword].length < VALIDATION.PASSWORD_MIN_LENGTH) {
      setPasswordError(t('auth.passwordMin', { min: VALIDATION.PASSWORD_MIN_LENGTH }));
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess('settings.passwordChanged');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      setPasswordError(extractApiError(err) ?? 'settings.failedChangePassword');
    } finally {
      setPasswordSaving(false);
    }
  }, [confirmPassword, currentPassword, newPassword, t]);

  return (
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
        placeholder={t('settings.newPasswordPlaceholder', { min: VALIDATION.PASSWORD_MIN_LENGTH })}
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
        accessibilityLabel={t('settings.changePassword')}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>
          {passwordSaving ? t('settings.changing') : t('settings.changePassword')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
