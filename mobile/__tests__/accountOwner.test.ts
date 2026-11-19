/**
 * Local data belongs to one account (issue #1264, spec §8.6): a different user
 * signing in wipes it, a deliberate logout wipes it, and an install that
 * predates the owner record is stamped rather than wiped.
 */

import { claimLocalData, getAccountOwner, getUnsyncedChangeCount, wipeLocalData } from '../src/db/accountOwner';
import { saveLabels, saveNote } from '../src/db/noteQueries';
import { saveUsers } from '../src/db/userQueries';
import { makeLabel, makeListNote, makeNoteItem, seedImageUpload, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

const fs = globalThis.mockFileSystem;
const TABLES = ['notes', 'note_items', 'labels', 'users', 'sync_queue', 'dead_letter', 'pending_image_uploads'];

const NOTE_IMAGE = 'file:///cache/note-images/image-1';
const PROFILE_ICON = 'file:///cache/profile-icons/user-a_2026-01-01';

let db: TestDatabase;

/** A cached note image and profile icon, as the image caches leave them on disk. */
function seedImageCaches(): void {
  fs.dirs.add('file:///cache/note-images');
  fs.dirs.add('file:///cache/profile-icons');
  fs.files.set(NOTE_IMAGE, 'png-bytes');
  fs.files.set(PROFILE_ICON, 'png-bytes');
}

function cachedImageFiles(): string[] {
  return [...fs.files.keys()].filter((uri) => uri.startsWith('file:///cache/'));
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

/**
 * One row in every account-data table, upload files included: a queued upload
 * (a sync queue row, #1288) and a failed one (`pending_image_uploads`).
 */
async function seedAccountData(): Promise<string[]> {
  await saveNote(db, makeListNote({ id: 'note-1', items: [makeNoteItem({ id: 'item-1', note_id: 'note-1' })] }));
  await saveLabels(db, [makeLabel({ id: 'label-1', name: 'Work' })]);
  await saveUsers(db, [{ id: 'user-a', username: 'alice', first_name: '', last_name: '', role: 'user', has_profile_icon: false }]);
  await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { title: 'x' } });
  await db.runAsync(
    `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
     VALUES ('update', '/notes/note-1', 'PATCH', '{}', 403, 'note-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  const queued = await seedImageUpload(db, { note_id: 'note-1' });
  const failed = await seedImageUpload(db, { id: 'upload-failed', note_id: 'note-1', status: 'error' });
  return [queued.local_path, failed.local_path];
}

beforeEach(() => {
  db = globalThis.testDb;
  fs.reset();
  silenceConsole('info', /wiped it before sign-in/);
});

describe('claimLocalData', () => {
  it('stamps an install with no recorded owner without wiping it', async () => {
    const uploadPaths = await seedAccountData();

    await expect(claimLocalData(db, 'user-a')).resolves.toBe(false);

    expect(await getAccountOwner(db)).toBe('user-a');
    expect(Object.values(await rowCounts()).every((count) => count > 0)).toBe(true);
    expect(uploadPaths.every((path) => fs.files.has(path))).toBe(true);
  });

  it('keeps the data when the owner signs back in', async () => {
    await claimLocalData(db, 'user-a');
    await seedAccountData();

    await expect(claimLocalData(db, 'user-a')).resolves.toBe(false);

    expect(await getUnsyncedChangeCount(db)).toBe(4);
  });

  it('keeps the image caches when the owner signs back in after a 401', async () => {
    await claimLocalData(db, 'user-a');
    seedImageCaches();

    await expect(claimLocalData(db, 'user-a')).resolves.toBe(false);

    expect(cachedImageFiles()).toEqual([NOTE_IMAGE, PROFILE_ICON]);
  });

  it('clears the image caches before another user takes over', async () => {
    await claimLocalData(db, 'user-a');
    seedImageCaches();

    await expect(claimLocalData(db, 'user-b')).resolves.toBe(true);

    expect(cachedImageFiles()).toEqual([]);
  });

  it('wipes every table and the queued upload files before another user takes over', async () => {
    await claimLocalData(db, 'user-a');
    const uploadPaths = await seedAccountData();
    // Another server's queued upload shares the directory and must survive.
    fs.files.set('file:///docs/pending-image-uploads/other-server', 'png-bytes');

    await expect(claimLocalData(db, 'user-b')).resolves.toBe(true);

    expect(await getAccountOwner(db)).toBe('user-b');
    expect(Object.values(await rowCounts())).toEqual(TABLES.map(() => 0));
    expect(uploadPaths.some((path) => fs.files.has(path))).toBe(false);
    expect(fs.files.has('file:///docs/pending-image-uploads/other-server')).toBe(true);
  });

  it('wipes again after a logout wipe, since a write in flight can land after it', async () => {
    await claimLocalData(db, 'user-a');
    await wipeLocalData(db);
    await saveNote(db, makeListNote({ id: 'late-response' }));

    await expect(claimLocalData(db, 'user-a')).resolves.toBe(true);

    expect((await rowCounts()).notes).toBe(0);
    expect(await getAccountOwner(db)).toBe('user-a');
  });
});

describe('wipeLocalData', () => {
  it('deletes all account data and leaves the database without an owner', async () => {
    await claimLocalData(db, 'user-a');
    const uploadPaths = await seedAccountData();

    await wipeLocalData(db);

    expect(Object.values(await rowCounts())).toEqual(TABLES.map(() => 0));
    expect(uploadPaths.some((path) => fs.files.has(path))).toBe(false);
    expect(await getAccountOwner(db)).toBe('');
  });

  it('clears the note image and profile icon caches', async () => {
    await claimLocalData(db, 'user-a');
    seedImageCaches();
    fs.files.set('file:///cache/exports/export.zip', 'zip-bytes');

    await wipeLocalData(db);

    expect(cachedImageFiles()).toEqual(['file:///cache/exports/export.zip']);
    expect(fs.dirs.has('file:///cache/note-images')).toBe(false);
    expect(fs.dirs.has('file:///cache/profile-icons')).toBe(false);
  });

  it('succeeds when the image caches were never created', async () => {
    await claimLocalData(db, 'user-a');

    await expect(wipeLocalData(db)).resolves.toBeUndefined();
  });
});

describe('getUnsyncedChangeCount', () => {
  it('counts queued writes, failed writes and image uploads', async () => {
    expect(await getUnsyncedChangeCount(db)).toBe(0);

    await seedAccountData();
    await seedImageUpload(db, { id: 'upload-2', note_id: 'note-1', status: 'error' });

    // Two queued ops (an edit, an upload), a dead letter and two failed uploads.
    expect(await getUnsyncedChangeCount(db)).toBe(5);
  });
});
