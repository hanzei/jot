import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getLabels, addLabelToNote, removeLabelFromNote } from '../api/labels';

export function useLabels() {
  return useQuery({
    queryKey: ['labels'],
    queryFn: getLabels,
  });
}

export function useAddLabelToNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, name }: { noteId: string; name: string }) =>
      addLabelToNote(noteId, name),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      // Invalidate labels list since a new label name may have been created
      queryClient.invalidateQueries({ queryKey: ['labels'] });
    },
  });
}

export function useRemoveLabelFromNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, labelId }: { noteId: string; labelId: string }) =>
      removeLabelFromNote(noteId, labelId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
    },
  });
}
