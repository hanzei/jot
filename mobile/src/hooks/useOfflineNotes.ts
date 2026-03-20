import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import axios from 'axios';
import { getLocalNotes, getLocalNote, saveNotes, saveNote, markLocalNoteDeleted, removeLocalNotesNotIn } from '../db/noteQueries';
import { getNotes, getNote } from '../api/notes';
import type { GetNotesParams, Note } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';

export function useOfflineNotes(params?: GetNotesParams) {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Primary query: reads from local SQLite (instant on subsequent launches)
  const query = useQuery<Note[]>({
    queryKey: ['notes-local', params],
    queryFn: () => getLocalNotes(db, params),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const syncFromServer = useCallback(async () => {
    try {
      const serverNotes = await getNotes(paramsRef.current);
      await saveNotes(db, serverNotes);
      // Remove local notes that matched this scope but are no longer returned by the server
      // (e.g., archived, deleted, or label-changed on another device).
      const serverIds = new Set(serverNotes.map((n) => n.id));
      await removeLocalNotesNotIn(db, serverIds, paramsRef.current);
      queryClient.invalidateQueries({ queryKey: ['notes-local', paramsRef.current] });
    } catch (err) {
      // Log for debugging; local data is used as fallback
      console.warn('Background notes sync failed:', err);
    }
  }, [db, queryClient]);

  // Background sync when online: fetch from server and update local DB
  useEffect(() => {
    if (isConnected) {
      syncFromServer().catch(() => {});
    }
  }, [isConnected, syncFromServer]);

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
    queryKey: ['note-local', id],
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
        await saveNote(db, serverNote);
        queryClient.invalidateQueries({ queryKey: ['note-local', id] });
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if ((status === 404 || status === 410) && !cancelled) {
          // Note no longer exists on server — tombstone it locally
          await markLocalNoteDeleted(db, id);
          queryClient.invalidateQueries({ queryKey: ['note-local', id] });
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
