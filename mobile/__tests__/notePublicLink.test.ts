/**
 * A note's public link (#1135) is cached on the local note row, so the share
 * screen shows it offline and it survives every server snapshot write.
 */
import type { PublicLink } from '@jot/shared';
import { getAllLocalNotes, getLocalNote, getLocalNotes, saveNote, setLocalNotePublicLink } from '../src/db/noteQueries';
import { saveServerNote, saveServerNotesScope } from '../src/db/syncQueue';
import { migrateDatabase, MIGRATIONS } from '../src/db/schema';
import { makeListNote, makeTextNote } from './helpers/fixtures';
import { createTestDb, type TestDatabase } from './helpers/testDb';

const link: PublicLink = {
  token: 'q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw',
  created_by: 'u1',
  created_at: '2026-11-01T00:00:00Z',
  expires_at: '2026-12-01T00:00:00Z',
};

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

describe('note public link', () => {
  it('round-trips through the local store on text and list notes', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', public_link: link }));
    await saveNote(db, makeListNote({ id: 'n2', public_link: { ...link, created_by: null, expires_at: null } }));

    expect((await getLocalNote(db, 'n1'))?.public_link).toEqual(link);
    expect((await getLocalNote(db, 'n2'))?.public_link).toEqual({ ...link, created_by: null, expires_at: null });
  });

  it('is read back by the list queries too', async () => {
    await saveServerNotesScope(db, [makeTextNote({ id: 'n1', public_link: link })]);

    expect((await getLocalNotes(db)).find((n) => n.id === 'n1')?.public_link).toEqual(link);
    expect((await getAllLocalNotes(db)).find((n) => n.id === 'n1')?.public_link).toEqual(link);
  });

  it('reads as no link when the note has none or the field is absent', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', public_link: null }));
    await saveNote(db, makeTextNote({ id: 'n2' }));

    expect((await getLocalNote(db, 'n1'))?.public_link).toBeNull();
    expect((await getLocalNote(db, 'n2'))?.public_link).toBeNull();
  });

  it('takes the server value on the next snapshot, revoked included', async () => {
    await saveServerNote(db, makeTextNote({ id: 'n1', public_link: link }));
    await saveServerNote(db, makeTextNote({ id: 'n1', public_link: null }));

    expect((await getLocalNote(db, 'n1'))?.public_link).toBeNull();
  });

  it('takes the server link even for a note a pending edit protects', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', content: 'local edit' }));
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at) VALUES ('update', '/notes/n1', 'PATCH', '{}', '')`,
    );

    await saveServerNote(db, makeTextNote({ id: 'n1', content: 'server copy', public_link: link }));
    await saveServerNotesScope(db, [makeTextNote({ id: 'n1', content: 'server copy', public_link: null })]);
    expect(await getLocalNote(db, 'n1')).toMatchObject({ content: 'local edit', public_link: null });

    await saveServerNote(db, makeTextNote({ id: 'n1', content: 'server copy', public_link: link }));
    expect(await getLocalNote(db, 'n1')).toMatchObject({ content: 'local edit', public_link: link });
  });

  it('sets only the link, leaving the rest of the note alone', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', content: 'local edit', updated_at: '2026-11-02T00:00:00Z' }));

    await setLocalNotePublicLink(db, 'n1', link);
    const withLink = await getLocalNote(db, 'n1');
    expect(withLink?.public_link).toEqual(link);
    expect(withLink).toMatchObject({ content: 'local edit', updated_at: '2026-11-02T00:00:00Z' });

    await setLocalNotePublicLink(db, 'n1', null);
    expect((await getLocalNote(db, 'n1'))?.public_link).toBeNull();
  });

  it('adds the column to an existing install, whose notes start with no link', async () => {
    const legacy = createTestDb();
    for (let i = 0; i < MIGRATIONS.length - 1; i++) {
      await MIGRATIONS[i]!(legacy);
      await legacy.runAsync(`PRAGMA user_version = ${i + 1}`);
    }
    await legacy.runAsync(
      `INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('old', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    await migrateDatabase(legacy);

    expect((await getLocalNote(legacy, 'old'))?.public_link).toBeNull();
    await saveNote(legacy, makeTextNote({ id: 'old', public_link: link }));
    expect((await getLocalNote(legacy, 'old'))?.public_link).toEqual(link);
  });
});
