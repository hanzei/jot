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
  saveServerResponseNote,
  QUEUED_WRITE_TIMEOUT_MS,
} from '../src/db/syncQueue';
import { reconcileDiscard } from '../src/hooks/useSyncFailures';
import { notesWrittenSince, snapshotMark } from '../src/db/snapshotGate';
import { getFailedNoteIds, getLocalNote, saveNote } from '../src/db/noteQueries';
import { insertKeys, legacyQueueKeys } from '../src/db/queueKeys';
import api from '../src/api/client';
import { makeTextNote as buildTextNote, remainingQueueIds, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockApi = api as jest.Mocked<typeof api>;
// Every replayed queue write carries the longer queued-write timeout (#1211).
const REPLAY_CONFIG = { timeout: QUEUED_WRITE_TIMEOUT_MS };

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

const makeTextNote = (id: string) => buildTextNote({ id, content: 'body', created_at: '', updated_at: '' });

let db: TestDatabase;

beforeEach(() => {
  jest.clearAllMocks();
  db = globalThis.testDb;
  // drainQueue logs every retry, discard and dead-letter decision; these suites
  // drive exactly those paths.
  silenceConsole('warn', /^Discarding queued operation/, /^Dead-lettering queued operation/);
  silenceConsole('info', /^Dropping queued operation/);
  // A drain pulls the notes its landed writes touched (#1262); here that pull
  // gets a 404, which is logged and ignored.
  mockApi.get.mockRejectedValue(makeAxiosError(404));
  silenceConsole('warn', /^Failed to pull note id=\S+ after the queue drain: Request failed with status code 404$/);
});

/** Seed a local note at a known optimistic-concurrency version. */
async function seedNoteAtVersion(id: string, version: number): Promise<void> {
  await saveNote(db, buildTextNote({ id, version }));
}

const deadLetters = () => getDeadLetteredOperations(db);

const failedNoteIds = async (): Promise<string[]> => [...(await getFailedNoteIds(db))].sort();

const syncStateOf = async (id: string): Promise<string | undefined> => {
  const row = await db.getFirstAsync<{ sync_state: string }>(
    'SELECT sync_state FROM notes WHERE id = ?',
    [id],
  );
  return row?.sync_state;
};

// ── drainQueue: dead-letter persistence ─────────────────────────────────────

describe('drainQueue dead-letter persistence', () => {
  it('preserves a permanently-rejected op and flags the affected note as failed', async () => {
    await seedNoteAtVersion('n1', 1);
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/n1',
      method: 'PATCH',
      body: { content: 'x' },
      created_at: 't0',
    });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(400));

    const { discardedOperations } = await drainQueue(db);

    // The op is preserved in the dead_letter table with its body + metadata.
    expect(await deadLetters()).toMatchObject([
      {
        operation: 'update',
        endpoint: '/notes/n1',
        method: 'PATCH',
        body: JSON.stringify({ content: 'x', base_version: 1 }),
        status: 400,
        note_id: 'n1',
        created_at: 't0',
      },
    ]);

    // The affected note is flagged failed and removed from the queue.
    expect(await failedNoteIds()).toEqual(['n1']);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/n1', status: 400 }]);
  });

  it('flags a dead-lettered offline-create so its orphan local note is distinguishable from a synced one', async () => {
    const orphanId = 'ClientNoteId000000000A';
    await saveNote(db, buildTextNote({ id: orphanId }));
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: orphanId, title: 'x', content: '', note_type: 'text' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(422));

    await drainQueue(db);

    expect(await failedNoteIds()).toEqual([orphanId]);
    expect(await deadLetters()).toMatchObject([{ note_id: orphanId }]);
  });

  it('carries the entry\'s keys over to the dead letter (#1282)', async () => {
    await saveNote(db, buildTextNote({ id: 'a' }));
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: 'a', note_type: 'text', content: 'x', labels: ['Work'] },
      keys: ['note:a', 'label:l1'],
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(400));

    await drainQueue(db);

    expect(await db.getAllAsync('SELECT key FROM dead_letter_keys ORDER BY key')).toEqual([
      { key: 'label:l1' },
      { key: 'note:a' },
    ]);
    expect(await db.getAllAsync('SELECT * FROM sync_queue_keys')).toEqual([]);
    // Once the failed flag is cleared, the dead letter's keys alone protect it.
    await db.runAsync(`UPDATE notes SET sync_state = 'synced'`);
    expect(await getProtectedNoteIds(db)).toEqual(new Set(['a']));
  });

  it('links and flags only the clone of a dead-lettered duplicate, not its source (#1282)', async () => {
    await saveNote(db, buildTextNote({ id: 'src' }));
    await saveNote(db, buildTextNote({ id: 'clone' }));
    await seedQueueEntry(db, {
      operation: 'duplicate',
      endpoint: '/notes/src/duplicate',
      method: 'POST',
      body: { id: 'clone' },
      keys: ['note:clone'],
      readKeys: ['note:src'],
    });
    // The source it only reads is not protected while it is queued.
    expect(await getProtectedNoteIds(db)).toEqual(new Set(['clone']));
    mockApi.post.mockRejectedValueOnce(makeAxiosError(400));

    await drainQueue(db);

    expect(await deadLetters()).toMatchObject([{ operation: 'duplicate', note_id: 'clone' }]);
    expect(await failedNoteIds()).toEqual(['clone']);
    expect(await getProtectedNoteIds(db)).toEqual(new Set(['clone']));
    // The dead letter keeps the source as a read-only key.
    expect(await db.getAllAsync('SELECT key, read_only FROM dead_letter_keys ORDER BY key')).toEqual([
      { key: 'note:clone', read_only: 0 },
      { key: 'note:src', read_only: 1 },
    ]);
  });

  it('applies the response to a write on a note a queued duplicate only reads (#1282)', async () => {
    await saveNote(db, buildTextNote({ id: 'src', content: 'local' }));
    await seedQueueEntry(db, {
      operation: 'duplicate',
      endpoint: '/notes/src/duplicate',
      method: 'POST',
      body: { id: 'clone' },
      keys: ['note:clone'],
      readKeys: ['note:src'],
    });

    expect(await saveServerResponseNote(db, buildTextNote({ id: 'src', content: 'server', version: 2 }))).toBe(true);
    expect(await db.getFirstAsync('SELECT content, version FROM notes WHERE id = ?', ['src'])).toEqual({
      content: 'server',
      version: 2,
    });
  });

  it('does not dead-letter or flag an idempotent 409 conflict', async () => {
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, {
      operation: 'createItem',
      endpoint: '/notes/n1/items',
      method: 'POST',
      body: { id: 'i1' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    // Still discarded from the queue so it can't wedge the drain.
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'createItem', endpoint: '/notes/n1/items', status: 409 }]);
  });

  it.each([
    ['delete', '/notes/n1', 'DELETE'],
    ['permanentDelete', '/notes/n1?permanent=true', 'DELETE'],
    ['deleteItem', '/notes/n1/items/i1', 'DELETE'],
    ['restore', '/notes/n1/restore', 'POST'],
    ['unshare', '/notes/n1/shares/u2', 'DELETE'],
    ['removeLabelFromNote', '/notes/n1/labels/l1', 'DELETE'],
    ['deleteLabel', '/labels/l1', 'DELETE'],
  ])('treats a 404 replay of %s as an idempotent success (no dead-letter, no failed flag)', async (operation, endpoint, method) => {
    // The common flaky-connection case: the original online write timed out
    // client-side after the server committed it, fell back to the queue, and the
    // replay now finds the target already gone/restored → 404. The desired
    // end-state already holds, so it must not dead-letter or flag the note as
    // failed (which would surface a spurious banner and, for a delete, offer to
    // resurrect the just-deleted note).
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, {
      operation: operation as never,
      endpoint,
      method: method as never,
    });
    if (method === 'DELETE') mockApi.delete.mockRejectedValueOnce(makeAxiosError(404));
    else mockApi.post.mockRejectedValueOnce(makeAxiosError(404));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    // Still removed from the queue (and reported as discarded for logging).
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation, endpoint, status: 404 }]);
  });

  it('treats a 410 (gone) replay of a destructive op as idempotent too', async () => {
    // targetGone covers 410 alongside 404, so a resource reported permanently
    // gone resolves the same way as a 404.
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/n1', method: 'DELETE' });
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(410));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'delete', endpoint: '/notes/n1', status: 410 }]);
  });

  it('resolves a permanently-rejected removeImage silently regardless of status (issue #618)', async () => {
    // Unlike every other operation, a queued image delete never dead-letters:
    // the note-content "Keep my version" fork is a meaningless response to a
    // failed image removal, and a background sync/SSE event reconciles the
    // note's images either way (§6's fail-safe design).
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, {
      operation: 'removeImage',
      endpoint: '/images/img1',
      method: 'DELETE',
      body: { note_id: 'n1' },
    });
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(403));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'removeImage', endpoint: '/images/img1', status: 403 }]);
  });

  it('records the landing of a replayed removeImage, whose request names no note (#1265)', async () => {
    // The DELETE goes out without a body, so only the drain knows its note: a
    // snapshot fetched before the delete must not bring the image back.
    await seedQueueEntry(db, {
      operation: 'removeImage',
      endpoint: '/images/img1',
      method: 'DELETE',
      body: { note_id: 'n1' },
    });
    mockApi.delete.mockResolvedValueOnce({ data: null } as never);
    const since = snapshotMark();

    await drainQueue(db);

    expect(notesWrittenSince(since)).toEqual(new Set(['n1']));
  });

  it('records the landing of a create resolved as an already-applied 409 (#1265)', async () => {
    // The original POST landed unseen, so the API client never recorded it; the
    // queue row was the only gate, and it is about to go.
    await saveNote(db, makeTextNote('created'));
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: 'created', note_type: 'text' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));
    const since = snapshotMark();

    await drainQueue(db);

    expect(notesWrittenSince(since)).toEqual(new Set(['created']));
  });

  it('leaves a successful replay to the API client, which already recorded it (#1265)', async () => {
    // Recording it again at row deletion would skip a snapshot fetched between
    // the response and the delete, which already holds the write.
    await saveNote(db, makeTextNote('n1'));
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/n1',
      method: 'PATCH',
      body: { pinned: true },
    });
    mockApi.patch.mockResolvedValueOnce({ data: buildTextNote({ id: 'n1', pinned: true }) } as never);
    const since = snapshotMark();

    await drainQueue(db);

    expect(notesWrittenSince(since)).toEqual(new Set());
  });

  it('records no landing for a dropped markViewed, which changes no content (#1265)', async () => {
    await saveNote(db, makeTextNote('n1'));
    await seedQueueEntry(db, {
      operation: 'markViewed',
      endpoint: '/notes/n1/viewed',
      method: 'POST',
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));
    const since = snapshotMark();

    await drainQueue(db);

    expect(notesWrittenSince(since)).toEqual(new Set());
  });

  it('drops a permanently-rejected markViewed without flagging the note', async () => {
    // Marking a note viewed is best-effort: a rejection (say the note was
    // unshared meanwhile) only leaves a badge the next server fetch reconciles.
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, {
      operation: 'markViewed',
      endpoint: '/notes/n1/viewed',
      method: 'POST',
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(404));

    await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('dead-letters an update 409 (version conflict) instead of dropping it silently', async () => {
    // A 409 on an `update` is an optimistic-concurrency conflict: the note
    // changed on another device since base_version (#489). Unlike an idempotent
    // create/item 409, it must be preserved + flagged so the stale edit surfaces
    // in the failed-changes banner instead of being silently clobbered.
    await seedNoteAtVersion('n1', 3);
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/n1',
      method: 'PATCH',
      body: { content: 'mine' },
    });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toMatchObject([{ operation: 'update', status: 409, note_id: 'n1' }]);
    expect(await failedNoteIds()).toEqual(['n1']);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/n1', status: 409 }]);
  });

  it('resolves each queued update base_version from the advancing local version so a same-note chain does not self-conflict (#489)', async () => {
    // Two offline content edits to the same note (base local version 3). The first
    // drains, the server bumps to 4, and setLocalNoteVersion advances the local
    // version; the second must replay against 4, not the stale 3, or it would be
    // wrongly dead-lettered as a cross-device conflict. base_version is resolved at
    // drain time from the local version, not stored in the queued body.
    await seedNoteAtVersion('n1', 3);
    await seedQueueEntry(db, {
      operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { content: 'first' },
    });
    await seedQueueEntry(db, {
      operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { content: 'second' },
    });
    mockApi.patch
      .mockResolvedValueOnce({ data: { ...makeTextNote('n1'), version: 4 } } as never)
      .mockResolvedValueOnce({ data: { ...makeTextNote('n1'), version: 5 } } as never);

    await drainQueue(db);

    // First replays against the base version 3; second against the advanced 4.
    expect(mockApi.patch).toHaveBeenNthCalledWith(1, '/notes/n1', { content: 'first', base_version: 3 }, REPLAY_CONFIG);
    expect(mockApi.patch).toHaveBeenNthCalledWith(2, '/notes/n1', { content: 'second', base_version: 4 }, REPLAY_CONFIG);
    // Both drained cleanly — nothing dead-lettered or flagged failed.
    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    // The local version tracks the server's latest.
    expect(await db.getFirstAsync('SELECT version FROM notes WHERE id = ?', ['n1'])).toEqual({ version: 5 });
  });

  it('dead-letters a convertNoteType 409 (version conflict) instead of dropping it silently', async () => {
    // Mirrors the `update` 409 case above: a 409 on a convert means the note
    // changed on another device since base_version, so it must be preserved and
    // surfaced rather than treated as an idempotent already-applied conflict.
    await seedNoteAtVersion('n1', 3);
    await seedQueueEntry(db, {
      operation: 'convertNoteType',
      endpoint: '/notes/n1/convert',
      method: 'POST',
      body: { note_type: 'list', items: [] },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetters()).toMatchObject([
      { operation: 'convertNoteType', status: 409, note_id: 'n1' },
    ]);
    expect(await failedNoteIds()).toEqual(['n1']);
    expect(discardedOperations).toEqual([
      { operation: 'convertNoteType', endpoint: '/notes/n1/convert', status: 409 },
    ]);
  });

  it('resolves a queued convertNoteType base_version from the local version at replay time', async () => {
    await seedNoteAtVersion('n1', 5);
    await seedQueueEntry(db, {
      operation: 'convertNoteType',
      endpoint: '/notes/n1/convert',
      method: 'POST',
      body: { note_type: 'text', content: 'hi' },
    });
    mockApi.post.mockResolvedValueOnce({ data: { ...makeTextNote('n1'), version: 6 } } as never);

    await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/n1/convert', {
      note_type: 'text', content: 'hi', base_version: 5,
    }, REPLAY_CONFIG);
    expect(await deadLetters()).toEqual([]);
  });

  it('clears a prior failed flag when a later op for the note drains successfully', async () => {
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['n1']);
    await seedQueueEntry(db, {
      operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { content: 'y' },
    });
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(await syncStateOf('n1')).toBe('synced');
    expect(await deadLetters()).toEqual([]);
  });

  it('keeps the failed flag while a dead letter for the note is unresolved, so a later landed op does not unprotect it (#1263)', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', version: 5, content: 'my edit' }));
    await seedQueueEntry(db, {
      operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { content: 'my edit' },
    });
    await seedQueueEntry(db, {
      operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { pinned: true },
    });
    mockApi.patch
      .mockRejectedValueOnce(makeAxiosError(409))
      .mockResolvedValueOnce({ data: buildTextNote({ id: 'n1', version: 6, content: 'server text', pinned: true }) } as never);

    await drainQueue(db);

    expect(await deadLetters()).toMatchObject([{ operation: 'update', note_id: 'n1' }]);
    expect(await syncStateOf('n1')).toBe('failed');
    expect(await getProtectedNoteIds(db)).toContain('n1');
    // The landed op's response did not replace the edit "Keep my version" forks.
    await saveServerNote(db, buildTextNote({ id: 'n1', version: 6, content: 'server text' }), snapshotMark());
    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({ content: 'my edit' });
  });

  it('dead-letters an update queued after an offline create when the update fails', async () => {
    const clientId = 'ClientNoteId000000001A';
    await saveNote(db, buildTextNote({ id: clientId }));
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: clientId, title: 'x', content: '', note_type: 'text' },
    });
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: `/notes/${clientId}`,
      method: 'PATCH',
      body: { content: 'z' },
    });
    mockApi.post.mockResolvedValueOnce({ data: makeTextNote(clientId) } as never);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(403));

    await drainQueue(db);

    // The dead-lettered update is stored and flagged against the client/server id.
    expect(await deadLetters()).toMatchObject([
      { endpoint: `/notes/${clientId}`, note_id: clientId },
    ]);
    expect(await failedNoteIds()).toEqual([clientId]);
  });
});

