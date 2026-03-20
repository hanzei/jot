import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { getLabels, addLabelToNote, removeLabelFromNote, renameLabel, deleteLabel } from '../api/labels';
import { getNotes } from '../api/notes';
import { saveNote, saveNotes, renameLabelInLocalNotes, deleteLabelFromLocalNotes } from '../db/noteQueries';
import { useNetworkStatus } from './useNetworkStatus';

async function syncLocalNotesAfterLabelMutation(db: SQLiteDatabase) {
  const scopes = [
    undefined,
    { archived: true },
    { trashed: true },
    { my_todo: true },
  ] as const;

  for (const scope of scopes) {
    const notes = await getNotes(scope);
    await saveNotes(db, notes);
  }
}

export function useLabels() {
  return useQuery({
    queryKey: ['labels'],
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
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note-local', noteId] });
      // Invalidate labels list since a new label name may have been created
      queryClient.invalidateQueries({ queryKey: ['labels'] });
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
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note-local', noteId] });
      queryClient.invalidateQueries({ queryKey: ['labels'] });
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
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['note'] });
      queryClient.invalidateQueries({ queryKey: ['note-local'] });
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
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['note'] });
      queryClient.invalidateQueries({ queryKey: ['note-local'] });
    },
  });
}
