/**
 * Tests for the write-landing gate: a server snapshot started before one of
 * this device's writes landed must not roll that note back, even once the
 * write's queue row is gone (issue #1265).
 */

import { getSnapshotSkipNoteIds, saveServerNote, saveServerNotes, saveServerNotesScope } from '../src/db/syncQueue';
import { notesWrittenSince, recordWriteLanded, recordWriteResponse, snapshotMark } from '../src/db/snapshotGate';
import { saveNote } from '../src/db/noteQueries';
import { withSerializedTransaction } from '../src/db/transaction';
import { makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

const contentOf = async (id: string) =>
  (await db.getFirstAsync<{ content: string; version: number }>('SELECT content, version FROM notes WHERE id = ?', [id]));

describe('snapshotGate', () => {
  it('reports only the notes written after the mark', () => {
    recordWriteLanded(['before']);
    const mark = snapshotMark();
    expect(notesWrittenSince(mark)).toEqual(new Set());

    recordWriteLanded(['after-1', 'after-2']);

    expect(notesWrittenSince(mark)).toEqual(new Set(['after-1', 'after-2']));
    expect(notesWrittenSince(snapshotMark())).toEqual(new Set());
  });

  it('records the notes of a successful write from its method, url, and serialized body', () => {
    const mark = snapshotMark();

    recordWriteResponse('patch', '/notes/patched', JSON.stringify({ content: 'x' }));
    recordWriteResponse('post', '/notes', JSON.stringify({ id: 'created', note_type: 'text' }));
    recordWriteResponse('post', '/notes/item-note/items', '{"text":"milk"}');
    recordWriteResponse('delete', '/notes/gone?permanent=true', undefined);

    expect(notesWrittenSince(mark)).toEqual(new Set(['patched', 'created', 'item-note', 'gone']));
  });

  it('ignores reads and writes that touch no note', () => {
    const mark = snapshotMark();

    recordWriteResponse('get', '/notes/read', undefined);
    recordWriteResponse('post', '/labels', JSON.stringify({ name: 'x' }));
    recordWriteResponse('patch', '/users/me/settings', 'not json');

    expect(snapshotMark()).toBe(mark);
  });
});

describe('server snapshot writers (#1265)', () => {
  it('keeps the drained edit when a list fetched before it landed is saved after its queue row is gone', async () => {
    // The drain's PATCH landed (version 2) and its queue row is deleted, but the
    // list response was built before the PATCH reached the server.
    await saveNote(db, makeTextNote({ id: 'x', content: 'edited', version: 2 }));
    const since = snapshotMark();
    recordWriteLanded(['x']);

    await saveServerNotesScope(db, [makeTextNote({ id: 'x', content: 'pre-edit', version: 1 })], undefined, since);

    expect(await contentOf('x')).toEqual({ content: 'edited', version: 2 });
  });

  it('does not prune a note a write landed on after the scope fetch started', async () => {
    // A restore landed while the trash-less list was in flight, so the list
    // omits the note it just restored.
    await saveNote(db, makeTextNote({ id: 'restored' }));
    const since = snapshotMark();
    recordWriteLanded(['restored']);

    await saveServerNotesScope(db, [], undefined, since);

    expect(await contentOf('restored')).not.toBeNull();
  });

  it('applies a snapshot started after the landing', async () => {
    await saveNote(db, makeTextNote({ id: 'x', content: 'edited', version: 2 }));
    recordWriteLanded(['x']);
    const since = snapshotMark();

    await saveServerNote(db, makeTextNote({ id: 'x', content: 'from another device', version: 3 }), since);

    expect(await contentOf('x')).toEqual({ content: 'from another device', version: 3 });
  });

  it('skips only the notes written since the mark', async () => {
    await saveNote(db, makeTextNote({ id: 'written', content: 'local' }));
    await saveNote(db, makeTextNote({ id: 'other', content: 'local' }));
    const since = snapshotMark();
    recordWriteLanded(['written']);

    await saveServerNotes(
      db,
      [makeTextNote({ id: 'written', content: 'stale' }), makeTextNote({ id: 'other', content: 'server' })],
      since,
    );

    expect(await contentOf('written')).toMatchObject({ content: 'local' });
    expect(await contentOf('other')).toMatchObject({ content: 'server' });
  });

  it('getSnapshotSkipNoteIds joins the protected set with the landings', async () => {
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('update', '/notes/queued', 'PATCH', NULL, '')`,
    );
    const since = snapshotMark();
    recordWriteLanded(['landed']);

    expect(await getSnapshotSkipNoteIds(db, since)).toEqual(new Set(['queued', 'landed']));
  });

  it('reads the protected set when its transaction runs, not when the save is called', async () => {
    await saveNote(db, makeTextNote({ id: 'x', content: 'local' }));
    // Hold the write chain so the save has to wait its turn.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withSerializedTransaction(db, () => gate);

    const save = saveServerNote(db, makeTextNote({ id: 'x', content: 'server' }), snapshotMark());
    // A local edit is queued while the save waits.
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('update', '/notes/x', 'PATCH', NULL, '')`,
    );
    release();
    await held;
    await save;

    expect(await contentOf('x')).toMatchObject({ content: 'local' });
  });
});