// ── getDeadLetteredOperations ───────────────────────────────────────────────

// ── drainQueue: which rejections are failed changes (#1285, spec §8.4) ──────

describe('drainQueue rejection policy', () => {
  /** Rejects the next request of the entry's method only, so no unused rejection leaks into a later test. */
  const rejectNext = (method: string, err: unknown): void => {
    const fn = method === 'POST' ? mockApi.post : method === 'PATCH' ? mockApi.patch : mockApi.delete;
    fn.mockRejectedValueOnce(err);
  };
  type Seed = Parameters<typeof seedQueueEntry>[1];
  const n1 = (op: Omit<Seed, 'keys'>): Seed => ({ ...op, keys: ['note:n1'] });

  // Ops whose local value is not worth a "Keep my version" fork: a rejection
  // drops the row and pulls the note, which undoes the local change.
  it.each<[string, Seed]>([
    ['delete', n1({ operation: 'delete', endpoint: '/notes/n1', method: 'DELETE' })],
    ['restore', n1({ operation: 'restore', endpoint: '/notes/n1/restore', method: 'POST' })],
    ['permanentDelete', n1({ operation: 'permanentDelete', endpoint: '/notes/n1/permanent', method: 'DELETE' })],
    ['reorder', { operation: 'reorder', endpoint: '/notes/reorder', method: 'POST', body: { note_ids: ['n1'] }, keys: ['note:n1'] }],
    ['deleteItem', n1({ operation: 'deleteItem', endpoint: '/notes/n1/items/i1', method: 'DELETE' })],
    ['reorderItems', n1({ operation: 'reorderItems', endpoint: '/notes/n1/items/reorder', method: 'POST', body: { item_ids: ['i1'] } })],
    ['setItemsCompleted', n1({ operation: 'setItemsCompleted', endpoint: '/notes/n1/items/set-completed', method: 'POST', body: { item_ids: ['i1'], completed: true } })],
    ['deleteCompletedItems', n1({ operation: 'deleteCompletedItems', endpoint: '/notes/n1/items/delete', method: 'POST', body: { item_ids: ['i1'] } })],
    ['addLabelToNote', { operation: 'addLabelToNote', endpoint: '/notes/n1/labels', method: 'POST', body: { name: 'Work' }, keys: ['note:n1', 'label:l1'] }],
    ['removeLabelFromNote', { operation: 'removeLabelFromNote', endpoint: '/notes/n1/labels/l1', method: 'DELETE', keys: ['note:n1', 'label:l1'] }],
    ['share', n1({ operation: 'share', endpoint: '/notes/n1/shares', method: 'POST', body: { user_id: 'u2' } })],
    ['unshare', n1({ operation: 'unshare', endpoint: '/notes/n1/shares/u2', method: 'DELETE' })],
    ['a per-user update', n1({ operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { pinned: true } })],
    ['an updateItem without text', n1({ operation: 'updateItem', endpoint: '/notes/n1/items/i1', method: 'PATCH', body: { parent_id: 'i0' } })],
  ])('takes the server\'s state for a rejected op: %s', async (_name, entry) => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'local' }));
    await seedQueueEntry(db, entry);
    rejectNext(entry.method, makeAxiosError(400));
    mockApi.get.mockResolvedValue({ data: buildTextNote({ id: 'n1', content: 'server' }) });

    const { discardedOperations } = await drainQueue(db);

    expect(discardedOperations).toEqual([expect.objectContaining({ operation: entry.operation, status: 400 })]);
    expect(await deadLetters()).toEqual([]);
    expect(await failedNoteIds()).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
    // The pull replaced the local state with the server's.
    expect(mockApi.get).toHaveBeenCalledWith('/notes/n1');
    expect(await getLocalNote(db, 'n1')).toMatchObject({ content: 'server' });
  });

  it('brings back a note a rejected permanent delete already removed locally', async () => {
    await seedQueueEntry(db, n1({ operation: 'permanentDelete', endpoint: '/notes/n1/permanent', method: 'DELETE' }));
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(403));
    mockApi.get.mockResolvedValue({ data: buildTextNote({ id: 'n1', content: 'server' }) });

    await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await getLocalNote(db, 'n1')).toMatchObject({ content: 'server' });
  });

  // Content the user typed, and label and settings changes: a failed change.
  it.each<[string, Seed]>([
    ['a content update', n1({ operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: { content: 'x', base_version: 1 } })],
    ['an updateItem with text', n1({ operation: 'updateItem', endpoint: '/notes/n1/items/i1', method: 'PATCH', body: { text: 'x' } })],
    ['a createItem', n1({ operation: 'createItem', endpoint: '/notes/n1/items', method: 'POST', body: { id: 'i1', text: 'x', position: 0 } })],
    ['a convert', n1({ operation: 'convertNoteType', endpoint: '/notes/n1/convert', method: 'POST', body: { note_type: 'list', base_version: 1 } })],
    ['a renameLabel', { operation: 'renameLabel', endpoint: '/labels/l1', method: 'PATCH', body: { name: 'x' }, keys: ['label:l1'] }],
    ['an updateSettings', { operation: 'updateSettings', endpoint: '/users/me', method: 'PATCH', body: { username: 'x' }, keys: ['settings'] }],
  ])('dead-letters a rejected op: %s', async (_name, entry) => {
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, entry);
    rejectNext(entry.method, makeAxiosError(400));

    await drainQueue(db);

    expect(await deadLetters()).toEqual([expect.objectContaining({ operation: entry.operation, status: 400 })]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('dead-letters a taken username (409) and has the settings re-read', async () => {
    // Only a create-like op's 409 means "already applied"; a profile change's
    // is a real rejection the user has to see (#1285).
    await seedQueueEntry(db, { operation: 'updateSettings', endpoint: '/users/me', method: 'PATCH', body: { username: 'x' }, keys: ['settings'] });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(409));

    expect((await drainQueue(db)).syncedSettings).toBe(true);
    expect(await deadLetters()).toEqual([expect.objectContaining({ operation: 'updateSettings', status: 409 })]);
  });

  it.each<[string, Seed]>([
    ['create', { operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'n1', note_type: 'text', content: 'x' }, keys: ['note:n1'] }],
    ['createItem', n1({ operation: 'createItem', endpoint: '/notes/n1/items', method: 'POST', body: { id: 'i1', text: 'x', position: 0 } })],
    ['share', n1({ operation: 'share', endpoint: '/notes/n1/shares', method: 'POST', body: { user_id: 'u2' } })],
  ])('treats a 409 replay of %s as already applied', async (_name, entry) => {
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, entry);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    await drainQueue(db);

    expect(await deadLetters()).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });
});

