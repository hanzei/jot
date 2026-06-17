import { useEffect, useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import axios from 'axios';
import { getLocalNotes, getLocalNote, markLocalNoteDeleted } from '../db/noteQueries';
import { getProtectedNoteIds, saveServerNote, saveServerNotesScope } from '../db/syncQueue';
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
      // Persist the fetched notes and prune rows that fell out of this scope
      // (e.g., archived, deleted, or label-changed on another device), both
      // deferring to notes with pending local edits so they aren't reverted.
      await saveServerNotesScope(db, serverNotes, paramsRef.current);
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

  const [refetchCount, setRefetchCount] = useState(0);

  const refetch = useCallback(async () => {
    setRefetchCount(c => c + 1);
    try {
      await syncFromServer();
      return await query.refetch();
    } finally {
      setRefetchCount(c => c - 1);
    }
  }, [syncFromServer, query]);

  return {
    ...query,
    refetch,
    isRefetching: refetchCount > 0,
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
        await saveServerNote(db, serverNote);
        queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
      } catch (err) {
        // Cancelled or offline: expected; keep the local cache.
        if (err instanceof SyncAbortedError) return;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 404 || status === 410) {
          // Note no longer exists on server — tombstone it locally, unless it has
          // a pending or failed local op: a queued edit/restore may be racing the
          // fetch, or a dead-lettered edit may be the version we're preserving, so
          // let the drain/resolution reconcile it rather than hide the optimistic
          // edit (#487/#492). (404/410 are permanent, so retrySync surfaces them
          // immediately.) Guard the queue read + tombstone so a failure here doesn't
          // escape the fire-and-forget effect as an unhandled rejection; the local
          // cache remains as fallback and a later sync retries.
          try {
            const protectedNoteIds = await getProtectedNoteIds(db);
            // Re-check cancelled: the effect may have torn down (id change/unmount)
            // during the await above, in which case we must not write.
            if (!canceller.cancelled && !protectedNoteIds.has(id)) {
              await markLocalNoteDeleted(db, id);
              queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
            }
          } catch (tombstoneErr) {
            console.warn(`Failed to tombstone note id=${id} after server reported it gone:`, tombstoneErr);
          }
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
