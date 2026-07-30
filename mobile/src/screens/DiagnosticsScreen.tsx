import React, { useCallback, useEffect, useState } from 'react';
import {
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { ArrowLeft, Expand } from 'lucide-react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import {
  getServerSwitchLifecycleState,
  type ServerSwitchLifecycleState,
} from '../store/serverSwitchLifecycle';
import { getSseState, type SseState } from '../api/sseState';
import { getSyncQueueStats, MAX_ENTRY_DRAIN_ATTEMPTS, type SyncQueueStats } from '../db/syncQueue';
import {
  isServerReachable,
  getServerReachabilityChangedAt,
  subscribeToServerReachability,
} from '../api/serverReachability';
import { useOfflineContext } from '../store/OfflineContext';
import { getLogs, getPersistedLogs, clearLogs, type LogEntry } from '../utils/logger';
import appConfig from '../../app.json';

const APP_VERSION: string = appConfig.expo.version;

/** Cap on log entries embedded in a shared diagnostics report, to keep the payload shareable. */
const SHARED_REPORT_LOG_LIMIT = 500;

interface DiagnosticsSnapshot {
  pendingQueueCount: number;
  syncQueueHead: SyncQueueStats['head'];
  syncQueueMaxAttempts: number;
  lifecycle: ServerSwitchLifecycleState;
  sse: SseState;
  logs: LogEntry[];
  isConnected: boolean;
  serverUrl: string;
  isServerReachable: boolean;
  serverReachabilityChangedAt: string | null;
}

/** Formats an ISO timestamp for display, or a placeholder if never set. */
function formatTimestamp(iso: string | null, never: string): string {
  if (!iso) return never;
  return new Date(iso).toLocaleString();
}

