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
import { markLocalNoteDeleted, permanentDeleteLocalNote, patchLocalNoteImages, upsertLabel } from '../db/noteQueries';
import { getProtectedNoteIds, saveServerNote } from '../db/syncQueue';
import { getNote } from '../api/notes';
import { isSseQuiesced, subscribeToServerSwitchLifecycle } from '../store/serverSwitchLifecycle';
import { publishProfileIconUpdate } from '../store/profileIconEvents';
import { publishReconnectResync } from '../store/resyncEvents';
import {
  labelCountsQueryKey,
  labelsQueryKey,
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
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  onNoteUpdatedRef.current = onNoteUpdatedByOther;
  const onStatusChangeRef = useRef(onStatusChange);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  onStatusChangeRef.current = onStatusChange;
  // Tracks whether the stream has connected at least once this session, so the
  // catch-up resync fires only on a *re*connect and not the initial connect
  // (whose catch-up is already covered by the read hooks' mount-time sync).
  const hasConnectedOnceRef = useRef(false);
  const dbRef = useRef(db);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  dbRef.current = db;
  const userIdRef = useRef(user?.id);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
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
        // The drawer's label list and per-label counts (useLabels / useLabelCounts)
        // are derived from notes' labels_json in SQLite, so any note mutation can
        // change them. Invalidate them right after the note write lands (a local
        // re-read, no server round-trip) so the drawer refreshes in lockstep.
        const invalidateLabelQueries = () => {
          queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
          queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
        };
        switch (event.type) {
          case 'note_updated': {
            const { note_id, note } = event.data;
            if (note) {
              // Persist the updated note to SQLite so offline reads stay current
              // (deferring to a pending local edit on this note; see #487).
              try {
                await saveServerNote(db, note);
              } catch (err) {
                console.warn(`Failed to persist SSE ${event.type} for note id=${note_id}:`, err);
              }
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            invalidateLabelQueries();
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
            } catch (err) {
              console.warn(`Failed to persist SSE ${event.type} for note id=${note_id}:`, err);
            }
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            invalidateLabelQueries();
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
            } catch (err) {
              console.warn(`Failed to persist SSE ${event.type} for note id=${note_id}:`, err);
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            invalidateLabelQueries();
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
              } catch (err) {
                console.warn(`Failed to persist SSE ${event.type} for note id=${note_id}:`, err);
              }
            } else {
              // Owner / remaining collaborator: they keep the note but its
              // shared_with changed. The event carries no payload, and the
              // SQLite-backed queries (staleTime: Infinity) won't refetch on a
              // bare invalidation, so fetch the canonical note to refresh
              // shared_with/is_shared (deferring to a pending local edit; #487).
              try {
                await saveServerNote(db, await getNote(note_id));
              } catch (err) {
                console.warn(`Failed to persist SSE ${event.type} for note id=${note_id}:`, err);
              }
              queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(note_id) });
            }
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            invalidateLabelQueries();
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
            } catch (err) {
              console.warn(`Failed to persist SSE ${event.type} for note id=${imageNoteId}:`, err);
            }
            queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(imageNoteId) });
            queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
            break;
          }
          case 'labels_changed': {
            // A label was created on another device. Upsert it into the canonical
            // local label store so it appears in the drawer immediately — even when
            // it has zero attached notes (the store is what makes empty labels
            // reliable now; counts stay derived from notes) (#691).
            const { label } = event.data;
            if (label) {
              try {
                await upsertLabel(db, label);
              } catch (err) {
                console.warn(`Failed to persist SSE ${event.type} for label id=${label.id}:`, err);
              }
            }
            invalidateLabelQueries();
            break;
          }
          case 'profile_icon_updated': {
            // A collaborator changed their profile icon. Hand the updated user to
            // UsersContext (via the module bus, since UsersProvider sits above
            // SSEProvider) so avatars re-render off the bumped updated_at.
            const { user } = event.data;
            if (user) {
              publishProfileIconUpdate(user);
            }
            break;
          }
        }
      })();
    }, (status) => {
      // Catch-up after a *re*connect: SSE is a live stream with no backfill, so
      // any event emitted while it was down (notably while the app was
      // backgrounded — which calls stopConnection below) is lost. The read-side
      // background syncs otherwise only re-run on an isConnected flip, which does
      // not happen when the app is merely foregrounded on a stable network, so
      // publish a resync signal that the note/label/user caches listen for. It
      // fires on every reconnect (foreground, watchdog stall recovery,
      // server-switch), but never the first connect — that's already covered by
      // the read hooks' mount-time sync, and firing it here would just add a
      // redundant fetch at launch.
      //
      // We publish the *fetch* trigger, not a blanket query invalidation: an
      // invalidate only re-reads the (still-stale) local SQLite without hitting
      // the server, and doing so before fresh data lands is what caused the old
      // on-reconnect screen flash. The subscribers fetch → persist → invalidate,
      // so the UI only updates once fresh data is in SQLite.
      if (status === 'connected') {
        if (hasConnectedOnceRef.current) {
          publishReconnectResync();
        } else {
          hasConnectedOnceRef.current = true;
        }
      }
      onStatusChangeRef.current?.(status);
    });
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
        // A brief inactive→active blip (control center, notification shade, app
        // switcher peek) shouldn't tear down a working stream and pay a fresh TLS
        // handshake on a weak link, so only rebuild if it isn't already healthy.
        // A real background transition runs stopConnection() below (nulling the
        // manager), so this still reconnects after actual backgrounding; and the
        // reconnect/server-switch paths still force a rebuild via startConnection().
        if (!managerRef.current?.isConnected()) {
          startConnection();
        }
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
