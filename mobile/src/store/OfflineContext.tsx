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
import {
  clearQueuedWriteWaits,
  drainQueue,
  getDeadLetterCount,
  getOldestFailingSince,
  getPendingCount,
  subscribeToEnqueue,
} from '../db/syncQueue';
import { isServerReachable, markServerReachable, subscribeToServerReachability } from '../api/serverReachability';
import { publishReconnectResync } from './resyncEvents';
import { isNetworkChange, mergeNetworkIdentity, networkIdentity, type NetworkIdentity } from './networkChange';
import { getPendingCreateNoteIds, getFailedNoteIds } from '../db/noteQueries';
import { isClosedDatabaseError } from '../db/errors';
import { useAuth } from './AuthContext';
import { isLocalModeActive } from './localMode';
import { isSyncDrainPaused } from './serverSwitchLifecycle';
import { labelsQueryKey, noteLocalQueryKey, noteLocalQueryScopeKey, notesLocalQueryScopeKey, pendingImageUploadsQueryScopeKey } from '../hooks/queryKeys';

interface OfflineContextValue {
  isConnected: boolean;
  /**
   * True while a queued write has been failing for more than
   * SYNC_ERROR_AFTER_FAILING_MS (its retries go on), or once connectivity
   * failures have stopped the drain MAX_CONSECUTIVE_DRAIN_FAILURES times in a
   * row while online (automatic retries are paused; a fresh trigger —
   * reconnect, foreground, or a new write — clears that).
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
  /**
   * ISO timestamp of the last time the queue drained with nothing left behind,
   * or null if no drain has succeeded yet this session. Surfaced in Diagnostics
   * so a support report can tell "just synced" from "stuck since X" (#700).
   */
  lastSyncedAt: string | null;
  /**
   * Current streak of drains stopped by connectivity or that threw (mirrors
   * `failureCountRef`, the counter behind `syncError`'s cap). Resets to 0 on a successful drain, and
   * also on a reconnect or foreground even before that trigger's own drain has
   * resolved. A new write resets it only once retries have paused at the cap
   * (#1284), the point where it also clears `syncError`. Surfaced in Diagnostics alongside `syncError` so it's clear
   * *why* sync is stuck, not just that it is (#700).
   */
  consecutiveFailureCount: number;
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
  lastSyncedAt: null,
  consecutiveFailureCount: 0,
});

// Sync-loop safety knobs (see mobile/CLAUDE.md → "Sync Loop Safety").
/**
 * Base delay before the first backoff retry after a drain stopped on
 * connectivity, or on too many failed sends in a row (#1301).
 */
const DRAIN_BACKOFF_BASE_MS = 1000;
/** Upper bound on the exponential backoff between drain retries. */
const DRAIN_BACKOFF_MAX_MS = 60000;
/**
 * Consecutive drains stopped on connectivity tolerated before we stop
 * auto-retrying and surface an error. A write that fails over HTTP is paced by
 * its own wait instead and does not count (#1301).
 */
const MAX_CONSECUTIVE_DRAIN_FAILURES = 6;
/** How long a queued write may keep failing before the sync-error banner shows (#1301). */
export const SYNC_ERROR_AFTER_FAILING_MS = 5 * 60 * 1000;
/**
 * Debounce applied to drains triggered by a fresh enqueue, to coalesce bursts
 * of writes. Kept short: every converted write reaches the server only through
 * the drain (#1284), so this is added to its latency.
 */
const ENQUEUE_DRAIN_DEBOUNCE_MS = 300;

/** Exponential backoff for the `count`-th consecutive stopped drain. */
function drainBackoffMs(count: number): number {
  return Math.min(DRAIN_BACKOFF_BASE_MS * 2 ** (count - 1), DRAIN_BACKOFF_MAX_MS);
}

/**
 * Why a drain timer is pending. A `wait` timer only waits for the earliest
 * failed write to come due (#1301), so a new write may bring it forward; a
 * `backoff` timer protects a server that is failing, so it may not.
 */
