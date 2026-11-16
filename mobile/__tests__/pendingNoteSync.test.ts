/**
 * Tests for the pending-queue gate that stops a stale server fetch or SSE event
 * from transiently reverting an optimistic local edit before its queued op
 * drains (issue #487).
 */

import { getPendingNoteIds, saveServerNote, saveServerNotes, saveServerNotesScope } from '../src/db/syncQueue';
import { snapshotMark } from '../src/db/snapshotGate';
import { saveNote, saveNotes, removeLocalNotesNotIn } from '../src/db/noteQueries';
import { labelKey, noteKey, SETTINGS_KEY } from '../src/db/queueKeys';
import { makeTextNote as buildTextNote, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

const makeTextNote = (id: string) => buildTextNote({ id, content: 'body', created_at: '', updated_at: '' });

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

const localNoteIds = async (): Promise<string[]> => {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM notes ORDER BY id');
  return rows.map((r) => r.id);
};

/** Queue an op on `noteId`: these tests care about its key, not the op. */
const queue = (noteId: string) =>
  seedQueueEntry(db, { operation: 'update', endpoint: `/notes/${noteId}`, method: 'PATCH', keys: [noteKey(noteId)] });

// ── getPendingNoteIds ───────────────────────────────────────────────────────

describe('getPendingNoteIds', () => {
  it('returns an empty set when the queue is empty', async () => {
    expect((await getPendingNoteIds(db)).size).toBe(0);
  });

  it('reads the note keys the queued ops recorded (#1282)', async () => {
    await queue('n1');
    await queue('n1');
    await seedQueueEntry(db, {
      operation: 'reorder',
      endpoint: '/notes/reorder',
      method: 'POST',
      body: { note_ids: ['a', 'b'] },
      keys: [noteKey('a'), noteKey('b')],
    });

    expect(await getPendingNoteIds(db)).toEqual(new Set(['n1', 'a', 'b']));
  });

  it('does not read endpoints or bodies', async () => {
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { title: 'x' }, keys: [] });

    expect((await getPendingNoteIds(db)).size).toBe(0);
  });

  it('ignores label and settings keys', async () => {
    await seedQueueEntry(db, { operation: 'createLabel', endpoint: '/labels', method: 'POST', body: { id: 'l0', name: 'Work' }, keys: [labelKey('l0')] });
    await seedQueueEntry(db, { operation: 'updateSettings', endpoint: '/users/me', method: 'PATCH', keys: [SETTINGS_KEY] });
    await seedQueueEntry(db, {
      operation: 'addLabelToNote',
      endpoint: '/notes/n1/labels',
      method: 'POST',
      body: { name: 'Work' },
      keys: [noteKey('n1'), labelKey('l0')],
    });

    expect(await getPendingNoteIds(db)).toEqual(new Set(['n1']));
  });

  it('drops a note once its last op leaves the queue', async () => {
    const id = await queue('n1');
    await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [id]);

    expect((await getPendingNoteIds(db)).size).toBe(0);
  });
});

// ── saveNote / saveNotes skipNoteIds ────────────────────────────────────────

describe('saveNote skipNoteIds', () => {
  it('persists a note that has no pending ops', async () => {
    await saveNote(db, makeTextNote('n1'), { skipNoteIds: new Set(['other']) });

    expect(await localNoteIds()).toEqual(['n1']);
  });

  it('skips a note whose id is in skipNoteIds', async () => {
    await saveNote(db, makeTextNote('n1'), { skipNoteIds: new Set(['n1']) });

    expect(await localNoteIds()).toEqual([]);
  });

  it('leaves an existing local row untouched when the note is skipped', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'local edit' }));

    await saveNote(db, makeTextNote('n1'), { skipNoteIds: new Set(['n1']) });

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'local edit',
    });
  });

  it('persists when no options are provided (queue-drain path)', async () => {
    await saveNote(db, makeTextNote('n1'));

    expect(await localNoteIds()).toEqual(['n1']);
  });
});

describe('saveNotes skipNoteIds', () => {
  it('persists only the notes that have no pending ops', async () => {
    await saveNotes(db, [makeTextNote('keep'), makeTextNote('pending'), makeTextNote('keep2')], {
      skipNoteIds: new Set(['pending']),
    });

    expect(await localNoteIds()).toEqual(['keep', 'keep2']);
  });

  it('persists every note when no skip set is provided', async () => {
    await saveNotes(db, [makeTextNote('a'), makeTextNote('b')]);

    expect(await localNoteIds()).toEqual(['a', 'b']);
  });
});

