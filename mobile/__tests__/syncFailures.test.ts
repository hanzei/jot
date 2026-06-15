/**
 * Tests for the MVP sync-failure resolution logic (issue #493): the human-readable
 * cause mapping, building a fork request from preserved local content, and the two
 * resolution paths — Discard (accept server state, drop the local change + dead
 * letter) and Keep-my-version (fork the content into a new note, then discard).
 */

import {
  buildCreateRequestFromNote,
  syncFailureCauseKey,
  reconcileDiscard,
  keepThenDiscard,
} from '../src/hooks/useSyncFailures';
import type { DeadLetteredOperation } from '../src/db/syncQueue';
import { getNote } from '../src/api/notes';
import type { Note } from '@jot/shared';

jest.mock('../src/api/notes', () => ({
  __esModule: true,
  getNote: jest.fn(),
}));

const mockGetNote = getNote as jest.MockedFunction<typeof getNote>;

function makeTextNote(id: string, content = 'hello'): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'text',
    content,
    color: '#ffcc00',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    labels: [{ id: 'l1', name: 'Work', user_id: 'u1', created_at: '', updated_at: '' }],
    shared_with: [],
  };
}

function makeListNote(id: string): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'list',
    title: 'Groceries',
    checked_items_collapsed: false,
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
    items: [
      { id: 'a', note_id: id, text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
      { id: 'b', note_id: id, text: 'Skim', completed: true, position: 1, parent_id: 'a', assigned_to: '', created_at: '', updated_at: '' },
    ],
  };
}

/** Mock db whose getFirstAsync resolves the given local note row (or null). */
function makeDb(localNote: Note | null) {
  const row = localNote
    ? {
        id: localNote.id,
        user_id: localNote.user_id,
        title: localNote.note_type === 'list' ? localNote.title : '',
        content: localNote.note_type === 'text' ? localNote.content : '',
        note_type: localNote.note_type,
        color: localNote.color,
        pinned: 0,
        archived: 0,
        position: 0,
        checked_items_collapsed: 0,
        is_shared: 0,
        deleted_at: null,
        created_at: '',
        updated_at: '',
        labels_json: JSON.stringify(localNote.labels),
        shared_with_json: '[]',
      }
    : null;
  return {
    getFirstAsync: jest.fn().mockResolvedValue(row),
    getAllAsync: jest.fn().mockResolvedValue(
      localNote && localNote.note_type === 'list'
        ? (localNote.items ?? []).map((i) => ({ ...i, completed: i.completed ? 1 : 0 }))
        : [],
    ),
    runAsync: jest.fn().mockResolvedValue(undefined),
    withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
  };
}

function runCalls(db: ReturnType<typeof makeDb>, prefix: string): unknown[][] {
  return db.runAsync.mock.calls
    .filter((c) => String(c[0]).startsWith(prefix))
    .map((c) => (c[1] as unknown[]) ?? []);
}

