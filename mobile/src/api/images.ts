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
