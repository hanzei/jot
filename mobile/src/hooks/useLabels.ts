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
import { saveNote, saveNotes, renameLabelInLocalNotes, deleteLabelFromLocalNotes, getLocalLabels, getLocalLabelCounts, getLocalNote, generateLocalId, isLocalId } from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import { isServerSwitchInProgress } from '../api/client';
import type { Label, Note } from '@jot/shared';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  noteQueryKey,
  noteQueryScopeKey,
  notesLocalQueryScopeKey,
  notesQueryScopeKey,
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
      await saveNotes(db, notes);
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

  const query = useQuery<T>({
    queryKey: getQueryKey(),
    queryFn: localFn,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  useEffect(() => {
    if (!isConnected) return;
    const key = getQueryKey();
    let cancelled = false;
    (async () => {
      try {
        const data = await serverFn();
        if (!cancelled) queryClient.setQueryData(key, data);
      } catch { /* background sync — local cache remains */ }
    })();
    return () => { cancelled = true; };
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

export function useCreateLabel() {
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      assertSwitchWriteAllowed();
      if (!isConnectedRef.current) {
        throw new Error('Label creation requires an internet connection');
      }
      return createLabel(name);
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
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryScopeKey() });
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

  return useMutation({
    mutationFn: async ({ noteId, name }: { noteId: string; name: string }): Promise<Note> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('Label name must not be empty');
      }
      if (isConnectedRef.current) {
        try {
          const updatedNote = await addLabelToNote(noteId, trimmed);
          await saveNote(db, updatedNote);
          return updatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the label is
          // attached locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): attach the label locally and
      // queue the server operation.
      const existing = await getLocalNote(db, noteId);
      if (!existing) {
        throw new Error(`Note ${noteId} not found in local DB`);
      }
      // Already attached locally (and therefore already synced or queued): return
      // it as-is without writing or queuing a redundant operation. The server
      // treats label names as case-insensitively unique, so compare the same way.
      const normalized = trimmed.toLowerCase();
      if (existing.labels.some((l) => l.name.toLowerCase() === normalized)) {
        return existing;
      }
      const now = new Date().toISOString();
      // Reuse a known label with this name (so its id matches the server's),
      // otherwise mint a local one that drainQueue reconciles on replay.
      const known = await getLocalLabels(db);
      const label: Label = known.find((l) => l.name.toLowerCase() === normalized) ?? {
        id: generateLocalId(),
        user_id: existing.user_id,
        name: trimmed,
        created_at: now,
        updated_at: now,
      };
      const updatedNote: Note = {
        ...existing,
        labels: [...existing.labels, label],
        updated_at: now,
      };
      await saveNote(db, updatedNote);
      await enqueueOperation(db, {
        operation: 'addLabel',
        endpoint: `/notes/${noteId}/labels`,
        method: 'POST',
        // local_label_id lets drainQueue remap a later removeLabel that
        // references the locally-minted id; the server ignores it.
        body: isLocalId(label.id) ? { name: trimmed, local_label_id: label.id } : { name: trimmed },
      });
      return updatedNote;
    },
    onSuccess: (updatedNote, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
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
    mutationFn: async ({ noteId, labelId }: { noteId: string; labelId: string }): Promise<Note> => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        try {
          const updatedNote = await removeLabelFromNote(noteId, labelId);
          await saveNote(db, updatedNote);
          return updatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the removal
          // is applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): detach the label locally and
      // queue the server operation.
      const existing = await getLocalNote(db, noteId);
      if (!existing) {
        throw new Error(`Note ${noteId} not found in local DB`);
      }
      const updatedNote: Note = {
        ...existing,
        labels: existing.labels.filter((l) => l.id !== labelId),
        updated_at: new Date().toISOString(),
      };
      await saveNote(db, updatedNote);
      await enqueueOperation(db, {
        operation: 'removeLabel',
        endpoint: `/notes/${noteId}/labels/${labelId}`,
        method: 'DELETE',
      });
      return updatedNote;
    },
    onSuccess: (updatedNote, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
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

  return useMutation({
    mutationFn: async ({ labelId, name }: { labelId: string; name: string }) => {
      assertSwitchWriteAllowed();
      if (!isConnectedRef.current) {
        throw new Error('Label management requires an internet connection');
      }
      const updatedLabel = await renameLabel(labelId, name);
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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryScopeKey() });
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
      if (!isConnectedRef.current) {
        throw new Error('Label management requires an internet connection');
      }
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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    },
  });
}
