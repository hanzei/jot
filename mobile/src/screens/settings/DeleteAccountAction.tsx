import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { parseApiError, type DeleteAccountRequest } from '@jot/shared';
import { useAuth } from '../../store/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { useServerConfig } from '../../hooks/useServerConfig';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { isOnlineWriteAllowed, isServerReachable } from '../../api/serverReachability';
import { getUnsyncedChangeCount } from '../../db/accountOwner';
import { AccountDeletionNotSentError, deleteAccount } from '../../store/accountDeletion';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import { displayMessage, extractApiError } from '../../i18n/utils';
import { styles as settingsStyles } from './styles';

function hasResponse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { response?: unknown }).response != null;
}

/**
 * "Delete account" at the end of the account card (#1317). The confirmation
 * says what goes, including the unsynced changes on this device, and asks for
 * the password, or the username on an account without one. Deleting is an
 * online one-shot action with a pending state (spec §4.3), never queued; on
 * success the device signs out like a deliberate logout. Server mode only.
 */
export default function DeleteAccountAction() {
  const { user, endSessionLocally } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { sso } = useServerConfig();
  const { isConnected } = useNetworkStatus();
  const hasPassword = user?.has_password ?? true;
  const ssoLinked = user?.has_sso_linked ?? false;

  const [visible, setVisible] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [confirmation, setConfirmation] = useState('');
  // Translation keys or a server message, resolved at render.
  const [openError, setOpenError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Set synchronously, so a second tap before `deleting` re-renders is ignored.
  const busyRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleOpen = useCallback(async () => {
    if (busyRef.current) return;
    setOpenError('');
    let count: number;
    try {
      count = await getUnsyncedChangeCount(db);
    } catch (err) {
      // An unknown count is not zero: stop rather than warn without it.
      console.warn('Failed to count unsynced changes before deleting the account:', err);
      if (isMountedRef.current) setOpenError('settings.deleteAccountCheckFailed');
      return;
    }
    if (!isMountedRef.current) return;
    setUnsynced(count);
    setConfirmation('');
    setFieldError('');
    setError('');
    setVisible(true);
  }, [db]);

  const handleClose = useCallback(() => {
    if (busyRef.current) return;
    setVisible(false);
  }, []);

  const value = hasPassword ? confirmation : confirmation.trim();

  const handleConfirmationChange = useCallback((text: string) => {
    setConfirmation(text);
    // A rejection was for what was typed then.
    setFieldError('');
  }, []);

  const handleDelete = useCallback(async () => {
    if (busyRef.current || value === '') return;
    setFieldError('');
    setError('');
    // Nothing to fall back on: say so now rather than wait out a timeout.
    if (!isOnlineWriteAllowed(isConnected)) {
      setError('settings.deleteAccountUnreachable');
      return;
    }
    const body = (hasPassword ? { current_password: value } : { username: value }) satisfies DeleteAccountRequest;
    busyRef.current = true;
    setDeleting(true);
    try {
      // On success the session ends and this screen goes with it.
      await deleteAccount(db, body, endSessionLocally);
      if (isMountedRef.current) setVisible(false);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err instanceof AccountDeletionNotSentError) {
        setError(err.reason === 'unreachable' ? 'settings.deleteAccountUnreachable' : 'settings.deleteAccountFailed');
        return;
      }
      const code = parseApiError(err)?.code;
      if (code === 'incorrect_password') {
        setFieldError('apiErrors.incorrectPassword');
      } else if (code === 'incorrect_username') {
        setFieldError('settings.deleteAccountIncorrectUsername');
      } else if (code === 'last_admin') {
        setError('settings.deleteAccountLastAdmin');
      } else if (!hasResponse(err)) {
        // The request went out but no answer came back: the server may have
        // deleted the account and lost the 204, so do not claim it did not.
        setError('settings.deleteAccountUnconfirmed');
      } else if (!isServerReachable()) {
        setError('settings.deleteAccountUnreachable');
      } else {
        setError(extractApiError(err) ?? 'settings.deleteAccountFailed');
      }
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setDeleting(false);
    }
  }, [db, endSessionLocally, hasPassword, isConnected, value]);

  const providerName = sso?.provider_name || 'SSO';
  const fieldLabel = hasPassword
    ? t('settings.deleteAccountPasswordLabel')
    : t('settings.deleteAccountUsernameLabel', { username: user?.username ?? '' });
  const deleteDisabled = deleting || value === '';

  return (
    <View style={[styles.container, { borderTopColor: colors.border }]}>
      <Text style={[settingsStyles.sectionDescription, { color: colors.textSecondary }]}>
        {t('settings.deleteAccountDescription')}
      </Text>
      {openError !== '' && (
        <Text style={[settingsStyles.errorText, { color: colors.error }]} testID="settings-delete-account-open-error">
          {displayMessage(t, openError)}
        </Text>
      )}
      <TouchableOpacity
        style={[settingsStyles.primaryButton, styles.dangerButton, { borderColor: colors.error }]}
        onPress={handleOpen}
        testID="settings-delete-account"
        accessibilityLabel={t('settings.deleteAccount')}
        accessibilityRole="button"
      >
        <Text style={[styles.dangerButtonText, { color: colors.error }]}>{t('settings.deleteAccount')}</Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
        {/* The modal is its own window, out of reach of the settings screen's
            keyboard handling: keep the field and buttons above the keyboard
            the way BottomSheet does (iOS padding, an Android spacer). */}
        <KeyboardAvoidingView
          style={[styles.keyboardArea, { backgroundColor: colors.overlay }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={styles.overlay}
            onPress={handleClose}
            testID="settings-delete-account-overlay"
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Pressable
              style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
              onPress={(event) => event.stopPropagation()}
              testID="settings-delete-account-dialog"
            >
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
                  {t('settings.deleteAccountConfirmTitle')}
                </Text>
                <Text style={[styles.paragraph, { color: colors.text }]}>{t('settings.deleteAccountConfirmMessage')}</Text>
                {ssoLinked && (
                  <Text style={[styles.paragraph, { color: colors.text }]} testID="settings-delete-account-sso-note">
                    {t('settings.deleteAccountSsoNote', { provider: providerName })}
                  </Text>
                )}
                {unsynced > 0 && (
                  <Text
                    style={[styles.paragraph, styles.warning, { color: colors.error }]}
                    testID="settings-delete-account-unsynced"
                  >
                    {t('settings.deleteAccountUnsynced', { count: unsynced })}
                  </Text>
                )}
                <Text style={[settingsStyles.label, { color: colors.icon }]}>{fieldLabel}</Text>
                <TextInput
                  style={[settingsStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
                  value={confirmation}
                  onChangeText={handleConfirmationChange}
                  secureTextEntry={hasPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!deleting}
                  accessibilityLabel={fieldLabel}
                  testID={hasPassword ? 'settings-delete-account-password' : 'settings-delete-account-username'}
                />
                {fieldError !== '' && (
                  <Text
                    style={[settingsStyles.errorText, { color: colors.error }]}
                    testID="settings-delete-account-field-error"
                    accessibilityRole="alert"
                  >
                    {displayMessage(t, fieldError)}
                  </Text>
                )}
                {error !== '' && (
                  <Text
                    style={[settingsStyles.errorText, { color: colors.error }]}
                    testID="settings-delete-account-error"
                    accessibilityRole="alert"
                  >
                    {displayMessage(t, error)}
                  </Text>
                )}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.button, styles.secondaryButton, { borderColor: colors.border }, deleting && settingsStyles.buttonDisabled]}
                    onPress={handleClose}
                    disabled={deleting}
                    testID="settings-delete-account-cancel"
                    accessibilityLabel={t('common.cancel')}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: deleting }}
                  >
                    <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, { backgroundColor: colors.error }, deleteDisabled && settingsStyles.buttonDisabled]}
                    onPress={handleDelete}
                    disabled={deleteDisabled}
                    testID="settings-delete-account-confirm"
                    accessibilityLabel={deleting ? t('settings.deleteAccountDeleting') : t('settings.deleteAccount')}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: deleteDisabled, busy: deleting }}
                  >
                    {deleting ? (
                      <View style={styles.pendingRow}>
                        <ActivityIndicator size="small" color="#fff" testID="settings-delete-account-spinner" />
                        <Text style={styles.primaryText}>{t('settings.deleteAccountDeleting')}</Text>
                      </View>
                    ) : (
                      <Text style={styles.primaryText}>{t('settings.deleteAccount')}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </Pressable>
          </Pressable>
          {Platform.OS === 'android' ? <AndroidKeyboardSpacer /> : null}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// Its own component, so only an open dialog subscribes to keyboard events.
function AndroidKeyboardSpacer() {
  const keyboardHeight = useKeyboardHeight();
  return <View style={{ height: keyboardHeight }} />;
}

const styles = StyleSheet.create({
  keyboardArea: {
    flex: 1,
  },
  container: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  dangerButton: {
    marginTop: 0,
    borderWidth: 1,
  },
  dangerButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    maxHeight: '90%',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  paragraph: {
    fontSize: 14,
    marginBottom: 8,
  },
  warning: {
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
  },
  button: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButton: {
    borderWidth: 1,
  },
  secondaryText: {
    fontWeight: '500',
  },
  primaryText: {
    color: '#fff',
    fontWeight: '600',
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
