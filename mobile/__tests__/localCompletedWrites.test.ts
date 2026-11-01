import { getLocalNote, reconcileLocalItems, saveNote } from '../src/db/noteQueries';
import { localCompletedWrites } from '../src/db/localCompletedWrites';
import { makeListNote, makeNoteItem } from './helpers/fixtures';

// Server item snapshots written into SQLite go through localCompletedWrites:
// an item a toggle still in flight is writing keeps its local completed value,
// and a stale snapshot yields the newest value seen. Item ids are unique per
// test because the tracker is module-level.
const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-01T00:00:01Z';

async function seed(noteId: string, itemId: string, completed: boolean) {
  const db = globalThis.testDb;
  await saveNote(db, makeListNote({
    id: noteId,
    items: [makeNoteItem({ id: itemId, note_id: noteId, text: 'Milk', completed, updated_at: T0 })],
  }));
  return db;
}

async function localCompleted(noteId: string): Promise<boolean | undefined> {
  const note = await getLocalNote(globalThis.testDb, noteId);
  return note?.note_type === 'list' ? note.items?.[0]?.completed : undefined;
}

describe('completed-flag gate on server snapshots', () => {
  it('keeps the local value of an item a toggle is still writing, but takes every other field', async () => {
    const db = await seed('n1', 'gate-a', true);
    const write = localCompletedWrites.begin(new Map([['gate-a', false]]));

    // A queue drain's replay response, read before that toggle's write.
    await reconcileLocalItems(db, 'n1', [
      { ...makeNoteItem({ id: 'gate-a', note_id: 'n1', text: 'Oat milk', completed: false }), updated_at: T0 },
    ]);
    const note = await getLocalNote(db, 'n1');
    expect(note?.note_type === 'list' && note.items?.[0]).toMatchObject({ text: 'Oat milk', completed: true });

    localCompletedWrites.end(write);
  });

  it('answers a stale server note with the newest completed value seen', async () => {
    const db = await seed('n2', 'gate-b', true);
    const write = localCompletedWrites.begin(new Map([['gate-b', false]]));
    // The toggle's own response reports the item checked at T1...
    await reconcileLocalItems(db, 'n2', [makeNoteItem({ id: 'gate-b', note_id: 'n2', completed: true, updated_at: T1 })], write);
    localCompletedWrites.end(write);

    // ...then a background sync that fetched the note before that write lands.
    await saveNote(db, makeListNote({
      id: 'n2',
      items: [makeNoteItem({ id: 'gate-b', note_id: 'n2', completed: false, updated_at: T0 })],
    }), { serverSnapshot: true });
    expect(await localCompleted('n2')).toBe(true);
  });

  it('applies a server note as it stands when no local write is involved', async () => {
    const db = await seed('n3', 'gate-c', false);
    await saveNote(db, makeListNote({
      id: 'n3',
      items: [makeNoteItem({ id: 'gate-c', note_id: 'n3', completed: true, updated_at: T1 })],
    }), { serverSnapshot: true });
    expect(await localCompleted('n3')).toBe(true);
  });
});
