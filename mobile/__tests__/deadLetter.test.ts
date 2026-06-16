/**
 * Tests for dead-letter preservation of permanently-rejected sync ops (issue #492):
 * a dead-lettered op is persisted with its body + metadata, the affected note is
 * flagged `sync_state = 'failed'` and protected from being overwritten/pruned by a
 * background fetch or SSE event, the orphan-create case is distinguishable from a
 * synced note, 409 idempotent conflicts are not flagged, and a later successful
 * drain clears the failed flag.
 */

import {
  drainQueue,
  getProtectedNoteIds,
  getDeadLetteredOperations,
  saveServerNote,
} from '../src/db/syncQueue';
import { getFailedNoteIds } from '../src/db/noteQueries';
import api from '../src/api/client';
import type { Note } from '@jot/shared';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockApi = api as jest.Mocked<typeof api>;

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

function makeTextNote(id: string): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'text',
    content: 'body',
    version: 1,
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

type QueueRow = {
  id: number;
  operation: string;
  endpoint: string;
  method: string;
  body: string | null;
  created_at: string;
};

function makeDrainDb(entries: QueueRow[], opts: { versions?: Record<string, number> } = {}) {
  // Mutable per-note version store so the test can observe drainQueue resolving an
  // update's base_version from the local version and advancing it after each op.
  const versions: Record<string, number> = { ...opts.versions };
  return {
    getAllAsync: jest.fn().mockResolvedValue([...entries]),
    runAsync: jest.fn((sql: string, args?: unknown[]) => {
      if (typeof sql === 'string' && sql.startsWith('UPDATE notes SET version')) {
        // setLocalNoteVersion: args = [version, id]
        versions[args?.[1] as string] = args?.[0] as number;
      }
      return Promise.resolve(undefined);
    }),
    getFirstAsync: jest.fn((sql: string, args?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT version FROM notes')) {
        const id = args?.[0] as string;
        return Promise.resolve(id in versions ? { version: versions[id] } : null);
      }
      return Promise.resolve({ count: entries.length });
    }),
    withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
  };
}

/** runAsync calls whose SQL starts with `prefix`, as their bound-args arrays. */
function callsStartingWith(db: ReturnType<typeof makeDrainDb>, prefix: string): unknown[][] {
  return db.runAsync.mock.calls
    .filter((c) => String(c[0]).startsWith(prefix))
    .map((c) => (c[1] as unknown[]) ?? []);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── drainQueue: dead-letter persistence ─────────────────────────────────────

describe('drainQueue dead-letter persistence', () => {
  it('preserves a permanently-rejected op and flags the affected note as failed', async () => {
    const db = makeDrainDb([
      { id: 1, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: '{"content":"x"}', created_at: 't0' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(400));

    const { discardedOperations } = await drainQueue(db as never);

    // The op is preserved in the dead_letter table with its body + metadata.
    const inserts = callsStartingWith(db, 'INSERT INTO dead_letter');
    expect(inserts).toHaveLength(1);
    const [operation, endpoint, method, body, status, noteId, createdAt] = inserts[0];
    expect(operation).toBe('update');
    expect(endpoint).toBe('/notes/n1');
    expect(method).toBe('PATCH');
    expect(body).toBe('{"content":"x"}');
    expect(status).toBe(400);
    expect(noteId).toBe('n1');
    expect(createdAt).toBe('t0');

    // The affected note is flagged failed and removed from the queue.
    const failedMarks = callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`);
    expect(failedMarks).toEqual([['n1']]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [1]);

    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/n1', status: 400 }]);
  });

  it('flags a dead-lettered offline-create so its orphan local note is distinguishable from a synced one', async () => {
    const db = makeDrainDb([
      {
        id: 2,
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_orphan', title: 'x', content: '', note_type: 'text' }),
        created_at: 't0',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(422));

    await drainQueue(db as never);

    const failedMarks = callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`);
    expect(failedMarks).toEqual([['local_orphan']]);
    const inserts = callsStartingWith(db, 'INSERT INTO dead_letter');
    expect(inserts[0][5]).toBe('local_orphan'); // note_id column
  });

  it('stores a NULL note_id for a multi-note reorder but flags every listed note', async () => {
    const db = makeDrainDb([
      { id: 30, operation: 'reorder', endpoint: '/notes/reorder', method: 'POST', body: JSON.stringify({ note_ids: ['a', 'b', 'c'] }), created_at: 't0' },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(400));

    await drainQueue(db as never);

    const inserts = callsStartingWith(db, 'INSERT INTO dead_letter');
    expect(inserts[0][5]).toBeNull(); // note_id column: no single clear note
    expect(callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`)).toEqual([['a'], ['b'], ['c']]);
  });

  it('does not dead-letter or flag an idempotent 409 conflict', async () => {
    const db = makeDrainDb([
      { id: 3, operation: 'createItem', endpoint: '/notes/n1/items', method: 'POST', body: '{"id":"i1"}', created_at: 't0' },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db as never);

    expect(callsStartingWith(db, 'INSERT INTO dead_letter')).toHaveLength(0);
    expect(callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`)).toHaveLength(0);
    // Still discarded from the queue so it can't wedge the drain.
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [3]);
    expect(discardedOperations).toEqual([{ operation: 'createItem', endpoint: '/notes/n1/items', status: 409 }]);
  });

  it('dead-letters an update 409 (version conflict) instead of dropping it silently', async () => {
    // A 409 on an `update` is an optimistic-concurrency conflict: the note
    // changed on another device since base_version (#489). Unlike an idempotent
    // create/item 409, it must be preserved + flagged so the stale edit surfaces
    // in the failed-changes banner instead of being silently clobbered.
    const db = makeDrainDb(
      [{ id: 7, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: '{"content":"mine"}', created_at: 't0' }],
      { versions: { n1: 3 } },
    );
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db as never);

    const inserts = callsStartingWith(db, 'INSERT INTO dead_letter');
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe('update'); // operation column
    expect(inserts[0][4]).toBe(409); // status column
    expect(inserts[0][5]).toBe('n1'); // note_id column
    expect(callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`)).toEqual([['n1']]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [7]);
    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/n1', status: 409 }]);
  });

  it('resolves each queued update base_version from the advancing local version so a same-note chain does not self-conflict (#489)', async () => {
    // Two offline content edits to the same note (base local version 3). The first
    // drains, the server bumps to 4, and setLocalNoteVersion advances the local
    // version; the second must replay against 4, not the stale 3, or it would be
    // wrongly dead-lettered as a cross-device conflict. base_version is resolved at
    // drain time from the local version, not stored in the queued body.
    const db = makeDrainDb(
      [
        { id: 8, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: '{"content":"first"}', created_at: 't0' },
        { id: 9, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: '{"content":"second"}', created_at: 't1' },
      ],
      { versions: { n1: 3 } },
    );
    mockApi.patch
      .mockResolvedValueOnce({ data: { ...makeTextNote('n1'), version: 4 } } as never)
      .mockResolvedValueOnce({ data: { ...makeTextNote('n1'), version: 5 } } as never);

    await drainQueue(db as never);

    // First replays against the base version 3; second against the advanced 4.
    expect(mockApi.patch).toHaveBeenNthCalledWith(1, '/notes/n1', { content: 'first', base_version: 3 });
    expect(mockApi.patch).toHaveBeenNthCalledWith(2, '/notes/n1', { content: 'second', base_version: 4 });
    // Both drained cleanly — nothing dead-lettered or flagged failed.
    expect(callsStartingWith(db, 'INSERT INTO dead_letter')).toHaveLength(0);
    expect(callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`)).toHaveLength(0);
  });

  it('clears a prior failed flag when a later op for the note drains successfully', async () => {
    const db = makeDrainDb([
      { id: 4, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: '{"content":"y"}', created_at: 't0' },
    ]);
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    const cleared = callsStartingWith(db, `UPDATE notes SET sync_state = 'synced'`);
    expect(cleared).toEqual([['n1']]);
    expect(callsStartingWith(db, 'INSERT INTO dead_letter')).toHaveLength(0);
  });

  it('dead-letters using the id-remapped endpoint after an earlier create reconciled the local id', async () => {
    const serverNote = makeTextNote('server-1');
    const db = makeDrainDb([
      {
        id: 5,
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_a', title: 'x', content: '', note_type: 'text' }),
        created_at: 't0',
      },
      { id: 6, operation: 'update', endpoint: '/notes/local_a', method: 'PATCH', body: '{"content":"z"}', created_at: 't1' },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(403));

    await drainQueue(db as never);

    // The dead-lettered update is stored and flagged against the *server* id.
    const inserts = callsStartingWith(db, 'INSERT INTO dead_letter');
    expect(inserts[0][1]).toBe('/notes/server-1'); // endpoint column
    expect(inserts[0][5]).toBe('server-1'); // note_id column
    expect(callsStartingWith(db, `UPDATE notes SET sync_state = 'failed'`)).toEqual([['server-1']]);
  });
});