describe('getDeadLetteredOperations', () => {
  const insertDeadLetter = (endpoint: string) =>
    db.runAsync(
      `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
       VALUES ('update', ?, 'PATCH', NULL, 400, 'n1', '', '')`,
      [endpoint],
    );

  it('reads the dead_letter table oldest-first', async () => {
    await insertDeadLetter('/notes/first');
    await insertDeadLetter('/notes/second');

    expect((await getDeadLetteredOperations(db)).map((dl) => dl.endpoint)).toEqual([
      '/notes/first',
      '/notes/second',
    ]);
  });

  it('normalizes the #714 columns for rows missing them (older data)', async () => {
    // A row written before migration 6 takes the defaults those ALTERs supplied.
    await insertDeadLetter('/notes/n1');

    const dl = (await getDeadLetteredOperations(db))[0]!;

    expect(dl.attempts).toBe(0);
    expect(dl.error_message).toBeNull();
  });

  it('is empty when nothing has been dead-lettered', async () => {
    expect(await getDeadLetteredOperations(db)).toEqual([]);
  });
});

// ── failed-note overwrite protection ────────────────────────────────────────

describe('getFailedNoteIds / getProtectedNoteIds', () => {
  it('getFailedNoteIds returns the ids flagged failed', async () => {
    for (const id of ['f1', 'f2', 'ok']) {
      await saveNote(db, buildTextNote({ id }));
    }
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id IN ('f1', 'f2')`);

    expect(await getFailedNoteIds(db)).toEqual(new Set(['f1', 'f2']));
  });

  it('getProtectedNoteIds unions pending-queue and failed notes', async () => {
    await saveNote(db, buildTextNote({ id: 'failed' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['failed']);
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/pending', method: 'PATCH' });

    expect(await getProtectedNoteIds(db)).toEqual(new Set(['pending', 'failed']));
  });
});

describe('dead-letter protection without the failed flag (#1263)', () => {
  async function seedDeadLetter(noteId: string | null, endpoint: string, body: Record<string, unknown> | null = null): Promise<number> {
    const operation = noteId ? 'update' : 'reorder';
    const result = await db.runAsync(
      `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
       VALUES (?, ?, 'PATCH', ?, 409, ?, '', '')`,
      [operation, endpoint, body === null ? null : JSON.stringify(body), noteId],
    );
    await insertKeys(db, 'dead_letter_keys', result.lastInsertRowId, legacyQueueKeys(operation, endpoint, body, new Map()));
    return result.lastInsertRowId;
  }

  it('protects a note a dead letter names even when its flag was cleared (older data)', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'my edit' }));
    await seedDeadLetter('n1', '/notes/n1', { content: 'my edit' });

    await saveServerNote(db, buildTextNote({ id: 'n1', content: 'server copy' }), snapshotMark());

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({ content: 'my edit' });
  });

  it('protects every note a multi-note dead letter touched', async () => {
    await seedDeadLetter(null, '/notes/reorder', { note_ids: ['a', 'b'] });

    expect(await getProtectedNoteIds(db)).toEqual(new Set(['a', 'b']));
  });

  it('keeps the failed flag when one of two dead letters for a note is discarded', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'my edit' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['n1']);
    const first = await seedDeadLetter('n1', '/notes/n1', { content: 'my edit' });
    await seedDeadLetter('n1', '/notes/n1', { color: '#ffffff' });
    mockApi.get.mockResolvedValueOnce({ data: buildTextNote({ id: 'n1', content: 'server copy' }) } as never);

    const [firstDl] = (await deadLetters()).filter((d) => d.id === first);
    await reconcileDiscard(db, firstDl!);

    expect(await deadLetters()).toHaveLength(1);
    expect(await syncStateOf('n1')).toBe('failed');
    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({ content: 'my edit' });

    // Resolving the last one lifts the protection and takes the server copy.
    mockApi.get.mockResolvedValueOnce({ data: buildTextNote({ id: 'n1', content: 'server copy' }) } as never);
    await reconcileDiscard(db, (await deadLetters())[0]!);

    expect(await syncStateOf('n1')).toBe('synced');
    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({ content: 'server copy' });
  });
});

describe('saveServerNote failed-note protection', () => {
  it('does not overwrite a note that is flagged failed but has no pending queue op', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'unsent local edit' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['n1']);

    await saveServerNote(db, buildTextNote({ id: 'n1', content: 'server copy' }), snapshotMark());

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'unsent local edit',
    });
  });

  it('persists a note that is neither pending nor failed', async () => {
    await saveNote(db, buildTextNote({ id: 'other' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['other']);

    await saveServerNote(db, buildTextNote({ id: 'n1', content: 'server copy' }), snapshotMark());

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'server copy',
    });
  });
});
