/**
 * The server's per-user unread badge is cached on the local note row so the
 * list shows it offline, and cleared locally the moment the note is opened.
 */
import { clearLocalNoteUnread, getLocalNote, saveNote } from '../src/db/noteQueries';
import { makeListNote, makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

describe('note unread state', () => {
  it.each(['new', 'updated'] as const)('round-trips %s through the local store', async (unread) => {
    await saveNote(db, makeListNote({ id: 'n1', unread }));

    expect((await getLocalNote(db, 'n1'))?.unread).toBe(unread);
  });

  it('defaults to no badge', async () => {
    await saveNote(db, makeTextNote({ id: 'n1' }));

    expect((await getLocalNote(db, 'n1'))?.unread).toBeNull();
  });

  it('clears the badge locally', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', unread: 'updated' }));

    await clearLocalNoteUnread(db, 'n1');

    expect((await getLocalNote(db, 'n1'))?.unread).toBeNull();
  });

  it('takes the server value on the next save', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', unread: 'new' }));
    await saveNote(db, makeTextNote({ id: 'n1', unread: null }));

    expect((await getLocalNote(db, 'n1'))?.unread).toBeNull();
  });
});
