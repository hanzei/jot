import { Platform, Share } from 'react-native';
import { getServerSwitchLifecycleState } from '../store/serverSwitchLifecycle';
import { getSseState } from '../api/sseState';
import type { SyncQueueStats } from '../db/syncQueue';
import type { ImageUploadQueueStats } from '../db/imageUploadQueue';
import { isServerReachable, getServerReachabilityChangedAt } from '../api/serverReachability';
import { getPersistedLogs } from './logger';
import { getAppBuildInfo } from './appInfo';
import { getAboutInfo } from '../api/settings';
import type { AboutInfo } from '@jot/shared';

/** Cap on log entries embedded in a shared diagnostics report, to keep the payload shareable. */
const SHARED_REPORT_LOG_LIMIT = 500;

/** Sync state that only the mounted provider tree (database, OfflineContext) can supply. */
export interface DiagnosticsSyncState {
  queue: SyncQueueStats;
  imageUploads: ImageUploadQueueStats;
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
function buildDiagnosticsReport(input: DiagnosticsReportInput, serverBuild: AboutInfo | null) {
  const lifecycle = getServerSwitchLifecycleState();
  const sse = getSseState();
  const { sync } = input;
  const build = getAppBuildInfo();
  return {
    generatedAt: new Date().toISOString(),
    platform: Platform.OS,
    app: {
      version: build.version,
      commit: build.commit ?? null,
      buildTime: build.buildTime ?? null,
    },
    ...(input.crash ? { crash: input.crash } : {}),
    server: {
      url: input.serverUrl,
      generationId: lifecycle.generationId,
      version: serverBuild?.version ?? null,
      commit: serverBuild?.commit ?? null,
      build_time: serverBuild?.build_time ?? null,
      go_version: serverBuild?.go_version ?? null,
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
      headAttempts: sync ? (sync.queue.head?.attempts ?? 0) : null,
      maxAttempts: sync?.queue.maxAttempts ?? null,
      isSyncPaused: lifecycle.isSyncPaused,
      isSseQuiesced: lifecycle.isSseQuiesced,
      lastSyncedAt: sync?.lastSyncedAt ?? null,
      syncError: sync?.syncError ?? null,
      consecutiveFailureCount: sync?.consecutiveFailureCount ?? null,
      deadLetterCount: sync?.deadLetterCount ?? null,
    },
    imageUploads: {
      queuedCount: sync?.imageUploads.queuedCount ?? null,
      errorCount: sync?.imageUploads.errorCount ?? null,
      oldestQueuedAt: sync?.imageUploads.oldest?.created_at ?? null,
      oldestAttempts: sync ? (sync.imageUploads.oldest?.attempts ?? 0) : null,
      maxAttempts: sync?.imageUploads.maxAttempts ?? null,
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
  // Server build info lets a maintainer spot app/server version skew without
  // asking for it. It is best-effort: the default (finite) read timeout bounds
  // the wait, a device known offline or a server already believed unreachable
  // is not tried at all, and any failure just leaves the fields null so the
  // report still goes out.
  let serverBuild: AboutInfo | null = null;
  if (input.isConnected !== false && isServerReachable()) {
    try {
      serverBuild = await getAboutInfo();
    } catch {
      serverBuild = null;
    }
  }
  await Share.share({ message: JSON.stringify(buildDiagnosticsReport(input, serverBuild), null, 2) });
}
