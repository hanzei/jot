import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotes, getNote, createNote, updateNote, deleteNote } from '../api/notes';
import { Note, GetNotesParams, CreateNoteRequest, UpdateNoteRequest } from '../types';

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
