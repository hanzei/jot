import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import type { NoteImage } from '@jot/shared';
import { uploadNoteImage, deleteNoteImage, type ImageUploadFile } from '../api/images';
import { patchLocalNoteImages } from '../db/noteQueries';
import { assertSwitchWriteAllowed } from '../api/client';
import { noteLocalQueryKey, notesLocalQueryScopeKey } from './queryKeys';

// Online-only (issue #617 scope excludes the offline queue, tracked separately
// in #13): no local-first write or enqueue-for-replay fallback here, unlike
// useNotes.ts's mutations. A failed request simply rejects and the caller
// surfaces the error.
export function useUploadNoteImage() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({
      noteId,
      file,
      onProgress,
    }: {
      noteId: string;
      file: ImageUploadFile;
      onProgress?: (percent: number) => void;
    }): Promise<NoteImage> => {
      assertSwitchWriteAllowed();
      const image = await uploadNoteImage(noteId, file, onProgress);
      // The SSE echo of this upload is dropped for the client that triggered
      // it (self-echo suppression in useSSE, keyed on the same X-Client-Id
      // header this upload just sent), so the local cache needs patching here
      // directly instead of waiting for note_image_added to arrive.
      await patchLocalNoteImages(db, noteId, (images) =>
        images.some((img) => img.id === image.id) ? images : [...images, image],
      );
      return image;
    },
    onSuccess: (_image, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useDeleteNoteImage() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, imageId }: { noteId: string; imageId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      await deleteNoteImage(imageId);
      // Same self-echo gap as the upload above, on the removal side.
      await patchLocalNoteImages(db, noteId, (images) => images.filter((img) => img.id !== imageId));
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}
