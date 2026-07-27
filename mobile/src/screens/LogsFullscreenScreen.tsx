import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { getPersistedLogs, type LogEntry } from '../utils/logger';
import type { RootStackParamList } from '../navigation/RootNavigator';

const STATUS_ORANGE = '#f97316';
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export default function LogsFullscreenScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = React.useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Persisted logs span previous sessions too, so a crash-and-restart doesn't
  // hide the entries that explain the crash. Newest first.
  const logs = React.useMemo(() => getPersistedLogs().reverse(), []);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight, backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('diagnostics.recentLogs')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {logs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>—</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 16) }]}
          nestedScrollEnabled
        >
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            <View>
              {logs.map((entry, i) => (
                <LogLine key={entry.ts + i} entry={entry} />
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const { colors } = useTheme();
  const levelColor =
    entry.level === 'error'
      ? colors.error
      : entry.level === 'warn'
        ? STATUS_ORANGE
        : colors.textSecondary;

  const time = entry.ts.slice(11, 19); // HH:MM:SS from ISO string

  return (
    <View style={styles.logLine}>
      <Text style={[styles.logLevel, { color: levelColor }]}>{entry.level.toUpperCase().padEnd(5)}</Text>
      <Text style={[styles.logTime, { color: colors.textMuted }]}>{time} </Text>
      <Text style={[styles.logMsg, { color: colors.text }]}>{entry.msg}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 40,
  },
  scrollContent: {
    padding: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 24,
  },
  logLine: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  logLevel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    width: 44,
  },
  logTime: {
    fontSize: 11,
    fontFamily: MONO,
    width: 68,
  },
  logMsg: {
    fontSize: 11,
    fontFamily: MONO,
  },
});
