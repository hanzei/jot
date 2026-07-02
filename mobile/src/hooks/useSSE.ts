import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../store/AuthContext';
import { SSEConnectionManager, type SSEStatus } from '../api/events';
import { setActiveSseManager } from '../api/sseState';
import { CLIENT_ID } from '../api/client';
import type { SSEEvent } from '@jot/shared';
import { useNetworkStatus } from './useNetworkStatus';
import { markLocalNoteDeleted, permanentDeleteLocalNote, patchLocalNoteImages } from '../db/noteQueries';
import { getProtectedNoteIds, saveServerNote } from '../db/syncQueue';
import { getNote } from '../api/notes';
import { isSseQuiesced, subscribeToServerSwitchLifecycle } from '../store/serverSwitchLifecycle';
import {
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

export type SSENotificationCallback = (event: SSEEvent) => void;
export type SSEStatusChangeCallback = (status: SSEStatus) => void;

export function useSSE(
  onNoteUpdatedByOther?: SSENotificationCallback,
  onStatusChange?: SSEStatusChangeCallback,
): void {
  const { user, isAuthenticated, isLocalMode } = useAuth();
  const { isConnected } = useNetworkStatus();
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const managerRef = useRef<SSEConnectionManager | null>(null);
  const onNoteUpdatedRef = useRef(onNoteUpdatedByOther);
  onNoteUpdatedRef.current = onNoteUpdatedByOther;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
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
    setActiveSseManager(manager);

    manager.connect((event: SSEEvent) => {
      // Drop events that originated from this device to avoid redundant invalidations.
      if (event.client_id && event.client_id === CLIENT_ID) return;

      // Apply the SQLite write *before* invalidating queries. The notes list and
      // single-note queries read straight from SQLite (staleTime: Infinity), so an
      // invalidation triggers an immediate refetch; invalidating before the write
      // lands makes that refetch read stale rows, and nothing re-fetches once the
      // write completes (the change wouldn't surface until the next background
      // sync). Awaiting the write first keeps the refetch in sync — this mirrors
      // useOfflineNote's background-fetch ordering.
      void (async () => {
        const db = dbRef.current;
        switch (event.type) {
          case 'note_updated': {
            const { note_id, note } = event.data;
            if (note) {
              // Persist the updated note to SQLite so offline reads stay current
              // (deferring to a pending local edit on this note; see #487).
              try {
                await saveServerNote(db, note);
              } catch {
                // Note has a pending/failed local op or the write failed; keep the
                // local copy and let the queue drain / next sync reconcile it.
              }
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            // Don't fire the "updated by someone else" notification for changes
            // from the same user on another device — query invalidation above is
            // sufficient to sync the state.
            if (event.source_user_id !== userIdRef.current) {
              onNoteUpdatedRef.current?.(event);
            }
            break;
          }
          case 'note_deleted': {
            const { note_id } = event.data;
            // Tombstone the note in SQLite so it disappears from offline views — but
            // defer to a pending or failed local edit/restore on this note: a queued op
            // may be racing the remote delete, or a dead-lettered edit may be the version
            // we're preserving, so let the drain/resolution reconcile it rather than hide
            // the optimistic edit (#487/#492). The drain replaying against a server-deleted
            // note gets a 404 and dead-letters the op, so this can't wedge the queue.
            try {
              const protectedNoteIds = await getProtectedNoteIds(db);
              if (!protectedNoteIds.has(note_id)) {
                queryClient.removeQueries({ queryKey: noteLocalQueryKey(note_id) });
                await markLocalNoteDeleted(db, note_id);
              }
            } catch {
              // Leave the local copy in place; a later sync reconciles it.
            }
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
          case 'note_created':
          case 'note_shared': {
            const { note_id, note } = event.data;
            // Persist the note straight into SQLite (deferring to a pending local
            // edit; see #487). The list/detail queries read from SQLite with
            // staleTime: Infinity, so invalidation alone only re-reads the
            // (still-missing) local rows — it does NOT trigger a server fetch (that
            // only fires on an isConnected flip). Without writing here, a note newly
            // created/shared on another device wouldn't appear until the next
            // reconnect or foreground. If the event carries no payload (older
            // server), fall back to a one-shot fetch.
            try {
              if (note) {
                await saveServerNote(db, note);
              } else {
                await saveServerNote(db, await getNote(note_id));
              }
            } catch {
              // Pending/failed local op, fetch failure, or note inaccessible;
              // the next background sync reconciles it.
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
          case 'note_unshared': {
            const { note_id } = event.data;
            if (event.target_user_id === userIdRef.current) {
              // The recipient who lost access receives no note payload and can no
              // longer see the note in any scope, so hard-remove it locally (not a
              // tombstone — it must not linger in their trash view). Defer to a
              // pending/failed local op (#487/#492).
              try {
                const protectedNoteIds = await getProtectedNoteIds(db);
                if (!protectedNoteIds.has(note_id)) {
                  queryClient.removeQueries({ queryKey: noteLocalQueryKey(note_id) });
                  await permanentDeleteLocalNote(db, note_id);
                }
              } catch {
                // Leave the local copy in place; a later sync reconciles it.
              }
            } else {
              // Owner / remaining collaborator: they keep the note but its
              // shared_with changed. The event carries no payload, and the
              // SQLite-backed queries (staleTime: Infinity) won't refetch on a
              // bare invalidation, so fetch the canonical note to refresh
              // shared_with/is_shared (deferring to a pending local edit; #487).
              try {
                await saveServerNote(db, await getNote(note_id));
              } catch {
                // Fetch failed or note has a pending/failed local op; the next
                // background sync reconciles it.
              }
              queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            }
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
          case 'note_image_added':
          case 'note_image_removed': {
            const { note_id: imageNoteId } = event.data;
            try {
              await patchLocalNoteImages(db, imageNoteId, (images) => {
                if (event.type === 'note_image_added') {
                  const image = event.data.image;
                  if (!image || images.some((img) => img.id === image.id)) return images;
                  return [...images, image];
                }
                const imageId = event.data.image_id;
                if (!imageId) return images;
                return images.filter((img) => img.id !== imageId);
              });
            } catch {
              // Note not cached locally yet, or the write failed; the next
              // background sync/fetch reconciles it.
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(imageNoteId) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
        }
      })();
    }, (status) => onStatusChangeRef.current?.(status));
    // No catch-up invalidation here: startConnection runs on every reconnect,
    // foreground, and server-switch, and a blanket invalidate only re-reads the
    // (still-stale) local SQLite — it doesn't fetch from the server. The actual
    // catch-up after a reconnect is useOfflineNotes' background server resync,
    // which fires on the same isConnected flip, and live SSE events deliver any
    // subsequent changes. Invalidating here just added a redundant refetch that
    // raced the resync and contributed to the on-reconnect screen flashing.
  }, [queryClient]);

  const stopConnection = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current = null;
      setActiveSseManager(null);
    }
  }, []);

  // Manage connection based on auth state, network status, and app lifecycle
  useEffect(() => {
    // Real-time cross-device sync requires a central server, so SSE never starts
    // in local mode (epic #511, issue #514).
    if (!isAuthenticated || !isConnected || isLocalMode) {
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
      if (!isAuthenticated || !isConnected || isLocalMode) {
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
  }, [isAuthenticated, isConnected, isLocalMode, startConnection, stopConnection]);
}
