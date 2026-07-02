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

const mockDeleteAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: (path: string, opts: unknown) => mockDeleteAsync(path, opts),
}));

function makeDb(pendingUploadRows: { local_path: string }[]) {
  return {
    getAllAsync: jest.fn().mockResolvedValue(pendingUploadRows),
    runAsync: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('deletes stable files for any queued offline uploads before deleting the note', async () => {
  const db = makeDb([
    { local_path: 'file:///docs/pending-image-uploads/upload-1' },
    { local_path: 'file:///docs/pending-image-uploads/upload-2' },
  ]);

  await permanentDeleteLocalNote(db as never, 'note-1');

  expect(db.getAllAsync).toHaveBeenCalledWith(
    'SELECT local_path FROM pending_image_uploads WHERE note_id = ?',
    ['note-1'],
  );
  expect(mockDeleteAsync).toHaveBeenCalledWith('file:///docs/pending-image-uploads/upload-1', { idempotent: true });
  expect(mockDeleteAsync).toHaveBeenCalledWith('file:///docs/pending-image-uploads/upload-2', { idempotent: true });
  expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['note-1']);
});

it('deletes the note with no extra file cleanup when nothing is queued for it', async () => {
  const db = makeDb([]);

  await permanentDeleteLocalNote(db as never, 'note-1');

  expect(mockDeleteAsync).not.toHaveBeenCalled();
  expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['note-1']);
});
