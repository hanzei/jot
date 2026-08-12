import { IMAGE_ALLOWED_TYPES, UPLOAD_MAX_BYTES } from '@jot/shared';

export interface ImageValidationInput {
  mimeType: string;
  /** Bytes, when known — a size check is skipped entirely otherwise (the server is the source of truth regardless, per the file-attachments spec §7). */
  sizeBytes?: number;
}

export type ImageValidationError = 'wrongType' | 'tooLarge';

// Client-side pre-check mirroring the server's allowlist/size cap (spec §7):
// a fast, friendly rejection before a doomed upload starts. The server
// re-validates type (via content sniffing + decode) and size regardless.
// maxBytes defaults to the shared constant but should be the active server's
// real (config-fetched) limit wherever one is available.
export function validateImageFile(file: ImageValidationInput, maxBytes: number = UPLOAD_MAX_BYTES): ImageValidationError | null {
  if (!(IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.mimeType)) {
    return 'wrongType';
  }
  if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
    return 'tooLarge';
  }
  return null;
}

// For error copy alongside a dynamic maxBytes (see validateImageFile above).
// Rounds down: a limit displayed to the user must never overstate what
// validateImageFile actually accepts (e.g. a 1.5MB cap must read "1MB", not
// "2MB" — the latter would make a rejected 1.6MB file look like a bug).
export const imageMaxMB = (maxBytes: number): number => Math.floor(maxBytes / (1024 * 1024));

export const IMAGE_MAX_MB = imageMaxMB(UPLOAD_MAX_BYTES);
