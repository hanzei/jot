import { useEffect, useCallback, useRef, useState } from 'react';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import axios from 'axios';
import { getLocalNotes, getLocalNote } from '../db/noteQueries';
import { isClosedDatabaseError } from '../db/errors';
import { applyServerRemoval, saveServerNote, saveServerNotesScope } from '../db/syncQueue';
import { snapshotMark } from '../db/snapshotGate';
import type { GetNotesParams, Note } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { isLocalModeActive } from '../store/localMode';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import { subscribeToReconnectResync } from '../store/resyncEvents';
import {
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';
import { jot } from '../api/jot';

/**
 * True when two param sets select the same notes apart from the search term.
 * `hashKey` sorts keys and drops `undefined` fields, so a missing `search` and
 * `search: undefined` compare equal.
 */
function sameScopeIgnoringSearch(a: GetNotesParams | undefined, b: GetNotesParams | undefined): boolean {
  return hashKey([{ ...a, search: undefined }]) === hashKey([{ ...b, search: undefined }]);
}

export function useOfflineNotes(params?: GetNotesParams, options?: { enabled?: boolean }) {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const paramsRef = useRef(params);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  paramsRef.current = params;
  const isConnectedRef = useRef(isConnected);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isConnectedRef.current = isConnected;
  const enabled = options?.enabled ?? true;
  // Re-entrancy guard: skip a resync while one is already running rather than
  // firing a second (Sync Loop Safety in mobile/CLAUDE.md). This also dedupes the
  // rare double-trigger when a device reconnect flips isConnected *and* the SSE
  // reconnect fires its catch-up at nearly the same time.
  const isSyncingRef = useRef(false);

  // Primary query: reads from local SQLite (instant on subsequent launches)
  const query = useQuery({
    queryKey: notesLocalQueryKey(params),
    queryFn: () => getLocalNotes(db, params),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    // Each search term is its own query key, with no data until its SQLite read
    // resolves. Keep the previous term's results meanwhile, so typing swaps the
    // list once per debounce instead of flashing a spinner between results.
    // Only a search change qualifies: a different label, archive or trash
    // scope selects other notes, and showing the old ones there would be wrong.
    placeholderData: (previousData, previousQuery) =>
      enabled && previousQuery && sameScopeIgnoringSearch(previousQuery.queryKey[2], params)
        ? previousData
        : undefined,
  });

  const syncFromServer = useCallback(async (canceller?: SyncCanceller) => {
    // No server to sync against in local mode — also guards the manual `refetch`
    // (pull-to-refresh) path, not just the background effect (#514).
    if (isLocalModeActive()) return;
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      // Taken before the fetch: a write of ours that lands while it is in flight
      // may be missing from the response (#1265).
      const since = snapshotMark();
      const serverNotes = await retrySync(() => jot.notes.getAll(paramsRef.current), {
        isConnected: () => isConnectedRef.current,
        canceller,
      });
      if (canceller?.cancelled) return;
      // Persist the fetched notes and prune rows that fell out of this scope
      // (e.g., archived, deleted, or label-changed on another device), both
      // deferring to notes with pending local edits so they aren't reverted.
      await saveServerNotesScope(db, serverNotes, paramsRef.current, since);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    } catch (err) {
      // Cancelled or offline: expected; keep the local cache.
      if (err instanceof SyncAbortedError) return;
      // The SQLiteProvider was torn down mid-sync and the persist hit a closed
      // handle (server switch / DB-init retry / sign-out); a fresh provider
      // instance drives the next sync, so swallow it (issue #971).
      if (isClosedDatabaseError(err)) return;
      // Retries exhausted (or a permanent error): local data is used as fallback.
      console.warn('Background notes sync failed after retries:', err);
    } finally {
      isSyncingRef.current = false;
    }
  }, [db, queryClient]);

  // Background sync when online: fetch from server (with retry/backoff) and update local DB
  useEffect(() => {
    // Local mode is the source of truth: there is no server to resync from (#514).
    if (!enabled || !isConnected || isLocalModeActive()) return;
    const canceller = new SyncCanceller();
    syncFromServer(canceller).catch(() => {});
    return () => canceller.cancel();
  }, [enabled, isConnected, syncFromServer]);

  // Catch up on SSE reconnect: events missed while the stream was down (e.g. the
  // app was backgrounded) never arrive, and a bare foreground doesn't flip
  // isConnected, so the effect above wouldn't otherwise re-run (#708 follow-up).
  useEffect(() => {
    if (!enabled) return;
    return subscribeToReconnectResync(() => {
      if (!isConnectedRef.current || isLocalModeActive()) return;
      const canceller = new SyncCanceller();
      syncFromServer(canceller).catch(() => {});
    });
  }, [enabled, syncFromServer]);

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
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isConnectedRef.current = isConnected;

  const query = useQuery<Note | null>({
    queryKey: noteLocalQueryKey(id),
    queryFn: () => (id ? getLocalNote(db, id) : null),
    enabled: id !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Both note reads are SQLite-backed, so a write here has to invalidate both:
  // the single-note query the editor renders *and* every cached notes list. The
  // dashboard's own sync doesn't re-run on navigation, so without the list
  // invalidation a card kept rendering the item set SQLite held when the list
  // was last read — most visibly a shopping list whose unchecked items, added on
  // another device while the SSE stream was down, showed in the editor (which
  // this sync had just refreshed) but not on its card, with only an app restart
  // clearing it.
  const invalidateNoteReads = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
  }, [queryClient]);

  // Fetch the note from the server (with retry/backoff) and refresh the local
  // cache. Shared by the online background effect and the SSE-reconnect catch-up.
  const syncFromServer = useCallback(async (canceller: SyncCanceller) => {
    // Local mode is the source of truth: there is no server to refresh from (#514).
    if (!id || isLocalModeActive()) return;
    const since = snapshotMark();
    try {
      const serverNote = await retrySync(() => jot.notes.getById(id), {
        isConnected: () => isConnectedRef.current,
        canceller,
      });
      if (canceller.cancelled) return;
      await saveServerNote(db, serverNote, since);
      invalidateNoteReads();
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
          // Re-check cancelled where the write happens: the effect may have torn
          // down (id change/unmount) while the fetch or the write chain waited.
          if (await applyServerRemoval(db, id, since, 'tombstone', () => !canceller.cancelled)) {
            invalidateNoteReads();
          }
        } catch (tombstoneErr) {
          console.warn(`Failed to tombstone note id=${id} after server reported it gone:`, tombstoneErr);
        }
        return;
      }
      // The SQLiteProvider was torn down mid-sync and the persist hit a closed
      // handle; a fresh provider instance drives the next sync (issue #971).
      if (isClosedDatabaseError(err)) return;
      // Retries exhausted (or another error): local cache is used as fallback.
      console.warn(`Background note sync failed for id=${id} after retries:`, err);
    }
  }, [id, db, invalidateNoteReads]);

  // Background fetch from server when online to keep local cache fresh.
  useEffect(() => {
    if (!id || !isConnected || isLocalModeActive()) return;
    const canceller = new SyncCanceller();
    syncFromServer(canceller).catch(() => {});
    return () => { canceller.cancel(); };
  }, [id, isConnected, syncFromServer]);

  // Catch up on SSE reconnect: refresh the open note's full body/items in case it
  // was edited on another device while the stream was down (e.g. app backgrounded).
  useEffect(() => {
    if (!id) return;
    return subscribeToReconnectResync(() => {
      if (!isConnectedRef.current || isLocalModeActive()) return;
      const canceller = new SyncCanceller();
      syncFromServer(canceller).catch(() => {});
    });
  }, [id, syncFromServer]);

  return query;
}
