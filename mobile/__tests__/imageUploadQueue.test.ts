/**
 * Tests for offline image uploads (issue #618): enqueueing copies the picked
 * file to a stable path and queues an `uploadImage` row in the sync queue
 * (#1288), and the main drain sends it, respecting its transient/permanent
 * split. A permanently rejected upload becomes an error tile in
 * `pending_image_uploads` rather than a dead letter.
 */

import {
  enqueueImageUpload,
  getPendingImageUploads,
  getImageUploadQueueStats,
  retryImageUpload,
  dismissImageUpload,
  reassignPendingImageUploads,
  type PendingImageUploadEntry,
} from '../src/db/imageUploadQueue';
import { uploadNoteImage } from '../src/api/images';
import { jot } from '../src/api/jot';
import {
  getFailedNoteIds,
  getLocalNote,
  getPendingCreateNoteIds,
  markNotePendingCreate,
  markNoteSyncFailed,
  patchLocalNoteImagesInTx,
  permanentDeleteLocalNote,
  saveNote,
} from '../src/db/noteQueries';
import {
  drainQueue,
  getDeadLetterCount,
  getProtectedNoteIds,
  subscribeToEnqueue,
  GIVE_UP_AFTER_ATTEMPTS,
  GIVE_UP_AFTER_MS,
  GIVE_UP_FAILURE_SPACING_MS,
  MAX_ENTRY_DRAIN_ATTEMPTS,
} from '../src/db/syncQueue';
import { makeListNote, makeNoteItem, makeTextNote, seedImageUpload, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';
import api from '../src/api/client';

jest.mock('../src/api/images', () => ({
  uploadNoteImage: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// The drain probes the server with `jot.about.get` when an upload gets a
// gateway status (502/503/504), and pulls a note with `jot.notes.getById` when
// a landed write could not be applied locally.
jest.mock('../src/api/jot', () => ({
  jot: { about: { get: jest.fn() }, notes: { getById: jest.fn() } },
}));

// The note queries run for real against the test database; only
// patchLocalNoteImagesInTx stays a spy so one case can make it throw.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return { ...actual, patchLocalNoteImagesInTx: jest.fn(actual.patchLocalNoteImagesInTx) };
});

const fs = globalThis.mockFileSystem;

const mockUploadNoteImage = uploadNoteImage as jest.Mock;
const mockProbe = jot.about.get as jest.Mock;
const mockGetNote = jot.notes.getById as jest.Mock;
const mockPatchLocalNoteImages = patchLocalNoteImagesInTx as jest.Mock;
const mockApi = api as jest.Mocked<typeof api>;

const UPLOAD_PATH = 'file:///docs/pending-image-uploads/upload-1';

let db: TestDatabase;

/** Every seeded upload shares UPLOAD_PATH unless a test overrides it. */
const seedUpload = (overrides: Partial<PendingImageUploadEntry> = {}) =>
  seedImageUpload(db, { local_path: UPLOAD_PATH, ...overrides });

/** An upload's state: queued in the sync queue, failed in `pending_image_uploads`, or null when gone. */
async function uploadRow(id: string): Promise<{ status: string; error_message: string | null; attempts: number } | null> {
  const queued = await db.getFirstAsync<{ attempts: number }>(
    `SELECT attempts FROM sync_queue WHERE operation = 'uploadImage' AND json_extract(body, '$.id') = ?`,
    [id],
  );
  if (queued) return { status: 'queued', error_message: null, attempts: queued.attempts };
  return db.getFirstAsync<{ status: string; error_message: string | null; attempts: number }>(
    'SELECT status, error_message, attempts FROM pending_image_uploads WHERE id = ?',
    [id],
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.reset();
  db = globalThis.testDb;
  // The picked source file that enqueueImageUpload copies from.
  fs.files.set('file:///cache/photo.png', 'png-bytes');
  // A landed upload pulls its note afterwards; unless a test says otherwise,
  // that pull fails and leaves the local note as it is.
  mockGetNote.mockRejectedValue(new Error('pull not stubbed'));
  // The drain logs each stop, give-up and failed local patch; the drain suites
  // below drive exactly those paths.
  silenceConsole(
    'warn',
    /^Flagging image upload/,
    /^Image upload id=\S+ was rejected/,
    /^Queue entry id=\d+ uploadImage failed \(attempt \d+\); holding back/,
    /^Queue entry id=\d+ landed server-side/,
    /^Failed to pull note/,
  );
  silenceConsole('info', /^Queue drain stopped at entry/, /^Dropping queued image upload/);
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

describe('getPendingImageUploads', () => {
  it('reads a note\'s queued uploads in queue order, then its failed ones', async () => {
    await seedUpload({ id: 'failed', status: 'error', error_message: 'too big' });
    await seedUpload({ id: 'first', created_at: '2024-01-02T00:00:00Z' });
    await seedUpload({ id: 'second', created_at: '2024-01-01T00:00:00Z' });
    await seedUpload({ id: 'other-note', note_id: 'note-2' });

    expect((await getPendingImageUploads(db, 'note-1')).map((e) => [e.id, e.status])).toEqual([
      ['first', 'queued'],
      ['second', 'queued'],
      ['failed', 'error'],
    ]);
  });

  it('protects a note while it has a queued or a failed upload (#1279)', async () => {
    await seedUpload({ id: 'queued', note_id: 'note-1' });
    await seedUpload({ id: 'failed', note_id: 'note-2', status: 'error', error_message: 'too big' });
    await saveNote(db, makeTextNote({ id: 'note-3' }));

    expect(await getProtectedNoteIds(db)).toEqual(new Set(['note-1', 'note-2']));
  });
});

describe('getImageUploadQueueStats', () => {
  it('reports an empty queue', async () => {
    expect(await getImageUploadQueueStats(db)).toEqual({ queuedCount: 0, errorCount: 0, oldest: null, maxAttempts: 0 });
  });

  it('counts queued and errored uploads separately and reports the oldest queued entry', async () => {
    await seedUpload({ id: 'oldest', created_at: '2024-01-02T00:00:00Z', attempts: 2 });
    // Newer, but the one actually failing: maxAttempts surfaces it.
    await seedUpload({ id: 'newer', created_at: '2024-01-03T00:00:00Z', attempts: 4 });
    // Older still, but errored: it waits on the user, not the drain.
    await seedUpload({ id: 'failed', created_at: '2024-01-01T00:00:00Z', status: 'error', error_message: 'too big', attempts: 3 });

    expect(await getImageUploadQueueStats(db)).toEqual({
      queuedCount: 2,
      errorCount: 1,
      oldest: { created_at: '2024-01-02T00:00:00Z', attempts: 2 },
      maxAttempts: 4,
    });
  });

  it('reports no oldest entry when every upload has failed', async () => {
    await seedUpload({ id: 'failed', status: 'error', error_message: 'too big' });

    expect(await getImageUploadQueueStats(db)).toEqual({ queuedCount: 0, errorCount: 1, oldest: null, maxAttempts: 0 });
  });
});

describe('retryImageUpload / dismissImageUpload', () => {
  it('queues a failed upload again with a fresh attempt budget and notifies listeners', async () => {
    await seedUpload({ status: 'error', error_message: 'boom', attempts: MAX_ENTRY_DRAIN_ATTEMPTS });
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await retryImageUpload(db, 'upload-1');

    // The manual retry gets a fresh attempt budget (#714).
    expect(await uploadRow('upload-1')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(await db.getAllAsync('SELECT id FROM pending_image_uploads')).toEqual([]);
    expect(listener).toHaveBeenCalledWith('uploadImage');
    unsubscribe();
  });

  it('does nothing when retrying an id that is not a failed upload', async () => {
    await seedUpload();

    await retryImageUpload(db, 'upload-1');

    expect(await db.getAllAsync(`SELECT id FROM sync_queue WHERE operation = 'uploadImage'`)).toHaveLength(1);
  });

  it.each(['queued', 'error'] as const)('deletes a %s upload and its stable file copy', async (status) => {
    await seedUpload({ status });

    await dismissImageUpload(db, 'upload-1');

    expect(await uploadRow('upload-1')).toBeNull();
    expect(fs.files.has(UPLOAD_PATH)).toBe(false);
  });

  it('is a no-op when the id is unknown', async () => {
    await seedUpload();

    await dismissImageUpload(db, 'missing');

    expect(await uploadRow('upload-1')).not.toBeNull();
    expect(fs.files.has(UPLOAD_PATH)).toBe(true);
  });
});

describe('draining queued uploads', () => {
  const image = {
    id: 'img-1', filename: 'photo.png', content_type: 'image/png',
    width: 10, height: 10, created_at: '2026-06-01T12:00:00.123456Z',
  };

  it('uploads queued entries, patches the local cache, and deletes the row + file', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockResolvedValueOnce(image);

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', {
      uri: entry.local_path,
      name: entry.filename,
      mimeType: entry.mime_type,
      sizeBytes: entry.size_bytes,
    }, undefined, undefined, entry.id); // the row ID is the image's client ID, so a replay is idempotent (#1286)
    // The uploaded image lands on the note's cached metadata.
    // ...and the note takes the server's bumped updated_at, the image's created_at (#1275).
    expect(await db.getFirstAsync('SELECT images_json, updated_at FROM notes WHERE id = ?', ['note-1'])).toEqual({
      images_json: JSON.stringify([image]),
      updated_at: image.created_at,
    });
    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    // The queue's copy became the cached original, so the image opens offline.
    expect(fs.files.has(`file:///cache/note-images/${image.id}`)).toBe(true);
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('discards the entry even when the local-cache patch fails, so a retry cannot re-upload and duplicate the image', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockResolvedValueOnce(image);
    mockPatchLocalNoteImages.mockRejectedValueOnce(new Error('database is locked'));
    // The note the upload could not be applied to is pulled instead.
    mockGetNote.mockResolvedValueOnce(makeTextNote({ id: 'note-1', images: [image] }));

    const result = await drainQueue(db);

    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    // It landed under its client ID, so the copy is still cached as its original.
    expect(fs.files.has(`file:///cache/note-images/${entry.id}`)).toBe(true);
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('skips a note whose offline create has not drained yet, retrying it later', async () => {
    const entry = await seedUpload();
    await markNotePendingCreate(db, 'note-1');

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('stops draining on a transient failure so the entry is retried next time', async () => {
    await seedUpload({ id: 'upload-1', created_at: '2024-01-01T00:00:00Z' });
    await seedUpload({ id: 'upload-2', created_at: '2024-01-02T00:00:00Z' });
    const transientError = Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined });
    mockUploadNoteImage.mockRejectedValueOnce(transientError);

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledTimes(1);
    // A connectivity failure charges no attempt against the head entry (#714).
    expect(await uploadRow('upload-1')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('charges the attempt counter and keeps the upload queued on a 5xx (#714)', async () => {
    await seedUpload({ id: 'up-5xx' });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } });
    mockUploadNoteImage.mockRejectedValueOnce(err);

    const result = await drainQueue(db);

    expect(await uploadRow('up-5xx')).toEqual({ status: 'queued', error_message: null, attempts: 1 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('charges a 500 without probing the server', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-500', note_id: 'n1' });
    mockUploadNoteImage.mockRejectedValueOnce(
      Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } }),
    );

    await drainQueue(db);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(await uploadRow('up-500')).toEqual({ status: 'queued', error_message: null, attempts: 1 });
  });

  it('stops without charging on a gateway status while the server does not answer', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-gw', note_id: 'n1', created_at: '2024-01-01T00:00:00Z' });
    await seedUpload({ id: 'up-next', note_id: 'n1', local_path: 'file:///docs/pending-image-uploads/up-next', created_at: '2024-01-02T00:00:00Z' });
    mockUploadNoteImage.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { isAxiosError: true, response: { status: 502 } }),
    );
    mockProbe.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { isAxiosError: true, response: { status: 502 } }));

    const result = await drainQueue(db);

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockUploadNoteImage).toHaveBeenCalledTimes(1);
    expect(await uploadRow('up-gw')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('keeps an upload that keeps timing out at the proxy queued while the server answers (#1283)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-slow', note_id: 'n1' });
    mockUploadNoteImage.mockRejectedValueOnce(
      Object.assign(new Error('Gateway Timeout'), { isAxiosError: true, response: { status: 504 } }),
    );
    mockProbe.mockResolvedValueOnce({});

    const result = await drainQueue(db);

    expect(await uploadRow('up-slow')).toEqual({ status: 'queued', error_message: null, attempts: 1 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('keeps an upload that keeps timing out client-side queued while the server answers (#1211, #1283)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-timeout', note_id: 'n1' });
    mockUploadNoteImage.mockRejectedValueOnce(
      Object.assign(new Error('timeout of 90000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED', response: undefined }),
    );
    mockProbe.mockResolvedValueOnce({});

    const result = await drainQueue(db);

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(await uploadRow('up-timeout')).toEqual({ status: 'queued', error_message: null, attempts: 1 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('stops without charging on a client-side timeout while the server does not answer (#1211)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-timeout', note_id: 'n1' });
    const timeout = () => Object.assign(new Error('timeout exceeded'), { isAxiosError: true, code: 'ECONNABORTED', response: undefined });
    mockUploadNoteImage.mockRejectedValueOnce(timeout());
    mockProbe.mockRejectedValueOnce(timeout());

    const result = await drainQueue(db);

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(await uploadRow('up-timeout')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('holds back the failing upload\'s note and uploads the other notes\' images past it (#1283)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await saveNote(db, makeTextNote({ id: 'n2' }));
    await seedUpload({
      id: 'up-stuck', note_id: 'n1', local_path: 'file:///docs/pending-image-uploads/up-stuck',
      created_at: '2024-01-01T00:00:00Z', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedUpload({
      id: 'up-behind', note_id: 'n1', local_path: 'file:///docs/pending-image-uploads/up-behind',
      created_at: '2024-01-02T00:00:00Z',
    });
    await seedUpload({
      id: 'up-ok', note_id: 'n2', local_path: 'file:///docs/pending-image-uploads/up-ok',
      created_at: '2024-01-03T00:00:00Z',
    });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } });
    mockUploadNoteImage.mockRejectedValueOnce(err); // up-stuck fails again, past the old cap
    mockUploadNoteImage.mockResolvedValueOnce(image); // up-ok uploads fine

    const result = await drainQueue(db);

    // An HTTP failure is never capped: the upload stays queued, and so does
    // the one behind it on the same note.
    expect(await uploadRow('up-stuck')).toEqual({ status: 'queued', error_message: null, attempts: MAX_ENTRY_DRAIN_ATTEMPTS });
    expect(await uploadRow('up-behind')).toEqual({ status: 'queued', error_message: null, attempts: 0 });
    expect(mockUploadNoteImage).toHaveBeenCalledTimes(2);
    expect(await uploadRow('up-ok')).toBeNull();
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('does not flag an upload on its first non-HTTP error after many HTTP failures (#1283)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-outage', note_id: 'n1', attempts: MAX_ENTRY_DRAIN_ATTEMPTS + 3 });
    mockUploadNoteImage.mockRejectedValueOnce(new Error('file unreadable'));

    const result = await drainQueue(db);

    expect(await uploadRow('up-outage')).toEqual({ status: 'queued', error_message: null, attempts: MAX_ENTRY_DRAIN_ATTEMPTS + 4 });
    expect(result.discardedOperations).toHaveLength(0);
  });

  it('flags an upload whose processing keeps throwing a non-HTTP error at the cap and continues past it (#714)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await saveNote(db, makeTextNote({ id: 'n2' }));
    await seedUpload({
      id: 'up-stuck', note_id: 'n1', local_path: 'file:///docs/pending-image-uploads/up-stuck',
      created_at: '2024-01-01T00:00:00Z', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
      processing_errors: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedUpload({
      id: 'up-ok', note_id: 'n2', local_path: 'file:///docs/pending-image-uploads/up-ok',
      created_at: '2024-01-02T00:00:00Z',
    });
    mockUploadNoteImage.mockRejectedValueOnce(new Error('file unreadable')); // up-stuck hits the cap
    mockUploadNoteImage.mockResolvedValueOnce(image); // up-ok uploads fine

    const result = await drainQueue(db);

    expect(await uploadRow('up-stuck')).toEqual({
      status: 'error',
      error_message: 'file unreadable',
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS,
    });
    // The drain continued past the flagged entry to the next upload.
    expect(mockUploadNoteImage).toHaveBeenCalledTimes(2);
    expect(await uploadRow('up-ok')).toBeNull();
    expect(result.discardedOperations).toEqual([{ operation: 'uploadImage', endpoint: '/notes/n1/images', status: 0 }]);
  });

  it('flags an upload that has kept failing over HTTP for 24 h and 5 spaced attempts as an error tile, not a failed change (#1301)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));
    await seedUpload({ id: 'up-broken', note_id: 'n1', attempts: GIVE_UP_AFTER_ATTEMPTS - 1 });
    const now = Date.now();
    await db.runAsync(
      'UPDATE sync_queue SET first_failed_at = ?, spaced_failures = ?, last_spaced_failure_at = ?',
      [now - GIVE_UP_AFTER_MS - 1, GIVE_UP_AFTER_ATTEMPTS - 1, now - GIVE_UP_FAILURE_SPACING_MS],
    );
    mockUploadNoteImage.mockRejectedValueOnce(
      Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } }),
    );

    const result = await drainQueue(db);

    expect(await uploadRow('up-broken')).toEqual({ status: 'error', error_message: 'Server Error', attempts: GIVE_UP_AFTER_ATTEMPTS });
    expect(fs.files.has(UPLOAD_PATH)).toBe(true);
    expect(await getDeadLetterCount(db)).toBe(0);
    expect(await getFailedNoteIds(db)).toEqual(new Set());
    expect(result.discardedOperations).toEqual([{ operation: 'uploadImage', endpoint: '/notes/n1/images', status: 500 }]);
  });

  it('flags a permanently-rejected upload as errored instead of discarding it silently', async () => {
    const entry = await seedUpload();
    const permanentError = Object.assign(new Error('Payload Too Large'), {
      isAxiosError: true,
      response: { status: 413 },
    });
    mockUploadNoteImage.mockRejectedValueOnce(permanentError);

    const result = await drainQueue(db);

    expect(await uploadRow(entry.id)).toMatchObject({
      status: 'error',
      error_message: 'Payload Too Large',
    });
    // The file survives so the user can retry from the gallery.
    expect(fs.files.has(UPLOAD_PATH)).toBe(true);
    // A gallery tile, not a failed change: no dead letter, the note not flagged.
    expect(await getDeadLetterCount(db)).toBe(0);
    expect(await getFailedNoteIds(db)).toEqual(new Set());
    expect(result.discardedOperations).toHaveLength(1);
  });

  it('drops the upload silently when the parent note is gone server-side (404)', async () => {
    const entry = await seedUpload();
    const notFoundError = Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } });
    mockUploadNoteImage.mockRejectedValueOnce(notFoundError);

    const result = await drainQueue(db);

    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result.discardedOperations).toHaveLength(1);
  });

  it('leaves errored rows out of the drain until they are retried', async () => {
    await seedUpload({ id: 'already-failed', status: 'error', error_message: 'too big' });

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(result.discardedOperations).toHaveLength(0);
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

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(fs.files.has(entry.local_path)).toBe(true);
    expect(result.discardedOperations).toHaveLength(0);
  });
});

