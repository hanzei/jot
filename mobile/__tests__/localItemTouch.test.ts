import { deleteLocalItem, deleteLocalItems, saveNote, setLocalItemsCompleted } from '../src/db/noteQueries';
import { makeListNote, makeNoteItem } from './helpers/fixtures';

// A local item write bumps the note's updated_at only when it changed a row —
// as the server does (touchNoteIfChangedTx) — so a no-op does not move the note
// in "last modified" order.
const SEEDED_AT = '2026-01-01T00:00:00.000Z';

async function seed() {
  const db = globalThis.testDb;
  await saveNote(db, makeListNote({
    id: 'n1',
    updated_at: SEEDED_AT,
    items: [
      makeNoteItem({ id: 'a', note_id: 'n1', completed: true }),
      makeNoteItem({ id: 'b', note_id: 'n1', completed: false, position: 1 }),
    ],
  }));
  return db;
}

async function noteUpdatedAt(): Promise<string | undefined> {
  const row = await globalThis.testDb.getFirstAsync<{ updated_at: string }>('SELECT updated_at FROM notes WHERE id = ?', ['n1']);
  return row?.updated_at;
}

describe('local item writes touch the note only when they change something', () => {
  it('setLocalItemsCompleted leaves the note alone when every row is already at the value', async () => {
    const db = await seed();
    await setLocalItemsCompleted(db, 'n1', ['a'], true);
    expect(await noteUpdatedAt()).toBe(SEEDED_AT);
  });

  it('setLocalItemsCompleted touches the note when a row flips, and writes only the rows that flip', async () => {
    const db = await seed();
    await setLocalItemsCompleted(db, 'n1', ['a', 'b'], true);
    expect(await noteUpdatedAt()).not.toBe(SEEDED_AT);
    expect(await db.getAllAsync('SELECT id, completed FROM note_items WHERE note_id = ? ORDER BY id', ['n1'])).toEqual([
      { id: 'a', completed: 1 },
      { id: 'b', completed: 1 },
    ]);
  });

  it('deleting an item that is already gone leaves the note alone', async () => {
    const db = await seed();
    await deleteLocalItem(db, 'n1', 'missing');
    await deleteLocalItems(db, 'n1', ['missing', 'gone']);
    expect(await noteUpdatedAt()).toBe(SEEDED_AT);
  });

  it('deleting an existing item touches the note', async () => {
    const db = await seed();
    await deleteLocalItems(db, 'n1', ['missing', 'b']);
    expect(await noteUpdatedAt()).not.toBe(SEEDED_AT);
  });
});
