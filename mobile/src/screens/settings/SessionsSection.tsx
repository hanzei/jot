import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { listSessions, revokeSession } from '../../api/settings';
import { subscribeToClientActiveServerChanges } from '../../api/client';
import { getActiveServer } from '../../store/serverAccounts';
import { displayMessage, getCurrentLocale } from '../../i18n/utils';
import type { ActiveSession } from '@jot/shared';
import { styles } from './styles';

export default function SessionsSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isMountedRef = useRef(true);
  const previousServerUrlRef = useRef<string | null | undefined>(undefined);

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadSessions = async () => {
      try {
        const activeServer = await getActiveServer();
        if (!mounted) return;
        const nextServerUrl = activeServer?.serverUrl ?? null;
        if (previousServerUrlRef.current !== nextServerUrl) {
          previousServerUrlRef.current = nextServerUrl;
          setSessions([]);
          setSessionsError('');
          setSessionsLoading(true);
          void listSessions()
            .then((nextSessions) => {
              if (mounted) setSessions(nextSessions);
            })
            .catch(() => {
              if (mounted) setSessionsError('settings.sessionsLoadFailed');
            })
            .finally(() => {
              if (mounted) setSessionsLoading(false);
            });
        }
      } catch {
        if (!mounted) return;
        previousServerUrlRef.current = null;
        setSessions([]);
        setSessionsLoading(false);
        setSessionsError('settings.sessionsLoadFailed');
      }
    };

    void loadSessions();
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      void loadSessions();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const revokeSessionById = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      await revokeSession(id);
      if (!isMountedRef.current) return;
      setSessionsError('');
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {
      if (!isMountedRef.current) return;
      setSessionsError('settings.sessionsRevokeFailed');
    } finally {
      if (isMountedRef.current) {
        setRevokingId(null);
      }
    }
  }, []);

  const handleRevokeSession = useCallback((id: string) => {
    Alert.alert(
      t('settings.sessionsRevokeConfirmTitle'),
      t('settings.sessionsRevokeConfirmMessage'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => undefined,
        },
        {
          text: t('settings.sessionsRevoke'),
          style: 'destructive',
          onPress: () => {
            void revokeSessionById(id);
          },
        },
      ],
    );
  }, [revokeSessionById, t]);

  const currentLocale = getCurrentLocale();

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.sessionsSection')}</Text>
      <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
        {t('settings.sessionsDescription')}
      </Text>
      {sessionsLoading ? (
        <ActivityIndicator size="small" color={colors.primary} style={styles.sessionsLoader} />
      ) : sessionsError !== '' ? (
        <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, sessionsError)}</Text>
      ) : sessions.length === 0 ? (
        <Text style={[styles.sessionsDescription, { color: colors.textSecondary }]}>
          {t('settings.sessionsNone')}
        </Text>
      ) : (
        <View style={styles.sessionsList}>
          {sessions.map((session) => (
            <View
              key={session.id}
              style={[styles.sessionItem, { borderColor: colors.border }]}
            >
              <View style={styles.sessionInfo}>
                <View style={styles.sessionHeader}>
                  <Text style={[styles.sessionBrowser, { color: colors.text }]}>
                    {session.os !== 'Unknown'
                      ? t('settings.sessionsBrowserOnOS', { browser: session.browser, os: session.os })
                      : session.browser}
                  </Text>
                  {session.is_current && (
                    <View style={[styles.currentBadge, { backgroundColor: colors.successLight }]}>
                      <Text style={[styles.currentBadgeText, { color: colors.success }]}>{t('settings.sessionsCurrent')}</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.sessionDate, { color: colors.textMuted }]}>
                  {new Date(session.created_at).toLocaleDateString(currentLocale, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </Text>
              </View>
              {!session.is_current && (
                <TouchableOpacity
                  onPress={() => handleRevokeSession(session.id)}
                  disabled={revokingId === session.id}
                  style={styles.revokeButton}
                  testID={`settings-revoke-session-${session.id}`}
                  accessibilityLabel={t('settings.sessionsRevoke')}
                  accessibilityRole="button"
                >
                  <Text style={[
                    styles.revokeText,
                    { color: colors.error },
                    revokingId === session.id && styles.buttonDisabled,
                  ]}>
                    {revokingId === session.id ? t('settings.sessionsRevoking') : t('settings.sessionsRevoke')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
