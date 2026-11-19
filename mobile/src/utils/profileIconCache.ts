import { getActiveServerId } from '../api/client';
import { cachePath, deleteFileIfExists, downloadFile, ensureDirExists, fileExists, listFileNames } from './fs';
import { clearServerCacheDir, serverCacheDir } from './serverCacheDir';

const CACHE_ROOT = cachePath('profile-icons');

// The active server's cache folder: user ids are only meaningful per server.
function cacheDir(): string {
  return serverCacheDir(CACHE_ROOT, getActiveServerId());
}

// Tracks downloads in progress to avoid concurrent duplicate downloads.
const inProgress = new Set<string>();

function safeVersion(updatedAt: string): string {
  return updatedAt.replace(/[^a-zA-Z0-9-]/g, '_');
}

function iconFilePath(userId: string, updatedAt: string, dir: string = cacheDir()): string {
  return `${dir}/${userId}_${safeVersion(updatedAt)}`;
}

// Returns the local file URI for a cached icon, or null if not cached.
export async function getCachedIconUri(userId: string, updatedAt: string): Promise<string | null> {
  if (!updatedAt) return null;
  const path = iconFilePath(userId, updatedAt);
  return fileExists(path) ? path : null;
}

// Removes cached icon files in `dir` for userId that don't match currentUpdatedAt.
function purgeStaleIcons(dir: string, userId: string, currentUpdatedAt: string): void {
  const currentFile = `${userId}_${safeVersion(currentUpdatedAt)}`;
  for (const file of listFileNames(dir)) {
    if (file.startsWith(`${userId}_`) && file !== currentFile) {
      deleteFileIfExists(`${dir}/${file}`);
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
  // The folder is fixed when the download starts, so a server switch while it
  // runs cannot put this server's icon in, or purge from, another's folder.
  const dir = cacheDir();
  const path = iconFilePath(userId, updatedAt, dir);
  try {
    ensureDirExists(dir);
    await downloadFile(networkUrl, path);
    purgeStaleIcons(dir, userId, updatedAt);
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
  users: { id: string; has_profile_icon: boolean; updated_at?: string }[],
  baseUrl: string,
): Promise<void> {
  // `users` and `baseUrl` belong to the server active now. Stop once another
  // server becomes active, or the rest would be cached in that server's folder
  // and outlive a wipe of their own.
  const serverId = getActiveServerId();
  for (const user of users) {
    if (getActiveServerId() !== serverId) return;
    if (!user.has_profile_icon || !user.updated_at) continue;
    const cached = await getCachedIconUri(user.id, user.updated_at);
    if (!cached) {
      const networkUrl = `${baseUrl}/api/v1/users/${user.id}/profile-icon`;
      await downloadAndCacheIcon(user.id, user.updated_at, networkUrl);
    }
  }
}

// Removes every cached profile icon of one server. Called when that server's
// local data is wiped (logout or another account signing in, spec §8.6).
export function clearProfileIconCache(serverId: string | null): void {
  clearServerCacheDir(CACHE_ROOT, serverId);
}
