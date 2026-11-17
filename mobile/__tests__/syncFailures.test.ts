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
import { getDeadLetteredOperations, type DeadLetteredOperation } from '../src/db/syncQueue';
import { getStoredLabels, saveNote, upsertLabel } from '../src/db/noteQueries';
import { insertKeys } from '../src/db/queueKeys';
import type { Note } from '@jot/shared';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot', () => ({
  jot: {
    notes: {
      getById: jest.fn(),
    },
    labels: {
      getAll: jest.fn(),
    },
  },
}));

const mockGetNote = jest.mocked(jot.notes.getById);
const mockGetLabels = jest.mocked(jot.labels.getAll);

function makeTextNote(id: string, content = 'hello'): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'text',
    version: 1,
    content,
    color: '#ffcc00',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    unread: null,
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
    version: 1,
    title: 'Groceries',
    checked_items_collapsed: false,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    unread: null,
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

  it('keeps a pinned note pinned in the fork', () => {
    expect(buildCreateRequestFromNote({ ...makeTextNote('n1'), pinned: true })).toMatchObject({ pinned: true });
    expect(buildCreateRequestFromNote({ ...makeListNote('n1'), pinned: true })).toMatchObject({ pinned: true });
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

  it('clears the failed flag on every note a multi-note op touched (reorder) then deletes the row', async () => {
    // A reorder dead-letters with note_id NULL but flags every listed note failed
    // (#492). Resolving the banner must clear all of those per-note badges —
    // otherwise they'd stay stuck until an unrelated write happened to touch each
    // note. No content is fetched/forked (there's no single note to reconcile).
    // Real SQLite: the notes come from the dead letter's recorded keys (#1282).
    const db = globalThis.testDb;
    for (const id of ['a', 'b', 'c']) {
      await saveNote(db, makeTextNote(id));
    }
    await db.runAsync(`UPDATE notes SET sync_state = 'failed'`);
    const { lastInsertRowId: dlId } = await db.runAsync(
      `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
       VALUES ('reorder', '/notes/reorder', 'POST', ?, 400, NULL, '', '')`,
      [JSON.stringify({ note_ids: ['a', 'b', 'c'] })],
    );
    await insertKeys(db, 'dead_letter_keys', dlId, { keys: ['note:a', 'note:b', 'note:c'] });
    const [row] = await getDeadLetteredOperations(db);

    await reconcileDiscard(db, row!);

    expect(await db.getAllAsync('SELECT id, sync_state FROM notes ORDER BY id')).toEqual([
      { id: 'a', sync_state: 'synced' },
      { id: 'b', sync_state: 'synced' },
      { id: 'c', sync_state: 'synced' },
    ]);
    expect(await getDeadLetteredOperations(db)).toEqual([]);
    expect(await db.getAllAsync('SELECT * FROM dead_letter_keys')).toEqual([]);
    expect(mockGetNote).not.toHaveBeenCalled();
  });

  it('only deletes the dead-letter row for an op that touches no note (e.g. settings)', async () => {
    const db = makeDb(null);
    await reconcileDiscard(
      db as never,
      dl({ id: 10, operation: 'updateSettings', endpoint: '/settings', method: 'PATCH', body: '{"theme":"dark"}', note_id: null }),
    );

    expect(runCalls(db, 'DELETE FROM dead_letter')).toEqual([[10]]);
    expect(runCalls(db, `UPDATE notes SET sync_state = 'synced'`)).toHaveLength(0);
    expect(runCalls(db, 'DELETE FROM notes')).toHaveLength(0);
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

describe('reconcileDiscard of a label write', () => {
  const serverLabel = (id: string, name: string) => ({ id, name, user_id: 'u1', created_at: '', updated_at: '', note_count: 0 });
  const storedNames = async () => (await getStoredLabels(globalThis.testDb)).map((l) => `${l.id}:${l.name}`);

  /** Records a dead letter for a label op, with its `label:` key, in the real test DB. */
  async function deadLetterFor(operation: string, labelId: string): Promise<DeadLetteredOperation> {
    const db = globalThis.testDb;
    const { lastInsertRowId } = await db.runAsync(
      `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
       VALUES (?, ?, 'POST', NULL, 400, NULL, '', '')`,
      [operation, `/labels/${labelId}`],
    );
    await insertKeys(db, 'dead_letter_keys', lastInsertRowId, { keys: [`label:${labelId}`] });
    const [row] = await getDeadLetteredOperations(db);
    return row!;
  }

  it.each<[string, string[], string[]]>([
    // The rejected rename's name goes back to the server's.
    ['renameLabel', ['l1:Mine'], ['l1:Theirs']],
    // The label a rejected delete hid comes back.
    ['deleteLabel', [], ['l1:Theirs']],
  ])('restores the server\'s label after a rejected %s', async (operation, before, after) => {
    const db = globalThis.testDb;
    for (const entry of before) {
      const [id, name] = entry.split(':') as [string, string];
      await upsertLabel(db, { id, name, user_id: 'u1', created_at: '', updated_at: '' });
    }
    mockGetLabels.mockResolvedValueOnce([serverLabel('l1', 'Theirs')]);

    await reconcileDiscard(db, await deadLetterFor(operation, 'l1'));

    expect(await storedNames()).toEqual(after);
    expect(await getDeadLetteredOperations(db)).toEqual([]);
  });

  it('drops a label whose rejected create the server never had', async () => {
    const db = globalThis.testDb;
    await upsertLabel(db, { id: 'l1', name: 'Mine', user_id: 'u1', created_at: '', updated_at: '' });
    mockGetLabels.mockResolvedValueOnce([]);

    await reconcileDiscard(db, await deadLetterFor('createLabel', 'l1'));

    expect(await storedNames()).toEqual([]);
  });

  it('still resolves the failure when the label list cannot be fetched', async () => {
    const db = globalThis.testDb;
    await upsertLabel(db, { id: 'l1', name: 'Mine', user_id: 'u1', created_at: '', updated_at: '' });
    mockGetLabels.mockRejectedValueOnce(new Error('Network Error'));

    await reconcileDiscard(db, await deadLetterFor('renameLabel', 'l1'));

    expect(await storedNames()).toEqual(['l1:Mine']);
    expect(await getDeadLetteredOperations(db)).toEqual([]);
  });

  it('does not re-read labels for any other op', async () => {
    await reconcileDiscard(makeDb(null) as never, dl({ id: 10, operation: 'updateSettings', note_id: null }));

    expect(mockGetLabels).not.toHaveBeenCalled();
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

  // Regression coverage for #834: a photo captured offline before the note's
  // own create was dead-lettered is still sitting in pending_image_uploads
  // against the orphan note id. "Keep my version" must move it to the fork
  // before reconcileDiscard deletes the orphan (ON DELETE CASCADE would
  // otherwise silently drop the still-queued image along with it).
  it("reassigns the orphan's queued image uploads to the fork before discarding it", async () => {
    const db = makeDb(makeTextNote('orphan', 'my words'));
    const createNote = jest.fn().mockResolvedValue(makeTextNote('new-note-id'));

    await keepThenDiscard(db as never, dl({ id: 2, operation: 'create', note_id: 'orphan' }), createNote);

    const reassignCalls = runCalls(db, 'UPDATE pending_image_uploads SET note_id');
    expect(reassignCalls).toEqual([['new-note-id', 'orphan']]);

    // The reassignment must run before the orphan note (and its FK-cascaded
    // pending_image_uploads rows) are deleted — otherwise there's nothing
    // left to reassign.
    const order = (sqlPrefix: string) =>
      db.runAsync.mock.calls.findIndex((c) => String(c[0]).startsWith(sqlPrefix));
    expect(order('UPDATE pending_image_uploads SET note_id')).toBeLessThan(order('DELETE FROM notes'));
  });

  it('does not reassign image uploads for a non-create failure (no orphan note to move them from)', async () => {
    const db = makeDb(makeTextNote('n1', 'my words'));
    const createNote = jest.fn().mockResolvedValue(makeTextNote('new-note-id'));
    mockGetNote.mockResolvedValueOnce(makeTextNote('n1', 'server version'));

    await keepThenDiscard(db as never, dl({ id: 5, operation: 'update', note_id: 'n1' }), createNote);

    expect(runCalls(db, 'UPDATE pending_image_uploads SET note_id')).toHaveLength(0);
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