// ── saveServerNote / saveServerNotes (queue-aware writers) ──────────────────

describe('saveServerNote / saveServerNotes', () => {
  it('skips a single note that has a pending queue op, reading the queue itself', async () => {
    await queue('n1');

    await saveServerNote(db, makeTextNote('n1'), snapshotMark());

    expect(await localNoteIds()).toEqual([]);
  });

  it('persists a single note with no pending op', async () => {
    await saveServerNote(db, makeTextNote('n1'), snapshotMark());

    expect(await localNoteIds()).toEqual(['n1']);
  });

  it('skips only the pending notes in a batch and reads the protected set once', async () => {
    await queue('pending');
    db.getAllAsync.mockClear();

    await saveServerNotes(db, [makeTextNote('keep'), makeTextNote('pending')], snapshotMark());

    // The protected set is the pending-queue read plus the failed-notes read —
    // two reads total per batch, not one per note (which would be N+1).
    const protectedSetReads = db.getAllAsync.mock.calls.filter((c) =>
      /FROM sync_queue|FROM notes WHERE sync_state/.test(String(c[0])),
    );
    expect(protectedSetReads).toHaveLength(2);
    expect(await localNoteIds()).toEqual(['keep']);
  });

  it('skips a note flagged sync_state = failed', async () => {
    await saveNote(db, buildTextNote({ id: 'failed', content: 'unsent edit' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['failed']);

    await saveServerNotes(db, [buildTextNote({ id: 'failed', content: 'server copy' })], snapshotMark());

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['failed'])).toEqual({
      content: 'unsent edit',
    });
  });
});

// ── saveServerNotesScope (save + prune, shared pending set) ─────────────────

describe('saveServerNotesScope', () => {
  it('persists fetched notes but skips ones with a pending op', async () => {
    await queue('pending');

    await saveServerNotesScope(db, [makeTextNote('keep'), makeTextNote('pending')], undefined, snapshotMark());

    expect(await localNoteIds()).toEqual(['keep']);
  });

  it('excludes a pending note from the scope-prune DELETE even when the server omits it', async () => {
    // 'restored' has a pending restore op and is absent from the server response;
    // pruning it would destroy the optimistic edit, so it must be excluded (#487).
    await saveNote(db, makeTextNote('restored'));
    await saveNote(db, makeTextNote('stale'));
    await queue('restored');

    await saveServerNotesScope(db, [makeTextNote('on-server')], undefined, snapshotMark());

    // 'stale' is pruned; 'restored' survives on the strength of its queued op.
    expect(await localNoteIds()).toEqual(['on-server', 'restored']);
  });

  it('reads the pending queue only once for the whole reconcile', async () => {
    db.getAllAsync.mockClear();

    await saveServerNotesScope(db, [makeTextNote('a')], undefined, snapshotMark());

    const queueReads = db.getAllAsync.mock.calls.filter((c) => String(c[0]).includes('FROM sync_queue'));
    expect(queueReads).toHaveLength(1);
  });
});

// ── removeLocalNotesNotIn skipNoteIds ───────────────────────────────────────

describe('removeLocalNotesNotIn skipNoteIds', () => {
  it('excludes pending notes from the default-scope prune DELETE', async () => {
    await saveNote(db, makeTextNote('s1'));
    await saveNote(db, makeTextNote('p1'));
    await saveNote(db, makeTextNote('gone'));

    await removeLocalNotesNotIn(db, new Set(['s1']), undefined, { skipNoteIds: new Set(['p1']) });

    expect(await localNoteIds()).toEqual(['p1', 's1']);
  });

  it('does not delete a label-scoped note that has a pending op', async () => {
    await saveNote(
      db,
      buildTextNote({
        id: 'note-pending',
        labels: [{ id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }],
      }),
    );

    await removeLocalNotesNotIn(db, new Set<string>(), { label: 'l1' }, {
      skipNoteIds: new Set(['note-pending']),
    });

    expect(await localNoteIds()).toEqual(['note-pending']);
  });
});
