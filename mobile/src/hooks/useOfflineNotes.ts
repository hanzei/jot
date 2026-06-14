import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import axios from 'axios';
import { getLocalNotes, getLocalNote, markLocalNoteDeleted } from '../db/noteQueries';
import { getPendingNoteIds, saveServerNote, saveServerNotesScope } from '../db/syncQueue';
import { getNotes, getNote } from '../api/notes';
import type { GetNotesParams, Note } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
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
  const enabled = options?.enabled ?? true;

  // Primary query: reads from local SQLite (instant on subsequent launches)
  const query = useQuery<Note[]>({
    queryKey: notesLocalQueryKey(params),
    queryFn: () => getLocalNotes(db, params),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const syncFromServer = useCallback(async () => {
    try {
      const serverNotes = await getNotes(paramsRef.current);
      // Persist the fetched notes and prune rows that fell out of this scope
      // (e.g., archived, deleted, or label-changed on another device), both
      // deferring to notes with pending local edits so they aren't reverted.
      await saveServerNotesScope(db, serverNotes, paramsRef.current);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    } catch (err) {
      // Log for debugging; local data is used as fallback
      console.warn('Background notes sync failed:', err);
    }
  }, [db, queryClient]);

  // Background sync when online: fetch from server and update local DB
  useEffect(() => {
    if (enabled && isConnected) {
      syncFromServer().catch(() => {});
    }
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

  const query = useQuery<Note | null>({
    queryKey: noteLocalQueryKey(id),
    queryFn: () => (id ? getLocalNote(db, id) : null),
    enabled: id !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Background fetch from server when online to keep local cache fresh
  useEffect(() => {
    if (!id || !isConnected) return;
    let cancelled = false;
    (async () => {
      try {
        const serverNote = await getNote(id);
        if (cancelled) return;
        await saveServerNote(db, serverNote);
        queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if ((status === 404 || status === 410) && !cancelled) {
          // Note no longer exists on server — tombstone it locally, unless it has
          // a pending local op: a queued edit/restore may be racing the fetch, so
          // let the drain reconcile it rather than hide the optimistic edit (#487).
          // Guard the queue read + tombstone so a failure here doesn't escape the
          // fire-and-forget effect as an unhandled rejection; the local cache
          // remains as fallback and a later sync retries.
          try {
            const pendingNoteIds = await getPendingNoteIds(db);
            // Re-check cancelled: the effect may have torn down (id change/unmount)
            // during the await above, in which case we must not write.
            if (!cancelled && !pendingNoteIds.has(id)) {
              await markLocalNoteDeleted(db, id);
              queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
            }
          } catch (tombstoneErr) {
            console.warn(`Failed to tombstone note id=${id} after server reported it gone:`, tombstoneErr);
          }
        }
        // Other errors: log for debugging; local cache is used as fallback
        if (status !== 404 && status !== 410) {
          console.warn(`Background note sync failed for id=${id}:`, err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, isConnected, db, queryClient]);

  return query;
}
