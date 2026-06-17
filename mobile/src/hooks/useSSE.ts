import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../store/AuthContext';
import { SSEConnectionManager } from '../api/events';
import { setActiveSseManager } from '../api/sseState';
import { CLIENT_ID } from '../api/client';
import type { SSEEvent } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { markLocalNoteDeleted } from '../db/noteQueries';
import { getProtectedNoteIds, saveServerNote } from '../db/syncQueue';
import { isSseQuiesced, subscribeToServerSwitchLifecycle } from '../store/serverSwitchLifecycle';
import {
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

export type SSENotificationCallback = (event: SSEEvent) => void;

export function useSSE(onNoteUpdatedByOther?: SSENotificationCallback): void {
  const { user, isAuthenticated } = useAuth();
  const { isConnected } = useNetworkStatus();
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const managerRef = useRef<SSEConnectionManager | null>(null);
  const onNoteUpdatedRef = useRef(onNoteUpdatedByOther);
  onNoteUpdatedRef.current = onNoteUpdatedByOther;
  const dbRef = useRef(db);
  dbRef.current = db;
  const userIdRef = useRef(user?.id);
  userIdRef.current = user?.id;

  const startConnection = useCallback(() => {
    if (isSseQuiesced()) {
      return;
    }
    if (managerRef.current) {
      managerRef.current.disconnect();
    }

    const manager = new SSEConnectionManager();
    managerRef.current = manager;
    setActiveSseManager(manager);

    manager.connect((event: SSEEvent) => {
      // Drop events that originated from this device to avoid redundant invalidations.
      if (event.client_id && event.client_id === CLIENT_ID) return;

      // Apply the SQLite write *before* invalidating queries. The notes list and
      // single-note queries read straight from SQLite (staleTime: Infinity), so an
      // invalidation triggers an immediate refetch; invalidating before the write
      // lands makes that refetch read stale rows, and nothing re-fetches once the
      // write completes (the change wouldn't surface until the next background
      // sync). Awaiting the write first keeps the refetch in sync — this mirrors
      // useOfflineNote's background-fetch ordering.
      void (async () => {
        const db = dbRef.current;
        switch (event.type) {
          case 'note_updated': {
            const { note_id, note } = event.data;
            if (note) {
              // Persist the updated note to SQLite so offline reads stay current
              // (deferring to a pending local edit on this note; see #487).
              try {
                await saveServerNote(db, note);
              } catch {
                // Note has a pending/failed local op or the write failed; keep the
                // local copy and let the queue drain / next sync reconcile it.
              }
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            // Don't fire the "updated by someone else" notification for changes
            // from the same user on another device — query invalidation above is
            // sufficient to sync the state.
            if (event.source_user_id !== userIdRef.current) {
              onNoteUpdatedRef.current?.(event);
            }
            break;
          }
          case 'note_deleted': {
            const { note_id } = event.data;
            // Tombstone the note in SQLite so it disappears from offline views — but
            // defer to a pending or failed local edit/restore on this note: a queued op
            // may be racing the remote delete, or a dead-lettered edit may be the version
            // we're preserving, so let the drain/resolution reconcile it rather than hide
            // the optimistic edit (#487/#492). The drain replaying against a server-deleted
            // note gets a 404 and dead-letters the op, so this can't wedge the queue.
            try {
              const protectedNoteIds = await getProtectedNoteIds(db);
              if (!protectedNoteIds.has(note_id)) {
                queryClient.removeQueries({ queryKey: noteLocalQueryKey(note_id) });
                await markLocalNoteDeleted(db, note_id);
              }
            } catch {
              // Leave the local copy in place; a later sync reconciles it.
            }
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
          case 'note_created':
          case 'note_shared':
          case 'note_unshared':
            // No local write in this path; refresh the list so the new/changed
            // note is picked up by the next background sync + refetch.
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
        }
      })();
    });

    // Catch up on anything missed while disconnected
    queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
  }, [queryClient]);

  const stopConnection = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current = null;
      setActiveSseManager(null);
    }
  }, []);

  // Manage connection based on auth state, network status, and app lifecycle
  useEffect(() => {
    if (!isAuthenticated || !isConnected) {
      stopConnection();
      return;
    }

    startConnection();

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        startConnection();
      } else if (nextState === 'background') {
        stopConnection();
      }
      // 'inactive' state: keep connection open (brief state during app switching)
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    const lifecycleUnsubscribe = subscribeToServerSwitchLifecycle((state) => {
      if (!isAuthenticated || !isConnected) {
        return;
      }
      if (!state.isSwitching && !state.isSseQuiesced) {
        startConnection();
      }
    });

    return () => {
      subscription.remove();
      lifecycleUnsubscribe();
      stopConnection();
    };
  }, [isAuthenticated, isConnected, startConnection, stopConnection]);
}
