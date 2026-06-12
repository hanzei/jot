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
import { saveNote, saveNotes, renameLabelInLocalNotes, deleteLabelFromLocalNotes, getLocalLabels, getLocalLabelCounts } from '../db/noteQueries';
import { useNetworkStatus } from './useNetworkStatus';
import { isServerSwitchInProgress } from '../api/client';
import type { Label } from '@jot/shared';
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
    let cancelled = false;
    (async () => {
      try {
        const data = await serverFn();
        if (!cancelled) queryClient.setQueryData(getQueryKey(), data);
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
  return useMutation({
    mutationFn: ({ noteId, name }: { noteId: string; name: string }) => {
      assertSwitchWriteAllowed();
      return addLabelToNote(noteId, name);
    },
    onSuccess: async (updatedNote, { noteId }) => {
      await saveNote(db, updatedNote);
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
  return useMutation({
    mutationFn: ({ noteId, labelId }: { noteId: string; labelId: string }) => {
      assertSwitchWriteAllowed();
      return removeLabelFromNote(noteId, labelId);
    },
    onSuccess: async (updatedNote, { noteId }) => {
      await saveNote(db, updatedNote);
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
