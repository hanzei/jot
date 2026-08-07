/**
 * Tests for the offline image-upload queue (issue #618): enqueueing copies the
 * picked file to a stable path, and the drain uploads queued entries on
 * reconnect, respecting the same transient/permanent split as syncQueue's
 * drainQueue.
 */

import {
  enqueueImageUpload,
  getPendingImageUploads,
  getQueuedImageUploadCount,
  retryImageUpload,
  dismissImageUpload,
  drainImageUploadQueue,
  reassignPendingImageUploads,
  type PendingImageUploadEntry,
} from '../src/db/imageUploadQueue';
import { uploadNoteImage } from '../src/api/images';
import { getLocalNote, getPendingCreateNoteIds, markNotePendingCreate, markNoteSyncFailed, patchLocalNoteImages, saveNote } from '../src/db/noteQueries';
import { subscribeToEnqueue, MAX_ENTRY_DRAIN_ATTEMPTS } from '../src/db/syncQueue';
import { makeListNote, makeNoteItem, makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/images', () => ({
  uploadNoteImage: jest.fn(),
}));

// The note queries run for real against the test database; only
// patchLocalNoteImages stays a spy so one case can make it throw.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return { ...actual, patchLocalNoteImages: jest.fn(actual.patchLocalNoteImages) };
});

const fs = globalThis.mockFileSystem;

const mockUploadNoteImage = uploadNoteImage as jest.Mock;
const mockPatchLocalNoteImages = patchLocalNoteImages as jest.Mock;

const UPLOAD_PATH = 'file:///docs/pending-image-uploads/upload-1';

let db: TestDatabase;

