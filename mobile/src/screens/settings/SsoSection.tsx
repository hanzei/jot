import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { useAuth } from '../../store/AuthContext';
import { useConfirm } from '../../hooks/useConfirm';
import { useServerConfig } from '../../hooks/useServerConfig';
import { auth } from '../../api/client';
import {
  oidcLinkErrorMessage,
  oidcUnlinkErrorMessage,
  runOidcBrowserFlow,
} from '../../store/oidcFlow';
import { displayMessage } from '../../i18n/utils';
import { styles } from './styles';

/**
 * Connect / disconnect the account's SSO identity (docs/specs/oidc-sso.md
 * §10.3, §10.6). Shown only when the active server has SSO enabled. Connect
 * runs the native hand-off with `intent=link` and redeems the code against
 * the current session; the server refuses linking when local login is
 * disabled, so Connect is hidden then. Disconnect may be refused by the
 * server's strand guard, which is surfaced rather than swallowed.
 */
export default function SsoSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const { user, setUser, revalidateSession } = useAuth();
  const { sso } = useServerConfig();
  const isMountedRef = useRef(true);

  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  // Translation keys (or server text), resolved at render.
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const providerName = sso?.provider_name || 'SSO';
  const linked = user?.has_sso_linked ?? false;

  const setLinked = useCallback((next: boolean) => {
    setUser((prev) => (prev ? { ...prev, has_sso_linked: next } : prev));
    // Refresh /me so the cached profile agrees; the flag above already flipped,
    // so a failed refresh self-heals on the next revalidation.
    void revalidateSession().catch(() => undefined);
  }, [revalidateSession, setUser]);

  const handleConnect = useCallback(async () => {
    setError('');
    setSuccess('');
    setBusy('connect');
    try {
      const outcome = await runOidcBrowserFlow('link');
      if (!isMountedRef.current || outcome.type === 'cancelled') {
        return;
      }
      if (outcome.type === 'error') {
        setError(outcome.messageKey);
        return;
      }
      await auth.oidcNativeLink(outcome.code, outcome.codeVerifier);
      // Auth state outlives this screen: record the bind even if it unmounted.
      setLinked(true);
      if (!isMountedRef.current) return;
      setSuccess('settings.ssoConnected');
    } catch (err: unknown) {
      if (isMountedRef.current) setError(oidcLinkErrorMessage(err));
    } finally {
      if (isMountedRef.current) setBusy(null);
    }
  }, [setLinked]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.ssoDisconnectConfirmTitle'),
      message: t('settings.ssoDisconnectConfirmMessage', { provider: providerName }),
      confirmLabel: t('settings.ssoDisconnect', { provider: providerName }),
      destructive: true,
    });
    if (!confirmed) return;
    setError('');
    setSuccess('');
    setBusy('disconnect');
    try {
      await auth.oidcUnlink();
      setLinked(false);
      if (!isMountedRef.current) return;
      setSuccess('settings.ssoDisconnected');
    } catch (err: unknown) {
      if (isMountedRef.current) setError(oidcUnlinkErrorMessage(err));
    } finally {
      if (isMountedRef.current) setBusy(null);
    }
  }, [confirm, providerName, setLinked, t]);

  if (!sso?.enabled) {
    return null;
  }
  const canConnect = sso.local_login_enabled;
  if (!linked && !canConnect) {
    return null;
  }

  return (
    <View
      style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="settings-sso-section"
    >
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.ssoSection')}</Text>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]} testID="settings-sso-description">
        {linked
          ? t('settings.ssoLinkedDescription', { provider: providerName })
          : t('settings.ssoUnlinkedDescription', { provider: providerName })}
      </Text>
      {error !== '' && (
        <Text style={[styles.errorText, { color: colors.error }]} testID="settings-sso-error" accessibilityRole="alert">
          {displayMessage(t, error)}
        </Text>
      )}
      {success !== '' && (
        <Text style={[styles.successText, { color: colors.success }]} testID="settings-sso-success">
          {displayMessage(t, success)}
        </Text>
      )}
      {linked ? (
        <TouchableOpacity
          style={[styles.primaryButton, styles.ssoDisconnectButton, { borderColor: colors.border }, busy !== null && styles.buttonDisabled]}
          onPress={handleDisconnect}
          disabled={busy !== null}
          testID="settings-sso-disconnect"
          accessibilityLabel={t('settings.ssoDisconnect', { provider: providerName })}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === 'disconnect' }}
        >
          <Text style={[styles.importSelectButtonText, { color: colors.error }]}>
            {busy === 'disconnect' ? t('settings.ssoDisconnecting') : t('settings.ssoDisconnect', { provider: providerName })}
          </Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.primary }, busy !== null && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={busy !== null}
          testID="settings-sso-connect"
          accessibilityLabel={t('settings.ssoConnect', { provider: providerName })}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === 'connect' }}
        >
          {busy === 'connect' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>{t('settings.ssoConnect', { provider: providerName })}</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}