describe('draining uploads with the rest of the queue (#1288)', () => {
  const image = {
    id: 'img-1', filename: 'photo.png', content_type: 'image/png',
    width: 10, height: 10, created_at: '2026-06-01T12:00:00.123456Z',
  };

  it('sends an upload right after its note\'s queued create, in the same pass', async () => {
    await saveNote(db, makeTextNote({ id: 'note-1' }));
    await markNotePendingCreate(db, 'note-1');
    await seedQueueEntry(db, { operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'note-1' }, keys: ['note:note-1'] });
    const entry = await seedUpload();
    mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: 'note-1' }) });
    mockUploadNoteImage.mockResolvedValueOnce(image);
    // The create's response waited on the upload queued behind it, so the note is pulled.
    mockGetNote.mockResolvedValueOnce(makeTextNote({ id: 'note-1', images: [image] }));

    const result = await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', expect.objectContaining({ uri: entry.local_path }), undefined, undefined, entry.id);
    expect(await uploadRow(entry.id)).toBeNull();
    expect(result.leftBehind).toBe(0);
  });

  it('waits behind its note\'s create while the create fails transiently', async () => {
    await saveNote(db, makeTextNote({ id: 'note-1' }));
    await markNotePendingCreate(db, 'note-1');
    await seedQueueEntry(db, { operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'note-1' }, keys: ['note:note-1'] });
    const entry = await seedUpload();
    mockApi.post.mockRejectedValueOnce(Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } }));
    silenceConsole('warn', /^Queue entry id=\d+ create failed/);

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result.leftBehind).toBe(2);
  });

  it('holds an upload for a note with an unreviewed failure without holding back the note\'s other ops', async () => {
    const entry = await seedUpload();
    await markNoteSyncFailed(db, 'note-1');
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { pinned: true }, keys: ['note:note-1'] });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'note-1', pinned: true }) });

    const result = await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result.leftBehind).toBe(1);
  });

  it('pulls the note once its upload lands, for the responses withheld while it was queued', async () => {
    await seedUpload();
    mockUploadNoteImage.mockResolvedValueOnce(image);

    await drainQueue(db);

    expect(mockGetNote).toHaveBeenCalledWith('note-1');
  });

  it('keeps the file of an upload moved to another note while the drain ran', async () => {
    await saveNote(db, makeTextNote({ id: 'note-0' }));
    await saveNote(db, makeTextNote({ id: 'note-2' }));
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-0', method: 'PATCH', body: { pinned: true }, keys: ['note:note-0'] });
    const entry = await seedUpload();
    // While the pass waits on the op ahead, "Keep my version" moves the upload
    // to its fork and deletes the original note.
    mockApi.patch.mockImplementationOnce(async () => {
      await reassignPendingImageUploads(db, 'note-1', 'note-2');
      await db.runAsync('DELETE FROM notes WHERE id = ?', ['note-1']);
      return { data: makeTextNote({ id: 'note-0', pinned: true }) };
    });

    await drainQueue(db);

    expect(fs.files.has(entry.local_path)).toBe(true);
    expect(await getPendingImageUploads(db, 'note-2')).toMatchObject([{ id: entry.id, local_path: entry.local_path }]);
  });

  it('does not bring back an upload dismissed while its request was in flight', async () => {
    const entry = await seedUpload();
    mockUploadNoteImage.mockImplementationOnce(async () => {
      await dismissImageUpload(db, entry.id);
      throw Object.assign(new Error('Payload Too Large'), { isAxiosError: true, response: { status: 413 } });
    });

    await drainQueue(db);

    expect(await uploadRow(entry.id)).toBeNull();
    expect(await getPendingImageUploads(db, 'note-1')).toEqual([]);
  });

  it('lists an upload once when it is both queued and flagged failed', async () => {
    await seedUpload();
    await db.runAsync(
      `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, status, error_message, created_at)
       VALUES ('upload-1', 'note-1', ?, 'photo.png', 'image/png', 'error', 'too big', '2024-01-01T00:00:00Z')`,
      [UPLOAD_PATH],
    );

    expect((await getPendingImageUploads(db, 'note-1')).map((e) => [e.id, e.status])).toEqual([['upload-1', 'error']]);
  });

  it('drops a leftover upload whose note is gone locally', async () => {
    const entry = await seedUpload();
    await db.runAsync('DELETE FROM notes WHERE id = ?', ['note-1']);

    await drainQueue(db);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toBeNull();
    expect(fs.files.has(entry.local_path)).toBe(false);
  });

  it('deletes a note\'s queued and failed uploads, and their files, with the note', async () => {
    const queued = await seedUpload({ id: 'queued', local_path: 'file:///docs/pending-image-uploads/queued' });
    const failed = await seedUpload({ id: 'failed', local_path: 'file:///docs/pending-image-uploads/failed', status: 'error' });
    const other = await seedUpload({ id: 'other', note_id: 'note-2', local_path: 'file:///docs/pending-image-uploads/other' });

    await permanentDeleteLocalNote(db, 'note-1');

    expect(await uploadRow(queued.id)).toBeNull();
    expect(await uploadRow(failed.id)).toBeNull();
    expect(fs.files.has(queued.local_path)).toBe(false);
    expect(fs.files.has(failed.local_path)).toBe(false);
    expect(await uploadRow(other.id)).toMatchObject({ status: 'queued' });
    expect(fs.files.has(other.local_path)).toBe(true);
  });
});

