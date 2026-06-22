/**
 * Tests for offline support: local note queries, sync queue, and ID utilities.
 */

import { generateLocalId, generateClientNoteId, isLocalId, isUnsyncedNoteId, replaceLocalNoteId, removeLocalNotesNotIn, getLocalLabels, getLocalLabelCounts, saveNote, addLabelToLocalNote, removeLabelFromLocalNote } from '../src/db/noteQueries';
import { drainQueue, isTransientHttpStatus } from '../src/db/syncQueue';
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
  replaceLocalNoteId: jest.fn().mockResolvedValue(undefined),
  saveNote: jest.fn().mockResolvedValue(undefined),
}));

const mockApi = api as jest.Mocked<typeof api>;
const mockReplaceLocalNoteId = replaceLocalNoteId as jest.MockedFunction<typeof replaceLocalNoteId>;
const mockSaveNote = saveNote as jest.MockedFunction<typeof saveNote>;

// ── generateLocalId / isLocalId ────────────────────────────────────────────

describe('generateLocalId', () => {
  it('generates a string starting with "local_"', () => {
    const id = generateLocalId();
    expect(id).toMatch(/^local_/);
  });

  it('matches the expected format local_<base36timestamp>_<16hexchars>', () => {
    const id = generateLocalId();
    expect(id).toMatch(/^local_[0-9a-z]+_[0-9a-f]{16}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = Array.from({ length: 20 }, () => generateLocalId());
    const unique = new Set(ids);
    expect(unique.size).toBe(20);
  });
});

describe('isLocalId', () => {
  it('returns true for local_ prefixed IDs', () => {
    expect(isLocalId('local_abc123_xyz')).toBe(true);
  });

  it('returns false for server-style IDs', () => {
    expect(isLocalId('AbCdEfGhIjKlMnOpQrStUv')).toBe(false);
  });
});

describe('generateClientNoteId', () => {
  it('produces a 22-char server-valid id (no local_ prefix)', () => {
    const id = generateClientNoteId();
    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
    expect(isLocalId(id)).toBe(false);
  });

  it('generates unique ids', () => {
    const ids = Array.from({ length: 50 }, () => generateClientNoteId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isUnsyncedNoteId', () => {
  it('is true for a local_ duplicate id', () => {
    expect(isUnsyncedNoteId('local_abc_1', new Set())).toBe(true);
  });

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

// ── drainQueue ─────────────────────────────────────────────────────────────

function makeMockDb(entries: { id: number; operation: string; endpoint: string; method: string; body: string | null; created_at: string }[]) {
  return {
    getAllAsync: jest.fn().mockResolvedValue([...entries]),
    runAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: entries.length }),
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

  it('remaps local IDs after a create operation', async () => {
    const serverNote = {
      id: 'server-abc', title: 'Test', content: '', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 8,
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_temp_1', title: 'Test', content: '', note_type: 'text' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    await drainQueue(db as never);

    expect(mockReplaceLocalNoteId).toHaveBeenCalledWith(db, 'local_temp_1', serverNote);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [8]);
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

    // The id never changes, so there is no reconcile — the canonical note is
    // adopted and the pending-create marker is cleared.
    expect(mockReplaceLocalNoteId).not.toHaveBeenCalled();
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
    // Stable-id path: save canonical note and clear pending-create; no id replacement.
    expect(mockSaveNote).toHaveBeenCalledWith(db, serverNote);
    expect(mockReplaceLocalNoteId).not.toHaveBeenCalled();
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [9]);
    expect(idMappings).toEqual([{ localId: clientId, serverNote }]);
  });

  it('reconciles a legacy duplicate local_id and replaces the local note with the server note', async () => {
    // Backward-compat: old-style ops queued before this change still use { local_id }.
    // The server assigns a new id, so serverNote.id !== local_id → replaceLocalNoteId runs.
    const serverNote = {
      id: 'server-dup', title: 'Source copy', content: 'body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 10,
        operation: 'duplicate',
        endpoint: '/notes/src-123/duplicate',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_dup_1' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    const { idMappings } = await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/src-123/duplicate', { local_id: 'local_dup_1' });
    expect(mockReplaceLocalNoteId).toHaveBeenCalledWith(db, 'local_dup_1', serverNote);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [10]);
    expect(idMappings).toEqual([{ localId: 'local_dup_1', serverNote }]);
  });

  it('remaps a legacy duplicate local_id in later queue entries that reference it', async () => {
    const serverNote = {
      id: 'server-dup', title: '', content: 'body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const db = makeMockDb([
      {
        id: 17,
        operation: 'duplicate',
        endpoint: '/notes/src-123/duplicate',
        method: 'POST',
        body: JSON.stringify({ local_id: 'local_dup_1' }),
        created_at: '',
      },
      {
        id: 18,
        operation: 'update',
        endpoint: '/notes/local_dup_1',
        method: 'PATCH',
        body: JSON.stringify({ content: 'edited' }),
        created_at: '',
      },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    // The update endpoint should be remapped to the server-assigned id.
    expect(mockApi.patch).toHaveBeenCalledWith('/notes/server-dup', { content: 'edited' });
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [17]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [18]);
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
      shared_with: [{ id: 's-real', note_id: 'n1', shared_with_user_id: 'u2', shared_by_user_id: 'u1', permission_level: 'write', username: 'bob', first_name: '', last_name: '', has_profile_icon: false, created_at: '', updated_at: '' }],
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

// ── getLocalLabels ─────────────────────────────────────────────────────────

describe('getLocalLabels', () => {
  it('returns deduplicated labels from notes, sorted by name', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { labels_json: JSON.stringify([{ id: 'l2', name: 'Work' }, { id: 'l1', name: 'Home' }]) },
        { labels_json: JSON.stringify([{ id: 'l1', name: 'Home' }]) },
        { labels_json: JSON.stringify([{ id: 'l3', name: 'Alpha' }]) },
      ]),
    };

    const labels = await getLocalLabels(db as never);

    expect(labels).toEqual([
      { id: 'l3', name: 'Alpha' },
      { id: 'l1', name: 'Home' },
      { id: 'l2', name: 'Work' },
    ]);
  });

  it('returns an empty array when no notes have labels', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { labels_json: '[]' },
        { labels_json: '[]' },
      ]),
    };

    const labels = await getLocalLabels(db as never);

    expect(labels).toEqual([]);
  });

  it('ignores notes with malformed labels_json', async () => {
    const db = {
      getAllAsync: jest.fn().mockResolvedValue([
        { labels_json: 'not-json' },
        { labels_json: JSON.stringify([{ id: 'l1', name: 'Valid' }]) },
      ]),
    };

    const labels = await getLocalLabels(db as never);

    expect(labels).toEqual([{ id: 'l1', name: 'Valid' }]);
  });

  it('queries only non-trashed notes', async () => {
    const db = { getAllAsync: jest.fn().mockResolvedValue([]) };

    await getLocalLabels(db as never);

    expect(db.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('deleted_at IS NULL'),
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
        "SELECT id, labels_json FROM notes WHERE id NOT LIKE 'local_%' AND archived = 0 AND deleted_at IS NULL",
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
