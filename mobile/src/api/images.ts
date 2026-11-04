import { apiPaths, apiUrl, type NoteImage } from '@jot/shared';
import { jot } from './jot';
import { percentProgress, rnFilePart } from './upload';

// Note images are served inline by the server and rendered directly from the
// network URL (no axios round-trip), same as the profile-icon pattern in
// ProfileIconSection.tsx: the native networking layer attaches the session
// cookie set during login, so no extra auth wiring is needed here.
export function noteImageUrl(baseUrl: string, imageId: string): string {
  return apiUrl(apiPaths.image(imageId), baseUrl);
}

// Resized JPEG tile for grid tiles; the lightbox uses noteImageUrl (the
// original) instead so a closer look never shows a downscaled image.
export function noteImageThumbnailUrl(baseUrl: string, imageId: string): string {
  return apiUrl(apiPaths.imageThumbnail(imageId), baseUrl);
}

export interface ImageUploadFile {
  uri: string;
  name: string;
  mimeType: string;
  /** Bytes, when known from the picker/camera result — used for client-side size validation before upload. */
  sizeBytes?: number | undefined;
}

// Generous but finite: uploads can be slow on cellular, but a half-open /
// unreachable server must resolve to a recoverable error instead of hanging
// forever (issue #695).
export const NOTE_IMAGE_UPLOAD_TIMEOUT_MS = 90000;

// Multipart upload mirrors uploadProfileIcon in api/settings.ts. `signal` lets
// the caller abort an in-flight upload (the gallery's per-tile cancel button).
export async function uploadNoteImage(
  noteId: string,
  file: ImageUploadFile,
  onUploadProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<NoteImage> {
  const formData = new FormData();
  formData.append('file', rnFilePart(file.uri, file.name, file.mimeType));

  return jot.images.upload(noteId, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: NOTE_IMAGE_UPLOAD_TIMEOUT_MS,
    ...(signal && { signal }),
    ...percentProgress(onUploadProgress),
  });
}
