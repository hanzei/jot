import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { getLocalNotes, getLocalNote, saveNotes, saveNote } from '../db/noteQueries';
import { getNotes, getNote } from '../api/notes';
import { GetNotesParams, Note } from '../types';
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
      queryClient.invalidateQueries({ queryKey: ['notes-local', paramsRef.current] });
    } catch {
      // Silently ignore network errors — local data is used as fallback
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
      } catch {
        // Silently ignore — local cache is used as fallback
      }
    })();
    return () => { cancelled = true; };
  }, [id, isConnected, db, queryClient]);

  return query;
}
