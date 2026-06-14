import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import axios from 'axios';
import { getLocalNotes, getLocalNote, saveNotes, saveNote, markLocalNoteDeleted, removeLocalNotesNotIn } from '../db/noteQueries';
import { getNotes, getNote } from '../api/notes';
import type { GetNotesParams, Note } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import {
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

export function useOfflineNotes(params?: GetNotesParams, options?: { enabled?: boolean }) {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const enabled = options?.enabled ?? true;

  // Primary query: reads from local SQLite (instant on subsequent launches)
  const query = useQuery<Note[]>({
    queryKey: notesLocalQueryKey(params),
    queryFn: () => getLocalNotes(db, params),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const syncFromServer = useCallback(async (canceller?: SyncCanceller) => {
    try {
      const serverNotes = await retrySync(() => getNotes(paramsRef.current), {
        isConnected: () => isConnectedRef.current,
        canceller,
      });
      if (canceller?.cancelled) return;
      await saveNotes(db, serverNotes);
      // Remove local notes that matched this scope but are no longer returned by the server
      // (e.g., archived, deleted, or label-changed on another device).
      const serverIds = new Set(serverNotes.map((n) => n.id));
      await removeLocalNotesNotIn(db, serverIds, paramsRef.current);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    } catch (err) {
      // Cancelled or offline: expected; keep the local cache.
      if (err instanceof SyncAbortedError) return;
      // Retries exhausted (or a permanent error): local data is used as fallback.
      console.warn('Background notes sync failed after retries:', err);
    }
  }, [db, queryClient]);

  // Background sync when online: fetch from server (with retry/backoff) and update local DB
  useEffect(() => {
    if (!enabled || !isConnected) return;
    const canceller = new SyncCanceller();
    syncFromServer(canceller).catch(() => {});
    return () => canceller.cancel();
  }, [enabled, isConnected, syncFromServer]);

  const refetch = useCallback(async () => {
    await syncFromServer();
    return query.refetch();
  }, [syncFromServer, query]);

  return {
    ...query,
    refetch,
    isRefetching: query.isFetching,
  };
}

export function useOfflineNote(id: string | null) {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const query = useQuery<Note | null>({
    queryKey: noteLocalQueryKey(id),
    queryFn: () => (id ? getLocalNote(db, id) : null),
    enabled: id !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Background fetch from server when online (with retry/backoff) to keep local cache fresh
  useEffect(() => {
    if (!id || !isConnected) return;
    const canceller = new SyncCanceller();
    (async () => {
      try {
        const serverNote = await retrySync(() => getNote(id), {
          isConnected: () => isConnectedRef.current,
          canceller,
        });
        if (canceller.cancelled) return;
        await saveNote(db, serverNote);
        queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
      } catch (err) {
        // Cancelled or offline: expected; keep the local cache.
        if (err instanceof SyncAbortedError) return;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 404 || status === 410) {
          // Note no longer exists on server — tombstone it locally. (404/410 are
          // permanent, so retrySync surfaces them immediately without retrying.)
          await markLocalNoteDeleted(db, id);
          queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
          return;
        }
        // Retries exhausted (or another error): local cache is used as fallback.
        console.warn(`Background note sync failed for id=${id} after retries:`, err);
      }
    })();
    return () => { canceller.cancel(); };
  }, [id, isConnected, db, queryClient]);

  return query;
}