type DrainTimerKind = 'debounce' | 'wait' | 'backoff';

/** True when two string sets hold exactly the same ids (order-independent). */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  // Retries paused after MAX_CONSECUTIVE_DRAIN_FAILURES connectivity stops.
  const [drainPaused, setDrainPaused] = useState(false);
  // A queued write has been failing for longer than SYNC_ERROR_AFTER_FAILING_MS (#1301).
  const [writeFailing, setWriteFailing] = useState(false);
  const syncError = drainPaused || writeFailing;
  const [pendingNoteIds, setPendingNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [failedNoteIds, setFailedNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [syncFailureCount, setSyncFailureCount] = useState(0);
  const [syncFailuresBannerDismissed, setSyncFailuresBannerDismissed] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [consecutiveFailureCount, setConsecutiveFailureCount] = useState(0);
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

  // Re-read whether a queued write has been failing for too long (#1301).
  const refreshWriteFailing = useCallback(() => {
    getOldestFailingSince(db).then((since) => {
      setWriteFailing(since !== null && Date.now() - since > SYNC_ERROR_AFTER_FAILING_MS);
    }).catch(() => {});
  }, [db]);

  const dismissSyncFailuresBanner = useCallback(() => {
    setSyncFailuresBannerDismissed(true);
  }, []);
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef(true);
  const networkRef = useRef<NetworkIdentity | null>(null);
  const isConnectedRef = useRef(true);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isConnectedRef.current = isConnected;

  // Re-entrancy guard: never run two drains concurrently.
  const isDrainingRef = useRef(false);
  // Timer handle for a scheduled (debounced, waiting or backoff) drain.
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the pending timer is for, and when it fires.
  const drainTimerKindRef = useRef<DrainTimerKind>('debounce');
  const drainTimerDueRef = useRef(0);
  // Count of consecutive drains stopped on connectivity (or that threw), used
  // to grow the backoff and to cap retries. Reset to 0 on every drain that
  // reaches the server, and on a fresh trigger.
  const failureCountRef = useRef(0);
  // Count of consecutive drains stopped after too many failed sends in a row
  // (#1301): grows their backoff, with no cap. Reset by a pass that ends
  // without that stop, and on a reconnect or foreground.
  const failureStopCountRef = useRef(0);
  // Set when a drain is requested while one is already in flight, so we run one
  // more pass afterward to pick up anything enqueued during the drain.
  const rerunRequestedRef = useRef(false);
  // Set when performDrain skipped because the server was unreachable; that
  // early return ends the drain's backoff chain, so the next flip back to
  // reachable resumes it (#1217, spec §3.1). Only set while no drain is
  // running; cleared by anything that schedules or runs a drain itself.
  const drainParkedRef = useRef(false);
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

  const scheduleDrain = useCallback((delayMs: number, kind: DrainTimerKind = 'debounce') => {
    clearDrainTimer();
    drainParkedRef.current = false;
    drainTimerKindRef.current = kind;
    drainTimerDueRef.current = Date.now() + delayMs;
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      performDrainRef.current();
    }, delayMs);
  }, [clearDrainTimer]);

  // Called when a drain stopped on a connectivity failure, or threw. Grows the
  // backoff and reschedules, or gives up once the cap is hit.
  const onDrainStalled = useCallback(() => {
    failureCountRef.current += 1;
    setConsecutiveFailureCount(failureCountRef.current);
    if (failureCountRef.current >= MAX_CONSECUTIVE_DRAIN_FAILURES) {
      // Persistent failure: stop auto-retrying and surface an error so we don't
      // busy-loop against a server that keeps failing. A fresh external trigger
      // (reconnect, foreground, or a new write) resets the counter and resumes.
      console.warn(
        `Queue drain failed ${failureCountRef.current} times in a row; pausing automatic retries.`,
      );
      clearDrainTimer();
      setDrainPaused(true);
      return;
    }
    // Logged per attempt (capped at MAX_CONSECUTIVE_DRAIN_FAILURES, so at most
    // a handful of lines) so a "share diagnostics" log trail shows the retry
    // progression, not just the final consecutiveFailureCount snapshot (#700).
    // Info: a retry under backoff is the design working; giving up above warns.
    console.info(
      `Queue drain stalled (attempt ${failureCountRef.current}/${MAX_CONSECUTIVE_DRAIN_FAILURES}); retrying with backoff.`,
    );
    scheduleDrain(drainBackoffMs(failureCountRef.current), 'backoff');
  }, [clearDrainTimer, scheduleDrain]);

  // `fromReconnect` marks handleReconnect's own drain; any other drain waits
  // for it (see below).
  const performDrain = useCallback(async (fromReconnect = false) => {
    // Don't attempt to drain while offline — the network call is doomed and would
    // only stall and reschedule. A timer scheduled while online can fire after we
    // go offline; the offline NetInfo handler also clears it, this is a backstop.
    if (!isConnectedRef.current) return;
    if (isDrainingRef.current) {
      // A drain is already running; remember to run again once it finishes so
      // operations enqueued mid-drain are not stranded. Checked before the park
      // below, so a park never overlaps a running drain.
      rerunRequestedRef.current = true;
      return;
    }
    // A reconnect in progress drains right after revalidating the session, so
    // any other drain (a timer, a rerun, a resume) defers to it rather than
    // racing ahead of the revalidation. Checked before the park below, so a
    // deferred drain never parks.
    if (isReconnectingRef.current && !fromReconnect) return;
    // The device may be online while the Jot server itself is known-unreachable
    // (see serverReachability.ts). Without this check a scheduled backoff drain
    // would still fire the head entry's request and eat the full write timeout
    // before bailing (#718) — mirrors the read path's `retrySync`, which already
    // fast-fails on `!isServerReachable()`. Park instead; the reachability
    // subscription below resumes the drain once the server is reachable again.
    if (!isServerReachable()) {
      drainParkedRef.current = true;
      return;
    }
    // Local mode has no server and never enqueues server ops, so the drain loop
    // stays parked (issue #514). This single guard covers every drain trigger
    // (mount, reconnect, foreground, post-enqueue), keeping the online sync engine
    // otherwise untouched.
    if (isLocalModeActive()) return;
    if (isSyncDrainPaused()) return;
    isDrainingRef.current = true;
    let stalled = false;
    try {
      const { syncedNotes, syncedSettings, leftBehind, stoppedOnConnectivity, stoppedOnFailures, nextAttemptAt } =
        await drainQueue(db);
      for (const serverNote of syncedNotes) {
        queryClient.setQueryData(noteLocalQueryKey(serverNote.id), serverNote);
      }
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
      // A drained createLabel name conflict rewrites the local label id, so refresh the label list/counts too.
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      // Drained creates may have cleared their pending-create marker (#475).
      refreshPendingNoteIds();
      // A drain can dead-letter ops (new failures) or clear a prior failure, so
      // refresh the failed-note badges and review-banner count (#492/#493).
      refreshSyncFailures();
      // A write may have started failing, or got through after failing (#1301).
      refreshWriteFailing();

      // Refresh the gallery's queued and failed upload tiles.
      queryClient.invalidateQueries({ queryKey: pendingImageUploadsQueryScopeKey() });

      // Re-read settings after a settings drain once only image uploads (if
      // any) remain queued: earlier revalidation fetched pre-PATCH values, and
      // an upload backlog has nothing to do with settings.
      // `leftBehind` excludes rows queued during the pass (#1284), so new work
      // is not counted as a stall.
      if (syncedSettings && await getPendingCount(db, { excludeUploads: true }) === 0) {
        await revalidateSession().catch(() => {});
      }
      if (stoppedOnConnectivity) {
        stalled = true;
        onDrainStalled();
      } else {
        // The server answered this pass. Only log a recovery when there was
        // actually a failure streak to recover from — logging every routine
        // drain (the common case, firing on nearly every enqueue) would drown
        // out everything else in the log buffer (#700).
        if (failureCountRef.current > 0) {
          console.info(
            `Queue drain succeeded after ${failureCountRef.current} failed attempt(s); sync recovered.`,
          );
        }
        failureCountRef.current = 0;
        setConsecutiveFailureCount(0);
        setDrainPaused(false);
        // A write that failed over HTTP waits its own delay, so the next pass
        // runs when the earliest one is due (#1301). A pass that stopped after
        // too many failed sends in a row also backs off as a whole, so a server
        // that fails every write is not hit by a pass per second.
        const untilDue = nextAttemptAt === null ? null : Math.max(0, nextAttemptAt - Date.now());
        if (stoppedOnFailures) {
          stalled = true;
          failureStopCountRef.current += 1;
          scheduleDrain(Math.max(drainBackoffMs(failureStopCountRef.current), untilDue ?? 0), 'backoff');
        } else {
          failureStopCountRef.current = 0;
          if (untilDue !== null) scheduleDrain(untilDue, 'wait');
          else clearDrainTimer();
        }
        if (leftBehind === 0) setLastSyncedAt(new Date().toISOString());
      }
    } catch (err) {
      // The SQLiteProvider that owns `db` was torn down mid-drain (server switch,
      // DB-init retry, or sign-out) and closed the handle underneath us. The
      // handle never reopens and a fresh provider instance is already driving
      // sync, so stop quietly instead of backing off against the dead handle —
      // onDrainStalled would otherwise walk to its failure cap and set syncError
      // while flooding diagnostics with `Access to closed resource` (issue #971).
      if (isClosedDatabaseError(err)) {
        // Set stalled so the finally's rerun-requested path doesn't immediately
        // reschedule another pass that would hit the same closed handle.
        stalled = true;
        clearDrainTimer();
        return;
      }
      console.warn('Queue drain failed:', err);
      stalled = true;
      onDrainStalled();
    } finally {
      isDrainingRef.current = false;
      // Re-run once for anything enqueued mid-drain — but only if this drain
      // did not stop. If it stopped, a backoff-respecting retry is already
      // scheduled (or the cap was hit); an immediate rerun would wipe that
      // timer and retry with no backoff.
      if (rerunRequestedRef.current) {
        rerunRequestedRef.current = false;
        if (!stalled) scheduleDrain(0);
      }
    }
  }, [db, queryClient, onDrainStalled, clearDrainTimer, scheduleDrain, revalidateSession, refreshPendingNoteIds, refreshSyncFailures, refreshWriteFailing]);

  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
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
    // This reconnect drains below, after revalidating the session, so the flip
    // the next line may cause has no parked drain to resume.
    drainParkedRef.current = false;
    // The device just regained connectivity: re-arm the server-reachable belief
    // so the next write probes the network again instead of staying parked on the
    // queue from a prior outage. A still-down server flips it back on the first
    // failed attempt; the drain below reconciles either way.
    markServerReachable();
    try {
      do {
        reconnectRerunRequestedRef.current = false;
        // Re-validate session with the server (handles offline-authenticated users
        // and refreshes user/settings for all returning-online users).
        const stillAuthenticated = await revalidateSession();
        if (!stillAuthenticated) return;
        // A fresh connectivity/foreground signal: give the queue a clean budget of
        // retries even if a prior streak of failures had paused auto-retrying,
        // and let every waiting write go now, so the queue recovers at once
        // after an outage (#1301).
        failureCountRef.current = 0;
        failureStopCountRef.current = 0;
        setConsecutiveFailureCount(0);
        setDrainPaused(false);
        await clearQueuedWriteWaits(db).catch((err: unknown) => {
          if (!isClosedDatabaseError(err)) console.warn('Failed to clear queued write waits:', err);
        });
        await performDrain(true);
      } while (reconnectRerunRequestedRef.current);
    } finally {
      isReconnectingRef.current = false;
    }
  }, [db, revalidateSession, performDrain]);

  useEffect(() => {
    // Seed the initial state from the real network status before subscribing to changes,
    // so isConnected is accurate on first render (default useState(true) can be wrong).
    // If we start online and are already authenticated, drain any queued operations
    // that accumulated while the app was closed.
    // Online means the device has a network, whatever NetInfo thinks of the
    // internet behind it: a self-hosted server on a LAN with no uplink is
    // reachable although the OS reports "no internet". Whether the server
    // answers is the reachability flag's job (spec §3, #1266).
    NetInfo.fetch().then((initial) => {
      const connected = initial.isConnected === true;
      prevConnectedRef.current = connected;
      networkRef.current = mergeNetworkIdentity(networkRef.current, networkIdentity(initial));
      setIsConnected(connected);
      if (connected) {
        handleReconnect().catch(() => {});
      }
    }).catch((err) => {
      console.warn('NetInfo.fetch failed, defaulting to online:', err);
    });

    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true;
      setIsConnected(connected);
      const network = networkIdentity(state);
      const networkChanged = isNetworkChange(networkRef.current, network);
      networkRef.current = mergeNetworkIdentity(networkRef.current, network);

      if (connected && !prevConnectedRef.current) {
        // Transitioned from offline → online. The read caches re-sync on the
        // isConnected flip itself.
        handleReconnect().catch(() => {});
      } else if (connected && networkChanged) {
        // Moved to another network, or a captive portal let the device
        // through, while staying online: a server that was unreachable may
        // answer now. isConnected does not flip, and a stream that never
        // opened treats its first open as the initial connect, so neither
        // re-syncs the read caches; ask for that catch-up here, once the
        // reconnect has re-armed reachability and revalidated the session.
        handleReconnect().then(publishReconnectResync).catch(() => {});
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
    const unsubscribe = subscribeToEnqueue((operation) => {
      // Refresh before the offline early-return: an offline create enqueues while
      // disconnected and must immediately reflect its pending-create marker (#475).
      // No other op changes that set, and every editor save enqueues (#1284).
      if (operation === 'create' || operation === 'duplicate') refreshPendingNoteIds();
      if (!isConnectedRef.current) return;
      // Every write enqueues now, whatever the connectivity (#1284), so a write
      // says nothing about the server coming back: it keeps the failure count,
      // and the cap still bounds an entry that keeps failing while the user
      // types. Only once retries have given up does a new write resume them
      // with a clean budget.
      if (failureCountRef.current >= MAX_CONSECUTIVE_DRAIN_FAILURES) {
        failureCountRef.current = 0;
        setConsecutiveFailureCount(0);
        setDrainPaused(false);
      }
      // A drain in flight may finish without this write and clear its timer;
      // request its rerun so the write is not stranded.
      if (isDrainingRef.current) rerunRequestedRef.current = true;
      // A pending debounce or backoff retry already covers it. A timer that
      // only waits for a failed write to come due is brought forward: the new
      // write is not held back by it, and the failed one is skipped until due
      // (#1301).
      if (drainTimerRef.current !== null && (
        drainTimerKindRef.current !== 'wait'
        || drainTimerDueRef.current - Date.now() <= ENQUEUE_DRAIN_DEBOUNCE_MS)) return;
      scheduleDrain(ENQUEUE_DRAIN_DEBOUNCE_MS);
    });
    return unsubscribe;
  }, [scheduleDrain, refreshPendingNoteIds]);

  // Resume a parked drain when the server becomes reachable again. Unlike a
  // reconnect or foreground, this keeps the failure count, so the cap still
  // bounds a write that keeps failing (#1217, spec §3.1).
  useEffect(() => {
    return subscribeToServerReachability((reachable) => {
      if (reachable && drainParkedRef.current) scheduleDrain(ENQUEUE_DRAIN_DEBOUNCE_MS);
    });
  }, [scheduleDrain]);

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

  // Likewise a write that was already failing in a previous session (#1301).
  useEffect(() => {
    refreshWriteFailing();
  }, [refreshWriteFailing]);

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
      lastSyncedAt,
      consecutiveFailureCount,
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
      lastSyncedAt,
      consecutiveFailureCount,
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
