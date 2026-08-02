/**
 * Tests for the pending-queue gate that stops a stale server fetch or SSE event
 * from transiently reverting an optimistic local edit before its queued op
 * drains (issue #487).
 */

import { getPendingNoteIds, saveServerNote, saveServerNotes, saveServerNotesScope } from '../src/db/syncQueue';
import { saveNote, saveNotes, removeLocalNotesNotIn } from '../src/db/noteQueries';
import { makeTextNote as buildTextNote } from './helpers/fixtures';
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

/** Queue a raw entry: these tests care about the endpoint/body, not the op name. */
const queue = (endpoint: string, body: unknown = null) =>
  db.runAsync(
    `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
     VALUES ('update', ?, 'PATCH', ?, '2026-01-01T00:00:00Z')`,
    [endpoint, body === null ? null : JSON.stringify(body)],
  );

// ── getPendingNoteIds ───────────────────────────────────────────────────────

describe('getPendingNoteIds', () => {
  it('returns an empty set when the queue is empty', async () => {
    expect((await getPendingNoteIds(db)).size).toBe(0);
  });

  it('extracts the note id from /notes/{id} update and delete endpoints', async () => {
    await queue('/notes/n1', { title: 'x' });
    await queue('/notes/n2');

    expect(await getPendingNoteIds(db)).toEqual(new Set(['n1', 'n2']));
  });

  it('strips a query string before extracting the id (permanent delete)', async () => {
    await queue('/notes/n3?permanent=true');

    expect(await getPendingNoteIds(db)).toEqual(new Set(['n3']));
  });

  it('extracts the note id from item, share, and label sub-resource endpoints', async () => {
    for (const endpoint of [
      '/notes/n1/items',
      '/notes/n2/items/i1',
      '/notes/n3/items/reorder',
      '/notes/n4/items/i1/toggle-completed',
      '/notes/n5/share',
      '/notes/n7/labels',
    ]) {
      await queue(endpoint, {});
    }
    await queue('/notes/n6/shares/u9');
    await queue('/notes/n8/labels/l1');

    expect(await getPendingNoteIds(db)).toEqual(
      new Set(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']),
    );
  });

  it('uses body.id for offline-create (POST /notes) entries', async () => {
    await queue('/notes', { id: 'ClientNoteId000000000A', title: 'x' });

    expect(await getPendingNoteIds(db)).toEqual(new Set(['ClientNoteId000000000A']));
  });

  it('tracks only the new id for a duplicate, not the source note it reads', async () => {
    await queue('/notes/src-1/duplicate', { id: 'DupClientId000000000A' });

    expect(await getPendingNoteIds(db)).toEqual(new Set(['DupClientId000000000A']));
  });

  it('expands body.note_ids for a /notes/reorder entry', async () => {
    await queue('/notes/reorder', { note_ids: ['a', 'b', 'c'] });

    expect(await getPendingNoteIds(db)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores label-only endpoints that are not tied to a single note', async () => {
    await queue('/labels', { local_id: 'local_l', name: 'Work' });
    await queue('/labels/l1', { name: 'Renamed' });

    expect((await getPendingNoteIds(db)).size).toBe(0);
  });

  it('tolerates malformed JSON bodies without throwing', async () => {
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('create', '/notes', 'POST', 'not-json', ''), ('update', '/notes/reorder', 'POST', 'not-json', '')`,
    );
    await queue('/notes/n1');

    expect(await getPendingNoteIds(db)).toEqual(new Set(['n1']));
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
    await queue('/notes/n1');

    await saveServerNote(db, makeTextNote('n1'));

    expect(await localNoteIds()).toEqual([]);
  });

  it('persists a single note with no pending op', async () => {
    await saveServerNote(db, makeTextNote('n1'));

    expect(await localNoteIds()).toEqual(['n1']);
  });

  it('skips only the pending notes in a batch and reads the protected set once', async () => {
    await queue('/notes/pending');
    db.getAllAsync.mockClear();

    await saveServerNotes(db, [makeTextNote('keep'), makeTextNote('pending')]);

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

    await saveServerNotes(db, [buildTextNote({ id: 'failed', content: 'server copy' })]);

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['failed'])).toEqual({
      content: 'unsent edit',
    });
  });
});

// ── saveServerNotesScope (save + prune, shared pending set) ─────────────────

describe('saveServerNotesScope', () => {
  it('persists fetched notes but skips ones with a pending op', async () => {
    await queue('/notes/pending');

    await saveServerNotesScope(db, [makeTextNote('keep'), makeTextNote('pending')]);

    expect(await localNoteIds()).toEqual(['keep']);
  });

  it('excludes a pending note from the scope-prune DELETE even when the server omits it', async () => {
    // 'restored' has a pending restore op and is absent from the server response;
    // pruning it would destroy the optimistic edit, so it must be excluded (#487).
    await saveNote(db, makeTextNote('restored'));
    await saveNote(db, makeTextNote('stale'));
    await queue('/notes/restored/restore');

    await saveServerNotesScope(db, [makeTextNote('on-server')]);

    // 'stale' is pruned; 'restored' survives on the strength of its queued op.
    expect(await localNoteIds()).toEqual(['on-server', 'restored']);
  });

  it('reads the pending queue only once for the whole reconcile', async () => {
    db.getAllAsync.mockClear();

    await saveServerNotesScope(db, [makeTextNote('a')]);

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
