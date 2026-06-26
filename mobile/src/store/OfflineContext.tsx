import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { drainQueue, getPendingCount, getDeadLetterCount, subscribeToEnqueue } from '../db/syncQueue';
import { getPendingCreateNoteIds, getFailedNoteIds } from '../db/noteQueries';
import { useAuth } from './AuthContext';
import { isLocalModeActive } from './localMode';
import { isSyncDrainPaused } from './serverSwitchLifecycle';
import { labelCountsQueryKey, labelsQueryKey, noteLocalQueryKey, noteLocalQueryScopeKey, notesLocalQueryScopeKey } from '../hooks/queryKeys';

interface OfflineContextValue {
  isConnected: boolean;
  /**
   * True once the queue has failed to drain too many times in a row while
   * online (see MAX_CONSECUTIVE_DRAIN_FAILURES). Automatic retries are paused;
   * a fresh trigger (reconnect, foreground, or a new write) clears it.
   */
  syncError: boolean;
  /**
   * IDs of offline-created notes whose `POST /notes` hasn't drained yet (#475).
   * Such a note already has a server-valid ID, but it isn't on the server, so the
   * UI gates actions that need a server-side note (sharing, label management).
   */
  pendingNoteIds: ReadonlySet<string>;
  /**
   * IDs of notes flagged `sync_state = 'failed'` after a dead-lettered op (#492).
   * Drives the per-note "didn't sync" badge (#493).
   */
  failedNoteIds: ReadonlySet<string>;
  /** Number of preserved dead-lettered ops; drives the review banner count (#493). */
  syncFailureCount: number;
  /** True while the user has dismissed the sync-failures banner for the current batch (#493). */
  syncFailuresBannerDismissed: boolean;
  /** Dismiss the sync-failures banner until a new failure arrives (#493). */
  dismissSyncFailuresBanner: () => void;
  /** Re-read failed-note ids and the dead-letter count after a drain or a resolution (#493). */
  refreshSyncFailures: () => void;
}

const OfflineContext = createContext<OfflineContextValue>({
  isConnected: true,
  syncError: false,
  pendingNoteIds: new Set(),
  failedNoteIds: new Set(),
  syncFailureCount: 0,
  syncFailuresBannerDismissed: false,
  dismissSyncFailuresBanner: () => {},
  refreshSyncFailures: () => {},
});

// Sync-loop safety knobs (see mobile/CLAUDE.md → "Sync Loop Safety").
/** Base delay before the first backoff retry after a stalled drain. */
const DRAIN_BACKOFF_BASE_MS = 1000;
/** Upper bound on the exponential backoff between drain retries. */
const DRAIN_BACKOFF_MAX_MS = 60000;
/** Consecutive failed drains tolerated before we stop auto-retrying and surface an error. */
const MAX_CONSECUTIVE_DRAIN_FAILURES = 6;
/** Debounce applied to drains triggered by a fresh enqueue, to coalesce bursts of writes. */
const ENQUEUE_DRAIN_DEBOUNCE_MS = 1000;

