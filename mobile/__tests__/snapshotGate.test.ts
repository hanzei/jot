/**
 * Tests for the write-landing gate: a server snapshot started before one of
 * this device's writes landed must not roll that note back, even once the
 * write's queue row is gone (issue #1265).
 */

import { applyServerRemoval, getSnapshotSkipNoteIds, saveServerNote, saveServerNotes, saveServerNotesScope } from '../src/db/syncQueue';
import { notesWrittenSince, recordWriteLanded, recordWriteResponse, snapshotMark } from '../src/db/snapshotGate';
import { removeLocalNotesNotIn, saveNote } from '../src/db/noteQueries';
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

  it('ignores reads, writes that touch no note, and viewed pings', () => {
    const mark = snapshotMark();

    // Marking a note read changes no content, and it fires as the editor opens
    // alongside the note's own refresh.
    recordWriteResponse('post', '/notes/opened/viewed', undefined);

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

  it("does not apply a stale snapshot's public link to a note this device wrote since", async () => {
    // A link this device created landed while the list was in flight; the
    // list still shows the note without one.
    const link = { token: 'tok', created_by: 'u1', created_at: '', expires_at: null };
    await saveNote(db, makeTextNote({ id: 'linked', public_link: link }));
    const since = snapshotMark();
    recordWriteLanded(['linked']);

    await saveServerNotesScope(db, [makeTextNote({ id: 'linked', public_link: null })], undefined, since);

    const row = await db.getFirstAsync<{ public_link_json: string | null }>(
      'SELECT public_link_json FROM notes WHERE id = ?',
      ['linked'],
    );
    expect(row?.public_link_json).not.toBeNull();
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

describe('applyServerRemoval (#1265)', () => {
  const deletedAt = async (id: string) =>
    (await db.getFirstAsync<{ deleted_at: string | null }>('SELECT deleted_at FROM notes WHERE id = ?', [id]));
  const queueUpdate = (id: string) =>
    db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('update', ?, 'PATCH', NULL, '')`,
      [`/notes/${id}`],
    );

  it('tombstones or deletes a note nothing protects', async () => {
    await saveNote(db, makeTextNote({ id: 'gone' }));
    await saveNote(db, makeTextNote({ id: 'unshared' }));

    expect(await applyServerRemoval(db, 'gone', snapshotMark(), 'tombstone')).toBe(true);
    expect(await applyServerRemoval(db, 'unshared', snapshotMark(), 'delete')).toBe(true);

    expect((await deletedAt('gone'))?.deleted_at).not.toBeNull();
    expect(await deletedAt('unshared')).toBeNull();
  });

  it('keeps a note this device wrote after the report was taken', async () => {
    // A restore landed after the 404 or the delete event was produced.
    await saveNote(db, makeTextNote({ id: 'restored' }));
    const since = snapshotMark();
    recordWriteLanded(['restored']);

    expect(await applyServerRemoval(db, 'restored', since, 'tombstone')).toBe(false);

    expect(await deletedAt('restored')).toEqual({ deleted_at: null });
  });

  it('reads the skip set when its transaction runs, not when it is called', async () => {
    await saveNote(db, makeTextNote({ id: 'x' }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withSerializedTransaction(db, () => gate);

    const removal = applyServerRemoval(db, 'x', snapshotMark(), 'delete');
    // A local edit is queued while the removal waits its turn.
    await queueUpdate('x');
    release();
    await held;

    expect(await removal).toBe(false);
    expect(await deletedAt('x')).toEqual({ deleted_at: null });
  });

  it('writes nothing when shouldApply turns false while it waits', async () => {
    await saveNote(db, makeTextNote({ id: 'x' }));
    let cancelled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withSerializedTransaction(db, () => gate);

    const removal = applyServerRemoval(db, 'x', snapshotMark(), 'tombstone', () => !cancelled);
    cancelled = true;
    release();
    await held;

    expect(await removal).toBe(false);
    expect(await deletedAt('x')).toEqual({ deleted_at: null });
  });

  describe('queued image uploads (#1279)', () => {
    const seedUpload = (id: string, noteId: string, status: 'queued' | 'error') =>
      db.runAsync(
        `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, status, created_at)
         VALUES (?, ?, ?, 'a.png', 'image/png', ?, '2026-01-01T00:00:00.000Z')`,
        [id, noteId, `/tmp/${id}`, status],
      );
    const noteExists = async (id: string) =>
      (await db.getFirstAsync('SELECT id FROM notes WHERE id = ?', [id])) !== null;
    const uploadExists = async (id: string) =>
      (await db.getFirstAsync('SELECT id FROM pending_image_uploads WHERE id = ?', [id])) !== null;

    it.each(['queued', 'error'] as const)('keeps a note with a %s upload when a scope sync omits it', async (status) => {
      await saveNote(db, makeTextNote({ id: 'photo-note' }));
      await saveNote(db, makeTextNote({ id: 'plain-note' }));
      await seedUpload('up-1', 'photo-note', status);

      await saveServerNotesScope(db, [], undefined, snapshotMark());

      expect(await noteExists('photo-note')).toBe(true);
      expect(await uploadExists('up-1')).toBe(true);
      expect(await noteExists('plain-note')).toBe(false);
    });

    it('removes the copied upload files of notes a prune deletes', async () => {
      const path = 'file:///docs/pending-image-uploads/up-2';
      globalThis.mockFileSystem.files.set(path, 'png-bytes');
      await saveNote(db, makeTextNote({ id: 'gone-note' }));
      await db.runAsync(
        `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, status, created_at)
         VALUES ('up-2', 'gone-note', ?, 'a.png', 'image/png', 'queued', '2026-01-01T00:00:00.000Z')`,
        [path],
      );

      await removeLocalNotesNotIn(db, new Set());

      expect(await noteExists('gone-note')).toBe(false);
      expect(globalThis.mockFileSystem.files.has(path)).toBe(false);
    });
  });
});
