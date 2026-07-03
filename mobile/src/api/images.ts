import { Platform } from 'react-native';
import api from './client';
import type { NoteImage } from '@jot/shared';

// Trims a trailing slash so callers don't have to know whether baseUrl came
// from the canonicalized server registry (never trailing-slashed) or straight
// from EXPO_PUBLIC_API_URL before the server context has initialized (may be).
function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

// Note images are served inline by the server and rendered directly from the
// network URL (no axios round-trip), same as the profile-icon pattern in
// ProfileIconSection.tsx: the native networking layer attaches the session
// cookie set during login, so no extra auth wiring is needed here.
export function noteImageUrl(baseUrl: string, imageId: string): string {
  return `${stripTrailingSlash(baseUrl)}/api/v1/images/${imageId}`;
}

// Resized JPEG tile for grid tiles; the lightbox uses noteImageUrl (the
// original) instead so a closer look never shows a downscaled image.
export function noteImageThumbnailUrl(baseUrl: string, imageId: string): string {
  return `${stripTrailingSlash(baseUrl)}/api/v1/images/${imageId}/thumbnail`;
}

export interface ImageUploadFile {
  uri: string;
  name: string;
  mimeType: string;
  /** Bytes, when known from the picker/camera result — used for client-side size validation before upload. */
  sizeBytes?: number;
}

// Multipart upload mirrors uploadProfileIcon in api/settings.ts: no request
// timeout (uploads can be slow on cellular) and an optional progress callback
// for the gallery's pending-upload spinner.
export async function uploadNoteImage(
  noteId: string,
  file: ImageUploadFile,
  onUploadProgress?: (percent: number) => void,
): Promise<NoteImage> {
  const formData = new FormData();
  formData.append('file', {
    uri: Platform.OS === 'ios' ? file.uri.replace('file://', '') : file.uri,
    name: file.name,
    type: file.mimeType,
  } as unknown as Blob);

  let lastPercent = -1;
  const res = await api.post(`/notes/${noteId}/images`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    ...(onUploadProgress && {
      onUploadProgress: (progressEvent) => {
        const percent = progressEvent.total
          ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
          : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onUploadProgress(percent);
        }
      },
    }),
  });
  return res.data;
}

export async function deleteNoteImage(imageId: string): Promise<void> {
  await api.delete(`/images/${imageId}`);
}
