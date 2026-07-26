/**
 * Tests for offline support: local note queries, sync queue, and ID utilities.
 */

import { generateClientNoteId, isUnsyncedNoteId, removeLocalNotesNotIn, getLocalLabelCounts, saveNote, addLabelToLocalNote, removeLabelFromLocalNote, getLocalNotes } from '../src/db/noteQueries';
import { drainQueue, getSyncQueueStats, isTransientHttpStatus, MAX_ENTRY_DRAIN_ATTEMPTS, PROCESSING_ERROR_STATUS } from '../src/db/syncQueue';
import api from '../src/api/client';

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../src/db/noteQueries', () => ({
  ...jest.requireActual('../src/db/noteQueries'),
  saveNote: jest.fn().mockResolvedValue(undefined),
}));

const mockApi = api as jest.Mocked<typeof api>;
const mockSaveNote = saveNote as jest.MockedFunction<typeof saveNote>;

// ── generateClientNoteId / isUnsyncedNoteId ────────────────────────────────

describe('generateClientNoteId', () => {
  it('produces a 22-char server-valid id', () => {
    const id = generateClientNoteId();
    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
  });

  it('generates unique ids', () => {
    const ids = Array.from({ length: 50 }, () => generateClientNoteId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isUnsyncedNoteId', () => {
  it('is true for a server-valid id still pending its offline create', () => {
    expect(isUnsyncedNoteId('AbCdEfGhIjKlMnOpQrStUv', new Set(['AbCdEfGhIjKlMnOpQrStUv']))).toBe(true);
  });

  it('is false for a confirmed server id', () => {
    expect(isUnsyncedNoteId('AbCdEfGhIjKlMnOpQrStUv', new Set())).toBe(false);
  });
});

// ── isTransientHttpStatus ───────────────────────────────────────────────────

describe('isTransientHttpStatus', () => {
  it('treats no response (network failure) as transient', () => {
    expect(isTransientHttpStatus(undefined)).toBe(true);
  });

  it('treats 401, 408, 429 and 5xx as transient', () => {
    for (const status of [401, 408, 429, 500, 502, 503]) {
      expect(isTransientHttpStatus(status)).toBe(true);
    }
  });

  it('treats other 4xx client errors as permanent', () => {
    for (const status of [400, 403, 404, 409, 422]) {
      expect(isTransientHttpStatus(status)).toBe(false);
    }
  });
});

// ── getSyncQueueStats ───────────────────────────────────────────────────────

describe('getSyncQueueStats', () => {
  it('reports the FIFO head, pending count, and max attempts (#714)', async () => {
    const db = {
      getFirstAsync: jest.fn()
        .mockResolvedValueOnce({ id: 3, operation: 'update', created_at: '2024-01-01T00:00:00Z', attempts: 2 })
        .mockResolvedValueOnce({ count: 4 })
        .mockResolvedValueOnce({ max: 2 }),
    };

    const stats = await getSyncQueueStats(db as never);

    expect(stats).toEqual({
      pendingCount: 4,
      head: { id: 3, operation: 'update', created_at: '2024-01-01T00:00:00Z', attempts: 2 },
      maxAttempts: 2,
    });
  });

  it('returns an empty summary when the queue is empty', async () => {
    const db = {
      getFirstAsync: jest.fn()
        .mockResolvedValueOnce(null) // no head row
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ max: null }),
    };

    const stats = await getSyncQueueStats(db as never);

    expect(stats).toEqual({ pendingCount: 0, head: null, maxAttempts: 0 });
  });
});

// ── drainQueue ─────────────────────────────────────────────────────────────

function makeMockDb(entries: { id: number; operation: string; endpoint: string; method: string; body: string | null; created_at: string; attempts?: number }[]) {
  return {
    getAllAsync: jest.fn().mockResolvedValue([...entries]),
    runAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: entries.length }),
    withTransactionAsync: jest.fn(async (cb: () => Promise<void> | void) => { await cb(); }),
  };
}