describe('reassignPendingImageUploads', () => {
  it('queues the moved uploads behind the fork\'s create', async () => {
    await saveNote(db, makeTextNote({ id: 'note-2' }));
    const entry = await seedUpload();
    // "Keep my version" queues the fork's create before moving the uploads.
    await seedQueueEntry(db, { operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'note-2' }, keys: ['note:note-2'] });
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await reassignPendingImageUploads(db, 'note-1', 'note-2');

    expect(await db.getAllAsync(
      `SELECT q.operation, q.endpoint, k.key FROM sync_queue q JOIN sync_queue_keys k ON k.entry_id = q.id ORDER BY q.id`,
    )).toEqual([
      { operation: 'create', endpoint: '/notes', key: 'note:note-2' },
      { operation: 'uploadImage', endpoint: '/notes/note-2/images', key: 'note:note-2' },
    ]);
    expect(await getPendingImageUploads(db, 'note-2')).toMatchObject([{ id: entry.id, local_path: entry.local_path }]);
    expect(listener).toHaveBeenCalledWith('uploadImage');
    unsubscribe();
  });

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
    const result = await drainQueue(db);

    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', expect.objectContaining({ uri: entry.local_path }), undefined, undefined, entry.id);
    expect(result.discardedOperations).toHaveLength(0);
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
    const result = await drainQueue(db);
    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(await uploadRow(entry.id)).toMatchObject({ status: 'queued' });
    expect(result.discardedOperations).toHaveLength(0);
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
