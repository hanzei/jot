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
import { getFailedNoteIds, saveNote } from '../src/db/noteQueries';
import api from '../src/api/client';
import { makeTextNote as buildTextNote, remainingQueueIds, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

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

const makeTextNote = (id: string) => buildTextNote({ id, content: 'body', created_at: '', updated_at: '' });

let db: TestDatabase;

beforeEach(() => {
  jest.clearAllMocks();
  db = globalThis.testDb;
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

  it('stores a NULL note_id for a multi-note reorder but flags every listed note', async () => {
    for (const id of ['a', 'b', 'c']) {
      await saveNote(db, buildTextNote({ id }));
    }
    await seedQueueEntry(db, {
      operation: 'reorder',
      endpoint: '/notes/reorder',
      method: 'POST',
      body: { note_ids: ['a', 'b', 'c'] },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(400));

    await drainQueue(db);

    // No single clear note, so the row's note_id is NULL...
    expect(await deadLetters()).toMatchObject([{ note_id: null }]);
    // ...but every note the reorder touched is still flagged.
    expect(await failedNoteIds()).toEqual(['a', 'b', 'c']);
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

  it('still dead-letters a non-gone permanent failure (400) for a delete op', async () => {
    // Only 404/410 ("target is gone") is idempotent for a delete; a genuine
    // validation-class rejection is still preserved + flagged.
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/n1', method: 'DELETE' });
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(400));

    await drainQueue(db);

    expect(await deadLetters()).toHaveLength(1);
    expect(await failedNoteIds()).toEqual(['n1']);
  });

  it('does not treat a 404 as idempotent for a non-destructive op (addLabelToNote)', async () => {
    // A 404 on adding a label is a real failure (note gone) worth preserving; the
    // gone-idempotent shortcut is scoped to destructive/restore ops only.
    await saveNote(db, buildTextNote({ id: 'n1' }));
    await seedQueueEntry(db, {
      operation: 'addLabelToNote',
      endpoint: '/notes/n1/labels',
      method: 'POST',
      body: { label_id: 'l1' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(404));

    await drainQueue(db);

    expect(await deadLetters()).toHaveLength(1);
    expect(await failedNoteIds()).toEqual(['n1']);
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
    expect(mockApi.patch).toHaveBeenNthCalledWith(1, '/notes/n1', { content: 'first', base_version: 3 });
    expect(mockApi.patch).toHaveBeenNthCalledWith(2, '/notes/n1', { content: 'second', base_version: 4 });
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
    });
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

describe('saveServerNote failed-note protection', () => {
  it('does not overwrite a note that is flagged failed but has no pending queue op', async () => {
    await saveNote(db, buildTextNote({ id: 'n1', content: 'unsent local edit' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['n1']);

    await saveServerNote(db, buildTextNote({ id: 'n1', content: 'server copy' }));

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'unsent local edit',
    });
  });

  it('persists a note that is neither pending nor failed', async () => {
    await saveNote(db, buildTextNote({ id: 'other' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, ['other']);

    await saveServerNote(db, buildTextNote({ id: 'n1', content: 'server copy' }));

    expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'server copy',
    });
  });
});
