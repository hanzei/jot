// Note images are served inline by the server and rendered directly from the
// network URL (no axios round-trip), same as the profile-icon pattern in
// ProfileIconSection.tsx: the native networking layer attaches the session
// cookie set during login, so no extra auth wiring is needed here.
export function noteImageUrl(baseUrl: string, imageId: string): string {
  return `${baseUrl}/api/v1/images/${imageId}`;
}

// Resized JPEG tile for grid tiles; the lightbox uses noteImageUrl (the
// original) instead so a closer look never shows a downscaled image.
export function noteImageThumbnailUrl(baseUrl: string, imageId: string): string {
  return `${baseUrl}/api/v1/images/${imageId}/thumbnail`;
}
