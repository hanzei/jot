import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import {
  getPendingImageUploads,
  retryImageUpload,
  dismissImageUpload,
} from '../db/imageUploadQueue';
import { pendingImageUploadsQueryKey, pendingImageUploadsQueryScopeKey } from './queryKeys';

// A locally-tracked upload in flight (or failed) for a note, rendered as a
// gallery tile alongside the note's persisted images. Never sent to the
// server as-is — id is a client-generated key, not a NoteImage id. Defined
// here (the data hook that produces it) rather than in NoteImageGallery.tsx
// (the UI component that renders it) so the data layer doesn't depend on a UI
// component's types; NoteImageGallery re-exports it for its existing callers.
//
// 'queued' additionally covers an offline-deferred upload (issue #618):
// persisted to the pending_image_uploads table, so — unlike 'uploading' and
// 'error', which are held only in NoteEditorScreen's in-memory state — it
// survives navigating away or an app restart until the sync engine's drain
// flushes it (rendered the same as 'error': no progress bar, since nothing is
// in flight yet).
export interface PendingImageUpload {
  id: string;
  filename: string;
  previewUri: string;
  progress: number;
  status: 'uploading' | 'queued' | 'error';
  errorMessage?: string;
}

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
    // NoteEditorScreen fires this with `.mutate()` (fire-and-forget), so a
    // rejected write would otherwise be silently absorbed into unread mutation
    // state; at minimum, log it so a failure here is debuggable.
    onError: (error) => {
      console.error('Failed to retry a queued image upload:', error);
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
    onError: (error) => {
      console.error('Failed to dismiss a queued image upload:', error);
    },
  });
}
