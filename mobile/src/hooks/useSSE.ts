import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../store/AuthContext';
import { SSEConnectionManager } from '../api/events';
import type { SSEEvent } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { saveNote, markLocalNoteDeleted } from '../db/noteQueries';

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
    if (managerRef.current) {
      managerRef.current.disconnect();
    }

    const manager = new SSEConnectionManager();
    managerRef.current = manager;

    manager.connect((event: SSEEvent) => {
      // Skip events from the current user (already handled by optimistic updates)
      if (event.source_user_id === userIdRef.current) {
        return;
      }

      // All event types require refreshing the notes list
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });

      // Per-event-type extras
      if (event.type === 'note_updated') {
        if (event.note) {
          // Persist the updated note to SQLite so offline reads stay current
          saveNote(dbRef.current, event.note).catch(() => {});
        }
        queryClient.invalidateQueries({ queryKey: ['note', event.note_id] });
        queryClient.invalidateQueries({ queryKey: ['note-local', event.note_id] });
        onNoteUpdatedRef.current?.(event);
      } else if (event.type === 'note_deleted') {
        // Tombstone the note in SQLite so it disappears from offline views
        markLocalNoteDeleted(dbRef.current, event.note_id).catch(() => {});
        queryClient.removeQueries({ queryKey: ['note', event.note_id] });
        queryClient.removeQueries({ queryKey: ['note-local', event.note_id] });
      }
    });

    // Catch up on anything missed while disconnected
    queryClient.invalidateQueries({ queryKey: ['notes'] });
    queryClient.invalidateQueries({ queryKey: ['notes-local'] });
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

    return () => {
      subscription.remove();
      stopConnection();
    };
  }, [isAuthenticated, isConnected, startConnection, stopConnection]);
}