/** Insert a queued upload row (and the note it hangs off, for the FK). */
async function seedUpload(
  overrides: Partial<PendingImageUploadEntry> = {},
): Promise<PendingImageUploadEntry> {
  const entry: PendingImageUploadEntry = {
    id: 'upload-1',
    note_id: 'note-1',
    local_path: UPLOAD_PATH,
    filename: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    status: 'queued',
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    attempts: 0,
    ...overrides,
  };
  const exists = await db.getFirstAsync('SELECT id FROM notes WHERE id = ?', [entry.note_id]);
  if (!exists) {
    await saveNote(db, makeTextNote({ id: entry.note_id }));
  }
  await db.runAsync(
    `INSERT INTO pending_image_uploads
       (id, note_id, local_path, filename, mime_type, size_bytes, status, error_message, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.note_id, entry.local_path, entry.filename, entry.mime_type,
      entry.size_bytes, entry.status, entry.error_message, entry.created_at, entry.attempts ?? 0,
    ],
  );
  fs.files.set(entry.local_path, 'png-bytes');
  return entry;
}

const uploadRow = (id: string) =>
  db.getFirstAsync<{ status: string; error_message: string | null; attempts: number }>(
    'SELECT status, error_message, attempts FROM pending_image_uploads WHERE id = ?',
    [id],
  );

beforeEach(() => {
  jest.clearAllMocks();
  fs.reset();
  db = globalThis.testDb;
  // The picked source file that enqueueImageUpload copies from.
  fs.files.set('file:///cache/photo.png', 'png-bytes');
});

describe('enqueueImageUpload', () => {
  beforeEach(async () => {
    await saveNote(db, makeTextNote({ id: 'note-1' }));
  });

  it('copies the picked file to a stable path and inserts a queued row', async () => {
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png', sizeBytes: 2048 };

    await enqueueImageUpload(db, { id: 'upload-1', noteId: 'note-1', file });

    expect(fs.files.get(UPLOAD_PATH)).toBe('png-bytes');
    expect(await getPendingImageUploads(db, 'note-1')).toMatchObject([
      {
        id: 'upload-1',
        note_id: 'note-1',
        local_path: UPLOAD_PATH,
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        status: 'queued',
        attempts: 0,
      },
    ]);
  });

  it('stores a NULL size when the picker did not report one', async () => {
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' };

    await enqueueImageUpload(db, { id: 'upload-1', noteId: 'note-1', file });

    expect(await getPendingImageUploads(db, 'note-1')).toMatchObject([{ size_bytes: null }]);
  });

  it('creates the pending-uploads directory when it does not exist', async () => {
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' };
    expect(fs.dirs.has('file:///docs/pending-image-uploads')).toBe(false);

    await enqueueImageUpload(db, { id: 'upload-1', noteId: 'note-1', file });

    expect(fs.dirs.has('file:///docs/pending-image-uploads')).toBe(true);
  });

  it('notifies enqueue listeners so the sync engine picks it up promptly', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' };

    await enqueueImageUpload(db, { id: 'upload-1', noteId: 'note-1', file });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('getPendingImageUploads / getQueuedImageUploadCount', () => {
  it('reads uploads for a note ordered by created_at', async () => {
    await seedUpload({ id: 'later', created_at: '2024-01-02T00:00:00Z' });
    await seedUpload({ id: 'earlier', created_at: '2024-01-01T00:00:00Z' });
    await seedUpload({ id: 'other-note', note_id: 'note-2' });

    expect((await getPendingImageUploads(db, 'note-1')).map((e) => e.id)).toEqual(['earlier', 'later']);
  });

  it('counts only queued (not errored) uploads', async () => {
    await seedUpload({ id: 'q1' });
    await seedUpload({ id: 'q2' });
    await seedUpload({ id: 'q3' });
    await seedUpload({ id: 'failed', status: 'error', error_message: 'too big' });

    expect(await getQueuedImageUploadCount(db)).toBe(3);
  });

  it('counts zero when nothing is queued', async () => {
    expect(await getQueuedImageUploadCount(db)).toBe(0);
  });
});

describe('retryImageUpload / dismissImageUpload', () => {
  it('resets an errored upload to queued and notifies listeners', async () => {
    await seedUpload({ status: 'error', error_message: 'boom', attempts: MAX_ENTRY_DRAIN_ATTEMPTS });
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await retryImageUpload(db, 'upload-1');

    // The manual retry gets a fresh attempt budget (#714).
    expect(await uploadRow('upload-1')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('deletes the row and its stable file copy', async () => {
    await seedUpload();

    await dismissImageUpload(db, 'upload-1');

    expect(await uploadRow('upload-1')).toBeNull();
    expect(fs.files.has(UPLOAD_PATH)).toBe(false);
  });

  it('is a no-op (beyond the delete statement) when the id is unknown', async () => {
    await seedUpload();

    await dismissImageUpload(db, 'missing');

    expect(await uploadRow('upload-1')).not.toBeNull();
    expect(fs.files.has(UPLOAD_PATH)).toBe(true);
  });
});

describe('drainImageUploadQueue', () => {
  const image = {
    id: 'img-1', filename: 'photo.png', content_type: 'image/png',
    width: 10, height: 10, created_at: 'now',
  };

  it('uploads queued entries, patches the local cache, and deletes the row + file', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockResolvedValueOnce(image);

    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', {
      uri: entry.local_path,
      name: entry.filename,
      mimeType: entry.mime_type,
      sizeBytes: entry.size_bytes,
    });
    // The uploaded image lands on the note's cached metadata.
    expect(await db.getFirstAsync('SELECT images_json FROM notes WHERE id = ?', ['note-1'])).toEqual({
      images_json: JSON.stringify([image]),
    });
    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: ['note-1'], discardedCount: 0 });
  });

  it('discards the entry even when the local-cache patch fails, so a retry cannot re-upload and duplicate the image', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockResolvedValueOnce(image);
    mockPatchLocalNoteImages.mockRejectedValueOnce(new Error('database is locked'));

    const result = await drainImageUploadQueue(db);

    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: ['note-1'], discardedCount: 0 });
  });

  it('skips a note whose offline create has not drained yet, retrying it later', async () => {
    const entry = await seedUpload();
    await markNotePendingCreate(db, 'note-1');

    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('stops draining on a transient failure so the entry is retried next time', async () => {
    await seedUpload({ id: 'upload-1', created_at: '2024-01-01T00:00:00Z' });
    await seedUpload({ id: 'upload-2', created_at: '2024-01-02T00:00:00Z' });
    const transientError = Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined });
    mockUploadNoteImage.mockRejectedValueOnce(transientError);

    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledTimes(1);
    // A connectivity failure charges no attempt against the head entry (#714).
    expect(await uploadRow('upload-1')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('charges the attempt counter and stops below the cap on a persistent 5xx (#714)', async () => {
    await seedUpload({ id: 'up-5xx' });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 503 } });
    mockUploadNoteImage.mockRejectedValueOnce(err);

    const result = await drainImageUploadQueue(db);

    expect(await uploadRow('up-5xx')).toEqual({ status: 'queued', error_message: null, attempts: 1 });
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('flags a persistently-failing upload as errored at the cap and continues past it (#714)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await saveNote(db, makeTextNote({ id: 'n2' }));
    await seedUpload({
      id: 'up-stuck', note_id: 'n1', local_path: 'file:///docs/pending-image-uploads/up-stuck',
      created_at: '2024-01-01T00:00:00Z', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedUpload({
      id: 'up-ok', note_id: 'n2', local_path: 'file:///docs/pending-image-uploads/up-ok',
      created_at: '2024-01-02T00:00:00Z',
    });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } });
    mockUploadNoteImage.mockRejectedValueOnce(err); // up-stuck hits the cap
    mockUploadNoteImage.mockResolvedValueOnce(image); // up-ok uploads fine

    const result = await drainImageUploadQueue(db);

    expect(await uploadRow('up-stuck')).toEqual({
      status: 'error',
      error_message: 'Server Error',
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS,
    });
    // The drain continued past the flagged entry to the next upload.
    expect(mockUploadNoteImage).toHaveBeenCalledTimes(2);
    expect(await uploadRow('up-ok')).toBeNull();
    expect(result.uploadedNoteIds).toEqual(['n2']);
    expect(result.discardedCount).toBe(1);
  });

  it('flags a permanently-rejected upload as errored instead of discarding it silently', async () => {
    const entry = await seedUpload();
    const permanentError = Object.assign(new Error('Payload Too Large'), {
      isAxiosError: true,
      response: { status: 413 },
    });
    mockUploadNoteImage.mockRejectedValueOnce(permanentError);

    const result = await drainImageUploadQueue(db);

    expect(await uploadRow(entry.id)).toMatchObject({
      status: 'error',
      error_message: 'Payload Too Large',
    });
    // The file survives so the user can retry from the gallery.
    expect(fs.files.has(UPLOAD_PATH)).toBe(true);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 1 });
  });

  it('drops the upload silently when the parent note is gone server-side (404)', async () => {
    const entry = await seedUpload();
    const notFoundError = Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } });
    mockUploadNoteImage.mockRejectedValueOnce(notFoundError);

    const result = await drainImageUploadQueue(db);

    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 1 });
  });

  it('leaves errored rows out of the drain until they are retried', async () => {
    await seedUpload({ id: 'already-failed', status: 'error', error_message: 'too big' });

    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  // Regression coverage for a reported bug (#834): capturing a photo offline
  // on a brand-new note, then reconnecting, could permanently lose the image
  // if the note's own offline `create` was dead-lettered (a permanent
  // rejection, not just still-pending). Before this fix, `sync_state =
  // 'failed'` wasn't recognized as "note not confirmed on the server" here,
  // so the drain attempted the upload anyway, got a 404 (the note was never
  // actually created), and silently discarded the row and its file forever —
  // indistinguishable from the legitimate "note deleted server-side" case.
  it('skips (does not attempt or discard) a note whose create was dead-lettered', async () => {
    const entry = await seedUpload();
    await markNoteSyncFailed(db, 'note-1');

    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(fs.files.has(entry.local_path)).toBe(true);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });
});

