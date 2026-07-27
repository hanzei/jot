import { cachePath, deleteFileIfExists, downloadFile, ensureDirExists, fileExists } from './fs';

const CACHE_DIR = cachePath('note-images');

export type NoteImageVariant = 'original' | 'thumbnail';

// Tracks downloads in progress to avoid concurrent duplicate downloads.
const inProgress = new Set<string>();

// Note images are content-addressed and immutable once uploaded (the server
// never changes an image's bytes for a given id), so — unlike profile icons,
// which change per user over time — the cache key is just id + variant, with
// no staleness/version concern.
function cacheKey(imageId: string, variant: NoteImageVariant): string {
  return variant === 'thumbnail' ? `${imageId}_thumb` : imageId;
}

function imageFilePath(imageId: string, variant: NoteImageVariant): string {
  return `${CACHE_DIR}/${cacheKey(imageId, variant)}`;
}

// Returns the local file URI for a cached note image, or null if not cached.
export async function getCachedNoteImageUri(imageId: string, variant: NoteImageVariant): Promise<string | null> {
  const path = imageFilePath(imageId, variant);
  return fileExists(path) ? path : null;
}

// Downloads a note image (original or thumbnail) from networkUrl and stores it
// in the local cache. Returns the local file URI on success, or null on
// failure (offline, server error, etc.) — callers keep showing the network URL
// in that case. Deduplicates concurrent calls for the same (imageId, variant).
export async function downloadAndCacheNoteImage(
  imageId: string,
  variant: NoteImageVariant,
  networkUrl: string,
): Promise<string | null> {
  const key = cacheKey(imageId, variant);
  if (inProgress.has(key)) return null;
  inProgress.add(key);
  const path = imageFilePath(imageId, variant);
  try {
    ensureDirExists(CACHE_DIR);
    await downloadFile(networkUrl, path);
    return path;
  } catch {
    // A non-2xx response or a transport error both reject here. Clean up any
    // partially-written file to prevent corrupt cache entries.
    deleteFileIfExists(path);
    return null;
  } finally {
    inProgress.delete(key);
  }
}

// Removes both cached variants of an image. Called when an image is removed
// from a note (locally or via SSE) so its cache entries don't linger forever.
export async function deleteCachedNoteImage(imageId: string): Promise<void> {
  deleteFileIfExists(imageFilePath(imageId, 'original'));
  deleteFileIfExists(imageFilePath(imageId, 'thumbnail'));
}
