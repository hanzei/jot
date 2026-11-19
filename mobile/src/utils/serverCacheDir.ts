import { deleteDirectoryIfExists, deleteFileIfExists, listPlainFileNames } from './fs';

/**
 * The folder under a cache root (`note-images`, `profile-icons`) that holds one
 * server's files. The caches are split by server so that wiping one server's
 * local data (logout, another account signing in) leaves the cached images of
 * the other servers this device is signed in to.
 */
export function serverCacheDir(root: string, serverId: string | null): string {
  // Mirrors queryScope's 'no-server'; a server id is a UUID, but keep the
  // segment path-safe regardless.
  return `${root}/${(serverId ?? 'no-server').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * Delete one server's folder under a cache root, and any files directly in the
 * root: those were written before the caches were split by server, so which
 * account they belong to is unknown. Best-effort, never throws.
 */
export function clearServerCacheDir(root: string, serverId: string | null): void {
  deleteDirectoryIfExists(serverCacheDir(root, serverId));
  for (const name of listPlainFileNames(root)) {
    deleteFileIfExists(`${root}/${name}`);
  }
}