describe('reassignPendingImageUploads', () => {
  it('moves queued/errored rows from one note to another', async () => {
    await saveNote(db, makeTextNote({ id: 'note-2' }));
    const queued = await seedUpload({ id: 'upload-queued' });
    const errored = await seedUpload({ id: 'upload-errored', status: 'error', error_message: 'boom' });

    await reassignPendingImageUploads(db, 'note-1', 'note-2');

    expect(await getPendingImageUploads(db, 'note-2')).toMatchObject([
      { id: queued.id, note_id: 'note-2' },
      { id: errored.id, note_id: 'note-2' },
    ]);
    expect(await getPendingImageUploads(db, 'note-1')).toEqual([]);
  });

  it('is a no-op when the source note has no queued uploads', async () => {
    await saveNote(db, makeTextNote({ id: 'note-2' }));

    await expect(reassignPendingImageUploads(db, 'note-1', 'note-2')).resolves.toBeUndefined();
  });
});

// A queued upload only survives long enough to be drained if re-saving its
// parent note leaves it alone. `saveNoteInTx` used `INSERT OR REPLACE`, which
// SQLite implements as DELETE + INSERT — firing `pending_image_uploads`'
// `ON DELETE CASCADE` on every routine note write. Two user-visible symptoms
// came out of that one statement:
//
//   1. Reconnecting after queueing an image offline never uploaded it. The
//      reconnect triggers a background note fetch (useOfflineNote) at the same
//      time as the drain, and the fetch's `saveServerNote` deleted the queue
//      row first.
//   2. Switching to another server and back lost the image entirely — landing
//      back on the original server refetches its notes, deleting the row on the
//      way in.
//
// The offline-created-note case is the same statement a third time: the drain's
// own `create` response is persisted with `saveNote`, which would have wiped the
// uploads that were waiting for exactly that create to land.
describe('pending uploads survive a re-save of their note', () => {
  it('keeps queued uploads when the note is re-saved from the server', async () => {
    const entry = await seedUpload();

    await saveNote(db, makeTextNote({ id: 'note-1', content: 'edited on another device' }));

    expect(await getPendingImageUploads(db, 'note-1')).toMatchObject([{ id: entry.id, status: 'queued' }]);
    expect(await getLocalNote(db, 'note-1')).toMatchObject({ content: 'edited on another device' });
  });

  it('keeps queued uploads when a list note is re-saved with its items', async () => {
    await saveNote(db, makeListNote({ id: 'note-2', items: [] }));
    const entry = await seedUpload({ id: 'upload-list', note_id: 'note-2' });

    await saveNote(db, makeListNote({
      id: 'note-2',
      title: 'groceries',
      items: [makeNoteItem({ id: 'item-1', note_id: 'note-2', text: 'milk' })],
    }));

    expect(await getPendingImageUploads(db, 'note-2')).toMatchObject([{ id: entry.id }]);
    expect(await getLocalNote(db, 'note-2')).toMatchObject({
      title: 'groceries',
      items: [{ id: 'item-1', text: 'milk' }],
    });
  });

  it('still drains normally after the note has been re-saved', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockResolvedValue({ id: 'img-1', note_id: 'note-1' });

    // The reconnect's background note fetch lands first, then the drain runs.
    await saveNote(db, makeTextNote({ id: 'note-1' }));
    const result = await drainImageUploadQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', expect.objectContaining({ uri: entry.local_path }));
    expect(result).toEqual({ uploadedNoteIds: ['note-1'], discardedCount: 0 });
    expect(await getPendingImageUploads(db, 'note-1')).toEqual([]);
  });

  it('preserves the pending-create marker so uploads are not attempted early', async () => {
    const entry = await seedUpload();
    await markNotePendingCreate(db, 'note-1');

    // A local save of the note (an edit while its create is still queued) must
    // not silently promote it to 'synced' — REPLACE reset sync_state to its
    // column default, which would have let the drain upload against a note the
    // server has never seen.
    await saveNote(db, makeTextNote({ id: 'note-1', content: 'still offline' }));

    expect(await getPendingCreateNoteIds(db)).toEqual(new Set(['note-1']));
    const result = await drainImageUploadQueue(db);
    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('drops leftover items when a list note is re-saved as a text note', async () => {
    await saveNote(db, makeListNote({
      id: 'note-3',
      items: [makeNoteItem({ id: 'item-1', note_id: 'note-3', text: 'milk' })],
    }));

    await saveNote(db, makeTextNote({ id: 'note-3', content: 'converted' }));

    expect(await db.getAllAsync('SELECT id FROM note_items WHERE note_id = ?', ['note-3'])).toEqual([]);
  });
});
