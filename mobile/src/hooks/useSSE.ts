import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../store/AuthContext';
import { SSEConnectionManager } from '../api/events';
import { CLIENT_ID } from '../api/client';
import type { SSEEvent } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { saveNote, markLocalNoteDeleted } from '../db/noteQueries';
import { isSseQuiesced, subscribeToServerSwitchLifecycle } from '../store/serverSwitchLifecycle';
import {
  noteLocalQueryKey,
  noteQueryKey,
  notesLocalQueryScopeKey,
  notesQueryScopeKey,
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

    manager.connect((event: SSEEvent) => {
      // Drop events that originated from this device to avoid redundant invalidations.
      if (event.client_id && event.client_id === CLIENT_ID) return;

      // Note-related events require refreshing the notes list
      if (
        event.type === 'note_created' ||
        event.type === 'note_updated' ||
        event.type === 'note_deleted' ||
        event.type === 'note_shared' ||
        event.type === 'note_unshared'
      ) {
        queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
        queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      }

      // Per-event-type extras
      if (event.type === 'note_updated') {
        const { note_id, note } = event.data;
        if (note) {
          // Persist the updated note to SQLite so offline reads stay current
          saveNote(dbRef.current, note).catch(() => {});
        }
        queryClient.invalidateQueries({ queryKey: noteQueryKey(note_id) });
        queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
        // Don't fire the "updated by someone else" notification for changes
        // from the same user on another device — query invalidation above is
        // sufficient to sync the state.
        if (event.source_user_id !== userIdRef.current) {
          onNoteUpdatedRef.current?.(event);
        }
      } else if (event.type === 'note_deleted') {
        const { note_id } = event.data;
        // Tombstone the note in SQLite so it disappears from offline views
        markLocalNoteDeleted(dbRef.current, note_id).catch(() => {});
        queryClient.removeQueries({ queryKey: noteQueryKey(note_id) });
        queryClient.removeQueries({ queryKey: noteLocalQueryKey(note_id) });
      }
    });

    // Catch up on anything missed while disconnected
    queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
  }, [queryClient]);

  const stopConnection = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current = null;
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
