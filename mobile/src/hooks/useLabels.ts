import { useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import {
  getLabels,
  getLabelCounts,
  createLabel,
  addLabelToNote,
  removeLabelFromNote,
  renameLabel,
  deleteLabel,
} from '../api/labels';
import { getNotes } from '../api/notes';
import {
  saveNote,
  renameLabelInLocalNotes,
  deleteLabelFromLocalNotes,
  addLabelToLocalNote,
  removeLabelFromLocalNote,
  getLocalLabels,
  getLocalLabelCounts,
  getLocalNote,
  generateClientLabelId,
  isNotePendingCreate,
} from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable, saveServerNotes } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import { useAuth } from '../store/AuthContext';
import { isLocalModeActive } from '../store/localMode';
import { isServerSwitchInProgress } from '../api/client';
import type { Label } from '@jot/shared';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

type LabelSyncScope = { archived?: true; trashed?: true; my_tasks?: true } | undefined;

function assertSwitchWriteAllowed(): void {
  if (isServerSwitchInProgress()) {
    throw new Error('Server switch in progress; write blocked');
  }
}

function describeLabelSyncScope(scope: LabelSyncScope): string {
  if (scope?.archived) {
    return 'archived';
  }
  if (scope?.trashed) {
    return 'trashed';
  }
  if (scope?.my_tasks) {
    return 'my_tasks';
  }
  return 'active';
}

async function syncLocalNotesAfterLabelMutation(db: SQLiteDatabase) {
  const scopes = [
    undefined,
    { archived: true },
    { trashed: true },
    { my_tasks: true },
  ] as const;
  const failures: string[] = [];

  for (const scope of scopes) {
    try {
      const notes = await getNotes(scope);
      // saveServerNotes re-reads the pending set per scope, so an edit queued
      // mid-loop is gated by the scope saved after it, not just a stale snapshot
      // taken before the (multi-fetch) loop began (#487).
      await saveServerNotes(db, notes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${describeLabelSyncScope(scope)} scope: ${detail}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`failed to sync local notes after label mutation: ${failures.join('; ')}`);
  }
}

function useBackgroundSyncQuery<T>(
  getQueryKey: () => unknown[],
  localFn: () => Promise<T>,
  serverFn: () => Promise<T>,
) {
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const query = useQuery<T>({
    queryKey: getQueryKey(),
    queryFn: localFn,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  useEffect(() => {
    // Local mode has no server to read from; keep the local cache and skip the
    // background resync entirely (issue #514).
    if (!isConnected || isLocalModeActive()) return;
    const key = getQueryKey();
    const canceller = new SyncCanceller();
    (async () => {
      try {
        const data = await retrySync(serverFn, {
          isConnected: () => isConnectedRef.current,
          canceller,
        });
        if (!canceller.cancelled) queryClient.setQueryData(key, data);
      } catch (err) {
        // Cancelled or offline: expected; keep the local cache.
        if (err instanceof SyncAbortedError) return;
        // Retries exhausted (or a permanent error): local cache remains.
        console.warn('Background sync failed after retries:', err);
      }
    })();
    return () => { canceller.cancel(); };
  }, [isConnected, queryClient, getQueryKey, serverFn]);

  return query;
}

export function useLabels() {
  const db = useSQLiteContext();
  return useBackgroundSyncQuery(labelsQueryKey, () => getLocalLabels(db), getLabels);
}

export function useLabelCounts() {
  const db = useSQLiteContext();
  return useBackgroundSyncQuery(labelCountsQueryKey, () => getLocalLabelCounts(db), getLabelCounts);
}

/** Build an optimistic, locally-created label for the offline / transient-failure path. */
function buildLocalLabel(name: string, userId: string): Label {
  const now = new Date().toISOString();
  return {
    id: generateClientLabelId(),
    user_id: userId,
    name,
    created_at: now,
    updated_at: now,
  };
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ name }: { name: string }): Promise<Label> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Label name must not be empty');
      if (isConnectedRef.current && !isLocalModeActive()) {
        try {
          return await createLabel(trimmed);
        } catch (err) {
          // Transient failure: fall through to the offline path so the label is
          // queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): create a local placeholder label
      // and queue the server create. The client-generated id is sent to the server
      // as the label's primary key (#546), so no ID reconciliation is needed on
      // replay. Labels are derived from notes' labels_json, so a label not yet
      // attached to any note lives only in the React Query cache (updated in
      // onSuccess) until it is.
      const localLabel = buildLocalLabel(trimmed, user?.id ?? '');
      await enqueueOperation(db, {
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: { id: localLabel.id, name: trimmed },
      });
      return localLabel;
    },
    onSuccess: (newLabel) => {
      // A newly created label is not yet attached to any note, so getLocalLabels()
      // won't find it — add it directly to avoid it disappearing after the mutation.
      queryClient.setQueryData<Label[]>(labelsQueryKey(), (old) => {
        const existing = old ?? [];
        if (existing.some((l) => l.id === newLabel.id)) return existing;
        return [...existing, newLabel].sort((a, b) => a.name.localeCompare(b.name));
      });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    },
  });
}

