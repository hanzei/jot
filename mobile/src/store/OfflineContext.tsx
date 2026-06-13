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
import { drainQueue, getPendingCount, subscribeToEnqueue } from '../db/syncQueue';
import { useAuth } from './AuthContext';
import { isSyncDrainPaused } from './serverSwitchLifecycle';
import { noteLocalQueryKey, noteLocalQueryScopeKey, notesLocalQueryScopeKey } from '../hooks/queryKeys';

interface OfflineContextValue {
  isConnected: boolean;
  /**
   * True once the queue has failed to drain too many times in a row while
   * online (see MAX_CONSECUTIVE_DRAIN_FAILURES). Automatic retries are paused;
   * a fresh trigger (reconnect, foreground, or a new write) clears it.
   */
  syncError: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isConnected: true, syncError: false });

// Sync-loop safety knobs (see mobile/CLAUDE.md → "Sync Loop Safety").
/** Base delay before the first backoff retry after a stalled drain. */
const DRAIN_BACKOFF_BASE_MS = 1000;
/** Upper bound on the exponential backoff between drain retries. */
const DRAIN_BACKOFF_MAX_MS = 60000;
/** Consecutive failed drains tolerated before we stop auto-retrying and surface an error. */
const MAX_CONSECUTIVE_DRAIN_FAILURES = 6;
/** Debounce applied to drains triggered by a fresh enqueue, to coalesce bursts of writes. */
const ENQUEUE_DRAIN_DEBOUNCE_MS = 1000;

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const [syncError, setSyncError] = useState(false);
  const { revalidateSession } = useAuth();
  const db = useSQLiteContext();
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
      const { idMappings, discardedOperations } = await drainQueue(db);
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

      // drainQueue resolves even when it stops early on a transient failure, so
      // inspect what's left to decide whether a backoff retry is warranted.
      const remaining = await getPendingCount(db);
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
  }, [db, queryClient, onDrainStalled, clearDrainTimer, scheduleDrain]);

  performDrainRef.current = performDrain;

  const handleReconnect = useCallback(async () => {
    if (isSyncDrainPaused()) return;
    // Re-validate session with the server (handles offline-authenticated users
    // and refreshes user/settings for all returning-online users).
    const stillAuthenticated = await revalidateSession();
    if (!stillAuthenticated) return;
    // A fresh connectivity/foreground signal: give the queue a clean budget of
    // retries even if a prior streak of failures had paused auto-retrying.
    failureCountRef.current = 0;
    setSyncError(false);
    await performDrain();
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
  }, [scheduleDrain]);

  // Cancel any pending drain on unmount.
  useEffect(() => clearDrainTimer, [clearDrainTimer]);

  const value = useMemo<OfflineContextValue>(() => ({ isConnected, syncError }), [isConnected, syncError]);

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineContext(): OfflineContextValue {
  return useContext(OfflineContext);
}