function dl(overrides: Partial<DeadLetteredOperation>): DeadLetteredOperation {
  return {
    id: 1,
    operation: 'update',
    endpoint: '/notes/n1',
    method: 'PATCH',
    body: null,
    status: 400,
    note_id: 'n1',
    created_at: '',
    failed_at: '',
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('syncFailureCauseKey', () => {
  it.each([
    [403, 'syncFailures.causeUnshared'],
    [404, 'syncFailures.causeDeleted'],
    [410, 'syncFailures.causeDeleted'],
    [400, 'syncFailures.causeInvalid'],
    [422, 'syncFailures.causeInvalid'],
    [409, 'syncFailures.causeUnknown'],
  ])('maps status %i to %s', (status, key) => {
    expect(syncFailureCauseKey(dl({ status }))).toBe(key);
  });
});

describe('buildCreateRequestFromNote', () => {
  it('builds a text-note request preserving content, color, and label names', () => {
    const req = buildCreateRequestFromNote(makeTextNote('n1', 'preserved bytes'));
    expect(req).toEqual({
      note_type: 'text',
      content: 'preserved bytes',
      color: '#ffcc00',
      labels: ['Work'],
    });
  });

  it('builds a list-note request mapping parent_id back to indent_level', () => {
    const req = buildCreateRequestFromNote(makeListNote('n1'));
    expect(req).toMatchObject({
      note_type: 'list',
      title: 'Groceries',
      items: [
        { text: 'Milk', position: 0, completed: false, indent_level: 0 },
        { text: 'Skim', position: 1, completed: true, indent_level: 1 },
      ],
    });
  });
});

describe('reconcileDiscard', () => {
  it('deletes the orphan local note and dead-letter row for a dead-lettered create (no server fetch)', async () => {
    const db = makeDb(makeTextNote('orphan'));
    await reconcileDiscard(db as never, dl({ id: 7, operation: 'create', note_id: 'orphan' }));

    expect(runCalls(db, 'DELETE FROM dead_letter')).toEqual([[7]]);
    expect(runCalls(db, 'DELETE FROM notes')).toEqual([['orphan']]);
    expect(mockGetNote).not.toHaveBeenCalled();
  });

  it('clears the failed flag and writes the fetched server note for an update failure', async () => {
    const db = makeDb(makeTextNote('n1'));
    mockGetNote.mockResolvedValueOnce(makeTextNote('n1', 'server version'));

    await reconcileDiscard(db as never, dl({ id: 3, operation: 'update', note_id: 'n1' }));

    expect(runCalls(db, 'DELETE FROM dead_letter')).toEqual([[3]]);
    expect(runCalls(db, `UPDATE notes SET sync_state = 'synced'`)).toEqual([['n1']]);
    expect(mockGetNote).toHaveBeenCalledWith('n1');
    // saveNote runs inside a transaction.
    expect(db.withTransactionAsync).toHaveBeenCalled();
  });

  it('tombstones the note locally when the server reports it gone', async () => {
    const db = makeDb(makeTextNote('n1'));
    mockGetNote.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { isAxiosError: true, response: { status: 404 } }),
    );

    await reconcileDiscard(db as never, dl({ id: 4, operation: 'update', note_id: 'n1' }));

    expect(runCalls(db, 'UPDATE notes SET deleted_at')).toEqual([
      [expect.any(String), 'n1'],
    ]);
  });

  it('only deletes the dead-letter row for a multi-note op with no single note', async () => {
    const db = makeDb(null);
    await reconcileDiscard(db as never, dl({ id: 9, operation: 'reorder', note_id: null }));

    expect(runCalls(db, 'DELETE FROM dead_letter')).toEqual([[9]]);
    expect(runCalls(db, 'DELETE FROM notes')).toHaveLength(0);
    expect(runCalls(db, `UPDATE notes SET sync_state = 'synced'`)).toHaveLength(0);
    expect(mockGetNote).not.toHaveBeenCalled();
  });

  it('removes the dead-letter row only after the note reconciliation, so a mid-step failure keeps it for retry', async () => {
    const db = makeDb(makeTextNote('n1'));
    mockGetNote.mockResolvedValueOnce(makeTextNote('n1', 'server'));
    await reconcileDiscard(db as never, dl({ id: 3, operation: 'update', note_id: 'n1' }));

    const order = (sqlPrefix: string) =>
      db.runAsync.mock.calls.findIndex((c) => String(c[0]).startsWith(sqlPrefix));
    // The dead-letter delete is the last write — it follows clearing the failed flag.
    expect(order('DELETE FROM dead_letter')).toBeGreaterThan(order(`UPDATE notes SET sync_state = 'synced'`));
  });
});

describe('keepThenDiscard', () => {
  it('forks the preserved content into a new note before discarding the orphan create', async () => {
    const db = makeDb(makeTextNote('orphan', 'my words'));
    const createNote = jest.fn().mockResolvedValue(makeTextNote('new'));

    await keepThenDiscard(db as never, dl({ id: 2, operation: 'create', note_id: 'orphan' }), createNote);

    // Forks first…
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({ note_type: 'text', content: 'my words' }),
    );
    // …then drops the original orphan + dead-letter row.
    expect(runCalls(db, 'DELETE FROM notes')).toEqual([['orphan']]);
    expect(runCalls(db, 'DELETE FROM dead_letter')).toEqual([[2]]);
  });

  it('does not discard the original if the fork fails (no lost bytes)', async () => {
    const db = makeDb(makeTextNote('n1'));
    const createNote = jest.fn().mockRejectedValue(new Error('create failed'));

    await expect(
      keepThenDiscard(db as never, dl({ id: 5, operation: 'update', note_id: 'n1' }), createNote),
    ).rejects.toThrow('create failed');

    expect(runCalls(db, 'DELETE FROM dead_letter')).toHaveLength(0);
  });
});
