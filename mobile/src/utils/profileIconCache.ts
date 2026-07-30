import { cachePath, deleteFileIfExists, downloadFile, ensureDirExists, fileExists, listFileNames } from './fs';

const CACHE_DIR = cachePath('profile-icons');

// Tracks downloads in progress to avoid concurrent duplicate downloads.
const inProgress = new Set<string>();

function safeVersion(updatedAt: string): string {
  return updatedAt.replace(/[^a-zA-Z0-9-]/g, '_');
}

function iconFilePath(userId: string, updatedAt: string): string {
  return `${CACHE_DIR}/${userId}_${safeVersion(updatedAt)}`;
}

// Returns the local file URI for a cached icon, or null if not cached.
export async function getCachedIconUri(userId: string, updatedAt: string): Promise<string | null> {
  if (!updatedAt) return null;
  const path = iconFilePath(userId, updatedAt);
  return fileExists(path) ? path : null;
}

// Removes cached icon files for userId that don't match currentUpdatedAt.
function purgeStaleIcons(userId: string, currentUpdatedAt: string): void {
  const currentFile = `${userId}_${safeVersion(currentUpdatedAt)}`;
  for (const file of listFileNames(CACHE_DIR)) {
    if (file.startsWith(`${userId}_`) && file !== currentFile) {
      deleteFileIfExists(`${CACHE_DIR}/${file}`);
    }
  }
}

// Downloads an icon from networkUrl and stores it in the local cache.
// Returns the local file URI on success, or null on failure.
// Deduplicates concurrent calls for the same (userId, updatedAt) pair.
export async function downloadAndCacheIcon(
  userId: string,
  updatedAt: string,
  networkUrl: string,
): Promise<string | null> {
  if (!updatedAt) return null;
  const key = `${userId}_${updatedAt}`;
  if (inProgress.has(key)) return null;
  inProgress.add(key);
  const path = iconFilePath(userId, updatedAt);
  try {
    ensureDirExists(CACHE_DIR);
    await downloadFile(networkUrl, path);
    purgeStaleIcons(userId, updatedAt);
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

// Warms the icon cache for a list of users. Called during background sync.
// Downloads icons that are missing or stale; skips already-cached ones.
export async function refreshIconCacheForUsers(
  users: { id: string; has_profile_icon: boolean; updated_at: string }[],
  baseUrl: string,
): Promise<void> {
  for (const user of users) {
    if (!user.has_profile_icon || !user.updated_at) continue;
    const cached = await getCachedIconUri(user.id, user.updated_at);
    if (!cached) {
      const networkUrl = `${baseUrl}/api/v1/users/${user.id}/profile-icon`;
      await downloadAndCacheIcon(user.id, user.updated_at, networkUrl);
    }
  }
}
