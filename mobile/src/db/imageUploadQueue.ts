import type { SQLiteDatabase } from 'expo-sqlite';
import { apiPaths } from '@jot/shared';
import type { ImageUploadFile } from '../api/images';
import {
  enqueueOperation,
  insertQueueEntry,
  notifyEnqueueListeners,
  parseImageUploadBody,
  type EnqueueParams,
  type ImageUploadBody,
} from './syncQueue';
import { keyIdExpression, keyKindCondition, noteKey, parseJsonObject } from './queueKeys';
import { withSerializedTransaction } from './transaction';
import { copyFile, deleteFileIfExists, documentPath, ensureDirExists } from '../utils/fs';

// An offline image upload is a `sync_queue` row, operation `uploadImage` with
// key `note:<id>`, so it lands behind its note's create and is protected like
// any other queued change (#1288). The drain sends it (syncQueue.ts).
// `pending_image_uploads` holds only the uploads the server rejected, which
// wait for Retry or Dismiss on their gallery tile.

const PENDING_UPLOADS_DIR = documentPath('pending-image-uploads');

export type PendingImageUploadStatus = 'queued' | 'error';

/** A queued or failed upload, as the gallery shows it. */
export interface PendingImageUploadEntry {
  id: string;
  note_id: string;
  local_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  status: PendingImageUploadStatus;
  error_message: string | null;
  created_at: string;
  /** Count of transient upload failures for this entry (issue #714), for diagnostics. */
  attempts?: number;
  /** How many of `attempts` were non-HTTP errors (#1283). */
  processing_errors?: number;
}

/** The queue row that uploads `upload` to `noteId`. */
function uploadOp(noteId: string, upload: ImageUploadBody): EnqueueParams {
  return {
    operation: 'uploadImage',
    endpoint: apiPaths.noteImages(noteId),
    method: 'POST',
    body: { ...upload },
    keys: [noteKey(noteId)],
  };
}

interface QueuedUploadRow {
  id: number;
  body: string | null;
  created_at: string;
  attempts: number | null;
  processing_errors: number | null;
  note_id: string;
}

/** Every queued upload, or those for one note, in queue order. */
async function getQueuedUploadRows(db: SQLiteDatabase, noteId?: string): Promise<QueuedUploadRow[]> {
  return db.getAllAsync<QueuedUploadRow>(
    `SELECT q.id, q.body, q.created_at, q.attempts, q.processing_errors, ${keyIdExpression('k.key', 'note')} AS note_id
     FROM sync_queue q JOIN sync_queue_keys k ON k.entry_id = q.id
     WHERE q.operation = 'uploadImage' AND k.read_only = 0 AND ${keyKindCondition('k.key', 'note')}
       ${noteId === undefined ? '' : 'AND k.key = ?'}
     ORDER BY q.id ASC`,
    noteId === undefined ? [] : [noteKey(noteId)],
  );
}

/**
 * Persist a picked file (offline, or a transient online failure) so it
 * survives an app restart until the upload can be replayed. The picker/camera
 * URI can point into an OS-managed cache directory that may be purged before
 * connectivity returns, so the bytes are copied into a stable app-owned path
 * up front (issue #618).
 */
export async function enqueueImageUpload(
  db: SQLiteDatabase,
  params: { id: string; noteId: string; file: ImageUploadFile },
): Promise<void> {
  ensureDirExists(PENDING_UPLOADS_DIR);
  const localPath = `${PENDING_UPLOADS_DIR}/${params.id}`;
  await copyFile(params.file.uri, localPath);

  await enqueueOperation(db, uploadOp(params.noteId, {
    id: params.id,
    local_path: localPath,
    filename: params.file.name,
    mime_type: params.file.mimeType,
    size_bytes: params.file.sizeBytes ?? null,
  }));
}

/** A note's queued uploads, then its failed ones, each oldest first. */
export async function getPendingImageUploads(db: SQLiteDatabase, noteId: string): Promise<PendingImageUploadEntry[]> {
  const queued: PendingImageUploadEntry[] = [];
  for (const row of await getQueuedUploadRows(db, noteId)) {
    const upload = parseImageUploadBody(parseJsonObject(row.body));
    if (!upload) continue;
    queued.push({
      ...upload,
      note_id: row.note_id,
      status: 'queued',
      error_message: null,
      created_at: row.created_at,
      attempts: row.attempts ?? 0,
      processing_errors: row.processing_errors ?? 0,
    });
  }
  const failed = await db.getAllAsync<PendingImageUploadEntry>(
    'SELECT * FROM pending_image_uploads WHERE note_id = ? ORDER BY created_at ASC',
    [noteId],
  );
  return [...queued, ...failed];
}