/** True when two string sets hold exactly the same ids (order-independent). */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const [syncError, setSyncError] = useState(false);
  const [pendingNoteIds, setPendingNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [failedNoteIds, setFailedNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [syncFailureCount, setSyncFailureCount] = useState(0);
  const [syncFailuresBannerDismissed, setSyncFailuresBannerDismissed] = useState(false);
  const { revalidateSession } = useAuth();
  const db = useSQLiteContext();
  // Last observed dead-letter count, so a fresh failure can re-surface a banner
  // the user previously dismissed.
  const prevFailureCountRef = useRef(0);
  // Monotonic id of the latest refreshSyncFailures call, so an out-of-order
  // earlier read discards its stale result instead of clobbering fresh state.
  const refreshSyncFailuresSeqRef = useRef(0);

  // Reload the set of offline-created notes still awaiting their queued create
  // (#475). Called after every enqueue and drain so the UI gate stays current.
  // Keeps the previous Set reference when the contents are unchanged so unrelated
  // writes (the common case) don't re-render every consumer.
  const refreshPendingNoteIds = useCallback(() => {
    getPendingCreateNoteIds(db).then((next) => {
      setPendingNoteIds((prev) => (sameStringSet(prev, next) ? prev : next));
    }).catch(() => {});
  }, [db]);

  // Re-read the failed-note ids (for the per-note badge) and dead-letter count
  // (for the review banner) after a drain or a user resolution (#492/#493). When
  // the count grows, re-surface a banner the user had previously dismissed so a
  // newly-failed change isn't hidden. Keeps the previous Set reference when the
  // contents are unchanged so unrelated drains don't re-render every consumer.
  const refreshSyncFailures = useCallback(() => {
    // Tag each refresh so a slower earlier read can't overwrite a newer one's
    // result when two refreshes (e.g. mount + a drain) are in flight at once.
    const seq = refreshSyncFailuresSeqRef.current + 1;
    refreshSyncFailuresSeqRef.current = seq;
    Promise.all([getFailedNoteIds(db), getDeadLetterCount(db)]).then(([nextIds, nextCount]) => {
      if (seq !== refreshSyncFailuresSeqRef.current) return; // superseded by a newer refresh
      setFailedNoteIds((prev) => (sameStringSet(prev, nextIds) ? prev : nextIds));
      setSyncFailureCount(nextCount);
      if (nextCount > prevFailureCountRef.current) {
        setSyncFailuresBannerDismissed(false);
      }
      prevFailureCountRef.current = nextCount;
    }).catch(() => {});
  }, [db]);

  const dismissSyncFailuresBanner = useCallback(() => {
    setSyncFailuresBannerDismissed(true);
  }, []);
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef(true);
  const isConnectedRef = useRef(true);
  isConnectedRef.current = isConnected;

  // Re-entrancy guard: never run two drains concurrently.
  const isDrainingRef = useRef(false);
  // Timer handle for a scheduled (debounced or backoff) drain.
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Count of consecutive failed/stalled drains, used to grow the backoff and
  // to cap retries. Reset to 0 on every successful drain or fresh trigger.
  const failureCountRef = useRef(0);
  // Set when a drain is requested while one is already in flight, so we run one
  // more pass afterward to pick up anything enqueued during the drain.
  const rerunRequestedRef = useRef(false);
  // Holds the latest performDrain so timers always call the current closure.
  const performDrainRef = useRef<() => void>(() => {});
  // Guard so near-simultaneous reconnect signals collapse into a single resync.
  const isReconnectingRef = useRef(false);
  // Set when a reconnect is requested while one is already in flight, so we run
  // one more pass afterward and don't drop the later signal's session refresh.
  const reconnectRerunRequestedRef = useRef(false);

  const clearDrainTimer = useCallback(() => {
    if (drainTimerRef.current !== null) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
  }, []);

  const scheduleDrain = useCallback((delayMs: number) => {
    clearDrainTimer();
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      performDrainRef.current();
    }, delayMs);
  }, [clearDrainTimer]);

  // Called when a drain ran but left entries behind (transient failure) or threw.
  // Grows the backoff and reschedules, or gives up once the cap is hit.
  const onDrainStalled = useCallback(() => {
    failureCountRef.current += 1;
    if (failureCountRef.current >= MAX_CONSECUTIVE_DRAIN_FAILURES) {
      // Persistent failure: stop auto-retrying and surface an error so we don't
      // busy-loop against a server that keeps failing. A fresh external trigger
      // (reconnect, foreground, or a new write) resets the counter and resumes.
      console.warn(
        `Queue drain failed ${failureCountRef.current} times in a row; pausing automatic retries.`,
      );
      clearDrainTimer();
      setSyncError(true);
      return;
    }
    const delay = Math.min(
      DRAIN_BACKOFF_BASE_MS * 2 ** (failureCountRef.current - 1),
      DRAIN_BACKOFF_MAX_MS,
    );
    scheduleDrain(delay);
  }, [clearDrainTimer, scheduleDrain]);

  const performDrain = useCallback(async () => {
    // Don't attempt to drain while offline — the network call is doomed and would
    // only stall and reschedule. A timer scheduled while online can fire after we
    // go offline; the offline NetInfo handler also clears it, this is a backstop.
    if (!isConnectedRef.current) return;
    // Local mode has no server and never enqueues server ops, so the drain loop
    // stays parked (issue #514). This single guard covers every drain trigger
    // (mount, reconnect, foreground, post-enqueue), keeping the online sync engine
    // otherwise untouched.
    if (isLocalModeActive()) return;
    if (isSyncDrainPaused()) return;
    if (isDrainingRef.current) {
      // A drain is already running; remember to run again once it finishes so
      // operations enqueued mid-drain are not stranded.
      rerunRequestedRef.current = true;
      return;
    }
    isDrainingRef.current = true;
    let stalled = false;
    try {
      const { idMappings, discardedOperations, syncedSettings } = await drainQueue(db);
      for (const { localId, serverNote } of idMappings) {
        queryClient.setQueryData(noteLocalQueryKey(localId), serverNote);
      }
      if (discardedOperations.length > 0) {
        console.warn(
          `Sync discarded ${discardedOperations.length} operation(s) that were rejected by the server:`,
          discardedOperations,
        );
      }
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
      // Drained label ops may have reconciled local label ids (offline-created
      // labels) to server ids, so refresh the label list/counts too.
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      // Drained creates may have cleared their pending-create marker (#475).
      refreshPendingNoteIds();
      // A drain can dead-letter ops (new failures) or clear a prior failure, so
      // refresh the failed-note badges and review-banner count (#492/#493).
      refreshSyncFailures();
      // drainQueue resolves even when it stops early on a transient failure, so
      // inspect what's left to decide whether a backoff retry is warranted.
      const remaining = await getPendingCount(db);
      // Revalidate the session after a settings drain only when the queue is
      // fully empty. The pre-drain revalidation had fetched stale server values
      // (before the PATCH ran), so we need a fresh GET /me to reflect what the
      // drain just applied. Guarding on remaining === 0 avoids clobbering
      // in-memory optimistic state for settings ops that are still pending.
      if (syncedSettings && remaining === 0) {
        await revalidateSession().catch(() => {});
      }
      if (remaining > 0) {
        stalled = true;
        onDrainStalled();
      } else {
        failureCountRef.current = 0;
        clearDrainTimer();
        setSyncError(false);
      }
    } catch (err) {
      console.warn('Queue drain failed:', err);
      stalled = true;
      onDrainStalled();
    } finally {
      isDrainingRef.current = false;
      // Re-run once for anything enqueued mid-drain — but only if this drain
      // succeeded. If it stalled, onDrainStalled already scheduled a
      // backoff-respecting retry (or hit the cap); an immediate rerun would
      // wipe that timer and retry with no backoff.
      if (rerunRequestedRef.current) {
        rerunRequestedRef.current = false;
        if (!stalled) scheduleDrain(0);
      }
    }
  }, [db, queryClient, onDrainStalled, clearDrainTimer, scheduleDrain, revalidateSession, refreshPendingNoteIds, refreshSyncFailures]);

  performDrainRef.current = performDrain;

  const handleReconnect = useCallback(async () => {
    // In local mode there is no server session to revalidate and no queue to
    // drain, so skip the whole reconnect path (issue #514).
    if (isLocalModeActive()) return;
    if (isSyncDrainPaused()) return;
    // A NetInfo offline→online transition and an AppState foreground commonly fire
    // together when the device wakes, and each would otherwise re-validate the
    // session and drain — invalidating every query — independently, causing the UI
    // to refresh several times in a row. Collapse overlapping signals into one,
    // remembering to run one final pass so a later signal's session refresh isn't
    // dropped (mirrors performDrain's rerun-requested handling).
    if (isReconnectingRef.current) {
      reconnectRerunRequestedRef.current = true;
      return;
    }
    isReconnectingRef.current = true;
    try {
      do {
        reconnectRerunRequestedRef.current = false;
        // Re-validate session with the server (handles offline-authenticated users
        // and refreshes user/settings for all returning-online users).
        const stillAuthenticated = await revalidateSession();
        if (!stillAuthenticated) return;
        // A fresh connectivity/foreground signal: give the queue a clean budget of
        // retries even if a prior streak of failures had paused auto-retrying.
        failureCountRef.current = 0;
        setSyncError(false);
        await performDrain();
      } while (reconnectRerunRequestedRef.current);
    } finally {
      isReconnectingRef.current = false;
    }
  }, [revalidateSession, performDrain]);

  useEffect(() => {
    // Seed the initial state from the real network status before subscribing to changes,
    // so isConnected is accurate on first render (default useState(true) can be wrong).
    // If we start online and are already authenticated, drain any queued operations
    // that accumulated while the app was closed.
    NetInfo.fetch().then((initial) => {
      const connected = initial.isConnected === true && initial.isInternetReachable !== false;
      prevConnectedRef.current = connected;
      setIsConnected(connected);
      if (connected) {
        handleReconnect().catch(() => {});
      }
    }).catch((err) => {
      console.warn('NetInfo.fetch failed, defaulting to online:', err);
    });

    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      setIsConnected(connected);

      if (connected && !prevConnectedRef.current) {
        // Transitioned from offline → online
        handleReconnect().catch(() => {});
      } else if (!connected) {
        // Going offline: cancel any pending backoff/debounce drain so we don't
        // fire doomed network calls until connectivity returns.
        clearDrainTimer();
      }
      prevConnectedRef.current = connected;
    });

    return () => unsubscribe();
  }, [handleReconnect, clearDrainTimer]);

  // Drain when the app returns to the foreground (e.g. a write failed transiently
  // while backgrounded). Treated like a reconnect so the session is re-validated.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && isConnectedRef.current) {
        handleReconnect().catch(() => {});
      }
    });
    return () => subscription.remove();
  }, [handleReconnect]);

  // Drain shortly after a write is queued while online, so a transient failure
  // re-syncs without waiting for a disconnect/reconnect cycle.
  useEffect(() => {
    const unsubscribe = subscribeToEnqueue(() => {
      // Refresh before the offline early-return: an offline create enqueues while
      // disconnected and must immediately reflect its pending-create marker (#475).
      refreshPendingNoteIds();
      if (!isConnectedRef.current) return;
      // A fresh write is a new signal that the server may be reachable again, so
      // give the queue a clean retry budget even if a prior streak had paused
      // auto-retrying. scheduleDrain debounces bursts; performDrain's own guard
      // handles the case where a drain is still in flight when the timer fires.
      failureCountRef.current = 0;
      setSyncError(false);
      scheduleDrain(ENQUEUE_DRAIN_DEBOUNCE_MS);
    });
    return unsubscribe;
  }, [scheduleDrain, refreshPendingNoteIds]);

  // Seed the pending-create set on mount so notes created in a previous session
  // that never drained are gated correctly from first render (#475).
  useEffect(() => {
    refreshPendingNoteIds();
  }, [refreshPendingNoteIds]);

  // Seed the failed-note badges and review-banner count on mount so failures
  // preserved from a previous session surface immediately (#492/#493).
  useEffect(() => {
    refreshSyncFailures();
  }, [refreshSyncFailures]);

  // Cancel any pending drain on unmount.
  useEffect(() => clearDrainTimer, [clearDrainTimer]);

  const value = useMemo<OfflineContextValue>(
    () => ({
      isConnected,
      syncError,
      pendingNoteIds,
      failedNoteIds,
      syncFailureCount,
      syncFailuresBannerDismissed,
      dismissSyncFailuresBanner,
      refreshSyncFailures,
    }),
    [
      isConnected,
      syncError,
      pendingNoteIds,
      failedNoteIds,
      syncFailureCount,
      syncFailuresBannerDismissed,
      dismissSyncFailuresBanner,
      refreshSyncFailures,
    ],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineContext(): OfflineContextValue {
  return useContext(OfflineContext);
}

/** IDs of offline-created notes whose create hasn't drained yet (#475). */
export function usePendingNoteIds(): ReadonlySet<string> {
  return useContext(OfflineContext).pendingNoteIds;
}

/** IDs of notes whose unsynced change was permanently rejected (#492/#493). */
export function useFailedNoteIds(): ReadonlySet<string> {
  return useContext(OfflineContext).failedNoteIds;
}
