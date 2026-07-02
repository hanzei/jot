import { useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import type { NoteImage } from '@jot/shared';
import { uploadNoteImage, deleteNoteImage, type ImageUploadFile } from '../api/images';
import { patchLocalNoteImages } from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable } from '../db/syncQueue';
import { enqueueImageUpload } from '../db/imageUploadQueue';
import { deleteCachedNoteImage } from '../utils/noteImageCache';
import { assertSwitchWriteAllowed } from '../api/client';
import { useNetworkStatus } from './useNetworkStatus';
import { isLocalModeActive } from '../store/localMode';
import { noteLocalQueryKey, notesLocalQueryScopeKey, pendingImageUploadsQueryKey } from './queryKeys';

export type UploadNoteImageResult = { status: 'uploaded'; image: NoteImage } | { status: 'queued' };

export function useUploadNoteImage() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({
      noteId,
      uploadId,
      file,
      onProgress,
    }: {
      noteId: string;
      /** Client-generated id shared with the ephemeral gallery tile, so a fallback to the persisted queue below reuses the same key (issue #618). */
      uploadId: string;
      file: ImageUploadFile;
      onProgress?: (percent: number) => void;
    }): Promise<UploadNoteImageResult> => {
      assertSwitchWriteAllowed();

      if (isLocalModeActive() || isConnectedRef.current) {
        try {
          const image = await uploadNoteImage(noteId, file, onProgress);
          // The SSE echo of this upload is dropped for the client that triggered
          // it (self-echo suppression in useSSE, keyed on the same X-Client-Id
          // header this upload just sent), so the local cache needs patching here
          // directly instead of waiting for note_image_added to arrive.
          await patchLocalNoteImages(db, noteId, (images) =>
            images.some((img) => img.id === image.id) ? images : [...images, image],
          );
          return { status: 'uploaded', image };
        } catch (err) {
          // No server ever exists in local mode (epic #511), so there is nothing
          // to queue a replay against — keep #617's online-only behavior: let the
          // failure surface directly. Otherwise, a transient failure falls
          // through to the offline queue below instead of losing the picked
          // file; a permanent failure (413 too large, 400 validation, etc.)
          // rethrows so the caller shows an error tile.
          if (isLocalModeActive()) throw err;
          rethrowIfNotQueueable(err);
        }
      }

      // Offline, or a transient online failure above: persist the file and
      // queue it for replay once the sync engine's drain can reach the server.
      await enqueueImageUpload(db, { id: uploadId, noteId, file });
      return { status: 'queued' };
    },
    onSuccess: (result, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      if (result.status === 'queued') {
        queryClient.invalidateQueries({ queryKey: pendingImageUploadsQueryKey(noteId) });
      }
    },
  });
}

export function useDeleteNoteImage() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, imageId }: { noteId: string; imageId: string }): Promise<void> => {
      assertSwitchWriteAllowed();

      if (isLocalModeActive() || isConnectedRef.current) {
        try {
          await deleteNoteImage(imageId);
          // Same self-echo gap as the upload above, on the removal side.
          await patchLocalNoteImages(db, noteId, (images) => images.filter((img) => img.id !== imageId));
          await deleteCachedNoteImage(imageId);
          return;
        } catch (err) {
          // No server ever exists in local mode — same rationale as the upload above.
          if (isLocalModeActive()) throw err;
          rethrowIfNotQueueable(err);
        }
      }

      // Offline, or a transient online failure above: hide the image locally
      // now (matching the online path's effect) and queue the hard-delete for
      // replay. `/images/{id}` has no note id of its own, so it's carried in
      // the body purely for the queue's note-id bookkeeping (see
      // collectNoteIds in syncQueue.ts) — DELETE sends no body to the server.
      await patchLocalNoteImages(db, noteId, (images) => images.filter((img) => img.id !== imageId));
      await deleteCachedNoteImage(imageId);
      await enqueueOperation(db, {
        operation: 'removeImage',
        endpoint: `/images/${imageId}`,
        method: 'DELETE',
        body: { note_id: noteId },
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}
