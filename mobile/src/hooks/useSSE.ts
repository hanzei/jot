import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/AuthContext';
import { SSEConnectionManager } from '../api/events';
import { SSEEvent } from '../types';

export type SSENotificationCallback = (event: SSEEvent) => void;

export function useSSE(onNoteUpdatedByOther?: SSENotificationCallback): void {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const managerRef = useRef<SSEConnectionManager | null>(null);
  const onNoteUpdatedRef = useRef(onNoteUpdatedByOther);
  onNoteUpdatedRef.current = onNoteUpdatedByOther;

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

      // Per-event-type extras
      if (event.type === 'note_updated') {
        queryClient.invalidateQueries({ queryKey: ['note', event.note_id] });
        onNoteUpdatedRef.current?.(event);
      } else if (event.type === 'note_deleted') {
        queryClient.removeQueries({ queryKey: ['note', event.note_id] });
      }
    });

    // Catch up on anything missed while disconnected
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [queryClient]);

  const stopConnection = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current = null;
    }
  }, []);

  // Single effect managing connection based on auth state and app lifecycle
  useEffect(() => {
    if (!isAuthenticated) {
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
  }, [isAuthenticated, startConnection, stopConnection]);
}
