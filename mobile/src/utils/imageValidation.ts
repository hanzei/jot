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
export function validateImageFile(file: ImageValidationInput): ImageValidationError | null {
  if (!(IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.mimeType)) {
    return 'wrongType';
  }
  if (file.sizeBytes !== undefined && file.sizeBytes > UPLOAD_MAX_BYTES) {
    return 'tooLarge';
  }
  return null;
}

export const IMAGE_MAX_MB = Math.round(UPLOAD_MAX_BYTES / (1024 * 1024));
