import { createLocalItem, saveNote } from '../src/db/noteQueries';
import { makeListNote } from './helpers/fixtures';

describe('createLocalItem', () => {
  it("stores the wire format's '' parent_id as a top-level NULL", async () => {
    const db = globalThis.testDb;
    await saveNote(db, makeListNote({ id: 'n1' }));

    await createLocalItem(db, 'n1', { id: 'i1', text: 'a', completed: false, position: 0, parent_id: '', assigned_to: '' });

    expect(await db.getAllAsync('SELECT parent_id FROM note_items WHERE id = ?', ['i1'])).toEqual([{ parent_id: null }]);
  });
});