// ── getDeadLetteredOperations ───────────────────────────────────────────────

describe('getDeadLetteredOperations', () => {
  it('reads the dead_letter table oldest-first', async () => {
    const rows = [{ id: 1, operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: null, status: 400, note_id: 'n1', created_at: '', failed_at: '' }];
    const db = { getAllAsync: jest.fn().mockResolvedValue(rows) };
    const result = await getDeadLetteredOperations(db as never);
    expect(db.getAllAsync).toHaveBeenCalledWith('SELECT * FROM dead_letter ORDER BY id ASC');
    expect(result).toBe(rows);
  });
});

// ── failed-note overwrite protection ────────────────────────────────────────

describe('getFailedNoteIds / getProtectedNoteIds', () => {
  it('getFailedNoteIds returns the ids flagged failed', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]) };
    const ids = await getFailedNoteIds(db as never);
    expect(db.getAllAsync).toHaveBeenCalledWith(`SELECT id FROM notes WHERE sync_state = 'failed'`);
    expect(ids).toEqual(new Set(['f1', 'f2']));
  });

  it('getProtectedNoteIds unions pending-queue and failed notes', async () => {
    const db = {
      getAllAsync: jest.fn((sql: string) => {
        if (sql.includes('FROM sync_queue')) {
          return Promise.resolve([{ endpoint: '/notes/pending', body: null }]);
        }
        return Promise.resolve([{ id: 'failed' }]);
      }),
    };
    const ids = await getProtectedNoteIds(db as never);
    expect(ids).toEqual(new Set(['pending', 'failed']));
  });
});

describe('saveServerNote failed-note protection', () => {
  function makeDb(opts: { pending: { endpoint: string; body: string | null }[]; failed: { id: string }[] }) {
    return {
      getAllAsync: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('FROM sync_queue') ? opts.pending : opts.failed),
      ),
      runAsync: jest.fn().mockResolvedValue(undefined),
      withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
    };
  }

  it('does not overwrite a note that is flagged failed but has no pending queue op', async () => {
    const db = makeDb({ pending: [], failed: [{ id: 'n1' }] });
    await saveServerNote(db as never, makeTextNote('n1'));
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
  });

  it('persists a note that is neither pending nor failed', async () => {
    const db = makeDb({ pending: [], failed: [{ id: 'other' }] });
    await saveServerNote(db as never, makeTextNote('n1'));
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
  });
});
