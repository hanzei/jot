import type { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import type { NoteImage } from '@jot/shared';
import { uploadNoteImage, type ImageUploadFile } from '../api/images';
import { patchLocalNoteImages, getPendingCreateNoteIds, getFailedNoteIds } from './noteQueries';
import { isTransientHttpStatus, isGlobalDrainFailure, MAX_ENTRY_DRAIN_ATTEMPTS, notifyEnqueueListeners } from './syncQueue';
import { copyFile, deleteFileIfExists, documentPath, ensureDirExists } from '../utils/fs';

const PENDING_UPLOADS_DIR = documentPath('pending-image-uploads');

export type PendingImageUploadStatus = 'queued' | 'error';

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
  /**
   * Count of transient upload failures for this entry (issue #714). Defaults to 0
   * for rows written before migration 6. Once it reaches MAX_ENTRY_DRAIN_ATTEMPTS
   * the upload is flagged `error` and the drain continues past it.
   */
  attempts?: number;
}

/**
 * Persist a picked file (offline, or a transient online failure) so it
 * survives an app restart until the upload can be replayed. The picker/camera
 * URI can point into an OS-managed cache directory that may be purged before
 * connectivity returns, so the bytes are copied into a stable app-owned path
 * up front (issue #618) — mirroring why syncQueue's JSON operations don't need
 * this (their "payload" is already durable, plain data).
 */
export async function enqueueImageUpload(
  db: SQLiteDatabase,
  params: { id: string; noteId: string; file: ImageUploadFile },
): Promise<void> {
  ensureDirExists(PENDING_UPLOADS_DIR);
  const localPath = `${PENDING_UPLOADS_DIR}/${params.id}`;
  await copyFile(params.file.uri, localPath);

  await db.runAsync(
    `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, size_bytes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [
      params.id,
      params.noteId,
      localPath,
      params.file.name,
      params.file.mimeType,
      params.file.sizeBytes ?? null,
      new Date().toISOString(),
    ],
  );
  notifyEnqueueListeners();
}

export async function getPendingImageUploads(db: SQLiteDatabase, noteId: string): Promise<PendingImageUploadEntry[]> {
  return db.getAllAsync<PendingImageUploadEntry>(
    'SELECT * FROM pending_image_uploads WHERE note_id = ? ORDER BY created_at ASC',
    [noteId],
  );
}

/** Count of uploads still waiting for their turn (excludes permanently-failed rows, which need a manual retry). */
export async function getQueuedImageUploadCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM pending_image_uploads WHERE status = 'queued'`,
  );
  return row?.count ?? 0;
}

/** Drop a queue entry for good: its row and its stable file copy. Shared by the upload-success and note-gone-404/403 paths of {@link drainImageUploadQueue}. */
async function discardEntry(db: SQLiteDatabase, entry: Pick<PendingImageUploadEntry, 'id' | 'local_path'>): Promise<void> {
  await db.runAsync('DELETE FROM pending_image_uploads WHERE id = ?', [entry.id]);
  deleteFileIfExists(entry.local_path);
}

/**
 * Move queued/errored uploads from one note to another. Used when "Keep my
 * version" forks a dead-lettered create's content into a brand-new note
 * (`useSyncFailures.ts`): the original note is about to be deleted, and its
 * `pending_image_uploads` rows would otherwise cascade-delete right along
 * with it — silently dropping a photo the user just explicitly chose to
 * keep. No-op if there are no matching rows.
 */
export async function reassignPendingImageUploads(
  db: SQLiteDatabase,
  fromNoteId: string,
  toNoteId: string,
): Promise<void> {
  await db.runAsync('UPDATE pending_image_uploads SET note_id = ? WHERE note_id = ?', [toNoteId, fromNoteId]);
}

/** Re-queue a permanently-failed upload (e.g. after the user fixes something) so the next drain retries it. Resets the attempt counter so the manual retry gets a fresh budget (#714). */
export async function retryImageUpload(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`UPDATE pending_image_uploads SET status = 'queued', error_message = NULL, attempts = 0 WHERE id = ?`, [id]);
  notifyEnqueueListeners();
}

/** Give up on a queued/failed upload: delete its row and the stable file copy. No-op if the id is unknown. */
export async function dismissImageUpload(db: SQLiteDatabase, id: string): Promise<void> {
  const row = await db.getFirstAsync<Pick<PendingImageUploadEntry, 'local_path'>>(
    'SELECT local_path FROM pending_image_uploads WHERE id = ?',
    [id],
  );
  await db.runAsync('DELETE FROM pending_image_uploads WHERE id = ?', [id]);
  if (row) deleteFileIfExists(row.local_path);
}

export interface ImageUploadDrainResult {
  /** note_ids touched by a successful upload — callers invalidate their local caches. */
  uploadedNoteIds: string[];
  /** Uploads that were dropped or flagged `error` because of a permanent failure. */
  discardedCount: number;
}

