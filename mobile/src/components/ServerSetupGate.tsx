import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { getBaseUrl, getStoredServerUrl, probeServerReachability, setServerUrl as activateServerUrl } from '../api/client';
import { validateServerUrl } from '../hooks/useServerUrl';
import { displayMessage } from '../i18n/utils';

interface ServerSetupGateProps {
  children: React.ReactNode;
  testPrefix: string;
}

function getProbeErrorMessage(t: (key: string) => string, reason: 'INVALID_URL' | 'UNREACHABLE' | 'AUTH_ENDPOINT_UNAVAILABLE'): string {
  if (reason === 'INVALID_URL') {
    return t('auth.serverUrlProtocol');
  }
  if (reason === 'AUTH_ENDPOINT_UNAVAILABLE') {
    return t('auth.serverSetupConnectionInvalidServer');
  }
  return t('auth.serverSetupConnectionFailed');
}

export default function ServerSetupGate({ children, testPrefix }: ServerSetupGateProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [serverUrlInput, setServerUrlInput] = useState(getBaseUrl);
  const [isCheckingExistingServer, setIsCheckingExistingServer] = useState(true);
  const [isSavingServer, setIsSavingServer] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [isServerReady, setIsServerReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    getStoredServerUrl()
      .then((stored) => {
        if (!mounted) {
          return;
        }
        if (stored) {
          setServerUrlInput(stored);
          setIsServerReady(true);
          return;
        }
        setServerUrlInput(getBaseUrl());
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        setServerUrlInput(getBaseUrl());
      })
      .finally(() => {
        if (mounted) {
          setIsCheckingExistingServer(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const helperExamples = useMemo(
    () =>
      [
        t('auth.serverSetupExampleLocalhost'),
        t('auth.serverSetupExampleAndroidEmulator'),
        t('auth.serverSetupExampleLan'),
        t('auth.serverSetupExampleHosted'),
      ].join('\n'),
    [t],
  );

  const handleSaveServer = async () => {
    const formatError = validateServerUrl(serverUrlInput);
    if (formatError) {
      setSetupError(displayMessage(t, formatError));
      return;
    }

    setSetupError('');
    setIsSavingServer(true);
    try {
      const probe = await probeServerReachability(serverUrlInput.trim());
      if (!probe.ok) {
        setSetupError(getProbeErrorMessage(t, probe.reason));
        return;
      }
      await activateServerUrl(probe.canonicalUrl);
      setServerUrlInput(probe.canonicalUrl);
      setIsServerReady(true);
    } catch {
      setSetupError(t('auth.serverSetupConnectionFailed'));
    } finally {
      setIsSavingServer(false);
    }
  };

  if (isCheckingExistingServer) {
    return (
      <View style={styles.loadingContainer} testID={`${testPrefix}-server-setup-loading`}>
        <ActivityIndicator
          color={colors.primary}
          accessibilityLabel={t('common.loading')}
          accessibilityRole="progressbar"
        />
      </View>
    );
  }

  if (isServerReady) {
    return <>{children}</>;
  }

  return (
    <View style={styles.setupSection} testID={`${testPrefix}-server-setup-step`}>
      <Text style={[styles.setupTitle, { color: colors.text }]}>{t('auth.serverSetupTitle')}</Text>
      <Text style={[styles.setupDescription, { color: colors.textSecondary }]}>{t('auth.serverSetupDescription')}</Text>

      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: colors.inputBackground,
            borderColor: colors.inputBorder,
            color: colors.text,
          },
        ]}
        placeholder={t('auth.serverUrlPlaceholder')}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={serverUrlInput}
        onChangeText={setServerUrlInput}
        accessibilityLabel={t('auth.serverSetupInputA11yLabel')}
        testID={`${testPrefix}-server-setup-input`}
      />

      <Text style={[styles.setupHelper, { color: colors.textSecondary }]}>{helperExamples}</Text>

      {setupError ? (
        <Text
          style={[styles.error, { color: colors.error }]}
          testID={`${testPrefix}-server-setup-error`}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {setupError}
        </Text>
      ) : null}

      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.primary }, isSavingServer && styles.buttonDisabled]}
        onPress={handleSaveServer}
        disabled={isSavingServer}
        testID={`${testPrefix}-server-setup-submit`}
        accessibilityRole="button"
        accessibilityLabel={t('auth.serverSetupSubmitA11yLabel')}
        accessibilityState={{ disabled: isSavingServer, busy: isSavingServer }}
      >
        {isSavingServer ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{t('auth.serverSetupContinue')}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  setupSection: {
    marginBottom: 20,
  },
  setupTitle: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  setupDescription: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  setupHelper: {
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 8,
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
    marginBottom: 8,
    fontSize: 14,
  },
});