export function useAddLabelToNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId, name }: { noteId: string; name: string }) => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Label name must not be empty');
      // An offline-created note already carries a server-valid id (#475) and its
      // queued create drains FIFO before this label op, so queue rather than
      // calling online against a note the server doesn't know yet (a 404 would
      // surface as an error instead of syncing).
      const pendingCreate = await isNotePendingCreate(db, noteId);
      if (isConnectedRef.current && !pendingCreate && !isLocalModeActive()) {
        try {
          const updatedNote = await addLabelToNote(noteId, trimmed);
          await saveNote(db, updatedNote);
          return updatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the edit is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): attach the label to the local
      // note and queue the server op (the server resolves the label by name).
      const note = await getLocalNote(db, noteId);
      if (!note) throw new Error(`Note ${noteId} not found in local cache`);

      // Reuse an existing label with the same name if known locally; otherwise
      // mint a local label and queue its create so any later op referencing it
      // (e.g. removing it again while still offline) reconciles to the server id.
      // Match case-insensitively to mirror the server's GetOrCreateLabel lookup.
      const normalized = trimmed.toLowerCase();
      const known = (await getLocalLabels(db)).find((l) => l.name.toLowerCase() === normalized);
      const label = known ?? buildLocalLabel(trimmed, user?.id ?? '');
      if (!known) {
        await enqueueOperation(db, {
          operation: 'createLabel',
          endpoint: '/labels',
          method: 'POST',
          body: { id: label.id, name: trimmed },
        });
      }

      await addLabelToLocalNote(db, noteId, label);
      await enqueueOperation(db, {
        operation: 'addLabelToNote',
        endpoint: `/notes/${noteId}/labels`,
        method: 'POST',
        body: { name: trimmed },
      });
      return note;
    },
    onSuccess: async (_updatedNote, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      // Invalidate labels list since a new label name may have been created
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
    },
  });
}

export function useRemoveLabelFromNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, labelId }: { noteId: string; labelId: string }) => {
      assertSwitchWriteAllowed();
      // An offline-created note (#475) drains its create FIFO before this label
      // op, so queue rather than calling online against a note the server doesn't
      // know yet.
      const pendingCreate = await isNotePendingCreate(db, noteId);
      if (isConnectedRef.current && !pendingCreate && !isLocalModeActive()) {
        try {
          const updatedNote = await removeLabelFromNote(noteId, labelId);
          await saveNote(db, updatedNote);
          return updatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the edit is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): drop the label from the local
      // note and queue the server op. If the label id is a local one (added while
      // offline), it is remapped to the server id on replay (see drainQueue).
      const note = await getLocalNote(db, noteId);
      if (!note) throw new Error(`Note ${noteId} not found in local cache`);

      await removeLabelFromLocalNote(db, noteId, labelId);
      await enqueueOperation(db, {
        operation: 'removeLabelFromNote',
        endpoint: `/notes/${noteId}/labels/${labelId}`,
        method: 'DELETE',
      });
      return note;
    },
    onSuccess: async (_updatedNote, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
    },
  });
}

export function useRenameLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ labelId, name }: { labelId: string; name: string }): Promise<Label> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Label name must not be empty');
      if (isConnectedRef.current && !isLocalModeActive()) {
        try {
          const updatedLabel = await renameLabel(labelId, trimmed);
          try {
            await renameLabelInLocalNotes(db, labelId, updatedLabel.name);
          } catch (error) {
            console.warn('Failed to update renamed label locally, retrying with full sync:', error);
            try {
              await syncLocalNotesAfterLabelMutation(db);
            } catch (syncError) {
              console.warn('Failed to resync local notes after label rename:', syncError);
            }
          }
          return updatedLabel;
        } catch (err) {
          // Transient failure: fall through to the offline path so the rename is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): rename locally and queue. A
      // local label id (offline-created, not yet synced) is remapped to the
      // server id on replay (see drainQueue).
      await renameLabelInLocalNotes(db, labelId, trimmed);
      await enqueueOperation(db, {
        operation: 'renameLabel',
        endpoint: `/labels/${labelId}`,
        method: 'PATCH',
        body: { name: trimmed },
      });
      const now = new Date().toISOString();
      return { id: labelId, user_id: user?.id ?? '', name: trimmed, created_at: now, updated_at: now };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ labelId }: { labelId: string }) => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current && !isLocalModeActive()) {
        try {
          await deleteLabel(labelId);
          try {
            await deleteLabelFromLocalNotes(db, labelId);
          } catch (error) {
            console.warn('Failed to delete label locally, retrying with full sync:', error);
            try {
              await syncLocalNotesAfterLabelMutation(db);
            } catch (syncError) {
              console.warn('Failed to resync local notes after label deletion:', syncError);
            }
          }
          return;
        } catch (err) {
          // Transient failure: fall through to the offline path so the deletion is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): delete locally and queue. A
      // local label id (offline-created, not yet synced) is remapped to the
      // server id on replay (see drainQueue).
      await deleteLabelFromLocalNotes(db, labelId);
      await enqueueOperation(db, {
        operation: 'deleteLabel',
        endpoint: `/labels/${labelId}`,
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    },
  });
}
