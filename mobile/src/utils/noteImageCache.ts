import * as FileSystem from 'expo-file-system/legacy';
import { ensureDirExists } from './fsCache';

const CACHE_DIR = `${FileSystem.cacheDirectory ?? ''}note-images/`;

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
  return `${CACHE_DIR}${cacheKey(imageId, variant)}`;
}

// Returns the local file URI for a cached note image, or null if not cached.
export async function getCachedNoteImageUri(imageId: string, variant: NoteImageVariant): Promise<string | null> {
  const path = imageFilePath(imageId, variant);
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : null;
  } catch {
    return null;
  }
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
  try {
    await ensureDirExists(CACHE_DIR);
    const path = imageFilePath(imageId, variant);
    const result = await FileSystem.downloadAsync(networkUrl, path);
    if (result.status === 200) {
      return path;
    }
    // Non-200 means the download failed (e.g. server error). Remove the incomplete file.
    await FileSystem.deleteAsync(path, { idempotent: true });
    return null;
  } catch {
    // Clean up any partially-written file to prevent corrupt cache entries.
    try {
      await FileSystem.deleteAsync(imageFilePath(imageId, variant), { idempotent: true });
    } catch { /* ignore cleanup errors */ }
    return null;
  } finally {
    inProgress.delete(key);
  }
}

// Removes both cached variants of an image. Called when an image is removed
// from a note (locally or via SSE) so its cache entries don't linger forever.
export async function deleteCachedNoteImage(imageId: string): Promise<void> {
  await Promise.allSettled([
    FileSystem.deleteAsync(imageFilePath(imageId, 'original'), { idempotent: true }),
    FileSystem.deleteAsync(imageFilePath(imageId, 'thumbnail'), { idempotent: true }),
  ]);
}
