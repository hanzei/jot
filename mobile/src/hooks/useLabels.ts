import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { getLabels, addLabelToNote, removeLabelFromNote, renameLabel, deleteLabel } from '../api/labels';
import { getNotes } from '../api/notes';
import { saveNote, saveNotes, renameLabelInLocalNotes, deleteLabelFromLocalNotes } from '../db/noteQueries';
import { useNetworkStatus } from './useNetworkStatus';
import {
  labelsQueryKey,
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  noteQueryKey,
  noteQueryScopeKey,
  notesLocalQueryScopeKey,
  notesQueryScopeKey,
} from './queryKeys';

type LabelSyncScope = { archived?: true; trashed?: true; my_todo?: true } | undefined;

function describeLabelSyncScope(scope: LabelSyncScope): string {
  if (scope?.archived) {
    return 'archived';
  }
  if (scope?.trashed) {
    return 'trashed';
  }
  if (scope?.my_todo) {
    return 'my_todo';
  }
  return 'active';
}

async function syncLocalNotesAfterLabelMutation(db: SQLiteDatabase) {
  const scopes = [
    undefined,
    { archived: true },
    { trashed: true },
    { my_todo: true },
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

export function useLabels() {
  return useQuery({
    queryKey: labelsQueryKey(),
    queryFn: getLabels,
  });
}

export function useAddLabelToNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  return useMutation({
    mutationFn: ({ noteId, name }: { noteId: string; name: string }) =>
      addLabelToNote(noteId, name),
    onSuccess: async (updatedNote, { noteId }) => {
      await saveNote(db, updatedNote);
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      // Invalidate labels list since a new label name may have been created
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
    },
  });
}

export function useRemoveLabelFromNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  return useMutation({
    mutationFn: ({ noteId, labelId }: { noteId: string; labelId: string }) =>
      removeLabelFromNote(noteId, labelId),
    onSuccess: async (updatedNote, { noteId }) => {
      await saveNote(db, updatedNote);
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
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
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    },
  });
}
