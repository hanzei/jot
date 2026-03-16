import React, { useState } from 'react';
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
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { AuthStackParamList } from '../navigation/AuthStack';
import { restoreServerUrl, setServerUrl as configureServerUrl } from '../api/client';
import { useServerUrl } from '../hooks/useServerUrl';

type RegisterScreenProps = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

export default function RegisterScreen({ navigation }: RegisterScreenProps) {
  const { register } = useAuth();
  const { colors } = useTheme();
  const { serverUrl, setServerUrl, validateServerUrl } = useServerUrl();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const validate = (): string | null => {
    const urlError = validateServerUrl(serverUrl);
    if (urlError) return urlError;
    if (!username.trim()) return 'Username is required';
    if (username.trim().length < 2 || username.trim().length > 30) {
      return 'Username must be 2-30 characters';
    }
    if (!password.trim()) return 'Password is required';
    if (password.length < 8) return 'Password must be at least 8 characters';
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
      restoreServerUrl(serverUrl.trim());
      await register(username.trim(), password);
      await configureServerUrl(serverUrl.trim());
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: string } })?.response?.data || 'Registration failed';
      setError(typeof message === 'string' ? message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>Create Account</Text>

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
          placeholder="Server URL"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={serverUrl}
          onChangeText={setServerUrl}
          accessibilityLabel="Server URL"
          testID="server-url-input"
        />

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
          placeholder="Username"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
          accessibilityLabel="Username"
          testID="username-input"
        />

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
          placeholder="Password"
          placeholderTextColor={colors.placeholder}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          accessibilityLabel="Password"
          testID="password-input"
        />

        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary }, loading && styles.buttonDisabled]}
          onPress={handleRegister}
          disabled={loading}
          testID="register-button"
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Create account</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.link}
          testID="login-link"
        >
          <Text style={[styles.linkText, { color: colors.primary }]}>Already have an account? Sign in</Text>
        </TouchableOpacity>
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
