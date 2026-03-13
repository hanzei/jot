/**
 * Tests for offline support: local note queries, sync queue, and ID utilities.
 */

import { generateLocalId, isLocalId, replaceLocalNoteId } from '../src/db/noteQueries';
import { drainQueue } from '../src/db/syncQueue';
import api from '../src/api/client';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    put: jest.fn(),
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

// ── generateLocalId / isLocalId ────────────────────────────────────────────

describe('generateLocalId', () => {
  it('generates a string starting with "local_"', () => {
    const id = generateLocalId();
    expect(id).toMatch(/^local_/);
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
      { id: 1, operation: 'update', endpoint: '/notes/abc', method: 'POST', body: '{"title":"hi"}', created_at: '' },
    ]);
    mockApi.post.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/abc', { title: 'hi' });
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [1]);
  });

  it('processes PUT operations and removes them from queue', async () => {
    const db = makeMockDb([
      { id: 2, operation: 'update', endpoint: '/notes/abc', method: 'PUT', body: '{"title":"updated"}', created_at: '' },
    ]);
    mockApi.put.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(mockApi.put).toHaveBeenCalledWith('/notes/abc', { title: 'updated' });
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
      { id: 5, operation: 'update', endpoint: '/notes/exists', method: 'PUT', body: '{}', created_at: '' },
    ]);
    mockApi.delete.mockRejectedValueOnce({ response: { status: 404 } });
    mockApi.put.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [4]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [5]);
  });

  it('discards 409 errors and continues processing', async () => {
    const db = makeMockDb([
      { id: 4, operation: 'update', endpoint: '/notes/conflict', method: 'PUT', body: '{}', created_at: '' },
      { id: 5, operation: 'update', endpoint: '/notes/exists', method: 'PUT', body: '{}', created_at: '' },
    ]);
    mockApi.put.mockRejectedValueOnce({ response: { status: 409 } });
    mockApi.put.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db as never);

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [4]);
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [5]);
  });

  it('stops draining on network errors (non-4xx)', async () => {
    const db = makeMockDb([
      { id: 6, operation: 'update', endpoint: '/notes/abc', method: 'PUT', body: '{}', created_at: '' },
      { id: 7, operation: 'update', endpoint: '/notes/xyz', method: 'PUT', body: '{}', created_at: '' },
    ]);
    mockApi.put.mockRejectedValueOnce(new Error('Network Error'));

    await drainQueue(db as never);

    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [6]);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM sync_queue WHERE id = ?', [7]);
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
});
