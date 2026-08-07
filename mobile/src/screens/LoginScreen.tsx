import { useContext, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react-native';
import { useAuth } from '../store/AuthContext';
import { getStoredServerUrl } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import type { AuthStackParamList } from '../navigation/AuthStack';
import ServerSetupGate from '../components/ServerSetupGate';
import FadeInView from '../components/FadeInView';
import { displayMessage } from '../i18n/utils';

type LoginScreenProps = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export default function LoginScreen({ navigation }: LoginScreenProps) {
  const { login, enableLocalMode, sessionEndedReason, clearSessionEndedReason } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [localModeLoading, setLocalModeLoading] = useState(false);
  // When a server account already exists (e.g. the user was bounced here by an
  // expired session), entering local mode would switch them into a separate,
  // empty on-device notebook. Confirm first so an accidental tap can't strand
  // them away from their server notes. `null` means the lookup hasn't resolved
  // yet; the local-mode button stays disabled until it does so a tap can't race
  // ahead of the check and skip the confirmation.
  const [hasConfiguredServer, setHasConfiguredServer] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStoredServerUrl()
      .then((url) => {
        if (!cancelled) setHasConfiguredServer(!!url);
      })
      .catch(() => {
        // Fail safe: if we can't determine whether a server is configured, keep
        // the confirmation guard active rather than risking a silent switch.
        if (!cancelled) setHasConfiguredServer(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError(t('auth.usernamePasswordRequired'));
      return;
    }

    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; data?: string } })?.response;
      if (!response) {
        setError(t('auth.unableToConnect'));
      } else {
        const message = response.data;
        setError(
          typeof message === 'string' && message
            ? displayMessage(t, message)
            : t('auth.loginFailed'),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const enterLocalMode = async () => {
    setError('');
    setLocalModeLoading(true);
    try {
      await enableLocalMode();
    } catch {
      setError(t('auth.localModeFailed'));
    } finally {
      setLocalModeLoading(false);
    }
  };

  const handleUseLocalMode = () => {
    if (hasConfiguredServer === null) {
      // Lookup hasn't resolved yet; the button is disabled in this state so a
      // tap shouldn't reach here, but bail out defensively just in case.
      return;
    }
    if (!hasConfiguredServer) {
      void enterLocalMode();
      return;
    }
    Alert.alert(
      t('auth.localModeConfirmTitle'),
      t('auth.localModeConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('auth.localModeLink'), onPress: () => void enterLocalMode() },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.inner, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text style={[styles.title, { color: colors.text }]}>Jot</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('auth.signInSubtitle')}</Text>

        {sessionEndedReason ? (
          <FadeInView>
            <View
              style={[styles.sessionEndedBanner, { backgroundColor: colors.warning, borderColor: colors.warningBorder }]}
              testID="session-ended-banner"
            >
              <Text style={[styles.sessionEndedText, { color: colors.warningText }]}>
                {t('auth.sessionEndedMessage')}
              </Text>
              <TouchableOpacity
                onPress={clearSessionEndedReason}
                style={styles.sessionEndedDismiss}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={t('auth.sessionEndedDismiss')}
                testID="session-ended-dismiss"
              >
                <X size={16} color={colors.warningText} />
              </TouchableOpacity>
            </View>
          </FadeInView>
        ) : null}

        <ServerSetupGate testPrefix="login">
          {error ? (
            <FadeInView>
              <Text
                style={[styles.error, { color: colors.error }]}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {error}
              </Text>
            </FadeInView>
          ) : null}

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.usernamePlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
            accessibilityLabel={t('settings.usernameLabel')}
            testID="username-input"
          />

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.passwordPlaceholder')}
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            accessibilityLabel={t('auth.passwordPlaceholder')}
            testID="password-input"
          />

          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary }, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            testID="login-button"
            accessibilityRole="button"
            accessibilityLabel={loading ? t('auth.signingIn') : t('auth.signIn')}
            accessibilityState={{ disabled: loading, busy: loading }}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>{t('auth.signIn')}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => navigation.navigate('Register')}
            style={styles.link}
            testID="create-account-link"
            accessibilityRole="button"
            accessibilityLabel={t('auth.createAccountLink')}
          >
            <Text style={[styles.linkText, { color: colors.primary }]}>{t('auth.createAccountLink')}</Text>
          </TouchableOpacity>
        </ServerSetupGate>

        <View style={styles.localModeSection}>
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.inputBorder }]} />
            <Text style={[styles.dividerText, { color: colors.textSecondary }]}>{t('common.or')}</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.inputBorder }]} />
          </View>

          <TouchableOpacity
            onPress={handleUseLocalMode}
            disabled={localModeLoading || hasConfiguredServer === null}
            style={[styles.localModeButton, { borderColor: colors.primary }, localModeLoading && styles.buttonDisabled]}
            testID="use-local-mode-button"
            accessibilityRole="button"
            accessibilityLabel={t('auth.localModeLink')}
            accessibilityState={{ disabled: localModeLoading || hasConfiguredServer === null, busy: localModeLoading }}
          >
            {localModeLoading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={[styles.localModeButtonText, { color: colors.primary }]}>{t('auth.localModeLink')}</Text>
            )}
          </TouchableOpacity>
          <Text style={[styles.localModeHint, { color: colors.textSecondary }]}>{t('auth.localModeHint')}</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 32,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  sessionEndedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
    gap: 8,
  },
  sessionEndedText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
  },
  sessionEndedDismiss: {
    padding: 2,
  },
  link: {
    marginTop: 16,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 14,
  },
  localModeSection: {
    marginTop: 24,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    marginHorizontal: 12,
    fontSize: 13,
  },
  localModeButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  localModeButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  localModeHint: {
    textAlign: 'center',
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
  },
});
