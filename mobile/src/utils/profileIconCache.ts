import * as FileSystem from 'expo-file-system/legacy';
import { ensureDirExists } from './fsCache';
import { getSessionCookieHeader } from '../api/client';

const CACHE_DIR = `${FileSystem.cacheDirectory ?? ''}profile-icons/`;

// Tracks downloads in progress to avoid concurrent duplicate downloads.
const inProgress = new Set<string>();

function safeVersion(updatedAt: string): string {
  return updatedAt.replace(/[^a-zA-Z0-9-]/g, '_');
}

function iconFilePath(userId: string, updatedAt: string): string {
  return `${CACHE_DIR}${userId}_${safeVersion(updatedAt)}`;
}

// Returns the local file URI for a cached icon, or null if not cached.
export async function getCachedIconUri(userId: string, updatedAt: string): Promise<string | null> {
  if (!updatedAt) return null;
  const path = iconFilePath(userId, updatedAt);
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : null;
  } catch {
    return null;
  }
}

// Removes cached icon files for userId that don't match currentUpdatedAt.
async function purgeStaleIcons(userId: string, currentUpdatedAt: string): Promise<void> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!dirInfo.exists) return;
    const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
    const currentFile = `${userId}_${safeVersion(currentUpdatedAt)}`;
    for (const file of files) {
      if (file.startsWith(`${userId}_`) && file !== currentFile) {
        await FileSystem.deleteAsync(`${CACHE_DIR}${file}`, { idempotent: true });
      }
    }
  } catch {
    // Ignore cleanup errors — stale files will be overwritten on next download.
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
  try {
    await ensureDirExists(CACHE_DIR);
    const path = iconFilePath(userId, updatedAt);
    // The profile-icon endpoint is auth-gated and downloadAsync bypasses the
    // axios interceptor, so attach the session cookie explicitly (mirrors client.ts).
    const headers = await getSessionCookieHeader();
    const result = await FileSystem.downloadAsync(networkUrl, path, headers ? { headers } : undefined);
    if (result.status === 200) {
      await purgeStaleIcons(userId, updatedAt);
      return path;
    }
    // Non-200 means the download failed (e.g. server error). Remove the incomplete file.
    await FileSystem.deleteAsync(path, { idempotent: true });
    return null;
  } catch {
    // Clean up any partially-written file to prevent corrupt cache entries.
    try {
      await FileSystem.deleteAsync(iconFilePath(userId, updatedAt), { idempotent: true });
    } catch { /* ignore cleanup errors */ }
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
