import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import type { Note } from '@jot/shared';
import { getNote, getNoteRevision, getNoteRevisions, restoreNoteRevision } from '../api/notes';
import { isOnlineWriteAllowed, isServerReachable, subscribeToServerReachability } from '../api/serverReachability';
import { assertSwitchWriteAllowed } from '../api/client';
import { isNotePendingCreate, saveNote } from '../db/noteQueries';
import { getProtectedNoteIds } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import {
  noteLocalQueryKey,
  noteRevisionQueryKey,
  noteRevisionsQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

// Note history is online-only (mobile-connectivity-handling.md §4.3): revisions
// are fetched from the server on demand and never stored in the local database,
// and a restore has no queue to fall back on, so both are offered only while
// the server is usable and fail with a bounded, visible error otherwise.

/**
 * Whether history can be fetched or restored right now: device connected,
 * server believed reachable, and not in local mode. Re-renders when
 * reachability flips, like the export section.
 */
export function useHistoryAvailable(): boolean {
  const { isConnected } = useNetworkStatus();
  useSyncExternalStore(subscribeToServerReachability, isServerReachable);
  return isOnlineWriteAllowed(isConnected);
}

/**
 * How the note's local copy relates to the server, as far as history goes:
 * - `notCreated`: its offline create is still queued, so the server has no
 *   history for it yet.
 * - `unsynced`: it has queued (or dead-lettered) local changes. History can be
 *   read, but a restore is blocked: it is based on the server's version, and
 *   the queued changes would replay on top of the restored content.
 * - `synced`: nothing pending.
 */
export type NoteHistorySyncState = 'notCreated' | 'unsynced' | 'synced';

export async function readNoteHistorySyncState(db: SQLiteDatabase, noteId: string): Promise<NoteHistorySyncState> {
  if (await isNotePendingCreate(db, noteId)) return 'notCreated';
  const protectedIds = await getProtectedNoteIds(db);
  return protectedIds.has(noteId) ? 'unsynced' : 'synced';
}

// How often an open History screen re-reads a note's sync state while its
// changes are still queued. The queue has no drain event to subscribe to, and
// the read is a local SQLite query, so a short poll is cheap.
const UNSYNCED_RECHECK_MS = 2000;

export function useNoteHistorySyncState(noteId: string) {
  const db = useSQLiteContext();
  return useQuery({
    queryKey: [...noteRevisionsQueryKey(noteId), 'sync-state'],
    queryFn: () => readNoteHistorySyncState(db, noteId),
    staleTime: 0,
    gcTime: 0,
    // Re-enable Restore once the queued changes reach the server.
    refetchInterval: (query) => (query.state.data === 'unsynced' ? UNSYNCED_RECHECK_MS : false),
  });
}

export function useNoteRevisions(noteId: string, enabled: boolean) {
  return useQuery({
    queryKey: noteRevisionsQueryKey(noteId),
    queryFn: () => getNoteRevisions(noteId),
    enabled,
    // No silent retries: a failed load shows an error with a Retry button.
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useNoteRevision(noteId: string, revisionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: noteRevisionQueryKey(noteId, revisionId),
    queryFn: () => getNoteRevision(noteId, revisionId!), // enabled only with an id
    enabled: enabled && revisionId !== null,
    retry: false,
    // A revision never changes once recorded.
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/** Thrown by a restore of a note that has local changes still to sync. */
export class UnsyncedNoteError extends Error {
  constructor() {
    super('Note has unsynced local changes');
    this.name = 'UnsyncedNoteError';
  }
}

/**
 * Restores a revision online and writes the returned note into SQLite and the
 * note caches, the same way an online type conversion does, so an open editor
 * picks it up (including a type change).
 */
export function useRestoreNoteRevision() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, revisionId }: { noteId: string; revisionId: string }): Promise<Note> => {
      assertSwitchWriteAllowed();
      // Re-checked here rather than trusted from the screen: an edit can have
      // been queued since it last looked.
      if (await readNoteHistorySyncState(db, noteId) !== 'synced') {
        throw new UnsyncedNoteError();
      }
      // Base the restore on the server's current version, not the local
      // copy's: with nothing queued the restore replaces whatever the server
      // holds, and a local copy that has not caught up with another device's
      // edit would otherwise make every attempt conflict.
      const current = await getNote(noteId);
      const restored = await restoreNoteRevision(noteId, revisionId, { base_version: current.version });
      await saveNote(db, restored);
      return restored;
    },
    onSuccess: (restored) => {
      queryClient.setQueryData(noteLocalQueryKey(restored.id), restored);
      queryClient.setQueriesData<Note[]>(
        { queryKey: notesLocalQueryScopeKey() },
        (old) => old?.map((n) => (n.id === restored.id ? restored : n)),
      );
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteRevisionsQueryKey(restored.id) });
    },
  });
}
