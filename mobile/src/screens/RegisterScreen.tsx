import React, { useContext, useState } from 'react';
import {
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
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { AuthStackParamList } from '../navigation/AuthStack';
import { USERNAME_EDGE_PATTERN, USERNAME_PATTERN, VALIDATION } from '@jot/shared';
import { displayMessage } from '../i18n/utils';
import ServerSetupGate from '../components/ServerSetupGate';
import FadeInView from '../components/FadeInView';

type RegisterScreenProps = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

export default function RegisterScreen({ navigation }: RegisterScreenProps) {
  const { register } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const validate = (): string | null => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) return t('auth.usernameRequired');
    if (trimmedUsername.length < VALIDATION.USERNAME_MIN_LENGTH) {
      return t('auth.usernameMin');
    }
    if (trimmedUsername.length > VALIDATION.USERNAME_MAX_LENGTH) {
      return t('auth.usernameMax');
    }
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      return t('auth.usernameChars');
    }
    if (USERNAME_EDGE_PATTERN.test(trimmedUsername)) {
      return t('auth.usernameEdge');
    }
    if (!password.trim()) return t('auth.passwordRequired');
    if ([...password].length < VALIDATION.PASSWORD_MIN_LENGTH) return t('auth.passwordMin', { min: VALIDATION.PASSWORD_MIN_LENGTH });
    return null;
  };

  const handleRegister = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setLoading(true);
    try {
      await register(username.trim(), password);
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; data?: string } })?.response;
      if (!response) {
        setError(t('auth.unableToConnect'));
      } else {
        const message = response.data;
        setError(
          typeof message === 'string' && message
            ? displayMessage(t, message)
            : t('auth.registrationFailed'),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[styles.inner, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: colors.text }]}>{t('auth.createAccountTitle')}</Text>

        <ServerSetupGate testPrefix="register">
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
            placeholder={t('auth.usernamePlaceholderLong')}
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
            placeholder={t('auth.passwordPlaceholderLong')}
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
            onPress={handleRegister}
            disabled={loading}
            testID="register-button"
            accessibilityRole="button"
            accessibilityLabel={loading ? t('auth.creatingAccount') : t('auth.createAccount')}
            accessibilityState={{ disabled: loading, busy: loading }}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>{t('auth.createAccount')}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.link}
            testID="login-link"
            accessibilityRole="link"
            accessibilityLabel={t('auth.alreadyHaveAccount')}
          >
            <Text style={[styles.linkText, { color: colors.primary }]}>{t('auth.alreadyHaveAccount')}</Text>
          </TouchableOpacity>
        </ServerSetupGate>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
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
  link: {
    marginTop: 16,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 14,
  },
});
