import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAuth } from '../../store/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { getAboutInfo } from '../../api/settings';
import { subscribeToClientActiveServerChanges } from '../../api/client';
import { getActiveServer } from '../../store/serverAccounts';
import { displayMessage, getCurrentLocale } from '../../i18n/utils';
import type { AboutInfo } from '@jot/shared';
import { styles } from './styles';

function formatDate(iso: string, locale?: string): string {
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(locale);
}

function AboutRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.aboutRow}>
      <Text style={[styles.aboutLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.aboutValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function AboutSection() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const previousServerUrlRef = useRef<string | null | undefined>(undefined);
  const aboutRequestSeqRef = useRef(0);

  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState('');
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [activeServerUrl, setActiveServerUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadActiveServer = async () => {
      try {
        const activeServer = await getActiveServer();
        if (!mounted) return;
        const nextServerUrl = activeServer?.serverUrl ?? null;
        if (previousServerUrlRef.current !== nextServerUrl) {
          previousServerUrlRef.current = nextServerUrl;
          aboutRequestSeqRef.current += 1;
          setActiveServerUrl(nextServerUrl);
          setAboutInfo(null);
          setAboutError('');
          setAboutLoading(false);
        }
      } catch {
        if (!mounted) return;
        aboutRequestSeqRef.current += 1;
        previousServerUrlRef.current = null;
        setActiveServerUrl(null);
        setAboutLoading(false);
      }
    };

    void loadActiveServer();
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      void loadActiveServer();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (aboutExpanded && !aboutInfo && !aboutError) {
      let cancelled = false;
      const requestId = ++aboutRequestSeqRef.current;
      setAboutLoading(true);
      getAboutInfo()
        .then((nextAboutInfo) => {
          if (!cancelled && aboutRequestSeqRef.current === requestId) {
            setAboutInfo(nextAboutInfo);
          }
        })
        .catch(() => {
          if (!cancelled && aboutRequestSeqRef.current === requestId) {
            setAboutError('about.failedLoad');
          }
        })
        .finally(() => {
          if (!cancelled && aboutRequestSeqRef.current === requestId) {
            setAboutLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [aboutExpanded, aboutInfo, aboutError]);

  const currentLocale = getCurrentLocale();

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.aboutSection')}</Text>
      <TouchableOpacity
        style={styles.aboutToggle}
        onPress={() => {
          if (aboutExpanded) setAboutError('');
          setAboutExpanded(!aboutExpanded);
        }}
        testID="settings-about-toggle"
        accessibilityLabel={t('settings.aboutButton')}
        accessibilityRole="button"
      >
        <Text style={[styles.aboutToggleText, { color: colors.icon }]}>{t('settings.aboutButton')}</Text>
        <Ionicons
          name={aboutExpanded ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={colors.textSecondary}
        />
      </TouchableOpacity>
      {aboutExpanded && (
        <View style={styles.aboutContent}>
          {user && (
            <View style={styles.aboutSection}>
              <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>{t('about.clientInfo')}</Text>
              <AboutRow label={t('about.username')} value={user.username} />
              <AboutRow label={t('about.userId')} value={user.id} />
              <AboutRow label={t('about.role')} value={user.role} />
              <AboutRow
                label={t('about.accountCreated')}
                value={new Date(user.created_at).toLocaleDateString(currentLocale)}
              />
            </View>
          )}
          <View style={[styles.aboutDivider, { backgroundColor: colors.divider }]} />
          <View style={styles.aboutSection}>
            <Text style={[styles.aboutSectionTitle, { color: colors.textMuted }]}>{t('about.serverInfo')}</Text>
            <AboutRow
              label={t('about.serverOrigin')}
              value={activeServerUrl ?? t('settings.noServerConfigured')}
            />
            {aboutLoading && <ActivityIndicator size="small" color={colors.primary} />}
            {aboutError !== '' && (
              <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, aboutError)}</Text>
            )}
            {aboutInfo && (
              <>
                <AboutRow label={t('about.appVersion')} value={aboutInfo.version} />
                <AboutRow label={t('about.commit')} value={aboutInfo.commit} />
                {aboutInfo.build_time && (
                  <AboutRow
                    label={t('about.buildTime')}
                    value={formatDate(aboutInfo.build_time, currentLocale)}
                  />
                )}
                {aboutInfo.go_version && (
                  <AboutRow label={t('about.goVersion')} value={aboutInfo.go_version} />
                )}
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
