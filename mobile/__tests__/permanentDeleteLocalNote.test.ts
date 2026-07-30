/**
 * permanentDeleteLocalNote also cleans up stable file copies backing any
 * still-queued offline image upload for the note (issue #618): `ON DELETE
 * CASCADE` (migration4) removes the `pending_image_uploads` *rows*
 * automatically, but not the files those rows point at under
 * pending-image-uploads/ — left unhandled, hard-deleting a note (e.g.
 * emptying trash) while an offline image upload is still queued for it would
 * leak that file forever.
 */

import { permanentDeleteLocalNote } from '../src/db/noteQueries';

const fs = globalThis.mockFileSystem;

beforeEach(() => {
  fs.reset();
});

function makeDb(pendingUploadRows: { local_path: string }[]) {
  return {
    getAllAsync: jest.fn().mockResolvedValue(pendingUploadRows),
    runAsync: jest.fn().mockResolvedValue(undefined),
  };
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
  const db = makeDb(paths.map((local_path) => ({ local_path })));

  await permanentDeleteLocalNote(db as never, 'note-1');

  expect(db.getAllAsync).toHaveBeenCalledWith(
    'SELECT local_path FROM pending_image_uploads WHERE note_id = ?',
    ['note-1'],
  );
  expect(fs.files.has(paths[0])).toBe(false);
  expect(fs.files.has(paths[1])).toBe(false);
  // A file belonging to a different note is left alone.
  expect(fs.files.has(unrelated)).toBe(true);
  expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['note-1']);
});

it('deletes the note with no extra file cleanup when nothing is queued for it', async () => {
  const db = makeDb([]);

  await permanentDeleteLocalNote(db as never, 'note-1');

  expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['note-1']);
});

it('still deletes the note when a queued upload file is already gone', async () => {
  const db = makeDb([{ local_path: 'file:///docs/pending-image-uploads/missing' }]);

  await permanentDeleteLocalNote(db as never, 'note-1');

  expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['note-1']);
});