/**
 * Drain the offline image-upload queue in FIFO order, mirroring drainQueue's
 * transient/permanent split (see syncQueue.ts): a transient failure
 * (network/5xx/etc.) stops the drain so the rest retry on the next reconnect;
 * a permanent failure flags the row `error` (surfaced with retry/dismiss in the
 * gallery) rather than looping forever. A note whose own server-side existence
 * isn't confirmed — its offline `create` is still queued (`sync_state =
 * 'pending'`), *or* that create was dead-lettered (`sync_state = 'failed'`) —
 * is skipped for this pass rather than attempted: either way an upload would
 * 404, and treating a dead-lettered create the same as a note gone for good
 * would silently discard an image that was never sent anywhere (issue #834).
 * It's retried once that note's state resolves (the create lands, or the user
 * resolves the failure — see `useSyncFailures.ts`, which reassigns any
 * still-queued uploads to a "Keep my version" fork before the abandoned
 * original is deleted). A note that's *actually* gone for good (404/403 on a
 * note this check didn't skip — i.e. one that was previously confirmed synced
 * and has since been deleted/unshared server-side while offline, per issue
 * #618's "reconcile … gracefully") is dropped silently: there is no note left
 * to attach the image (or an error badge) to.
 */
export async function drainImageUploadQueue(db: SQLiteDatabase): Promise<ImageUploadDrainResult> {
  const [pendingCreateNoteIds, failedNoteIds] = await Promise.all([
    getPendingCreateNoteIds(db),
    getFailedNoteIds(db),
  ]);
  const entries = await db.getAllAsync<PendingImageUploadEntry>(
    `SELECT * FROM pending_image_uploads WHERE status = 'queued' ORDER BY created_at ASC`,
  );

  const uploadedNoteIds: string[] = [];
  let discardedCount = 0;

  for (const entry of entries) {
    if (pendingCreateNoteIds.has(entry.note_id) || failedNoteIds.has(entry.note_id)) continue;

    let image: NoteImage;
    try {
      image = await uploadNoteImage(entry.note_id, {
        uri: entry.local_path,
        name: entry.filename,
        mimeType: entry.mime_type,
        sizeBytes: entry.size_bytes ?? undefined,
      });
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status !== undefined && !isTransientHttpStatus(status)) {
        discardedCount += 1;
        if (status === 404 || status === 403) {
          // Parent note is gone (deleted/unshared server-side) — nothing to attach to.
          await discardEntry(db, entry);
        } else {
          const message = axios.isAxiosError(err) ? err.message : 'Upload failed';
          await db.runAsync(
            `UPDATE pending_image_uploads SET status = 'error', error_message = ? WHERE id = ?`,
            [message, entry.id],
          );
        }
        continue;
      }
      if (isGlobalDrainFailure(err, status)) {
        // Connectivity failure (network/timeout/401/408/429) — every entry would
        // fail the same way, so stop draining without charging this entry and
        // retry on the next reconnect (issue #714).
        console.warn(`Image upload queue drain stopped at entry id=${entry.id} (connectivity):`, err);
        break;
      }
      // Entry-specific transient failure (a 5xx tied to this upload, or a non-HTTP
      // throw): charge the attempt counter. Once it reaches the cap, flag the row
      // `error` (surfaced with retry/dismiss in the gallery) and continue past it
      // so one persistently-failing upload can't wedge the whole queue (#714).
      const attempts = (entry.attempts ?? 0) + 1;
      await db.runAsync('UPDATE pending_image_uploads SET attempts = ? WHERE id = ?', [attempts, entry.id]);
      if (attempts < MAX_ENTRY_DRAIN_ATTEMPTS) {
        console.warn(
          `Image upload queue drain stopped at entry id=${entry.id} (attempt ${attempts}/${MAX_ENTRY_DRAIN_ATTEMPTS}):`,
          err,
        );
        break;
      }
      discardedCount += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Flagging image upload id=${entry.id} as failed after ${attempts} attempts:`, err);
      await db.runAsync(
        `UPDATE pending_image_uploads SET status = 'error', error_message = ? WHERE id = ?`,
        [message, entry.id],
      );
      continue;
    }

    // The upload itself has already landed server-side at this point, so the
    // queue entry is done regardless of what happens next — a local-cache
    // patch failure below (e.g. a transient SQLite lock) must not leave the
    // entry `queued`, or the next drain would upload the same file again and
    // create a duplicate image (uploadNoteImage has no idempotency key).
    await discardEntry(db, entry);
    uploadedNoteIds.push(entry.note_id);
    try {
      await patchLocalNoteImages(db, entry.note_id, (images) =>
        images.some((img) => img.id === image.id) ? images : [...images, image],
      );
    } catch (err) {
      // The note's local images_json will be reconciled by the next server
      // fetch or SSE event; the upload itself is not lost.
      console.warn(`Failed to patch local images for note id=${entry.note_id} after upload:`, err);
    }
  }

  return { uploadedNoteIds, discardedCount };
}
