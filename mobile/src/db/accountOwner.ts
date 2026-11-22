import type { SQLiteDatabase } from 'expo-sqlite';
import { withSerializedTransaction } from './transaction';
import { deleteFileIfExists } from '../utils/fs';
import { clearForeignSnapshotFlags } from './foreignSnapshots';
import { clearOwnVersionSteps } from './ownVersions';
import { clearNoteImageCache } from '../utils/noteImageCache';
import { clearProfileIconCache } from '../utils/profileIconCache';

/**
 * Account ownership of a server's local database (issue #1264, spec §8.6).
 *
 * A server's database file is shared by every account that signs in to that
 * server on this device, so the account that produced the data is recorded in
 * `account_owner`. A different user signing in wipes it before anything reads
 * the cache or drains the queue; a deliberate logout wipes it outright.
 */

/** `account_owner.user_id` after a logout wipe: the data is gone and nobody owns what is left. */
const NO_OWNER = '';

// Children before parents: `note_items` and `pending_image_uploads` reference
// `notes`, and the key tables their queue rows. Every table that holds account
// data, the queues included.
const ACCOUNT_DATA_TABLES = [
  'note_items',
  'pending_image_uploads',
  'notes',
  'labels',
  'users',
  'sync_queue_keys',
  'sync_queue',
  'dead_letter_keys',
  'dead_letter',
] as const;

/**
 * Deletes every account-data row and records `owner`, inside the caller's
 * transaction. Returns the copied upload files to delete once it commits.
 */
async function wipeRows(db: SQLiteDatabase, owner: string): Promise<string[]> {
  // Failed uploads keep their file in their row; queued ones in their queue body (#1288).
  const uploads = await db.getAllAsync<{ local_path: string | null }>(
    `SELECT local_path FROM pending_image_uploads
     UNION ALL
     SELECT json_extract(body, '$.local_path') FROM sync_queue WHERE operation = 'uploadImage'`,
  );
  for (const table of ACCOUNT_DATA_TABLES) {
    await db.runAsync(`DELETE FROM ${table}`);
  }
  await setOwner(db, owner);
  return uploads.flatMap((row) => (row.local_path === null ? [] : [row.local_path]));
}

async function setOwner(db: SQLiteDatabase, owner: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO account_owner (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id',
    [owner],
  );
}

// Files go only after the rows are committed: a rolled-back wipe must not
// leave queue rows pointing at deleted bytes. The upload directory is shared by
// every server's database, so only this database's own files are removed.
function deleteUploadFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      deleteFileIfExists(path);
    } catch (error) {
      console.warn('Failed to delete a queued image upload file during a local-data wipe:', error);
    }
  }
}

// The image caches hold the account's note images (originals and thumbnails)
// and its collaborators' profile icons. They are split by server, so only this
// database's server loses its copies; the other servers this device is signed
// in to keep theirs. A 401 never gets here, so the same user signing back in
// keeps them too.
function clearImageCaches(serverId: string | null): void {
  clearNoteImageCache(serverId);
  clearProfileIconCache(serverId);
}

/** The recorded owner: a user id, `''` after a logout wipe, or `null` when nothing has been recorded yet. */
export async function getAccountOwner(db: SQLiteDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ user_id: string }>('SELECT user_id FROM account_owner WHERE id = 1');
  return row?.user_id ?? null;
}

/**
 * Makes `userId` the owner of the local data, wiping it first when it belongs
 * to anyone else. Run before the first read or drain for a signed-in user.
 *
 * A database with no recorded owner predates the table (or is new) and is
 * stamped without a wipe, so upgrading keeps the signed-in user's queue. A
 * database wiped on logout (`''`) is wiped again: a write that was in flight
 * at logout can have landed after the wipe.
 *
 * `serverId` names the server this database belongs to, whose image caches
 * go with a wipe. Resolves `true` when it wiped.
 */
export async function claimLocalData(db: SQLiteDatabase, userId: string, serverId: string | null): Promise<boolean> {
  // An object, not a `let`: TypeScript does not see assignments made inside the callback.
  const wiped: { files: string[] | null } = { files: null };
  await withSerializedTransaction(db, async () => {
    const owner = await getAccountOwner(db);
    if (owner === userId) return;
    if (owner === null) {
      await setOwner(db, userId);
      return;
    }
    wiped.files = await wipeRows(db, userId);
  });
  if (wiped.files === null) return false;
  deleteUploadFiles(wiped.files);
  clearImageCaches(serverId);
  clearOwnVersionSteps(db);
  clearForeignSnapshotFlags(db);
  console.info('Local data belonged to another account; wiped it before sign-in.');
  return true;
}

/**
 * Deletes all local account data, the queues, their upload files and the
 * image caches of `serverId` (this database's server) included, for a
 * deliberate logout.
 */
export async function wipeLocalData(db: SQLiteDatabase, serverId: string | null): Promise<void> {
  const wiped: { files: string[] } = { files: [] };
  await withSerializedTransaction(db, async () => {
    wiped.files = await wipeRows(db, NO_OWNER);
  });
  deleteUploadFiles(wiped.files);
  clearImageCaches(serverId);
  clearOwnVersionSteps(db);
  clearForeignSnapshotFlags(db);
}

/**
 * Local changes the server has not accepted: queued writes, failed writes
 * awaiting review, and image uploads (queued or failed). A logout would lose them.
 */
export async function getUnsyncedChangeCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT (SELECT COUNT(*) FROM sync_queue)
          + (SELECT COUNT(*) FROM dead_letter)
          + (SELECT COUNT(*) FROM pending_image_uploads) AS count`,
  );
  return row?.count ?? 0;
}
