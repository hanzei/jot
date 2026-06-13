/**
 * Tests for offline support: local note queries, sync queue, and ID utilities.
 */

import { generateLocalId, isLocalId, replaceLocalNoteId, removeLocalNotesNotIn, getLocalLabels, getLocalLabelCounts, saveNote, addLabelToLocalNote, removeLabelFromLocalNote } from '../src/db/noteQueries';
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