/** Compact "how long has the head entry been waiting" string, for spotting a wedge. */
function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function DiagnosticsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const serverUrl = useActiveServerBaseUrl();
  const { syncError, syncFailureCount, lastSyncedAt, consecutiveFailureCount } = useOfflineContext();

  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() => ({
    pendingQueueCount: 0,
    syncQueueHead: null,
    syncQueueMaxAttempts: 0,
    lifecycle: getServerSwitchLifecycleState(),
    sse: getSseState(),
    logs: getLogs().slice(-50),
    isConnected: false,
    serverUrl: '',
    isServerReachable: isServerReachable(),
    serverReachabilityChangedAt: getServerReachabilityChangedAt(),
  }));

  const refresh = useCallback(async () => {
    let stats: SyncQueueStats = { pendingCount: 0, head: null, maxAttempts: 0 };
    try {
      stats = await getSyncQueueStats(db);
    } catch {
      // DB read failure — show an empty queue rather than blocking the snapshot update
    }
    setSnapshot({
      pendingQueueCount: stats.pendingCount,
      syncQueueHead: stats.head,
      syncQueueMaxAttempts: stats.maxAttempts,
      lifecycle: getServerSwitchLifecycleState(),
      sse: getSseState(),
      logs: getLogs().slice(-50),
      isConnected,
      serverUrl: serverUrl ?? '',
      isServerReachable: isServerReachable(),
      serverReachabilityChangedAt: getServerReachabilityChangedAt(),
    });
  }, [db, isConnected, serverUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
    refresh();
  }, [refresh]);

  // Reflect a reachability transition immediately rather than waiting for the
  // next mount or manual refresh — the belief flips from write/SSE outcomes
  // that can happen at any time while this screen is open.
  useEffect(() => {
    return subscribeToServerReachability((reachable) => {
      setSnapshot((prev) => ({
        ...prev,
        isServerReachable: reachable,
        serverReachabilityChangedAt: getServerReachabilityChangedAt(),
      }));
    });
  }, []);

  const handleClearLogs = useCallback(() => {
    clearLogs();
    setSnapshot((prev) => ({ ...prev, logs: [] }));
  }, []);

  const handleShare = useCallback(async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      platform: Platform.OS,
      appVersion: APP_VERSION,
      server: {
        url: snapshot.serverUrl,
        generationId: snapshot.lifecycle.generationId,
      },
      network: {
        isConnected: snapshot.isConnected,
        isServerReachable: snapshot.isServerReachable,
        serverReachabilityChangedAt: snapshot.serverReachabilityChangedAt,
      },
      sse: {
        isConnected: snapshot.sse.isConnected,
        reconnectAttempts: snapshot.sse.reconnectAttempts,
      },
      sync: {
        pendingQueueCount: snapshot.pendingQueueCount,
        headOperation: snapshot.syncQueueHead?.operation ?? null,
        headQueuedAt: snapshot.syncQueueHead?.created_at ?? null,
        headAttempts: snapshot.syncQueueHead?.attempts ?? 0,
        maxAttempts: snapshot.syncQueueMaxAttempts,
        isSyncPaused: snapshot.lifecycle.isSyncPaused,
        isSseQuiesced: snapshot.lifecycle.isSseQuiesced,
        lastSyncedAt,
        syncError,
        consecutiveFailureCount,
        deadLetterCount: syncFailureCount,
      },
      lifecycle: {
        isSwitching: snapshot.lifecycle.isSwitching,
        degraded: snapshot.lifecycle.degraded,
        degradedMessage: snapshot.lifecycle.degradedMessage,
      },
      // Persisted rather than in-memory: a report filed after a restart is
      // exactly the case where the interesting entries predate this session.
      recentLogs: getPersistedLogs().slice(-SHARED_REPORT_LOG_LIMIT),
    };
    await Share.share({ message: JSON.stringify(report, null, 2) });
  }, [snapshot, lastSyncedAt, syncError, consecutiveFailureCount, syncFailureCount]);

  const { lifecycle, sse } = snapshot;

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
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('diagnostics.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 24) + 24 }]}
      >
        {/* Network */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.network')}</Text>
          <DiagRow
            label={t('diagnostics.network')}
            value={snapshot.isConnected ? t('diagnostics.connected') : t('diagnostics.disconnected')}
            valueColor={snapshot.isConnected ? STATUS_GREEN : colors.error}
          />
          <DiagRow
            label={t('diagnostics.serverReachable')}
            value={snapshot.isServerReachable ? t('diagnostics.connected') : t('diagnostics.disconnected')}
            valueColor={snapshot.isServerReachable ? STATUS_GREEN : colors.error}
          />
          <DiagRow
            label={t('diagnostics.serverReachableChangedAt')}
            value={formatTimestamp(snapshot.serverReachabilityChangedAt, t('diagnostics.never'))}
          />
        </View>

        {/* SSE */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.sse')}</Text>
          <DiagRow
            label={t('diagnostics.sse')}
            value={sse.isConnected ? t('diagnostics.sseConnected') : t('diagnostics.sseReconnecting')}
            valueColor={sse.isConnected ? STATUS_GREEN : STATUS_ORANGE}
          />
          <DiagRow
            label={t('diagnostics.reconnectAttempts')}
            value={String(sse.reconnectAttempts)}
          />
        </View>

        {/* Sync Queue */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.syncQueue')}</Text>
          <DiagRow
            label={t('diagnostics.pendingOps')}
            value={String(snapshot.pendingQueueCount)}
            valueColor={snapshot.pendingQueueCount > 0 ? STATUS_ORANGE : undefined}
          />
          {snapshot.syncQueueHead && (
            <>
              <DiagRow
                label={t('diagnostics.headOperation')}
                value={snapshot.syncQueueHead.operation}
                mono
              />
              <DiagRow
                label={t('diagnostics.headWaiting')}
                value={formatAge(snapshot.syncQueueHead.created_at)}
              />
              <DiagRow
                label={t('diagnostics.headAttempts')}
                value={`${snapshot.syncQueueHead.attempts} / ${MAX_ENTRY_DRAIN_ATTEMPTS}`}
                valueColor={snapshot.syncQueueHead.attempts > 0 ? STATUS_ORANGE : undefined}
              />
            </>
          )}
          <DiagRow
            label={t('diagnostics.syncPaused')}
            value={lifecycle.isSyncPaused ? t('diagnostics.yes') : t('diagnostics.no')}
            valueColor={lifecycle.isSyncPaused ? STATUS_ORANGE : undefined}
          />
          <DiagRow
            label={t('diagnostics.sseQuiesced')}
            value={lifecycle.isSseQuiesced ? t('diagnostics.yes') : t('diagnostics.no')}
            valueColor={lifecycle.isSseQuiesced ? STATUS_ORANGE : undefined}
          />
          <DiagRow
            label={t('diagnostics.lastSyncedAt')}
            value={formatTimestamp(lastSyncedAt, t('diagnostics.never'))}
          />
          <DiagRow
            label={t('diagnostics.syncStatus')}
            value={syncError ? t('diagnostics.syncFailed') : t('diagnostics.syncOk')}
            valueColor={syncError ? colors.error : STATUS_GREEN}
          />
          <DiagRow
            label={t('diagnostics.consecutiveFailures')}
            value={String(consecutiveFailureCount)}
            valueColor={consecutiveFailureCount > 0 ? STATUS_ORANGE : undefined}
          />
          <DiagRow
            label={t('diagnostics.deadLetterCount')}
            value={String(syncFailureCount)}
            valueColor={syncFailureCount > 0 ? STATUS_ORANGE : undefined}
          />
        </View>

        {/* Server */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.server')}</Text>
          <DiagRow label={t('diagnostics.serverUrl')} value={snapshot.serverUrl || '—'} mono />
          <DiagRow label={t('diagnostics.generationId')} value={String(lifecycle.generationId)} mono />
          <DiagRow
            label={t('diagnostics.switchInProgress')}
            value={lifecycle.isSwitching ? t('diagnostics.yes') : t('diagnostics.no')}
            valueColor={lifecycle.isSwitching ? STATUS_ORANGE : undefined}
          />
          <DiagRow
            label={t('diagnostics.degraded')}
            value={lifecycle.degraded ? (lifecycle.degradedMessage ?? t('diagnostics.yes')) : t('diagnostics.no')}
            valueColor={lifecycle.degraded ? colors.error : undefined}
          />
        </View>

        {/* Recent Logs */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sectionTitleRow}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.recentLogs')}</Text>
            <View style={styles.logsHeaderActions}>
              <TouchableOpacity
                onPress={() => navigation.navigate('LogsFullscreen')}
                style={styles.expandButton}
                accessibilityRole="button"
                accessibilityLabel={t('diagnostics.expandLogs')}
              >
                <Expand size={18} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleClearLogs} accessibilityRole="button">
                <Text style={[styles.clearLogsButton, { color: colors.primary }]}>
                  {t('diagnostics.clearLogs')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => navigation.navigate('LogsFullscreen')}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            {snapshot.logs.length === 0 ? (
              <Text style={[styles.noLogs, { color: colors.textSecondary }]}>—</Text>
            ) : (
              snapshot.logs.slice().reverse().map((entry, i) => (
                <LogEntryRow key={entry.ts + i} entry={entry} />
              ))
            )}
          </TouchableOpacity>
        </View>

        {/* Actions */}
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonOutline, { borderColor: colors.border }]}
            onPress={refresh}
            accessibilityRole="button"
          >
            <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('diagnostics.refresh')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.primary }]}
            onPress={handleShare}
            accessibilityRole="button"
          >
            <Text style={[styles.actionButtonText, styles.actionButtonTextPrimary]}>
              {t('diagnostics.shareDiagnostics')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const STATUS_GREEN = '#22c55e';
const STATUS_ORANGE = '#f97316';

function DiagRow({
  label,
  value,
  valueColor,
  mono,
}: {
  label: string;
  value: string;
  valueColor?: string;
  mono?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.diagRow}>
      <Text style={[styles.diagLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text
        style={[
          styles.diagValue,
          { color: valueColor ?? colors.text },
          mono && { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const { colors } = useTheme();
  const levelColor =
    entry.level === 'error' ? colors.error :
    entry.level === 'warn' ? STATUS_ORANGE :
    colors.textSecondary;

  const time = entry.ts.slice(11, 19); // HH:MM:SS from ISO string

  return (
    <View style={styles.logRow}>
      <Text style={[styles.logLevel, { color: levelColor }]}>{entry.level.toUpperCase()}</Text>
      <Text style={[styles.logTime, { color: colors.textMuted }]}>{time}</Text>
      <Text style={[styles.logMsg, { color: colors.text }]} numberOfLines={3}>{entry.msg}</Text>
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
    padding: 16,
    gap: 16,
  },
  section: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 12,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  logsHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  expandButton: {
    padding: 2,
  },
  clearLogsButton: {
    fontSize: 13,
    fontWeight: '500',
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 4,
    gap: 8,
  },
  diagLabel: {
    fontSize: 13,
    flexShrink: 0,
    maxWidth: '45%',
  },
  diagValue: {
    fontSize: 13,
    flexShrink: 1,
    textAlign: 'right',
    fontWeight: '500',
  },
  noLogs: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
  },
  logRow: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 3,
    alignItems: 'flex-start',
  },
  logLevel: {
    fontSize: 10,
    fontWeight: '700',
    width: 36,
    paddingTop: 2,
  },
  logTime: {
    fontSize: 10,
    width: 52,
    paddingTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  logMsg: {
    fontSize: 11,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionButtonOutline: {
    borderWidth: 1,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonTextPrimary: {
    color: '#fff',
  },
});
