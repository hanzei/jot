/**
 * saveNoteInTx's item-sync step upserts incoming items and deletes only the
 * ones no longer present, rather than deleting the whole set and reinserting
 * it — so an item unchanged between two saves keeps its row identity instead
 * of being torn down and recreated (issue: reviewer follow-up on the
 * INSERT-OR-REPLACE fix in noteQueries.ts).
 */
import { saveNote } from '../src/db/noteQueries';
import { makeListNote, makeNoteItem } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

const itemRowid = async (itemId: string): Promise<number> => {
  const row = await db.getFirstAsync<{ rowid: number }>('SELECT rowid FROM note_items WHERE id = ?', [itemId]);
  if (!row) throw new Error(`item ${itemId} not found`);
  return row.rowid;
};

describe('saveNoteInTx note_items sync', () => {
  it('keeps an unchanged item\'s row identity across a resync instead of deleting and recreating it', async () => {
    const item1 = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'keep me' });
    const item2 = makeNoteItem({ id: 'i2', note_id: 'n1', text: 'also unchanged' });
    const note = makeListNote({ id: 'n1', items: [item1, item2] });
    await saveNote(db, note);
    const rowidBefore = await itemRowid('i1');

    // Resync with the same items (as a server-sourced refresh would send back
    // an unmodified note) plus one genuinely new item.
    const item3 = makeNoteItem({ id: 'i3', note_id: 'n1', text: 'new' });
    await saveNote(db, { ...note, items: [item1, item2, item3] });

    const rowidAfter = await itemRowid('i1');
    expect(rowidAfter).toBe(rowidBefore);

    const ids = (await db.getAllAsync<{ id: string }>('SELECT id FROM note_items WHERE note_id = ? ORDER BY id', ['n1']))
      .map((r) => r.id);
    expect(ids).toEqual(['i1', 'i2', 'i3']);
  });

  it('deletes only items no longer present in the incoming list', async () => {
    const item1 = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'stays' });
    const item2 = makeNoteItem({ id: 'i2', note_id: 'n1', text: 'removed' });
    const note = makeListNote({ id: 'n1', items: [item1, item2] });
    await saveNote(db, note);

    await saveNote(db, { ...note, items: [item1] });

    const ids = (await db.getAllAsync<{ id: string }>('SELECT id FROM note_items WHERE note_id = ?', ['n1']))
      .map((r) => r.id);
    expect(ids).toEqual(['i1']);
  });

  it('falls back to deleting the whole set when the note is synced with zero items', async () => {
    const item1 = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'only item' });
    const note = makeListNote({ id: 'n1', items: [item1] });
    await saveNote(db, note);

    await saveNote(db, { ...note, items: [] });

    const ids = await db.getAllAsync('SELECT id FROM note_items WHERE note_id = ?', ['n1']);
    expect(ids).toHaveLength(0);
  });
});
