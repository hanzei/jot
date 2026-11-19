import axios from 'axios';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { apiPaths, type NoteImage } from '@jot/shared';
import { uploadNoteImage, type ImageUploadFile } from '../api/images';
import { patchLocalNoteImages, patchLocalNoteImagesInTx, isNotePendingCreate } from '../db/noteQueries';
import { enqueueWrite } from '../db/syncQueue';
import { isTransientError } from '../utils/retryWithBackoff';
import { noteKey } from '../db/queueKeys';
import { enqueueImageUpload } from '../db/imageUploadQueue';
import { cacheUploadedNoteImage, deleteCachedNoteImage } from '../utils/noteImageCache';
import { assertSwitchWriteAllowed } from '../api/client';
import { isOnlineWriteAllowed } from '../api/serverReachability';
import { useNetworkStatus } from './useNetworkStatus';
import { isLocalModeActive } from '../store/localMode';
import { noteLocalQueryKey, notesLocalQueryScopeKey, pendingImageUploadsQueryKey } from './queryKeys';

export type UploadNoteImageResult = { status: 'uploaded'; image: NoteImage } | { status: 'queued' };

export function useUploadNoteImage() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async ({
      noteId,
      uploadId,
      file,
      onProgress,
      signal,
    }: {
      noteId: string;
      /** Client-generated id shared with the ephemeral gallery tile, so a fallback to the persisted queue below reuses the same key (issue #618). */
      uploadId: string;
      file: ImageUploadFile;
      onProgress?: (percent: number) => void;
      /** Lets the caller cancel this in-flight upload (the gallery tile's cancel button, issue #695). */
      signal?: AbortSignal;
    }): Promise<UploadNoteImageResult> => {
      assertSwitchWriteAllowed();

      // While the note's own create is still queued (#475) it doesn't exist on
      // the server, so a direct upload would 404 — permanent, so the picked file
      // would be dropped rather than queued. Queue it instead: the drain sends it
      // after the create, which shares its key (#1288).
      // Local mode has no server and never marks a note pending, so it is
      // unaffected and still uploads (terminally) below.
      const pendingCreate = await isNotePendingCreate(db, noteId);
      if (isLocalModeActive() || (isOnlineWriteAllowed(isConnected) && !pendingCreate)) {
        try {
          const image = await uploadNoteImage(noteId, file, onProgress, signal, uploadId);
          // The SSE echo of this upload is dropped for the client that triggered
          // it (self-echo suppression in useSSE, keyed on the same X-Client-Id
          // header this upload just sent), so the local cache needs patching here
          // directly instead of waiting for note_image_added to arrive. The
          // server bumped the note's updated_at to the image's created_at.
          await patchLocalNoteImages(
            db,
            noteId,
            (images) => images.some((img) => img.id === image.id) ? images : [...images, image],
            image.created_at,
          );
          await cacheUploadedNoteImage(image.id, file.uri);
          return { status: 'uploaded', image };
        } catch (err) {
          // A user-initiated cancel is neither a permanent error nor something
          // to replay later — always propagate it as-is so the caller (whose
          // cancel handler already dropped the tile) doesn't queue a request
          // the user explicitly aborted.
          if (axios.isCancel(err)) throw err;
          // No server ever exists in local mode (epic #511), so there is nothing
          // to queue a replay against — keep #617's online-only behavior: let the
          // failure surface directly. Otherwise, a transient failure falls
          // through to the offline queue below instead of losing the picked
          // file; a permanent failure (413 too large, 400 validation, etc.)
          // rethrows so the caller shows an error tile.
          // Online first, for the tile's progress bar and cancel button; the
          // sync queue is the fallback.
          if (isLocalModeActive() || !isTransientError(err)) throw err;
        }
      }

      // Offline, or a transient online failure above: persist the file and
      // queue it in the sync queue for the drain to send (#1288). `uploadId`
      // is the image's client ID, so a replay of an upload whose response was
      // lost returns the image already stored rather than a duplicate.
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

  return useMutation({
    mutationFn: async ({ noteId, imageId }: { noteId: string; imageId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      // Through the outbox (#1285): the image is hidden locally and its
      // hard-delete queued in one transaction. A rejection resolves silently
      // (removeImage is best-effort): the image reappears on the next sync.
      await enqueueWrite(db, {
        // The server bumps the note's updated_at for the removal; the response
        // is a bare 204, so touch the local row with this device's clock, as
        // item edits do.
        localApply: () => patchLocalNoteImagesInTx(
          db,
          noteId,
          (images) => images.filter((img) => img.id !== imageId),
          new Date().toISOString(),
        ),
        // `/images/{id}` has no note id of its own, so the op's key names the
        // note; the drain records the landing on it (#1265).
        op: () => ({
          operation: 'removeImage',
          endpoint: apiPaths.image(imageId),
          method: 'DELETE',
          keys: [noteKey(noteId)],
        }),
      });
      // The gallery no longer shows the image, so its cached bytes are orphaned.
      await deleteCachedNoteImage(imageId);
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}