/** Image-upload diagnostics, the counterpart of {@link SyncQueueStats} (issue #1085). */
export interface ImageUploadQueueStats {
  /** Uploads still waiting in the sync queue. */
  queuedCount: number;
  /** Uploads the server rejected: they wait on a manual retry or dismiss in the gallery. */
  errorCount: number;
  /**
   * The oldest queued upload, or null when none are queued. Not necessarily the
   * one that is stuck: an upload waits while its note awaits its create or a
   * failed change's review, so see `maxAttempts` for a wedged entry.
   * `attempts` counts its transient failures.
   * Metadata only: no path, filename, or note id.
   */
  oldest: { created_at: string; attempts: number } | null;
  /** Highest `attempts` across queued uploads: non-zero means one is failing transiently. */
  maxAttempts: number;
}

export const EMPTY_IMAGE_UPLOAD_QUEUE_STATS: ImageUploadQueueStats = {
  queuedCount: 0,
  errorCount: 0,
  oldest: null,
  maxAttempts: 0,
};

/**
 * Summarize the image uploads for the Diagnostics screen, so "my image never
 * appeared" can be told apart as still queued, stuck retrying, or failed.
 */
export async function getImageUploadQueueStats(db: SQLiteDatabase): Promise<ImageUploadQueueStats> {
  const [queued, errored, oldest] = await Promise.all([
    db.getFirstAsync<{ count: number; max_attempts: number | null }>(
      `SELECT COUNT(*) AS count, MAX(attempts) AS max_attempts FROM sync_queue WHERE operation = 'uploadImage'`,
    ),
    db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_image_uploads'),
    db.getFirstAsync<{ created_at: string; attempts: number | null }>(
      `SELECT created_at, attempts FROM sync_queue WHERE operation = 'uploadImage' ORDER BY id ASC LIMIT 1`,
    ),
  ]);
  return {
    queuedCount: queued?.count ?? 0,
    errorCount: errored?.count ?? 0,
    oldest: oldest ? { created_at: oldest.created_at, attempts: oldest.attempts ?? 0 } : null,
    maxAttempts: queued?.max_attempts ?? 0,
  };
}

/**
 * Move queued and failed uploads from one note to another. Used when "Keep my
 * version" forks a dead-lettered create's content into a brand-new note
 * (`useSyncFailures.ts`): the original note is about to be deleted, and its
 * uploads with it, silently dropping a photo the user just explicitly chose to
 * keep. Queued uploads are queued again, behind the fork's create, which their
 * key would otherwise put them ahead of. No-op if there are none.
 */
export async function reassignPendingImageUploads(
  db: SQLiteDatabase,
  fromNoteId: string,
  toNoteId: string,
): Promise<void> {
  let moved = false;
  await withSerializedTransaction(db, async () => {
    await db.runAsync('UPDATE pending_image_uploads SET note_id = ? WHERE note_id = ?', [toNoteId, fromNoteId]);
    for (const row of await getQueuedUploadRows(db, fromNoteId)) {
      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [row.id]);
      const upload = parseImageUploadBody(parseJsonObject(row.body));
      if (!upload) continue;
      await insertQueueEntry(db, uploadOp(toNoteId, upload));
      moved = true;
    }
  });
  if (moved) notifyEnqueueListeners('uploadImage');
}

/**
 * Queue a failed upload again (e.g. after the user fixes something) so the
 * next drain retries it, with a fresh attempt budget (#714). No-op if the id
 * is not a failed upload.
 */
export async function retryImageUpload(db: SQLiteDatabase, id: string): Promise<void> {
  let queued = false;
  await withSerializedTransaction(db, async () => {
    const row = await db.getFirstAsync<PendingImageUploadEntry>('SELECT * FROM pending_image_uploads WHERE id = ?', [id]);
    if (!row) return;
    await db.runAsync('DELETE FROM pending_image_uploads WHERE id = ?', [id]);
    await insertQueueEntry(db, uploadOp(row.note_id, {
      id: row.id,
      local_path: row.local_path,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
    }));
    queued = true;
  });
  if (queued) notifyEnqueueListeners('uploadImage');
}

/** Give up on a queued or failed upload: delete its row and the stable file copy. No-op if the id is unknown. */
export async function dismissImageUpload(db: SQLiteDatabase, id: string): Promise<void> {
  const paths: string[] = [];
  await withSerializedTransaction(db, async () => {
    const failed = await db.getFirstAsync<{ local_path: string }>(
      'SELECT local_path FROM pending_image_uploads WHERE id = ?',
      [id],
    );
    if (failed) {
      await db.runAsync('DELETE FROM pending_image_uploads WHERE id = ?', [id]);
      paths.push(failed.local_path);
    }
    for (const row of await getQueuedUploadRows(db)) {
      const upload = parseImageUploadBody(parseJsonObject(row.body));
      if (upload?.id !== id) continue;
      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [row.id]);
      paths.push(upload.local_path);
    }
  });
  for (const path of paths) deleteFileIfExists(path);
}
