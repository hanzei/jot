import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotes, getNote, createNote, updateNote, deleteNote, restoreNote, permanentDeleteNote, reorderNotes } from '../api/notes';
import { getNoteShares, shareNote, unshareNote } from '../api/users';
import { Note, NoteShare, GetNotesParams, CreateNoteRequest, UpdateNoteRequest } from '../types';

export function useNotes(params?: GetNotesParams) {
  return useQuery<Note[]>({
    queryKey: ['notes', params],
    queryFn: () => getNotes(params),
  });
}

export function useNote(id: string | null) {
  return useQuery<Note>({
    queryKey: ['note', id],
    queryFn: () => getNote(id!),
    enabled: id !== null,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateNoteRequest) => createNote(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateNoteRequest }) => updateNote(id, data),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(['note', updatedNote.id], updatedNote);
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function usePermanentDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteNote(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useReorderNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteIds: string[]) => reorderNotes(noteIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useNoteShares(noteId: string | null) {
  return useQuery<NoteShare[]>({
    queryKey: ['noteShares', noteId],
    queryFn: () => getNoteShares(noteId!),
    enabled: noteId !== null,
  });
}

export function useShareNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      shareNote(noteId, userId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['noteShares', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useUnshareNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      unshareNote(noteId, userId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['noteShares', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}
