/**
 * permanentDeleteLocalNote also cleans up stable file copies backing any
 * still-queued offline image upload for the note (issue #618): `ON DELETE
 * CASCADE` (migration4) removes the `pending_image_uploads` *rows*
 * automatically, but not the files those rows point at under
 * pending-image-uploads/ — left unhandled, hard-deleting a note (e.g.
 * emptying trash) while an offline image upload is still queued for it would
 * leak that file forever.
 */

import { permanentDeleteLocalNote, saveNote } from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

const fs = globalThis.mockFileSystem;

let db: TestDatabase;

beforeEach(() => {
  fs.reset();
  db = globalThis.testDb;
});

/** A note with one queued offline image upload per supplied path. */
async function seedNoteWithQueuedUploads(noteId: string, localPaths: string[]): Promise<void> {
  await saveNote(db, makeTextNote({ id: noteId }));
  for (let i = 0; i < localPaths.length; i++) {
    await db.runAsync(
      `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, created_at)
       VALUES (?, ?, ?, 'photo.jpg', 'image/jpeg', '2026-01-01T00:00:00Z')`,
      [`${noteId}-upload-${i}`, noteId, localPaths[i]],
    );
  }
}

it('deletes stable files for any queued offline uploads before deleting the note', async () => {
  const paths = [
    'file:///docs/pending-image-uploads/upload-1',
    'file:///docs/pending-image-uploads/upload-2',
  ];
  const unrelated = 'file:///docs/pending-image-uploads/upload-other';
  for (const path of [...paths, unrelated]) {
    fs.files.set(path, 'bytes');
  }
  await seedNoteWithQueuedUploads('note-1', paths);
  await seedNoteWithQueuedUploads('note-2', [unrelated]);

  await permanentDeleteLocalNote(db, 'note-1');

  expect(fs.files.has(paths[0]!)).toBe(false);
  expect(fs.files.has(paths[1]!)).toBe(false);
  // A file belonging to a different note is left alone.
  expect(fs.files.has(unrelated)).toBe(true);
  expect(await db.getAllAsync('SELECT id FROM notes ORDER BY id')).toEqual([{ id: 'note-2' }]);
});

it('cascades the queued upload rows away with the note', async () => {
  await seedNoteWithQueuedUploads('note-1', ['file:///docs/pending-image-uploads/upload-1']);

  await permanentDeleteLocalNote(db, 'note-1');

  // migration4's ON DELETE CASCADE, which only a real engine enforces.
  expect(await db.getAllAsync('SELECT id FROM pending_image_uploads')).toEqual([]);
});

it('deletes the note with no extra file cleanup when nothing is queued for it', async () => {
  await saveNote(db, makeTextNote({ id: 'note-1' }));

  await permanentDeleteLocalNote(db, 'note-1');

  expect(await db.getAllAsync('SELECT id FROM notes')).toEqual([]);
});

it('still deletes the note when a queued upload file is already gone', async () => {
  await seedNoteWithQueuedUploads('note-1', ['file:///docs/pending-image-uploads/missing']);

  await permanentDeleteLocalNote(db, 'note-1');

  expect(await db.getAllAsync('SELECT id FROM notes')).toEqual([]);
});

it('leaves other notes untouched', async () => {
  await saveNote(db, makeTextNote({ id: 'note-1' }));
  await saveNote(db, makeTextNote({ id: 'note-2' }));

  await permanentDeleteLocalNote(db, 'note-1');

  expect(await db.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'note-2' }]);
});
