import { sessionCookieHeaders } from '../api/client';
import { cachePath, copyFile, deleteFileIfExists, downloadFileAtomically, ensureDirExists, fileExists, moveFile } from './fs';

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
    // Atomic, since a cached file is trusted by existence alone. The cookie is
    // explicit because the native downloader skips the axios interceptor.
    await downloadFileAtomically(networkUrl, path, { headers: await sessionCookieHeaders() });
    return path;
  } catch {
    // A non-2xx response or a transport error both reject here; nothing was
    // written to `path`.
    return null;
  } finally {
    inProgress.delete(key);
  }
}

/**
 * Store the file a just-uploaded image was sent from as its cached original,
 * so the lightbox can show it without a network round trip — otherwise the
 * original is only cached once it has been viewed online, and an image
 * uploaded and then opened offline would not show. The server stores an
 * original's bytes unchanged, so the local file is the original.
 *
 * `move` hands over a file the caller owns (the sync queue's stable copy);
 * otherwise the source is copied (a picker/camera result the OS owns).
 * Best-effort: a failure only means the original is downloaded on first view.
 */
export async function cacheUploadedNoteImage(
  imageId: string,
  sourceUri: string,
  { move = false }: { move?: boolean } = {},
): Promise<void> {
  const path = imageFilePath(imageId, 'original');
  try {
    ensureDirExists(CACHE_DIR);
    if (move) await moveFile(sourceUri, path);
    else await copyFile(sourceUri, path);
  } catch (err) {
    console.warn(`Could not cache uploaded image ${imageId}:`, err);
    // A failed move must not leave the queue's copy behind.
    if (move) deleteFileIfExists(sourceUri);
  }
}

// Removes both cached variants of an image. Called when an image is removed
// from a note (locally or via SSE) so its cache entries don't linger forever.
export async function deleteCachedNoteImage(imageId: string): Promise<void> {
  for (const variant of ['original', 'thumbnail'] as const) {
    const path = imageFilePath(imageId, variant);
    deleteFileIfExists(path);
    // A download the process died during leaves its `.part` file behind
    // (downloadFileAtomically); nothing else would ever remove it.
    deleteFileIfExists(`${path}.part`);
  }
}
