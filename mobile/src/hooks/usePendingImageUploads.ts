import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import {
  getPendingImageUploads,
  retryImageUpload,
  dismissImageUpload,
} from '../db/imageUploadQueue';
import type { PendingImageUpload } from '../components/NoteImageGallery';
import { pendingImageUploadsQueryKey, pendingImageUploadsQueryScopeKey } from './queryKeys';

// The persisted counterpart to NoteEditorScreen's in-memory `imageUploads`
// state: uploads that were queued while offline (or hit a transient failure)
// live in the pending_image_uploads table so they survive navigating away or
// an app restart until the sync engine's drain flushes them (issue #618).
export function usePendingImageUploads(noteId: string | null): PendingImageUpload[] {
  const db = useSQLiteContext();
  const { data } = useQuery({
    queryKey: pendingImageUploadsQueryKey(noteId),
    queryFn: async (): Promise<PendingImageUpload[]> => {
      const rows = await getPendingImageUploads(db, noteId!);
      return rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        previewUri: row.local_path,
        progress: 0,
        status: row.status,
        errorMessage: row.error_message ?? undefined,
      }));
    },
    enabled: noteId !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? [];
}

export function useRetryPendingImageUpload() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => retryImageUpload(db, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pendingImageUploadsQueryScopeKey() });
    },
  });
}

export function useDismissPendingImageUpload() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => dismissImageUpload(db, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pendingImageUploadsQueryScopeKey() });
    },
  });
}
