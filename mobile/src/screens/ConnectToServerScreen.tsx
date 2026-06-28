import React, { useContext, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme/ThemeContext';
import { probeServerReachability } from '../api/client';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { VALIDATION } from '@jot/shared';
import { displayMessage } from '../i18n/utils';
import { registerOnServer, runPreflightChecks } from '../store/upgradeToServer';
import type { PreflightFailReason } from '../store/upgradeToServer';
import FadeInView from '../components/FadeInView';

type Step =
  | { name: 'serverUrl' }
  | { name: 'register'; serverUrl: string }
  | { name: 'checking'; serverUrl: string }
  | { name: 'success' }
  | { name: 'error'; reason: PreflightFailReason | 'REGISTRATION_FAILED' | 'UNREACHABLE' | 'INVALID_SERVER' | string };

export default function ConnectToServerScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [step, setStep] = useState<Step>({ name: 'serverUrl' });
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleCheckServer = async () => {
    setFieldError('');
    const trimmed = serverUrlInput.trim();
    if (!trimmed) {
      setFieldError(t('auth.serverUrlRequired'));
      return;
    }
    setBusy(true);
    try {
      const probe = await probeServerReachability(trimmed);
      if (!probe.ok) {
        if (probe.reason === 'INVALID_URL') {
          setFieldError(t('auth.serverUrlProtocol'));
        } else if (probe.reason === 'AUTH_ENDPOINT_UNAVAILABLE') {
          setFieldError(t('auth.serverSetupConnectionInvalidServer'));
        } else {
          setFieldError(t('auth.serverSetupConnectionFailed'));
        }
        return;
      }
      setServerUrlInput(probe.canonicalUrl);
      setStep({ name: 'register', serverUrl: probe.canonicalUrl });
    } catch {
      setFieldError(t('auth.serverSetupConnectionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const validateRegistration = (): string | null => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) return t('auth.usernameRequired');
    if (trimmedUsername.length < VALIDATION.USERNAME_MIN_LENGTH) return t('auth.usernameMin');
    if (trimmedUsername.length > VALIDATION.USERNAME_MAX_LENGTH) return t('auth.usernameMax');
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedUsername)) return t('auth.usernameChars');
    if (/^[_-]|[_-]$/.test(trimmedUsername)) return t('auth.usernameEdge');
    if (!password.trim()) return t('auth.passwordRequired');
    if ([...password].length < VALIDATION.PASSWORD_MIN_LENGTH) {
      return t('auth.passwordMin', { min: VALIDATION.PASSWORD_MIN_LENGTH });
    }
    return null;
  };

  const handleRegister = async () => {
    if (step.name !== 'register') return;
    const validationError = validateRegistration();
    if (validationError) {
      setFieldError(validationError);
      return;
    }
    setFieldError('');
    setBusy(true);
    const serverUrl = step.serverUrl;
    try {
      const session = await registerOnServer(serverUrl, username.trim(), password);
      setStep({ name: 'checking', serverUrl });
      const result = await runPreflightChecks(session);
      if (result.ok) {
        setStep({ name: 'success' });
      } else {
        setStep({ name: 'error', reason: result.reason });
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'USERNAME_TAKEN') {
        setFieldError(t('upgrade.usernameTaken'));
        setStep({ name: 'register', serverUrl });
      } else if (code === 'INVALID_URL' || code === 'NO_SESSION') {
        setStep({ name: 'error', reason: 'UNREACHABLE' });
      } else {
        setStep({ name: 'error', reason: 'REGISTRATION_FAILED' });
      }
    } finally {
      setBusy(false);
    }
  };

  function preflightErrorMessage(reason: string): string {
    switch (reason) {
      case 'CLIENT_ID_NOT_HONORED':
      case 'DEDUP_409_MISSING':
      case 'ENDPOINT_SHAPE_ERROR':
        return t('upgrade.capabilityFailed');
      case 'NOTES_NOT_EMPTY':
      case 'LABELS_NOT_EMPTY':
        return t('upgrade.emptinessFailed');
      case 'FETCH_FAILED':
        return t('upgrade.fetchFailed');
      case 'UNREACHABLE':
        return t('auth.serverSetupConnectionFailed');
      case 'INVALID_SERVER':
        return t('auth.serverSetupConnectionInvalidServer');
      default:
        return displayMessage(t, reason);
    }
  }

  const renderContent = () => {
    if (step.name === 'serverUrl') {
      return (
        <>
          <Text style={[styles.title, { color: colors.text }]}>{t('upgrade.title')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('upgrade.subtitle')}</Text>

          {fieldError ? (
            <FadeInView>
              <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {fieldError}
              </Text>
            </FadeInView>
          ) : null}

          <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upgrade.serverUrlLabel')}</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('upgrade.serverUrlPlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={serverUrlInput}
            onChangeText={setServerUrlInput}
            testID="upgrade-server-url-input"
            accessibilityLabel={t('upgrade.serverUrlLabel')}
          />

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.buttonDisabled]}
            onPress={handleCheckServer}
            disabled={busy}
            testID="upgrade-server-url-submit"
            accessibilityRole="button"
            accessibilityLabel={busy ? t('common.loading') : t('upgrade.continue')}
            accessibilityState={{ disabled: busy, busy }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{t('upgrade.continue')}</Text>}
          </TouchableOpacity>
        </>
      );
    }

    if (step.name === 'register') {
      return (
        <>
          <Text style={[styles.title, { color: colors.text }]}>{t('upgrade.registerTitle')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{step.serverUrl}</Text>

          {fieldError ? (
            <FadeInView>
              <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {fieldError}
              </Text>
            </FadeInView>
          ) : null}

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.usernamePlaceholderLong')}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
            testID="upgrade-username-input"
            accessibilityLabel={t('settings.usernameLabel')}
          />

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.passwordPlaceholderLong')}
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            testID="upgrade-password-input"
            accessibilityLabel={t('auth.passwordPlaceholder')}
          />

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.buttonDisabled]}
            onPress={handleRegister}
            disabled={busy}
            testID="upgrade-register-button"
            accessibilityRole="button"
            accessibilityLabel={busy ? t('auth.creatingAccount') : t('auth.createAccount')}
            accessibilityState={{ disabled: busy, busy }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{t('auth.createAccount')}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backLink}
            onPress={() => { setFieldError(''); setStep({ name: 'serverUrl' }); }}
            testID="upgrade-back-to-server-url"
            accessibilityRole="button"
          >
            <Text style={[styles.backLinkText, { color: colors.primary }]}>{t('upgrade.changeServer')}</Text>
          </TouchableOpacity>
        </>
      );
    }

    if (step.name === 'checking') {
      return (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} style={styles.checkingSpinner} />
          <Text style={[styles.checkingTitle, { color: colors.text }]}>{t('upgrade.checkingTitle')}</Text>
          <Text style={[styles.checkingSubtitle, { color: colors.textSecondary }]}>{step.serverUrl}</Text>
        </View>
      );
    }

    if (step.name === 'success') {
      return (
        <View style={styles.centeredState}>
          <Ionicons name="checkmark-circle" size={64} color={colors.success ?? colors.primary} style={styles.resultIcon} />
          <Text style={[styles.resultTitle, { color: colors.text }]}>{t('upgrade.successTitle')}</Text>
          <Text style={[styles.resultSubtitle, { color: colors.textSecondary }]}>{t('upgrade.successSubtitle')}</Text>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={() => navigation.goBack()}
            testID="upgrade-success-done"
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
          >
            <Text style={styles.primaryButtonText}>{t('common.done')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // error step
    return (
      <View style={styles.centeredState}>
        <Ionicons name="close-circle" size={64} color={colors.error} style={styles.resultIcon} />
        <Text style={[styles.resultTitle, { color: colors.text }]}>{t('upgrade.errorTitle')}</Text>
        <Text style={[styles.resultSubtitle, { color: colors.textSecondary }]}>
          {preflightErrorMessage(step.reason)}
        </Text>
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
          onPress={() => navigation.goBack()}
          testID="upgrade-error-cancel"
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
        >
          <Text style={styles.primaryButtonText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.borderLight, backgroundColor: colors.surface }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.closeButton}
          testID="upgrade-close"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Ionicons name="close" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        {renderContent()}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  closeButton: {
    padding: 8,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  error: {
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  backLink: {
    marginTop: 16,
    alignItems: 'center',
  },
  backLinkText: {
    fontSize: 14,
  },
  centeredState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
  },
  checkingSpinner: {
    marginBottom: 24,
  },
  checkingTitle: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  checkingSubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  resultIcon: {
    marginBottom: 20,
  },
  resultTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  resultSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
    paddingHorizontal: 16,
  },
});
