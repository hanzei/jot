/**
 * Tests for the pending-queue gate that stops a stale server fetch or SSE event
 * from transiently reverting an optimistic local edit before its queued op
 * drains (issue #487).
 */

import { getPendingNoteIds, saveServerNote, saveServerNotes, saveServerNotesScope } from '../src/db/syncQueue';
import { saveNote, saveNotes, removeLocalNotesNotIn } from '../src/db/noteQueries';
import type { Note } from '@jot/shared';

function makeTextNote(id: string): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'text',
    version: 1,
    content: 'body',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    labels: [],
    shared_with: [],
  };
}

// ── getPendingNoteIds ───────────────────────────────────────────────────────

describe('getPendingNoteIds', () => {
  function makeDb(entries: { endpoint: string; body: string | null }[]) {
    return { getAllAsync: jest.fn().mockResolvedValue(entries) };
  }

  it('returns an empty set when the queue is empty', async () => {
    const ids = await getPendingNoteIds(makeDb([]) as never);
    expect(ids.size).toBe(0);
  });

  it('extracts the note id from /notes/{id} update and delete endpoints', async () => {
    const db = makeDb([
      { endpoint: '/notes/n1', body: '{"title":"x"}' },
      { endpoint: '/notes/n2', body: null },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['n1', 'n2']));
  });

  it('strips a query string before extracting the id (permanent delete)', async () => {
    const db = makeDb([{ endpoint: '/notes/n3?permanent=true', body: null }]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['n3']));
  });

  it('extracts the note id from item, share, and label sub-resource endpoints', async () => {
    const db = makeDb([
      { endpoint: '/notes/n1/items', body: '{}' },
      { endpoint: '/notes/n2/items/i1', body: '{}' },
      { endpoint: '/notes/n3/items/reorder', body: '{}' },
      { endpoint: '/notes/n4/items/i1/toggle-completed', body: '{}' },
      { endpoint: '/notes/n5/share', body: '{}' },
      { endpoint: '/notes/n6/shares/u9', body: null },
      { endpoint: '/notes/n7/labels', body: '{}' },
      { endpoint: '/notes/n8/labels/l1', body: null },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']));
  });

  it('uses body.local_id for offline-create (POST /notes) entries', async () => {
    const db = makeDb([
      { endpoint: '/notes', body: JSON.stringify({ local_id: 'local_abc', title: 'x' }) },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['local_abc']));
  });

  it('tracks only the new local_id for a duplicate, not the source note it reads', async () => {
    const db = makeDb([
      { endpoint: '/notes/src-1/duplicate', body: JSON.stringify({ local_id: 'local_clone' }) },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['local_clone']));
  });

  it('expands body.note_ids for a /notes/reorder entry', async () => {
    const db = makeDb([
      { endpoint: '/notes/reorder', body: JSON.stringify({ note_ids: ['a', 'b', 'c'] }) },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores label-only endpoints that are not tied to a single note', async () => {
    const db = makeDb([
      { endpoint: '/labels', body: JSON.stringify({ local_id: 'local_l', name: 'Work' }) },
      { endpoint: '/labels/l1', body: '{"name":"Renamed"}' },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids.size).toBe(0);
  });

  it('tolerates malformed JSON bodies without throwing', async () => {
    const db = makeDb([
      { endpoint: '/notes', body: 'not-json' },
      { endpoint: '/notes/reorder', body: 'not-json' },
      { endpoint: '/notes/n1', body: null },
    ]);
    const ids = await getPendingNoteIds(db as never);
    expect(ids).toEqual(new Set(['n1']));
  });
});

// ── saveNote / saveNotes skipNoteIds ────────────────────────────────────────

describe('saveNote skipNoteIds', () => {
  function makeDb() {
    return {
      runAsync: jest.fn().mockResolvedValue(undefined),
      withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
    };
  }

  it('persists a note that has no pending ops', async () => {
    const db = makeDb();
    await saveNote(db as never, makeTextNote('n1'), { skipNoteIds: new Set(['other']) });
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(db.runAsync).toHaveBeenCalled();
  });

  it('skips a note whose id is in skipNoteIds', async () => {
    const db = makeDb();
    await saveNote(db as never, makeTextNote('n1'), { skipNoteIds: new Set(['n1']) });
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it('persists when no options are provided (queue-drain path)', async () => {
    const db = makeDb();
    await saveNote(db as never, makeTextNote('n1'));
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('saveNotes skipNoteIds', () => {
  function makeDb() {
    return {
      runAsync: jest.fn().mockResolvedValue(undefined),
      withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
    };
  }

  it('persists only the notes that have no pending ops', async () => {
    const db = makeDb();
    await saveNotes(
      db as never,
      [makeTextNote('keep'), makeTextNote('pending'), makeTextNote('keep2')],
      { skipNoteIds: new Set(['pending']) },
    );

    const savedIds = db.runAsync.mock.calls.map((call) => (call[1] as unknown[])[0]);
    expect(savedIds).toContain('keep');
    expect(savedIds).toContain('keep2');
    expect(savedIds).not.toContain('pending');
  });

  it('persists every note when no skip set is provided', async () => {
    const db = makeDb();
    await saveNotes(db as never, [makeTextNote('a'), makeTextNote('b')]);
    const savedIds = db.runAsync.mock.calls.map((call) => (call[1] as unknown[])[0]);
    expect(savedIds).toEqual(['a', 'b']);
  });
});

// ── saveServerNote / saveServerNotes (queue-aware writers) ──────────────────

describe('saveServerNote / saveServerNotes', () => {
  function makeDb(pendingEntries: { endpoint: string; body: string | null }[]) {
    return {
      getAllAsync: jest.fn().mockResolvedValue(pendingEntries),
      runAsync: jest.fn().mockResolvedValue(undefined),
      withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
    };
  }

  it('skips a single note that has a pending queue op, reading the queue itself', async () => {
    const db = makeDb([{ endpoint: '/notes/n1', body: null }]);
    await saveServerNote(db as never, makeTextNote('n1'));
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
  });

  it('persists a single note with no pending op', async () => {
    const db = makeDb([]);
    await saveServerNote(db as never, makeTextNote('n1'));
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
  });

  it('skips only the pending notes in a batch and reads the protected set once', async () => {
    const db = makeDb([{ endpoint: '/notes/pending', body: null }]);
    await saveServerNotes(db as never, [makeTextNote('keep'), makeTextNote('pending')]);

    // The protected set is the pending-queue read plus the failed-notes read —
    // two reads total per batch, not one per note (which would be N+1).
    expect(db.getAllAsync).toHaveBeenCalledTimes(2);
    const savedIds = db.runAsync.mock.calls.map((call) => (call[1] as unknown[])[0]);
    expect(savedIds).toContain('keep');
    expect(savedIds).not.toContain('pending');
  });
});

// ── saveServerNotesScope (save + prune, shared pending set) ─────────────────

describe('saveServerNotesScope', () => {
  function makeDb(pendingEntries: { endpoint: string; body: string | null }[]) {
    return {
      getAllAsync: jest.fn().mockResolvedValue(pendingEntries),
      runAsync: jest.fn().mockResolvedValue(undefined),
      withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
    };
  }

  const inserts = (db: ReturnType<typeof makeDb>) =>
    db.runAsync.mock.calls
      .filter((c) => String(c[0]).startsWith('INSERT OR REPLACE INTO notes'))
      .map((c) => (c[1] as unknown[])[0]);

  const deleteCall = (db: ReturnType<typeof makeDb>) =>
    db.runAsync.mock.calls.find((c) => String(c[0]).startsWith('DELETE FROM notes')) as
      | [string, string[]]
      | undefined;

  it('persists fetched notes but skips ones with a pending op', async () => {
    const db = makeDb([{ endpoint: '/notes/pending', body: null }]);
    await saveServerNotesScope(db as never, [makeTextNote('keep'), makeTextNote('pending')]);

    expect(inserts(db)).toContain('keep');
    expect(inserts(db)).not.toContain('pending');
  });

  it('excludes a pending note from the scope-prune DELETE even when the server omits it', async () => {
    // 'restored' has a pending restore op and is absent from the server response;
    // pruning it would destroy the optimistic edit, so it must be excluded (#487).
    const db = makeDb([{ endpoint: '/notes/restored/restore', body: null }]);
    await saveServerNotesScope(db as never, [makeTextNote('on-server')]);

    const call = deleteCall(db);
    expect(call).toBeDefined();
    const [, args] = call as [string, string[]];
    expect(args).toContain('on-server'); // protected because it's still on the server
    expect(args).toContain('restored'); // protected because it has a pending op
  });

  it('reads the pending queue only once for the whole reconcile', async () => {
    const db = makeDb([]);
    await saveServerNotesScope(db as never, [makeTextNote('a')]);
    const queueReads = db.getAllAsync.mock.calls.filter(
      (c) => String(c[0]).includes('FROM sync_queue'),
    );
    expect(queueReads).toHaveLength(1);
  });
});

// ── removeLocalNotesNotIn skipNoteIds ───────────────────────────────────────

describe('removeLocalNotesNotIn skipNoteIds', () => {
  it('excludes pending notes from the default-scope prune DELETE', async () => {
    const db = { runAsync: jest.fn().mockResolvedValue(undefined) };
    await removeLocalNotesNotIn(
      db as never,
      new Set(['s1']),
      undefined,
      { skipNoteIds: new Set(['p1']) },
    );
    const [sql, args] = db.runAsync.mock.calls[0] as [string, string[]];
    expect(sql).toContain('id NOT IN');
    expect(args).toContain('s1');
    expect(args).toContain('p1');
  });

  it('does not delete a label-scoped note that has a pending op', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { id: 'note-pending', labels_json: JSON.stringify([{ id: 'l1', name: 'Work' }]) },
      ]),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };
    await removeLocalNotesNotIn(
      db as never,
      new Set<string>(),
      { label: 'l1' },
      { skipNoteIds: new Set(['note-pending']) },
    );
    expect(db.runAsync).not.toHaveBeenCalled();
  });
});
