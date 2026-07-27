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
  type PendingImageUploadEntry,
} from '../src/db/imageUploadQueue';
import { uploadNoteImage } from '../src/api/images';
import { patchLocalNoteImages, getPendingCreateNoteIds } from '../src/db/noteQueries';
import { subscribeToEnqueue, MAX_ENTRY_DRAIN_ATTEMPTS } from '../src/db/syncQueue';

jest.mock('../src/api/images', () => ({
  uploadNoteImage: jest.fn(),
}));

jest.mock('../src/db/noteQueries', () => ({
  patchLocalNoteImages: jest.fn().mockResolvedValue(undefined),
  getPendingCreateNoteIds: jest.fn().mockResolvedValue(new Set()),
}));

const fs = globalThis.mockFileSystem;

const mockUploadNoteImage = uploadNoteImage as jest.Mock;
const mockPatchLocalNoteImages = patchLocalNoteImages as jest.Mock;
const mockGetPendingCreateNoteIds = getPendingCreateNoteIds as jest.Mock;

function makeDb(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    runAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<PendingImageUploadEntry> = {}): PendingImageUploadEntry {
  return {
    id: 'upload-1',
    note_id: 'note-1',
    local_path: 'file:///docs/pending-image-uploads/upload-1',
    filename: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    status: 'queued',
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.reset();
  // The stable file copy backing the default `makeEntry()` row, so tests can
  // assert it is (or is not) cleaned up.
  fs.files.set('file:///docs/pending-image-uploads/upload-1', 'png-bytes');
  // The picked source file that enqueueImageUpload copies from.
  fs.files.set('file:///cache/photo.png', 'png-bytes');
  mockGetPendingCreateNoteIds.mockResolvedValue(new Set());
});

describe('enqueueImageUpload', () => {
  it('copies the picked file to a stable path and inserts a queued row', async () => {
    const db = makeDb();
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png', sizeBytes: 2048 };

    await enqueueImageUpload(db as never, { id: 'upload-1', noteId: 'note-1', file });

    expect(fs.files.get('file:///docs/pending-image-uploads/upload-1')).toBe('png-bytes');
    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pending_image_uploads'),
      ['upload-1', 'note-1', 'file:///docs/pending-image-uploads/upload-1', 'photo.png', 'image/png', 2048, expect.any(String)],
    );
  });

  it('creates the pending-uploads directory when it does not exist', async () => {
    const db = makeDb();
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' };
    expect(fs.dirs.has('file:///docs/pending-image-uploads')).toBe(false);

    await enqueueImageUpload(db as never, { id: 'upload-1', noteId: 'note-1', file });

    expect(fs.dirs.has('file:///docs/pending-image-uploads')).toBe(true);
  });

  it('notifies enqueue listeners so the sync engine picks it up promptly', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);
    const db = makeDb();
    const file = { uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' };

    await enqueueImageUpload(db as never, { id: 'upload-1', noteId: 'note-1', file });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('getPendingImageUploads / getQueuedImageUploadCount', () => {
  it('reads uploads for a note ordered by created_at', async () => {
    const rows = [makeEntry()];
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue(rows) });

    const result = await getPendingImageUploads(db as never, 'note-1');

    expect(result).toEqual(rows);
    expect(db.getAllAsync).toHaveBeenCalledWith(expect.stringContaining('WHERE note_id = ?'), ['note-1']);
  });

  it('counts only queued (not errored) uploads', async () => {
    const db = makeDb({ getFirstAsync: jest.fn().mockResolvedValue({ count: 3 }) });
    const result = await getQueuedImageUploadCount(db as never);
    expect(result).toBe(3);
    expect(db.getFirstAsync).toHaveBeenCalledWith(expect.stringContaining("status = 'queued'"));
  });
});

describe('retryImageUpload / dismissImageUpload', () => {
  it('resets an errored upload to queued and notifies listeners', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);
    const db = makeDb();

    await retryImageUpload(db as never, 'upload-1');

    expect(db.runAsync).toHaveBeenCalledWith(expect.stringContaining("SET status = 'queued'"), ['upload-1']);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('deletes the row and its stable file copy', async () => {
    const db = makeDb({
      getFirstAsync: jest.fn().mockResolvedValue({ local_path: 'file:///docs/pending-image-uploads/upload-1' }),
    });

    await dismissImageUpload(db as never, 'upload-1');

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_image_uploads WHERE id = ?', ['upload-1']);
    expect(fs.files.has('file:///docs/pending-image-uploads/upload-1')).toBe(false);
  });

  it('is a no-op (beyond the delete statement) when the id is unknown', async () => {
    const db = makeDb({ getFirstAsync: jest.fn().mockResolvedValue(null) });

    await dismissImageUpload(db as never, 'missing');

    expect(fs.files.has('file:///docs/pending-image-uploads/upload-1')).toBe(true);
  });
});