describe('drainQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('processes POST operations and removes them from queue', async () => {
    const db = makeMockDb([
      { id: 1, operation: 'create', endpoint: '/notes/abc', method: 'POST', body: '{"title":"hi"}', created_at: '' },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/abc', { title: 'hi' });
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [1]);
  });

  it('processes PATCH operations and removes them from queue', async () => {
    const db = makeMockDb([
      { id: 2, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{"title":"updated"}', created_at: '' },
    ]);
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(mockApi.patch).toHaveBeenCalledWith('/notes/abc', { title: 'updated' });
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [2]);
  });

  it('processes DELETE operations and removes them from queue', async () => {
    const db = makeMockDb([
      { id: 3, operation: 'delete', endpoint: '/notes/abc', method: 'DELETE', body: null, created_at: '' },
    ]);
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/abc');
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [3]);
  });

  it('discards 404 errors and continues processing', async () => {
    const db = makeMockDb([
      { id: 4, operation: 'delete', endpoint: '/notes/gone', method: 'DELETE', body: null, created_at: '' },
      { id: 5, operation: 'update', endpoint: '/notes/exists', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(404));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [4]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [5]);
  });

  it('discards 409 errors and continues processing', async () => {
    const db = makeMockDb([
      { id: 4, operation: 'update', endpoint: '/notes/conflict', method: 'PATCH', body: '{}', created_at: '' },
      { id: 5, operation: 'update', endpoint: '/notes/exists', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(409));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [4]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [5]);
  });

  it('does not duplicate a createItem whose original request already committed (409 replay is dead-lettered)', async () => {
    // Models the partial-commit case: the server created item i1 but the client
    // never saw the response (transient failure), so the create was queued for
    // replay. Replaying it POSTs the same stable id, the server rejects the
    // duplicate with 409, and the entry is discarded rather than retried.
    const db = makeMockDb([
      {
        id: 20,
        operation: 'createItem',
        endpoint: '/notes/n1/items',
        method: 'POST',
        body: JSON.stringify({ id: 'i1', text: 'a', position: 0 }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [20]);
    expect(discardedOperations).toEqual([
      { operation: 'createItem', endpoint: '/notes/n1/items', status: 409 },
    ]);
  });

  it('stops draining on network errors (non-4xx)', async () => {
    const db = makeMockDb([
      { id: 6, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '' },
      { id: 7, operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(new Error('Network Error'));

    await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [6]);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [7]);
  });

  it('discards permanent 4xx errors (e.g. 400) so they cannot wedge the queue', async () => {
    const db = makeMockDb([
      { id: 10, operation: 'update', endpoint: '/notes/bad', method: 'PATCH', body: '{"title":""}', created_at: '' },
      { id: 11, operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(400));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db as never);

    // The bad entry is dead-lettered and the rest of the queue still drains.
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [10]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [11]);
    expect(discardedOperations).toEqual([
      { operation: 'update', endpoint: '/notes/bad', status: 400 },
    ]);
  });

  it('stops draining on 5xx errors and retries the rest later', async () => {
    const db = makeMockDb([
      { id: 12, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '' },
      { id: 13, operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(503));

    await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [12]);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [13]);
  });

  it('stops draining on 429 (rate limit) and retries the rest later', async () => {
    const db = makeMockDb([
      { id: 14, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(429));

    await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [14]);
  });

  it('stops draining on 401 (does not discard) so the op survives re-auth', async () => {
    const db = makeMockDb([
      { id: 15, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(401));

    const { discardedOperations } = await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [15]);
    expect(discardedOperations).toHaveLength(0);
  });

  it('stops draining on a non-Axios error rather than discarding the entry', async () => {
    const db = makeMockDb([
      { id: 16, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(new Error('unexpected'));

    const { discardedOperations } = await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [16]);
    expect(discardedOperations).toHaveLength(0);
  });

  // ── head-of-line handling: per-entry attempt counter + dead-letter (#714) ──

  it('increments the attempt counter and stops (no dead-letter) below the cap on a persistent 5xx (#714)', async () => {
    const db = makeMockDb([
      { id: 30, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '', attempts: 0 },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

    const { discardedOperations } = await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('UPDATE sync_queue SET attempts = ? WHERE id = ?', [1, 30]);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [30]);
    expect(discardedOperations).toHaveLength(0);
  });

  it('dead-letters a persistently-failing 5xx entry at the cap and drains past it (#714)', async () => {
    const db = makeMockDb([
      { id: 31, operation: 'update', endpoint: '/notes/stuck', method: 'PATCH', body: '{}', created_at: '', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 },
      { id: 32, operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(503)); // id 31 — one more failure hits the cap
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never); // id 32 — the unaffected note

    const { discardedOperations } = await drainQueue(db as never);

    // The stuck entry is charged, dead-lettered, and removed from the queue...
    expect(db.runAsync).toHaveBeenCalledWith('UPDATE sync_queue SET attempts = ? WHERE id = ?', [MAX_ENTRY_DRAIN_ATTEMPTS, 31]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [31]);
    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/stuck', status: 503 }]);
    // ...and the later entry for an unaffected note still drains.
    expect(mockApi.patch).toHaveBeenCalledWith('/notes/ok', {});
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [32]);
  });

  it('dead-letters a non-HTTP processing error at the cap and continues past it (#714)', async () => {
    const db = makeMockDb([
      { id: 40, operation: 'update', endpoint: '/notes/corrupt', method: 'PATCH', body: '{}', created_at: '', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 },
      { id: 41, operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: '{}', created_at: '' },
    ]);
    mockApi.patch.mockRejectedValueOnce(new Error('boom')); // non-axios throw processing id 40
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db as never);

    // A non-HTTP throw is recorded with the processing-error sentinel status (0).
    expect(discardedOperations).toEqual([
      { operation: 'update', endpoint: '/notes/corrupt', status: PROCESSING_ERROR_STATUS },
    ]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [40]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [41]);
  });

  it('records attempts and error_message on the dead_letter row (#714)', async () => {
    const db = makeMockDb([
      { id: 50, operation: 'update', endpoint: '/notes/x', method: 'PATCH', body: '{}', created_at: '', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 },
    ]);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

    await drainQueue(db as never);

    const insert = (db.runAsync.mock.calls as unknown[][]).find((c) =>
      String(c[0]).startsWith('INSERT INTO dead_letter'),
    );
    expect(insert).toBeTruthy();
    // args: [operation, endpoint, method, body, status, note_id, created_at, failed_at, attempts, error_message]
    const args = insert![1] as unknown[];
    expect(args[4]).toBe(500); // status
    expect(args[8]).toBe(MAX_ENTRY_DRAIN_ATTEMPTS); // attempts
    expect(typeof args[9]).toBe('string'); // error_message preserved
    expect(args[9]).toBeTruthy();
  });

  it('drops later queued ops for a note whose create was dead-lettered, without hitting the server (#714 cascade)', async () => {
    const clientId = 'Cascade0000000000000ab'; // 22-char server-valid id
    const db = makeMockDb([
      { id: 60, operation: 'create', endpoint: '/notes', method: 'POST', body: JSON.stringify({ id: clientId, content: 'x', note_type: 'text' }), created_at: '', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 },
      { id: 61, operation: 'update', endpoint: `/notes/${clientId}`, method: 'PATCH', body: '{"title":"later"}', created_at: '' },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(500)); // create hits the cap and dead-letters

    const { discardedOperations } = await drainQueue(db as never);

    // The create is dead-lettered...
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [60]);
    // ...and the dependent update is dropped without an API call (no orphan 404).
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [61]);
    // Only the create surfaces as discarded; the dependent drop is silent.
    expect(discardedOperations).toEqual([{ operation: 'create', endpoint: '/notes', status: 500 }]);
  });

  it('does not charge the attempt counter on a global connectivity failure (network error) (#714)', async () => {
    const db = makeMockDb([
      { id: 70, operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: '{}', created_at: '', attempts: 2 },
    ]);
    // An axios error with no response models a network failure/timeout at the transport.
    mockApi.patch.mockRejectedValueOnce(
      Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined }),
    );

    await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('UPDATE sync_queue SET attempts = ? WHERE id = ?', [3, 70]);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [70]);
  });

  it('drops an entry whose server write landed but post-response reconciliation threw, without dead-lettering (#714)', async () => {
    const clientId = 'Landed00000000000000ab'; // 22-char server-valid id
    const db = makeMockDb([
      // Sitting at the cap: proves a landed-then-reconcile-fail is NOT dead-lettered.
      { id: 80, operation: 'create', endpoint: '/notes', method: 'POST', body: JSON.stringify({ id: clientId, content: 'x', note_type: 'text' }), created_at: '', attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1 },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: { id: clientId } } as never); // request lands
    mockSaveNote.mockRejectedValueOnce(new Error('local db write failed')); // reconciliation throws

    const { discardedOperations } = await drainQueue(db as never);

    // The entry is removed because the write landed — not retried, not dead-lettered.
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [80]);
    expect(discardedOperations).toHaveLength(0);
    expect((db.runAsync.mock.calls as unknown[][]).some((c) => String(c[0]).startsWith('INSERT INTO dead_letter'))).toBe(false);
    expect((db.runAsync.mock.calls as unknown[][]).some((c) => String(c[0]).startsWith('UPDATE sync_queue SET attempts'))).toBe(false);
  });

  it('keeps a client-supplied create id stable: adopts the server note, clears pending, no reconcile (#475)', async () => {
    const clientId = 'AbcdefghijklmnopqrstUv'; // 22-char server-valid id
    const serverNote = {
      id: clientId, title: '', content: 'Test', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 10,
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: JSON.stringify({ id: clientId, content: 'Test', note_type: 'text' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    const { idMappings } = await drainQueue(db as never);

    // The id never changes — adopt the canonical note and clear the pending-create marker.
    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(db.runAsync).toHaveBeenCalledWith(
      `UPDATE notes SET sync_state = 'synced' WHERE id = ? AND sync_state = 'pending'`,
      [clientId],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [10]);
    expect(idMappings).toEqual([{ localId: clientId, serverNote }]);
  });

  it('clears the pending marker when a replayed create returns 409 (#475)', async () => {
    const clientId = 'Replay00000000000000Ab';
    const db = makeMockDb([
      {
        id: 11,
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: JSON.stringify({ id: clientId, content: 'Test', note_type: 'text' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);

    const { discardedOperations } = await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith(
      `UPDATE notes SET sync_state = 'synced' WHERE id = ? AND sync_state = 'pending'`,
      [clientId],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [11]);
    expect(discardedOperations).toEqual([
      { operation: 'create', endpoint: '/notes', status: 409 },
    ]);
  });

  it('adopts the server note and clears pending-create when duplicate uses a client-supplied id', async () => {
    // New-style offline duplicate: client sends { id } instead of { local_id }.
    // The server keeps the client-supplied id, so serverNote.id === clientId →
    // the stable-id path runs (saveNote + clearNotePendingCreate), no remap needed.
    const clientId = 'DupClientId000000000Ab';
    const serverNote = {
      id: clientId, title: 'Copy of Source', content: 'body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 9,
        operation: 'duplicate',
        endpoint: '/notes/src-123/duplicate',
        method: 'POST',
        body: JSON.stringify({ id: clientId }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    const { idMappings } = await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/src-123/duplicate', { id: clientId });
    // Save canonical note and clear pending-create marker.
    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(db.runAsync).toHaveBeenCalledWith(
      `UPDATE notes SET sync_state = 'synced' WHERE id = ? AND sync_state = 'pending'`,
      [clientId],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [9]);
    expect(idMappings).toEqual([{ localId: clientId, serverNote }]);
  });

  it('reconciles a createLabel local id and remaps it for later queued ops', async () => {
    const db = makeMockDb([
      {
        id: 30,
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_lbl_1', name: 'Work' }),
        created_at: '',
      },
      {
        id: 31,
        operation: 'deleteLabel',
        endpoint: '/labels/local_lbl_1',
        method: 'DELETE',
        body: null,
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: { id: 'srv_lbl_1', name: 'Work' } } as never);
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    // The label is created first, then the delete endpoint is remapped to the server id.
    expect(mockApi.post).toHaveBeenCalledWith('/labels', { local_id: 'local_lbl_1', name: 'Work' });
    expect(mockApi.delete).toHaveBeenCalledWith('/labels/srv_lbl_1');
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [30]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [31]);
  });

  it('resolves a createLabel 409 as idempotent when the server label has the same ID (replay)', async () => {
    const clientId = 'ClientLblId00000000001';
    const db = makeMockDb([
      {
        id: 32,
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: JSON.stringify({ id: clientId, name: 'Work' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: [{ id: clientId, name: 'Work' }] } as never);

    const { discardedOperations } = await drainQueue(db as never);

    // Resolved via GET /labels — same server ID, no remap needed.
    expect(mockApi.get).toHaveBeenCalledWith('/labels');
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [32]);
    // No dead-letter inserted.
    const calls = (db.runAsync as jest.Mock).mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO dead_letter'))).toBe(false);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('remaps a createLabel 409 to the server ID when there is a name collision', async () => {
    const clientId = 'ClientLblId00000000002';
    const serverLblId = 'ServerLblId0000000002';
    const db = makeMockDb([
      {
        id: 33,
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: JSON.stringify({ id: clientId, name: 'Home' }),
        created_at: '',
      },
      {
        id: 34,
        operation: 'deleteLabel',
        endpoint: `/labels/${clientId}`,
        method: 'DELETE',
        body: null,
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: [{ id: serverLblId, name: 'Home' }] } as never);
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db as never);

    // Downstream delete endpoint remapped to the server label ID.
    expect(mockApi.delete).toHaveBeenCalledWith(`/labels/${serverLblId}`);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [33]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [34]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('dead-letters a createLabel 409 when the label is not found via GET /labels', async () => {
    const db = makeMockDb([
      {
        id: 35,
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: JSON.stringify({ id: 'ClientLblId00000000003', name: 'Gone' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: [] } as never);

    const { discardedOperations } = await drainQueue(db as never);

    const calls = (db.runAsync as jest.Mock).mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO dead_letter'))).toBe(true);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [35]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('dead-letters a createLabel 409 when the GET /labels lookup itself fails', async () => {
    const db = makeMockDb([
      {
        id: 36,
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: JSON.stringify({ id: 'ClientLblId00000000004', name: 'Fail' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockRejectedValueOnce(new Error('Network Error') as never);

    const { discardedOperations } = await drainQueue(db as never);

    const calls = (db.runAsync as jest.Mock).mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO dead_letter'))).toBe(true);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [36]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('persists the note returned by an addLabelToNote replay', async () => {
    const serverNote = {
      id: 'n1', content: 'body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '',
      labels: [{ id: 'srv_lbl', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }],
      shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 40,
        operation: 'addLabelToNote',
        endpoint: '/notes/n1/labels',
        method: 'POST',
        body: JSON.stringify({ name: 'Work' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [40]);
  });

  it('persists the note returned by a convertNoteType replay', async () => {
    const serverNote = {
      id: 'n1', note_type: 'list', title: '', version: 4,
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      items: [{ id: 'i1', note_id: 'n1', text: 'Buy milk', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' }],
    };
    const db = makeMockDb([
      {
        id: 41,
        operation: 'convertNoteType',
        endpoint: '/notes/n1/convert',
        method: 'POST',
        body: JSON.stringify({ note_type: 'list', items: [{ id: 'i1', text: 'Buy milk', position: 0, completed: false }] }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [41]);
  });

  it('reconciles all authoritative fields (not just completed) from a toggleItemCompleted replay', async () => {
    // The server returns the note's full, authoritative item list on this
    // endpoint. If the local DB only patched `completed`, a stale local
    // parent_id/position left over from an earlier partial sync would never
    // get corrected, and the toggle would end up rendered against the wrong
    // item's row.
    const db = makeMockDb([
      {
        id: 42,
        operation: 'toggleItemCompleted',
        endpoint: '/notes/n1/items/i1/toggle-completed',
        method: 'POST',
        body: '{"completed":true}',
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({
      data: [
        { id: 'i1', text: 'Replace faucet', completed: true, position: 1, parent_id: 'kitchen', assigned_to: '' },
        { id: 'i2', text: 'Hgg', completed: false, position: 4, parent_id: 'mirror', assigned_to: '' },
      ],
    } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE note_items SET text'),
      expect.arrayContaining(['Replace faucet', 1, 'kitchen', 'i1', 'n1']),
    );
    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE note_items SET text'),
      expect.arrayContaining(['Hgg', 4, 'mirror', 'i2', 'n1']),
    );
  });

  it('reconciles all authoritative fields from an uncheckAllItems (set-completed) replay, upserting a locally-missing item', async () => {
    const db = makeMockDb([
      {
        id: 43,
        operation: 'uncheckAllItems',
        endpoint: '/notes/n1/items/set-completed',
        method: 'POST',
        body: JSON.stringify({ item_ids: ['i1', 'i2'], completed: false }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({
      data: [
        { id: 'i1', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '' },
        // i2: simulates an item created on another device while this one was
        // offline, so no local row exists yet — the upsert's UPDATE is a no-op
        // against a real DB and the INSERT OR IGNORE is what actually creates it.
        { id: 'i2', text: 'Eggs', completed: false, position: 1, parent_id: null, assigned_to: '' },
      ],
    } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE note_items SET text'),
      expect.arrayContaining(['Milk', 0, null, 'i1', 'n1']),
    );
    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO note_items'),
      expect.arrayContaining(['i2', 'n1', 'Eggs', 0, 1, null, '']),
    );
    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM note_items WHERE note_id = ? AND id NOT IN'),
      ['n1', 'i1', 'i2'],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [43]);
  });

  it('prunes a local item absent from a deleteCompletedItems replay\'s remaining-items response', async () => {
    // The endpoint's response is the note's full, authoritative remaining item
    // list post-delete — not just the requested ids' outcome — so any local
    // row absent from it must be removed too, including one that was never in
    // the queued item_ids (e.g. cascade-deleted alongside its parent, or
    // removed by another session while this device was offline).
    const db = makeMockDb([
      {
        id: 44,
        operation: 'deleteCompletedItems',
        endpoint: '/notes/n1/items/delete',
        method: 'POST',
        body: JSON.stringify({ item_ids: ['i1'] }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({
      data: [{ id: 'i3', text: 'Bread', completed: false, position: 0, parent_id: null, assigned_to: '' }],
    } as never);

    await drainQueue(db as never);

    // i1 (requested) and i2 (never requested, but absent from the
    // authoritative response) are both pruned via the same NOT IN delete.
    expect(db.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM note_items WHERE note_id = ? AND id NOT IN'),
      ['n1', 'i3'],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [44]);
  });

  it('resolves a deleteCompletedItems replay silently on a 404 (note already gone)', async () => {
    const db = makeMockDb([
      {
        id: 45,
        operation: 'deleteCompletedItems',
        endpoint: '/notes/n1/items/delete',
        method: 'POST',
        body: JSON.stringify({ item_ids: ['i1'] }),
        created_at: '',
      },
    ]);
    mockApi.post.mockRejectedValueOnce(makeAxiosError(404));

    const { discardedOperations } = await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [45]);
    const calls = (db.runAsync as jest.Mock).mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO dead_letter'))).toBe(false);
    expect(discardedOperations).toEqual([{ operation: 'deleteCompletedItems', endpoint: '/notes/n1/items/delete', status: 404 }]);
  });

  it('persists the note returned by a removeLabelFromNote replay', async () => {
    const serverNote = {
      id: 'n1', content: 'body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 41,
        operation: 'removeLabelFromNote',
        endpoint: '/notes/n1/labels/l1',
        method: 'DELETE',
        body: null,
        created_at: '',
      },
    ]);
    mockApi.delete.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/n1/labels/l1');
    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [41]);
  });

  it('processes updateSettings PATCH and sets syncedSettings in the result', async () => {
    const db = makeMockDb([
      {
        id: 50,
        operation: 'updateSettings',
        endpoint: '/users/me',
        method: 'PATCH',
        body: JSON.stringify({ language: 'de' }),
        created_at: '',
      },
    ]);
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { syncedSettings } = await drainQueue(db as never);

    expect(mockApi.patch).toHaveBeenCalledWith('/users/me', { language: 'de' });
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [50]);
    expect(syncedSettings).toBe(true);
  });

  it('reconciles the note from the server after a share op (204 has no body)', async () => {
    const serverNote = {
      id: 'n1', title: 'Shared', content: '', note_type: 'text', color: '#fff', pinned: false,
      archived: false, position: 0, version: 1, checked_items_collapsed: false, is_shared: true,
      deleted_at: null, user_id: 'u1', created_at: '', updated_at: '', labels: [],
      shared_with: [{ id: 's-real', note_id: 'n1', shared_with_user_id: 'u2', shared_by_user_id: 'u1', username: 'bob', first_name: '', last_name: '', has_profile_icon: false, created_at: '', updated_at: '' }],
    };
    const db = makeMockDb([
      { id: 60, operation: 'share', endpoint: '/notes/n1/share', method: 'POST', body: JSON.stringify({ user_id: 'u2' }), created_at: '' },
    ]);
    mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/n1/share', { user_id: 'u2' });
    // The optimistic `optimistic_<userId>` share row is replaced by re-fetching
    // the canonical note (share returns 204, so there is no response body). Only
    // the share columns are written, not a full saveNote, so a content edit still
    // queued for the same note isn't clobbered.
    expect(mockApi.get).toHaveBeenCalledWith('/notes/n1');
    expect(mockSaveNote).not.toHaveBeenCalled();
    expect(db.runAsync).toHaveBeenCalledWith(
      'UPDATE notes SET is_shared = ?, shared_with_json = ? WHERE id = ?',
      [1, JSON.stringify(serverNote.shared_with), 'n1'],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [60]);
  });

  it('reconciles the note from the server after an unshare op', async () => {
    const serverNote = {
      id: 'n1', title: 'Unshared', content: '', note_type: 'text', color: '#fff', pinned: false,
      archived: false, position: 0, version: 1, checked_items_collapsed: false, is_shared: false,
      deleted_at: null, user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      { id: 61, operation: 'unshare', endpoint: '/notes/n1/shares/u2', method: 'DELETE', body: null, created_at: '' },
    ]);
    mockApi.delete.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/n1/shares/u2');
    expect(mockApi.get).toHaveBeenCalledWith('/notes/n1');
    expect(mockSaveNote).not.toHaveBeenCalled();
    expect(db.runAsync).toHaveBeenCalledWith(
      'UPDATE notes SET is_shared = ?, shared_with_json = ? WHERE id = ?',
      [0, JSON.stringify([]), 'n1'],
    );
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [61]);
  });

  it('still drains a share op when the post-share reconcile fetch fails', async () => {
    const db = makeMockDb([
      { id: 62, operation: 'share', endpoint: '/notes/n1/share', method: 'POST', body: JSON.stringify({ user_id: 'u2' }), created_at: '' },
    ]);
    mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockRejectedValueOnce(makeAxiosError(500));

    await drainQueue(db as never);

    // The share itself succeeded, so the entry is removed even though the
    // best-effort reconcile fetch failed (the next background sync reconciles).
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [62]);
    expect(db.runAsync).not.toHaveBeenCalledWith(
      'UPDATE notes SET is_shared = ?, shared_with_json = ? WHERE id = ?',
      expect.anything(),
    );
  });
});

// ── getLocalLabelCounts ────────────────────────────────────────────────────

describe('getLocalLabelCounts', () => {
  it('counts active notes per label', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { labels_json: JSON.stringify([{ id: 'l1', name: 'Home' }, { id: 'l2', name: 'Work' }]) },
        { labels_json: JSON.stringify([{ id: 'l1', name: 'Home' }]) },
        { labels_json: '[]' },
      ]),
    };

    const counts = await getLocalLabelCounts(db as never);

    expect(counts).toEqual({ l1: 2, l2: 1 });
  });

  it('returns an empty object when no notes exist', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    const counts = await getLocalLabelCounts(db as never);

    expect(counts).toEqual({});
  });

  it('ignores notes with malformed labels_json', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { labels_json: 'not-json' },
        { labels_json: JSON.stringify([{ id: 'l1', name: 'Tag' }]) },
      ]),
    };

    const counts = await getLocalLabelCounts(db as never);

    expect(counts).toEqual({ l1: 1 });
  });

  it('queries only active (non-archived, non-trashed) notes', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    await getLocalLabelCounts(db as never);

    expect(db.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('archived = 0 AND deleted_at IS NULL'),
    );
  });
});

// ── removeLocalNotesNotIn label scope ───────────────────────────────────────

describe('removeLocalNotesNotIn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes only notes that matched the label filter but are missing from serverIds', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        {
          id: 'note-label-removed',
          labels_json: JSON.stringify([{ id: 'l1', name: 'Work' }]),
        },
        {
          id: 'note-other-label',
          labels_json: JSON.stringify([{ id: 'l2', name: 'Personal' }]),
        },
      ]),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLocalNotesNotIn(
      db as never,
      new Set<string>(['note-still-on-server']),
      { label: 'l1' },
    );

    expect(db.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining(
        'SELECT id, labels_json FROM notes WHERE 1=1 AND archived = 0 AND deleted_at IS NULL',
      ),
      [],
    );
    expect(db.runAsync).toHaveBeenCalledWith(
      'DELETE FROM notes WHERE id IN (?)',
      ['note-label-removed'],
    );
  });

  it('does not delete non-label-matching notes in a label-filtered sync', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        {
          id: 'note-unrelated',
          labels_json: JSON.stringify([{ id: 'l2', name: 'Personal' }]),
        },
      ]),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLocalNotesNotIn(
      db as never,
      new Set<string>(),
      { label: 'l1' },
    );

    expect(db.runAsync).not.toHaveBeenCalled();
  });
});

// ── getLocalNotes search ───────────────────────────────────────────────────

describe('getLocalNotes search', () => {
  it('searches title, content, and item text when search param is provided', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    await getLocalNotes(db as never, { search: 'hello' });

    const [sql, args] = (db.getAllAsync as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("title LIKE ? ESCAPE '\\'");
    expect(sql).toContain("content LIKE ? ESCAPE '\\'");
    expect(sql).toContain("id IN (SELECT note_id FROM note_items WHERE text LIKE ? ESCAPE '\\')");
    expect(args).toEqual(['%hello%', '%hello%', '%hello%']);
  });

  it('escapes LIKE wildcards in the search text so they match literally', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    await getLocalNotes(db as never, { search: '50%_a\\b' });

    const [, args] = (db.getAllAsync as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(args).toEqual(['%50\\%\\_a\\\\b%', '%50\\%\\_a\\\\b%', '%50\\%\\_a\\\\b%']);
  });

  it('does not add a LIKE condition when no search param is given', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    await getLocalNotes(db as never);

    const [sql] = (db.getAllAsync as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('LIKE');
  });
});

// ── removeLocalNotesNotIn search scope ────────────────────────────────────────

describe('removeLocalNotesNotIn with search', () => {
  it('includes item-text subquery in pruning scope when search param is provided', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([]),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLocalNotesNotIn(db as never, new Set<string>(), { search: 'hello' });

    const deleteCall = (db.runAsync as jest.Mock).mock.calls.find(
      (c: unknown[]) => String(c[0]).startsWith('DELETE'),
    ) as [string, unknown[]] | undefined;
    expect(deleteCall).toBeDefined();
    const [sql, args] = deleteCall!;
    expect(sql).toContain("title LIKE ? ESCAPE '\\'");
    expect(sql).toContain("content LIKE ? ESCAPE '\\'");
    expect(sql).toContain("id IN (SELECT note_id FROM note_items WHERE text LIKE ? ESCAPE '\\')");
    expect(args).toEqual(['%hello%', '%hello%', '%hello%']);
  });

  it('escapes LIKE wildcards so the prune scope matches the server literal search', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([]),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLocalNotesNotIn(db as never, new Set<string>(), { search: '50%' });

    const deleteCall = (db.runAsync as jest.Mock).mock.calls.find(
      (c: unknown[]) => String(c[0]).startsWith('DELETE'),
    ) as [string, unknown[]] | undefined;
    expect(deleteCall).toBeDefined();
    const [, args] = deleteCall!;
    expect(args).toEqual(['%50\\%%', '%50\\%%', '%50\\%%']);
  });
});

// ── addLabelToLocalNote ──────────────────────────────────────────────────────

describe('addLabelToLocalNote', () => {
  const label = { id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' };

  it('appends the label to a note that does not yet have it', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({ labels_json: '[]' }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await addLabelToLocalNote(db as never, 'n1', label);

    expect(db.runAsync).toHaveBeenCalledWith(
      'UPDATE notes SET labels_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify([label]), expect.any(String), 'n1'],
    );
  });

  it('is idempotent when the note already has the label (by id)', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({ labels_json: JSON.stringify([label]) }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await addLabelToLocalNote(db as never, 'n1', { ...label, name: 'Different' });

    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it('is idempotent when the note already has a label of the same name', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({ labels_json: JSON.stringify([label]) }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await addLabelToLocalNote(db as never, 'n1', { ...label, id: 'l2' });

    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it('is idempotent when the note already has a same-name label differing only in case', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({ labels_json: JSON.stringify([label]) }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await addLabelToLocalNote(db as never, 'n1', { ...label, id: 'l2', name: 'WORK' });

    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it('does nothing when the note is not in the local cache', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue(null),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await addLabelToLocalNote(db as never, 'missing', label);

    expect(db.runAsync).not.toHaveBeenCalled();
  });
});

// ── removeLabelFromLocalNote ─────────────────────────────────────────────────

describe('removeLabelFromLocalNote', () => {
  it('removes the matching label from the note', async () => {
    const labels = [
      { id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' },
      { id: 'l2', user_id: 'u1', name: 'Home', created_at: '', updated_at: '' },
    ];
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({ labels_json: JSON.stringify(labels) }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLabelFromLocalNote(db as never, 'n1', 'l1');

    expect(db.runAsync).toHaveBeenCalledWith(
      'UPDATE notes SET labels_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify([labels[1]]), expect.any(String), 'n1'],
    );
  });

  it('does nothing when the label is not present on the note', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue({
        labels_json: JSON.stringify([{ id: 'l2', name: 'Home' }]),
      }),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLabelFromLocalNote(db as never, 'n1', 'l1');

    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it('does nothing when the note is not in the local cache', async () => {
    const db = {
      getFirstAsync: jest.fn().mockResolvedValue(null),
      runAsync: jest.fn().mockResolvedValue(undefined),
    };

    await removeLabelFromLocalNote(db as never, 'missing', 'l1');

    expect(db.runAsync).not.toHaveBeenCalled();
  });
});
