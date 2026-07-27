import { Directory, File, Paths } from 'expo-file-system';

/**
 * The single boundary between the app and `expo-file-system`.
 *
 * Everything here used to be spread across call sites as `expo-file-system/legacy`
 * imports. The modern `File`/`Directory` API replaced that in SDK 54, and it
 * differs in three ways that would otherwise be easy to get wrong at each call
 * site, so the differences are papered over once, here:
 *
 * - Most operations are **synchronous** (`write`, `delete`, `create`, `exists`,
 *   `size`), where the legacy API was promise-based.
 * - `File.delete()` **throws** when the target is missing; the legacy
 *   `deleteAsync(uri, { idempotent: true })` did not.
 * - `File.downloadFileAsync()` **throws** on a non-2xx response and on an
 *   existing destination, where legacy `downloadAsync` resolved with a status
 *   code and always overwrote.
 *
 * Paths are passed around as `file:///` URI strings rather than `File`
 * instances because some of them are persisted (`pending_image_uploads.local_path`)
 * and must stay comparable across app versions.
 */

function joinUri(base: string, segments: string[]): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return [root, ...segments].join('/');
}

/**
 * A path under the app's document directory — durable storage that the OS will
 * not reclaim. Use for anything that must survive until the app deletes it.
 */
export function documentPath(...segments: string[]): string {
  return joinUri(Paths.document.uri, segments);
}

/**
 * A path under the app's cache directory. The OS may purge these files when the
 * device runs low on storage, so only use it for data that can be re-fetched.
 */
export function cachePath(...segments: string[]): string {
  return joinUri(Paths.cache.uri, segments);
}

/** Create a directory (and any missing parents). No-op when it already exists. */
export function ensureDirExists(uri: string): void {
  new Directory(uri).create({ intermediates: true, idempotent: true });
}

/** Whether a file exists and is readable. Never throws. */
export function fileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** Size in bytes, or 0 when the file is missing or unreadable. Never throws. */
export function fileSize(uri: string): number {
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

/**
 * Delete a file if it is there. Restores the idempotence of the legacy
 * `deleteAsync(uri, { idempotent: true })` this replaced — the modern
 * `delete()` throws on a missing target. Best-effort: never throws, since every
 * caller treats an orphaned file as harmless next to failing the operation.
 */
export function deleteFileIfExists(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Best-effort cleanup; a leftover file only costs disk space.
  }
}

/** Copy a file, overwriting the destination. */
export async function copyFile(fromUri: string, toUri: string): Promise<void> {
  await new File(fromUri).copy(new File(toUri), { overwrite: true });
}

/** Move a file, overwriting the destination. */
export async function moveFile(fromUri: string, toUri: string): Promise<void> {
  await new File(fromUri).move(new File(toUri), { overwrite: true });
}

/**
 * Synchronous {@link moveFile}. Used by log rotation, which runs entirely
 * synchronously so two flushes can never interleave mid-rotation.
 */
export function moveFileSync(fromUri: string, toUri: string): void {
  new File(fromUri).moveSync(new File(toUri), { overwrite: true });
}

/** Names of the entries in a directory. Empty when the directory is absent. */
export function listFileNames(uri: string): string[] {
  try {
    const dir = new Directory(uri);
    if (!dir.exists) {
      return [];
    }
    return dir.list().map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Download `url` to `destUri`, overwriting anything already there.
 *
 * Rejects when the server responds non-2xx — callers that previously branched
 * on `result.status === 200` need a `try`/`catch` instead. On Android a failed
 * download can leave a partial file behind, so callers still clean up the
 * destination on failure.
 */
export async function downloadFile(url: string, destUri: string): Promise<void> {
  await File.downloadFileAsync(url, new File(destUri), { idempotent: true });
}

/** Read a whole file as text, or `null` when it is missing or unreadable. */
export function readTextFile(uri: string): string | null {
  try {
    const file = new File(uri);
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

/**
 * Append text to a file, creating it (and any missing parent directories) first
 * if needed. Synchronous, matching the underlying API.
 */
export function appendTextFile(uri: string, text: string): void {
  const file = new File(uri);
  if (!file.exists) {
    file.create({ intermediates: true, overwrite: false });
  }
  file.write(text, { append: true });
}
