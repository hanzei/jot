import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { AuthStackParamList } from '../navigation/AuthStack';
import { restoreServerUrl, setServerUrl as configureServerUrl } from '../api/client';
import { useServerUrl } from '../hooks/useServerUrl';
import { displayMessage } from '../i18n/utils';

type LoginScreenProps = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export default function LoginScreen({ navigation }: LoginScreenProps) {
  const { login } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { serverUrl, setServerUrl, validateServerUrl } = useServerUrl();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const urlError = validateServerUrl(serverUrl);
    if (urlError) {
      setError(displayMessage(t, urlError));
      return;
    }
    if (!username.trim() || !password.trim()) {
      setError(t('auth.usernamePasswordRequired'));
      return;
    }

    setError('');
    setLoading(true);
    try {
      restoreServerUrl(serverUrl.trim());
      await login(username.trim(), password);
      await configureServerUrl(serverUrl.trim());
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

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <Text style={[styles.title, { color: colors.text }]}>Jot</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('auth.signInSubtitle')}</Text>

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
          placeholder={t('auth.serverUrlPlaceholder')}
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={serverUrl}
          onChangeText={setServerUrl}
          accessibilityLabel={t('auth.serverUrlPlaceholder')}
          testID="server-url-input"
        />

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
        >
          <Text style={[styles.linkText, { color: colors.primary }]}>{t('auth.createAccountLink')}</Text>
        </TouchableOpacity>
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
  link: {
    marginTop: 16,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 14,
  },
});
