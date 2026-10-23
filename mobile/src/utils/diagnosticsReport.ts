import { Platform, Share } from 'react-native';
import { getServerSwitchLifecycleState } from '../store/serverSwitchLifecycle';
import { getSseState } from '../api/sseState';
import type { SyncQueueStats } from '../db/syncQueue';
import { isServerReachable, getServerReachabilityChangedAt } from '../api/serverReachability';
import { getPersistedLogs } from './logger';
import { getAppBuildInfo } from './appInfo';

/** Cap on log entries embedded in a shared diagnostics report, to keep the payload shareable. */
const SHARED_REPORT_LOG_LIMIT = 500;

/** Sync state that only the mounted provider tree (database, OfflineContext) can supply. */
export interface DiagnosticsSyncState {
  queue: SyncQueueStats;
  lastSyncedAt: string | null;
  syncError: boolean;
  consecutiveFailureCount: number;
  deadLetterCount: number;
}

/** A render error caught by an error boundary. Name, message and stacks only — never props or state. */
export interface DiagnosticsCrash {
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
}

export interface DiagnosticsReportInput {
  serverUrl: string;
  /** Device connectivity, or null when NetInfo is not available to the caller. */
  isConnected: boolean | null;
  /** Null when the caller has no database (e.g. the root crash screen). */
  sync: DiagnosticsSyncState | null;
  crash?: DiagnosticsCrash;
}

/**
 * Builds the report shared from Diagnostics and from the crash screen. Module
 * state (lifecycle, SSE, reachability, logs) is read here, so a caller outside
 * the provider tree only has to supply what it can.
 */
function buildDiagnosticsReport(input: DiagnosticsReportInput) {
  const lifecycle = getServerSwitchLifecycleState();
  const sse = getSseState();
  const { sync } = input;
  const build = getAppBuildInfo();
  return {
    generatedAt: new Date().toISOString(),
    platform: Platform.OS,
    appVersion: build.version,
    appCommit: build.commit ?? null,
    ...(input.crash ? { crash: input.crash } : {}),
    server: {
      url: input.serverUrl,
      generationId: lifecycle.generationId,
    },
    network: {
      isConnected: input.isConnected,
      isServerReachable: isServerReachable(),
      serverReachabilityChangedAt: getServerReachabilityChangedAt(),
    },
    sse: {
      isConnected: sse.isConnected,
      reconnectAttempts: sse.reconnectAttempts,
    },
    sync: {
      pendingQueueCount: sync?.queue.pendingCount ?? null,
      headOperation: sync?.queue.head?.operation ?? null,
      headQueuedAt: sync?.queue.head?.created_at ?? null,
      headAttempts: sync?.queue.head?.attempts ?? 0,
      maxAttempts: sync?.queue.maxAttempts ?? null,
      isSyncPaused: lifecycle.isSyncPaused,
      isSseQuiesced: lifecycle.isSseQuiesced,
      lastSyncedAt: sync?.lastSyncedAt ?? null,
      syncError: sync?.syncError ?? null,
      consecutiveFailureCount: sync?.consecutiveFailureCount ?? null,
      deadLetterCount: sync?.deadLetterCount ?? null,
    },
    lifecycle: {
      isSwitching: lifecycle.isSwitching,
      degraded: lifecycle.degraded,
      degradedMessage: lifecycle.degradedMessage,
    },
    // Persisted rather than in-memory: a report filed after a restart is
    // exactly the case where the interesting entries predate this session.
    recentLogs: getPersistedLogs().slice(-SHARED_REPORT_LOG_LIMIT),
  };
}

export async function shareDiagnosticsReport(input: DiagnosticsReportInput): Promise<void> {
  await Share.share({ message: JSON.stringify(buildDiagnosticsReport(input), null, 2) });
}
