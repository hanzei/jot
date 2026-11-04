import { getLocalNote, reconcileLocalItems, saveNote } from '../src/db/noteQueries';
import { localCompletedWrites } from '../src/db/localCompletedWrites';
import { insertQueueEntry, reconcileServerItems, saveServerResponseNote } from '../src/db/syncQueue';
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

// A completed op that was queued (offline, or after a transient failure) has
// released its in-memory claim, but the server's copy of its items still
// predates it until it replays — so server writers that apply the rest of a
// snapshot keep those items' local completed value, read from the queue.
describe('completed values a queued op has yet to replay', () => {
  async function seedGroup(noteId: string) {
    const db = globalThis.testDb;
    // A parent checked offline, with its child cascaded; plus an unrelated item.
    await saveNote(db, makeListNote({
      id: noteId,
      items: [
        makeNoteItem({ id: `${noteId}-p`, note_id: noteId, completed: true }),
        makeNoteItem({ id: `${noteId}-c`, note_id: noteId, completed: true, parent_id: `${noteId}-p`, position: 1 }),
        makeNoteItem({ id: `${noteId}-x`, note_id: noteId, completed: false, position: 2 }),
      ],
    }));
    await insertQueueEntry(db, {
      operation: 'setItemsCompleted',
      endpoint: `/notes/${noteId}/items/set-completed`,
      method: 'POST',
      body: { item_ids: [`${noteId}-p`], completed: true },
    });
    return db;
  }

  async function completedById(noteId: string): Promise<Record<string, boolean>> {
    const note = await getLocalNote(globalThis.testDb, noteId);
    const out: Record<string, boolean> = {};
    for (const item of note?.note_type === 'list' ? note.items ?? [] : []) out[item.id] = item.completed;
    return out;
  }

  it('a server response note keeps the queued item and its cascade, and takes everything else', async () => {
    const db = await seedGroup('q1');
    // The reply to a title PATCH sent before the queued toggle replayed.
    await saveServerResponseNote(db, makeListNote({
      id: 'q1',
      items: [
        makeNoteItem({ id: 'q1-p', note_id: 'q1', completed: false }),
        makeNoteItem({ id: 'q1-c', note_id: 'q1', completed: false, parent_id: 'q1-p', position: 1 }),
        makeNoteItem({ id: 'q1-x', note_id: 'q1', completed: true, position: 2 }),
      ],
    }));
    expect(await completedById('q1')).toEqual({ 'q1-p': true, 'q1-c': true, 'q1-x': true });
  });

  it('a drain response applies its own op but keeps the items a later queued op still has to replay', async () => {
    const db = await seedGroup('q2');
    // Replaying an earlier op (entry id 0 stands for one not in the queue):
    // the parent's queued toggle is still pending, so its items stay checked.
    await reconcileServerItems(db, 'q2', [
      makeNoteItem({ id: 'q2-p', note_id: 'q2', completed: false }),
      makeNoteItem({ id: 'q2-c', note_id: 'q2', completed: false, parent_id: 'q2-p', position: 1 }),
      makeNoteItem({ id: 'q2-x', note_id: 'q2', completed: true, position: 2 }),
    ], { exceptEntryId: 0 });
    expect(await completedById('q2')).toEqual({ 'q2-p': true, 'q2-c': true, 'q2-x': true });

    // Replaying the toggle itself: its own response is authoritative, even where
    // it disagrees with the local rows.
    const entry = await db.getFirstAsync<{ id: number }>("SELECT id FROM sync_queue WHERE endpoint LIKE '/notes/q2/%'");
    await reconcileServerItems(db, 'q2', [
      makeNoteItem({ id: 'q2-p', note_id: 'q2', completed: false }),
      makeNoteItem({ id: 'q2-c', note_id: 'q2', completed: false, parent_id: 'q2-p', position: 1 }),
      makeNoteItem({ id: 'q2-x', note_id: 'q2', completed: true, position: 2 }),
    ], { exceptEntryId: entry!.id });
    expect(await completedById('q2')).toEqual({ 'q2-p': false, 'q2-c': false, 'q2-x': true });
  });
});