describe('drainImageUploadQueue', () => {
  it('uploads queued entries, patches the local cache, and deletes the row + file', async () => {
    const entry = makeEntry();
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });
    const image = { id: 'img-1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: 'now' };
    mockUploadNoteImage.mockResolvedValueOnce(image);

    const result = await drainImageUploadQueue(db as never);

    expect(mockUploadNoteImage).toHaveBeenCalledWith('note-1', {
      uri: entry.local_path,
      name: entry.filename,
      mimeType: entry.mime_type,
      sizeBytes: entry.size_bytes,
    });
    expect(mockPatchLocalNoteImages).toHaveBeenCalledWith(db, 'note-1', expect.any(Function));
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_image_uploads WHERE id = ?', [entry.id]);
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: ['note-1'], discardedCount: 0 });
  });

  it('discards the entry even when the local-cache patch fails, so a retry cannot re-upload and duplicate the image', async () => {
    const entry = makeEntry();
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });
    const image = { id: 'img-1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: 'now' };
    mockUploadNoteImage.mockResolvedValueOnce(image);
    mockPatchLocalNoteImages.mockRejectedValueOnce(new Error('database is locked'));

    const result = await drainImageUploadQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_image_uploads WHERE id = ?', [entry.id]);
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: ['note-1'], discardedCount: 0 });
  });

  it('skips a note whose offline create has not drained yet, retrying it later', async () => {
    mockGetPendingCreateNoteIds.mockResolvedValueOnce(new Set(['note-1']));
    const entry = makeEntry();
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });

    const result = await drainImageUploadQueue(db as never);

    expect(mockUploadNoteImage).not.toHaveBeenCalled();
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('stops draining on a transient failure so the entry is retried next time', async () => {
    const entries = [makeEntry({ id: 'upload-1' }), makeEntry({ id: 'upload-2' })];
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue(entries) });
    const transientError = Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined });
    mockUploadNoteImage.mockRejectedValueOnce(transientError);

    const result = await drainImageUploadQueue(db as never);

    expect(mockUploadNoteImage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('charges the attempt counter and stops below the cap on a persistent 5xx (#714)', async () => {
    const entry = makeEntry({ id: 'up-5xx' });
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 503 } });
    mockUploadNoteImage.mockRejectedValueOnce(err);

    const result = await drainImageUploadQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('UPDATE pending_image_uploads SET attempts = ? WHERE id = ?', [1, 'up-5xx']);
    expect(db.runAsync).not.toHaveBeenCalledWith(expect.stringContaining("SET status = 'error'"), expect.anything());
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 0 });
  });

  it('flags a persistently-failing upload as errored at the cap and continues past it (#714)', async () => {
    const stuck = makeEntry({ id: 'up-stuck', note_id: 'n1', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 });
    const ok = makeEntry({ id: 'up-ok', note_id: 'n2' });
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([stuck, ok]) });
    const err = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 500 } });
    mockUploadNoteImage.mockRejectedValueOnce(err); // up-stuck hits the cap
    mockUploadNoteImage.mockResolvedValueOnce({ id: 'img1' }); // up-ok uploads fine

    const result = await drainImageUploadQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith(
      'UPDATE pending_image_uploads SET attempts = ? WHERE id = ?',
      [MAX_ENTRY_DRAIN_ATTEMPTS, 'up-stuck'],
    );
    expect(db.runAsync).toHaveBeenCalledWith(expect.stringContaining("SET status = 'error'"), ['Server Error', 'up-stuck']);
    // The drain continued past the flagged entry to the next upload.
    expect(mockUploadNoteImage).toHaveBeenCalledTimes(2);
    expect(result.uploadedNoteIds).toEqual(['n2']);
    expect(result.discardedCount).toBe(1);
  });

  it('flags a permanently-rejected upload as errored instead of discarding it silently', async () => {
    const entry = makeEntry();
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });
    const permanentError = Object.assign(new Error('Payload Too Large'), {
      isAxiosError: true,
      response: { status: 413 },
    });
    mockUploadNoteImage.mockRejectedValueOnce(permanentError);

    const result = await drainImageUploadQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'error'"),
      [permanentError.message, entry.id],
    );
    expect(fs.files.has('file:///docs/pending-image-uploads/upload-1')).toBe(true);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 1 });
  });

  it('drops the upload silently when the parent note is gone server-side (404)', async () => {
    const entry = makeEntry();
    const db = makeDb({ getAllAsync: jest.fn().mockResolvedValue([entry]) });
    const notFoundError = Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } });
    mockUploadNoteImage.mockRejectedValueOnce(notFoundError);

    const result = await drainImageUploadQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM pending_image_uploads WHERE id = ?', [entry.id]);
    expect(fs.files.has(entry.local_path)).toBe(false);
    expect(result).toEqual({ uploadedNoteIds: [], discardedCount: 1 });
  });
});
