/**
 * getNextLocalPinnedPosition places an offline pinned create where the server
 * puts a pinned `POST /notes`: after the last active pinned note.
 */

import { getNextLocalPinnedPosition, saveNote } from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';

it('is 0 when nothing is pinned', async () => {
  await saveNote(globalThis.testDb, makeTextNote({ id: 'unpinned', position: 7 }));

  expect(await getNextLocalPinnedPosition(globalThis.testDb)).toBe(0);
});

it('is one past the last active pinned note, ignoring archived and trashed ones', async () => {
  const db = globalThis.testDb;
  await saveNote(db, makeTextNote({ id: 'p1', pinned: true, position: 0 }));
  await saveNote(db, makeTextNote({ id: 'p2', pinned: true, position: 2 }));
  await saveNote(db, makeTextNote({ id: 'unpinned', position: 9 }));
  await saveNote(db, makeTextNote({ id: 'archived', pinned: true, archived: true, position: 5 }));
  await saveNote(db, makeTextNote({ id: 'trashed', pinned: true, position: 6, deleted_at: '2026-01-01T00:00:00Z' }));

  expect(await getNextLocalPinnedPosition(db)).toBe(3);
});
