/**
 * Tests for offline support: local note queries, sync queue, and ID utilities.
 *
 * The database is a real SQLite engine (see `helpers/testDb.ts`), so these seed
 * rows and assert on what the queries actually read and write rather than on
 * the SQL text passed to a mock.
 */

import { generateClientNoteId, isUnsyncedNoteId, removeLocalNotesNotIn, getLocalLabelCounts, saveNote, addLabelToLocalNote, removeLabelFromLocalNote, getLocalNotes, upsertLabel, getStoredLabels } from '../src/db/noteQueries';
import { drainQueue, getSyncQueueStats, isTransientHttpStatus, getDeadLetteredOperations, MAX_ENTRY_DRAIN_ATTEMPTS, PROCESSING_ERROR_STATUS, QUEUED_WRITE_TIMEOUT_MS } from '../src/db/syncQueue';
import api from '../src/api/client';
import { makeLabel, makeListNote, makeNoteItem, makeTextNote, remainingQueueIds, seedQueueEntry } from './helpers/fixtures';
import type { NoteItem } from '@jot/shared';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

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

// saveNote runs for real (writes land in the test database) but stays a spy so
// the reconciliation-failure case below can make one call throw.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return { ...actual, saveNote: jest.fn(actual.saveNote) };
});

const mockApi = api as jest.Mocked<typeof api>;
// Every replayed queue write carries the longer queued-write timeout (#1211).
const REPLAY_CONFIG = { timeout: QUEUED_WRITE_TIMEOUT_MS };
const mockSaveNote = saveNote as jest.MockedFunction<typeof saveNote>;

let db: TestDatabase;
beforeEach(() => {
  jest.clearAllMocks();
  db = globalThis.testDb;
  // drainQueue logs every retry, discard and dead-letter decision; these suites
  // drive exactly those paths.
  silenceConsole(
    'warn',
    /^Queue drain stopped at entry/,
    /^Queue entry id=\S+ landed server-side/,
    /^Discarding queued operation/,
    /^Dead-lettering queued operation/,
    /^Dropping queued operation/,
    /^Failed to reconcile note/,
  );
  silenceConsole('info', /^Queue drain stopped at entry/, /^Dropping queued operation/);
  // A drain pulls the notes its landed writes touched (#1262). Suites that do
  // not care about the pull get a 404 for it (logged and ignored); the probe
  // and other reads keep the mock's default.
  mockApi.get.mockImplementation(((url: string) =>
    url.startsWith('/notes/') ? Promise.reject(makeAxiosError(404)) : undefined) as never);
  silenceConsole('warn', /^Failed to pull note id=\S+ after the queue drain: Request failed with status code 404$/);
});

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
    const headId = await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/a',
      method: 'PATCH',
      attempts: 2,
      created_at: '2024-01-01T00:00:00Z',
    });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/b', method: 'PATCH', attempts: 1 });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/c', method: 'PATCH' });

    expect(await getSyncQueueStats(db)).toEqual({
      pendingCount: 3,
      head: { id: headId, operation: 'update', created_at: '2024-01-01T00:00:00Z', attempts: 2 },
      maxAttempts: 2,
    });
  });

  it('returns an empty summary when the queue is empty', async () => {
    expect(await getSyncQueueStats(db)).toEqual({ pendingCount: 0, head: null, maxAttempts: 0 });
  });
});

// ── drainQueue ─────────────────────────────────────────────────────────────

describe('drainQueue', () => {
  const deadLetterRows = () => getDeadLetteredOperations(db);

  const attemptsFor = async (id: number): Promise<number | null> => {
    const row = await db.getFirstAsync<{ attempts: number }>(
      'SELECT attempts FROM sync_queue WHERE id = ?',
      [id],
    );
    return row?.attempts ?? null;
  };

  it('processes POST operations and removes them from queue', async () => {
    const id = await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes/abc',
      method: 'POST',
      body: { title: 'hi' },
    });
    mockApi.post.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/abc', { title: 'hi' }, REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).not.toContain(id);
  });

  it('processes PATCH operations and removes them from queue', async () => {
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/abc',
      method: 'PATCH',
      body: { title: 'updated' },
    });
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(mockApi.patch).toHaveBeenCalledWith('/notes/abc', { title: 'updated' }, REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('processes DELETE operations and removes them from queue', async () => {
    await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/abc', method: 'DELETE' });
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/abc', REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('discards 404 errors and continues processing', async () => {
    await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/gone', method: 'DELETE' });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/exists', method: 'PATCH', body: {} });
    mockApi.delete.mockRejectedValueOnce(makeAxiosError(404));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('discards 409 errors and continues processing', async () => {
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/conflict', method: 'PATCH', body: {} });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/exists', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(409));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('does not duplicate a createItem whose original request already committed (409 replay is dead-lettered)', async () => {
    // Models the partial-commit case: the server created item i1 but the client
    // never saw the response (transient failure), so the create was queued for
    // replay. Replaying it POSTs the same stable id, the server rejects the
    // duplicate with 409, and the entry is discarded rather than retried.
    await seedQueueEntry(db, {
      operation: 'createItem',
      endpoint: '/notes/n1/items',
      method: 'POST',
      body: { id: 'i1', text: 'a', position: 0 },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409));

    const { discardedOperations } = await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([
      { operation: 'createItem', endpoint: '/notes/n1/items', status: 409 },
    ]);
  });

  it('stops draining on network errors (non-4xx)', async () => {
    const first = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
    const second = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(new Error('Network Error'));

    await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([first, second]);
  });

  it('discards permanent 4xx errors (e.g. 400) so they cannot wedge the queue', async () => {
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/bad', method: 'PATCH', body: { title: '' } });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(400));
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db);

    // The bad entry is dead-lettered and the rest of the queue still drains.
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([
      { operation: 'update', endpoint: '/notes/bad', status: 400 },
    ]);
    expect(await deadLetterRows()).toMatchObject([{ endpoint: '/notes/bad', status: 400 }]);
  });

  it('stops draining on a 500 and retries the rest later', async () => {
    const first = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
    const second = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

    await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([first, second]);
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
  });

  it('stops draining on 429 (rate limit) and retries the rest later', async () => {
    const id = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(429));

    await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([id]);
  });

  it('stops draining on 401 (does not discard) so the op survives re-auth', async () => {
    const id = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(401));

    const { discardedOperations } = await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([id]);
    expect(discardedOperations).toHaveLength(0);
  });

  it('stops draining on a non-Axios error rather than discarding the entry', async () => {
    const id = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(new Error('unexpected'));

    const { discardedOperations } = await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([id]);
    expect(discardedOperations).toHaveLength(0);
  });

  // ── head-of-line handling: per-entry attempt counter + dead-letter (#714) ──

  it('increments the attempt counter and stops (no dead-letter) below the cap on a persistent 5xx (#714)', async () => {
    const id = await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/abc',
      method: 'PATCH',
      body: {},
      attempts: 0,
    });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

    const { discardedOperations } = await drainQueue(db);

    expect(await attemptsFor(id)).toBe(1);
    expect(await remainingQueueIds(db)).toEqual([id]);
    expect(discardedOperations).toHaveLength(0);
    expect(await deadLetterRows()).toEqual([]);
  });

  it('dead-letters a persistently-failing 5xx entry at the cap and drains past it (#714)', async () => {
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/stuck',
      method: 'PATCH',
      body: {},
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500)); // stuck — one more failure hits the cap
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never); // the unaffected note

    const { discardedOperations } = await drainQueue(db);

    // The stuck entry is charged, dead-lettered, and removed from the queue...
    expect(await deadLetterRows()).toMatchObject([
      { endpoint: '/notes/stuck', status: 500, attempts: MAX_ENTRY_DRAIN_ATTEMPTS },
    ]);
    expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/stuck', status: 500 }]);
    // ...and the later entry for an unaffected note still drains.
    expect(mockApi.patch).toHaveBeenCalledWith('/notes/ok', {}, REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('drops a persistently-failing markViewed at the cap without dead-lettering or flagging the note', async () => {
    // Marking a note viewed is best-effort: it must never surface as a failed
    // sync, whether the server rejects it outright or keeps failing.
    await saveNote(db, makeTextNote({ id: 'viewed' }));
    await seedQueueEntry(db, {
      operation: 'markViewed',
      endpoint: '/notes/viewed/viewed',
      method: 'POST',
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(500));

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetterRows()).toEqual([]);
    expect(discardedOperations).toEqual([]);
    expect(await remainingQueueIds(db)).toEqual([]);
    const row = await db.getFirstAsync<{ sync_state: string }>('SELECT sync_state FROM notes WHERE id = ?', ['viewed']);
    expect(row?.sync_state).toBe('synced');
  });

  it('dead-letters a non-HTTP processing error at the cap and continues past it (#714)', async () => {
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/corrupt',
      method: 'PATCH',
      body: {},
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/ok', method: 'PATCH', body: {} });
    mockApi.patch.mockRejectedValueOnce(new Error('boom')); // non-axios throw processing the first entry
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db);

    // A non-HTTP throw is recorded with the processing-error sentinel status (0).
    expect(discardedOperations).toEqual([
      { operation: 'update', endpoint: '/notes/corrupt', status: PROCESSING_ERROR_STATUS },
    ]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('records attempts and error_message on the dead_letter row (#714)', async () => {
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/x',
      method: 'PATCH',
      body: {},
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
      created_at: '2026-03-01T00:00:00Z',
    });
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

    await drainQueue(db);

    const row = (await deadLetterRows())[0]!;
    expect(row).toMatchObject({
      operation: 'update',
      endpoint: '/notes/x',
      method: 'PATCH',
      status: 500,
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS,
      created_at: '2026-03-01T00:00:00Z',
    });
    expect(typeof row.error_message).toBe('string');
    expect(row.error_message).toBeTruthy();
  });

  it('drops later queued ops for a note whose create was dead-lettered, without hitting the server (#714 cascade)', async () => {
    const clientId = 'Cascade0000000000000ab'; // 22-char server-valid id
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: clientId, content: 'x', note_type: 'text' },
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: `/notes/${clientId}`,
      method: 'PATCH',
      body: { title: 'later' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(500)); // create hits the cap and dead-letters

    const { discardedOperations } = await drainQueue(db);

    // The create is dead-lettered, and the dependent update is dropped without
    // an API call (no orphan 404) — both leave the queue.
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(mockApi.patch).not.toHaveBeenCalled();
    // Only the create surfaces as discarded; the dependent drop is silent.
    expect(discardedOperations).toEqual([{ operation: 'create', endpoint: '/notes', status: 500 }]);
    expect(await deadLetterRows()).toHaveLength(1);
  });

  it('does not charge the attempt counter on a global connectivity failure (network error) (#714)', async () => {
    const id = await seedQueueEntry(db, {
      operation: 'update',
      endpoint: '/notes/abc',
      method: 'PATCH',
      body: {},
      attempts: 2,
    });
    // An axios error with no response models a network failure/timeout at the transport.
    mockApi.patch.mockRejectedValueOnce(
      Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined }),
    );

    await drainQueue(db);

    expect(await attemptsFor(id)).toBe(2);
    expect(await remainingQueueIds(db)).toEqual([id]);
  });

  describe('a client-side timeout (#1211)', () => {
    const makeTimeoutError = (code: 'ECONNABORTED' | 'ETIMEDOUT') =>
      Object.assign(new Error('timeout of 5000ms exceeded'), { isAxiosError: true, code, response: undefined });

    const seedAtCap = async () => {
      const first = await seedQueueEntry(db, {
        operation: 'update',
        endpoint: '/notes/abc',
        method: 'PATCH',
        body: {},
        attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
      });
      const second = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: {} });
      return { first, second };
    };

    it.each(['ECONNABORTED', 'ETIMEDOUT'] as const)(
      'is charged to the entry when the server answers the probe (%s), so it dead-letters at the cap',
      async (code) => {
        const { second } = await seedAtCap();
        mockApi.patch.mockRejectedValueOnce(makeTimeoutError(code)); // this op always outlasts the write timeout
        mockApi.get.mockResolvedValueOnce({ data: {} } as never);
        mockApi.patch.mockResolvedValueOnce({ data: {} } as never); // the unaffected note
        // The unaffected note's write landed, so the drain pulls it afterwards.
        mockApi.get.mockResolvedValueOnce({ data: makeTextNote({ id: 'xyz' }) } as never);

        const { discardedOperations } = await drainQueue(db);

        // The probe, then the post-drain pull.
        expect(mockApi.get).toHaveBeenCalledTimes(2);
        expect(mockApi.get).toHaveBeenLastCalledWith('/notes/xyz');
        expect(await deadLetterRows()).toMatchObject([
          { endpoint: '/notes/abc', status: PROCESSING_ERROR_STATUS, attempts: MAX_ENTRY_DRAIN_ATTEMPTS },
        ]);
        expect(discardedOperations).toEqual([
          { operation: 'update', endpoint: '/notes/abc', status: PROCESSING_ERROR_STATUS },
        ]);
        expect(mockApi.patch).toHaveBeenCalledWith('/notes/xyz', {}, REPLAY_CONFIG);
        expect(await remainingQueueIds(db)).not.toContain(second);
      },
    );

    it('is global when the server does not answer the probe: no charge, no dead-letter', async () => {
      const { first, second } = await seedAtCap();
      mockApi.patch.mockRejectedValueOnce(makeTimeoutError('ECONNABORTED'));
      mockApi.get.mockRejectedValueOnce(makeTimeoutError('ECONNABORTED'));

      const { discardedOperations } = await drainQueue(db);

      expect(mockApi.get).toHaveBeenCalledTimes(1);
      expect(await attemptsFor(first)).toBe(MAX_ENTRY_DRAIN_ATTEMPTS - 1);
      expect(await remainingQueueIds(db)).toEqual([first, second]);
      expect(mockApi.patch).toHaveBeenCalledTimes(1);
      expect(discardedOperations).toEqual([]);
      expect(await deadLetterRows()).toEqual([]);
    });

    it('does not probe on a plain network error', async () => {
      const { first } = await seedAtCap();
      mockApi.patch.mockRejectedValueOnce(
        Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', response: undefined }),
      );

      await drainQueue(db);

      expect(mockApi.get).not.toHaveBeenCalled();
      expect(await attemptsFor(first)).toBe(MAX_ENTRY_DRAIN_ATTEMPTS - 1);
    });

    it('does not probe on an aborted request (ECONNABORTED without a timeout)', async () => {
      const { first } = await seedAtCap();
      mockApi.patch.mockRejectedValueOnce(
        Object.assign(new Error('Request aborted'), { isAxiosError: true, code: 'ECONNABORTED', response: undefined }),
      );

      await drainQueue(db);

      expect(mockApi.get).not.toHaveBeenCalled();
      expect(await attemptsFor(first)).toBe(MAX_ENTRY_DRAIN_ATTEMPTS - 1);
    });
  });

  describe('a gateway status (502/503/504) from a reverse proxy', () => {
    const seedAtCap = async () => {
      const first = await seedQueueEntry(db, {
        operation: 'update',
        endpoint: '/notes/abc',
        method: 'PATCH',
        body: {},
        attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
      });
      const second = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/xyz', method: 'PATCH', body: {} });
      return { first, second };
    };

    it.each([
      ['also gets a gateway status', () => mockApi.get.mockRejectedValueOnce(makeAxiosError(502))],
      ['gets no response', () => mockApi.get.mockRejectedValueOnce(
        Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined }),
      )],
    ])('is global when the server probe %s: no charge, no dead-letter', async (_label, mockProbe) => {
      const { first, second } = await seedAtCap();
      mockApi.patch.mockRejectedValueOnce(makeAxiosError(503));
      mockProbe();

      const { discardedOperations } = await drainQueue(db);

      // Even at the cap, the entry stays queued and uncharged, and the drain
      // stops rather than trying later entries.
      expect(mockApi.get).toHaveBeenCalledTimes(1);
      expect(await attemptsFor(first)).toBe(MAX_ENTRY_DRAIN_ATTEMPTS - 1);
      expect(await remainingQueueIds(db)).toEqual([first, second]);
      expect(mockApi.patch).toHaveBeenCalledTimes(1);
      expect(discardedOperations).toEqual([]);
      expect(await deadLetterRows()).toEqual([]);
    });

    it.each([
      ['succeeds', () => mockApi.get.mockResolvedValueOnce({ data: {} } as never)],
      ['gets an error status from the server itself', () => mockApi.get.mockRejectedValueOnce(makeAxiosError(401))],
    ])('is charged to the entry when the server probe %s, so it still dead-letters at the cap', async (_label, mockProbe) => {
      const { second } = await seedAtCap();
      mockApi.patch.mockRejectedValueOnce(makeAxiosError(504)); // this op times out at the proxy
      mockProbe();
      mockApi.patch.mockResolvedValueOnce({ data: {} } as never); // the unaffected note

      const { discardedOperations } = await drainQueue(db);

      expect(await deadLetterRows()).toMatchObject([
        { endpoint: '/notes/abc', status: 504, attempts: MAX_ENTRY_DRAIN_ATTEMPTS },
      ]);
      expect(discardedOperations).toEqual([{ operation: 'update', endpoint: '/notes/abc', status: 504 }]);
      expect(mockApi.patch).toHaveBeenCalledWith('/notes/xyz', {}, REPLAY_CONFIG);
      expect(await remainingQueueIds(db)).not.toContain(second);
    });

    it('does not probe on a 500', async () => {
      await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/abc', method: 'PATCH', body: {} });
      mockApi.patch.mockRejectedValueOnce(makeAxiosError(500));

      await drainQueue(db);

      expect(mockApi.get).not.toHaveBeenCalled();
    });
  });

  it('drops an entry whose server write landed but post-response reconciliation threw, without dead-lettering (#714)', async () => {
    const clientId = 'Landed00000000000000ab'; // 22-char server-valid id
    // Sitting at the cap: proves a landed-then-reconcile-fail is NOT dead-lettered.
    const id = await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: clientId, content: 'x', note_type: 'text' },
      attempts: MAX_ENTRY_DRAIN_ATTEMPTS - 1,
    });
    mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: clientId }) } as never); // request lands
    mockSaveNote.mockRejectedValueOnce(new Error('local db write failed')); // reconciliation throws

    const { discardedOperations } = await drainQueue(db);

    // The entry is removed because the write landed — not retried, not dead-lettered.
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toHaveLength(0);
    expect(await deadLetterRows()).toEqual([]);
    expect(await attemptsFor(id)).toBeNull();
  });

  it('keeps a client-supplied create id stable: adopts the server note, clears pending, no reconcile (#475)', async () => {
    const clientId = 'AbcdefghijklmnopqrstUv'; // 22-char server-valid id
    const serverNote = makeTextNote({ id: clientId, content: 'Test' });
    // The optimistic local row, still flagged pending its server confirmation.
    await saveNote(db, makeTextNote({ id: clientId, content: 'Test' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'pending' WHERE id = ?`, [clientId]);
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: clientId, content: 'Test', note_type: 'text' },
    });
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    const { syncedNotes } = await drainQueue(db);

    // The id never changes — adopt the canonical note and clear the pending-create marker.
    expect(await db.getFirstAsync('SELECT id, sync_state FROM notes WHERE id = ?', [clientId])).toEqual({
      id: clientId,
      sync_state: 'synced',
    });
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(syncedNotes).toEqual([serverNote]);
  });

  it('clears the pending marker when a replayed create returns 409 (#475)', async () => {
    const clientId = 'Replay00000000000000Ab';
    await saveNote(db, makeTextNote({ id: clientId, content: 'Test' }));
    await db.runAsync(`UPDATE notes SET sync_state = 'pending' WHERE id = ?`, [clientId]);
    await seedQueueEntry(db, {
      operation: 'create',
      endpoint: '/notes',
      method: 'POST',
      body: { id: clientId, content: 'Test', note_type: 'text' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);

    const { discardedOperations } = await drainQueue(db);

    expect(await db.getFirstAsync('SELECT sync_state FROM notes WHERE id = ?', [clientId])).toEqual({
      sync_state: 'synced',
    });
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([
      { operation: 'create', endpoint: '/notes', status: 409 },
    ]);
  });

  it('adopts the server note and clears pending-create when duplicate uses a client-supplied id', async () => {
    // New-style offline duplicate: client sends { id }. The server keeps it, so
    // serverNote.id === clientId (saveNote + clearNotePendingCreate).
    const clientId = 'DupClientId000000000Ab';
    const serverNote = makeTextNote({ id: clientId, content: 'body' });
    await seedQueueEntry(db, {
      operation: 'duplicate',
      endpoint: '/notes/src-123/duplicate',
      method: 'POST',
      body: { id: clientId },
    });
    mockApi.post.mockResolvedValueOnce({ data: serverNote } as never);

    const { syncedNotes } = await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/src-123/duplicate', { id: clientId }, REPLAY_CONFIG);
    // The canonical note is saved locally and carries no pending marker.
    expect(await db.getFirstAsync('SELECT id, content, sync_state FROM notes WHERE id = ?', [clientId])).toEqual({
      id: clientId,
      content: 'body',
      sync_state: 'synced',
    });
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(syncedNotes).toEqual([serverNote]);
  });

  it('resolves a createLabel 409 as idempotent when the server label has the same ID (replay)', async () => {
    const clientId = 'ClientLblId00000000001';
    await seedQueueEntry(db, {
      operation: 'createLabel',
      endpoint: '/labels',
      method: 'POST',
      body: { id: clientId, name: 'Work' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: { labels: [{ id: clientId, name: 'Work' }] } } as never);

    const { discardedOperations } = await drainQueue(db);

    // Resolved via GET /labels — same server ID, no remap needed.
    expect(mockApi.get).toHaveBeenCalledWith('/labels');
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(await deadLetterRows()).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('persists the server ID for a createLabel 409 name collision, across drains', async () => {
    const clientId = 'ClientLblId00000000002';
    const serverLblId = 'ServerLblId0000000002';
    await seedQueueEntry(db, {
      operation: 'createLabel',
      endpoint: '/labels',
      method: 'POST',
      body: { id: clientId, name: 'Home' },
    });
    await seedQueueEntry(db, {
      operation: 'deleteLabel',
      endpoint: `/labels/${clientId}`,
      method: 'DELETE',
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: { labels: [makeLabel({ id: serverLblId, name: 'Home' })] } } as never);
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    const { discardedOperations } = await drainQueue(db);

    // Downstream delete endpoint remapped to the server label ID.
    expect(mockApi.delete).toHaveBeenCalledWith(`/labels/${serverLblId}`, REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('rewrites the label id in later queued ops, the label store and local notes on a name collision', async () => {
    const clientId = 'ClientLblId00000000003';
    const serverLabel = { id: 'ServerLblId0000000003', user_id: 'u1', name: 'Home', created_at: 't', updated_at: 't' };
    await upsertLabel(db, { ...serverLabel, id: clientId });
    await saveNote(db, makeTextNote({ id: 'n1', labels: [{ ...serverLabel, id: clientId }] }));
    await seedQueueEntry(db, { operation: 'createLabel', endpoint: '/labels', method: 'POST', body: { id: clientId, name: 'Home' } });
    // The drain stops after the create, so the op behind it is replayed in a later drain.
    await seedQueueEntry(db, { operation: 'renameLabel', endpoint: `/labels/${clientId}`, method: 'PATCH', body: { name: 'Haus' } });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: { labels: [serverLabel] } } as never);
    mockApi.patch.mockRejectedValueOnce(makeAxiosError(503) as never);

    await drainQueue(db);

    const queued = await db.getAllAsync<{ endpoint: string }>('SELECT endpoint FROM sync_queue');
    expect(queued).toEqual([{ endpoint: `/labels/${serverLabel.id}` }]);
    // Its recorded key moves with it (#1282).
    expect(await db.getAllAsync('SELECT key FROM sync_queue_keys')).toEqual([{ key: `label:${serverLabel.id}` }]);
    expect((await getStoredLabels(db)).map((l) => l.id)).toEqual([serverLabel.id]);
    const row = await db.getFirstAsync<{ labels_json: string }>("SELECT labels_json FROM notes WHERE id = 'n1'");
    expect((JSON.parse(row!.labels_json) as { id: string }[]).map((l) => l.id)).toEqual([serverLabel.id]);
  });

  it('dead-letters a createLabel 409 when the label is not found via GET /labels', async () => {
    await seedQueueEntry(db, {
      operation: 'createLabel',
      endpoint: '/labels',
      method: 'POST',
      body: { id: 'ClientLblId00000000003', name: 'Gone' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockResolvedValueOnce({ data: { labels: [] } } as never);

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetterRows()).toMatchObject([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('dead-letters a createLabel 409 when the GET /labels lookup itself fails', async () => {
    await seedQueueEntry(db, {
      operation: 'createLabel',
      endpoint: '/labels',
      method: 'POST',
      body: { id: 'ClientLblId00000000004', name: 'Fail' },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(409) as never);
    mockApi.get.mockRejectedValueOnce(new Error('Network Error') as never);

    const { discardedOperations } = await drainQueue(db);

    expect(await deadLetterRows()).toHaveLength(1);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(discardedOperations).toEqual([{ operation: 'createLabel', endpoint: '/labels', status: 409 }]);
  });

  it('persists the note returned by an addLabelToNote replay', async () => {
    const note = makeTextNote({
      id: 'n1',
      content: 'body',
      labels: [makeLabel({ id: 'srv_lbl', name: 'Work' })],
    });
    await seedQueueEntry(db, {
      operation: 'addLabelToNote',
      endpoint: '/notes/n1/labels',
      method: 'POST',
      body: { name: 'Work' },
    });
    mockApi.post.mockResolvedValueOnce({ data: note } as never);

    await drainQueue(db);

    expect(await db.getFirstAsync('SELECT labels_json FROM notes WHERE id = ?', ['n1'])).toEqual({
      labels_json: JSON.stringify(note.labels),
    });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('persists the note returned by a convertNoteType replay', async () => {
    const note = makeListNote({
      id: 'n1',
      version: 4,
      items: [makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Buy milk' })],
    });
    await seedQueueEntry(db, {
      operation: 'convertNoteType',
      endpoint: '/notes/n1/convert',
      method: 'POST',
      body: { note_type: 'list', items: [{ id: 'i1', text: 'Buy milk', position: 0, completed: false }] },
    });
    mockApi.post.mockResolvedValueOnce({ data: note } as never);

    await drainQueue(db);

    expect(await db.getFirstAsync('SELECT note_type, version FROM notes WHERE id = ?', ['n1'])).toEqual({
      note_type: 'list',
      version: 4,
    });
    expect(await db.getAllAsync('SELECT id, text FROM note_items WHERE note_id = ?', ['n1'])).toEqual([
      { id: 'i1', text: 'Buy milk' },
    ]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('reconciles all authoritative fields (not just completed) from a single-item setItemsCompleted replay', async () => {
    // The server returns the note's full, authoritative item list on this
    // endpoint. If the local DB only patched `completed`, a stale local
    // parent_id/position left over from an earlier partial sync would never
    // get corrected, and the toggle would end up rendered against the wrong
    // item's row.
    await saveNote(
      db,
      makeListNote({
        id: 'n1',
        items: [
          makeNoteItem({ id: 'kitchen', note_id: 'n1', text: 'Kitchen', position: 0 }),
          makeNoteItem({ id: 'mirror', note_id: 'n1', text: 'Mirror', position: 2 }),
          makeNoteItem({ id: 'i1', note_id: 'n1', text: 'stale', position: 9, parent_id: null }),
          makeNoteItem({ id: 'i2', note_id: 'n1', text: 'stale', position: 9, parent_id: null }),
        ],
      }),
    );
    await seedQueueEntry(db, {
      operation: 'setItemsCompleted',
      endpoint: '/notes/n1/items/set-completed',
      method: 'POST',
      body: { item_ids: ['i1'], completed: true },
    });
    mockApi.post.mockResolvedValueOnce({
      data: [
        { id: 'i1', text: 'Replace faucet', completed: true, position: 1, parent_id: 'kitchen', assigned_to: '' },
        { id: 'i2', text: 'Hgg', completed: false, position: 4, parent_id: 'mirror', assigned_to: '' },
      ],
    } as never);

    await drainQueue(db);

    expect(
      await db.getAllAsync(
        'SELECT id, text, completed, position, parent_id FROM note_items WHERE id IN (?, ?) ORDER BY id',
        ['i1', 'i2'],
      ),
    ).toEqual([
      { id: 'i1', text: 'Replace faucet', completed: 1, position: 1, parent_id: 'kitchen' },
      { id: 'i2', text: 'Hgg', completed: 0, position: 4, parent_id: 'mirror' },
    ]);
  });

  it('reconciles all authoritative fields from a multi-item setItemsCompleted replay, upserting a locally-missing item', async () => {
    // i2 simulates an item created on another device while this one was
    // offline, so no local row exists yet — the upsert's UPDATE is a no-op and
    // the INSERT OR IGNORE is what actually creates it.
    await saveNote(
      db,
      makeListNote({
        id: 'n1',
        items: [makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Milk', completed: true })],
      }),
    );
    await seedQueueEntry(db, {
      operation: 'setItemsCompleted',
      endpoint: '/notes/n1/items/set-completed',
      method: 'POST',
      body: { item_ids: ['i1', 'i2'], completed: false },
    });
    mockApi.post.mockResolvedValueOnce({
      data: [
        { id: 'i1', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '' },
        { id: 'i2', text: 'Eggs', completed: false, position: 1, parent_id: null, assigned_to: '' },
      ],
    } as never);

    await drainQueue(db);

    expect(
      await db.getAllAsync('SELECT id, text, completed FROM note_items WHERE note_id = ? ORDER BY position', ['n1']),
    ).toEqual([
      { id: 'i1', text: 'Milk', completed: 0 },
      { id: 'i2', text: 'Eggs', completed: 0 },
    ]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it("prunes a local item absent from a deleteCompletedItems replay's remaining-items response", async () => {
    // The endpoint's response is the note's full, authoritative remaining item
    // list post-delete — not just the requested ids' outcome — so any local
    // row absent from it must be removed too, including one that was never in
    // the queued item_ids (e.g. cascade-deleted alongside its parent, or
    // removed by another session while this device was offline).
    await saveNote(
      db,
      makeListNote({
        id: 'n1',
        items: [
          makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Done', completed: true, position: 0 }),
          makeNoteItem({ id: 'i2', note_id: 'n1', text: 'Gone elsewhere', position: 1 }),
          makeNoteItem({ id: 'i3', note_id: 'n1', text: 'Bread', position: 2 }),
        ],
      }),
    );
    await seedQueueEntry(db, {
      operation: 'deleteCompletedItems',
      endpoint: '/notes/n1/items/delete',
      method: 'POST',
      body: { item_ids: ['i1'] },
    });
    mockApi.post.mockResolvedValueOnce({
      data: [{ id: 'i3', text: 'Bread', completed: false, position: 0, parent_id: null, assigned_to: '' }],
    } as never);

    await drainQueue(db);

    // i1 (requested) and i2 (never requested, but absent from the
    // authoritative response) are both pruned.
    expect(await db.getAllAsync('SELECT id FROM note_items WHERE note_id = ?', ['n1'])).toEqual([{ id: 'i3' }]);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  describe('an item whose createItem is still queued', () => {
    const queueCreateItem = (item: NoteItem) =>
      seedQueueEntry(db, {
        operation: 'createItem',
        endpoint: `/notes/${item.note_id}/items`,
        method: 'POST',
        body: { id: item.id, text: item.text, position: item.position, completed: item.completed, parent_id: item.parent_id },
      });
    const queueDeleteCompleted = (itemIds: string[]) =>
      seedQueueEntry(db, { operation: 'deleteCompletedItems', endpoint: '/notes/n1/items/delete', method: 'POST', body: { item_ids: itemIds } });
    const localItemIds = () => db.getAllAsync('SELECT id, parent_id FROM note_items WHERE note_id = ? ORDER BY id', ['n1']);

    it('survives a bulk delete that replays first', async () => {
      // Offline: the user deletes the checked items, then adds a new one. The
      // delete's remaining-items list cannot contain an item the server has
      // not been told about yet.
      const done = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Done', completed: true, position: 0 });
      const kept = makeNoteItem({ id: 'i2', note_id: 'n1', text: 'Bread', position: 1 });
      const added = makeNoteItem({ id: 'i3', note_id: 'n1', text: 'Added offline', position: 2 });
      await saveNote(db, makeListNote({ id: 'n1', items: [done, kept, added] }));
      await queueDeleteCompleted(['i1']);
      await queueCreateItem(added);
      mockApi.post.mockResolvedValueOnce({ data: [kept] } as never).mockResolvedValueOnce({ data: added } as never);

      await drainQueue(db);

      expect(await localItemIds()).toEqual([{ id: 'i2', parent_id: null }, { id: 'i3', parent_id: null }]);
      expect(await remainingQueueIds(db)).toEqual([]);
    });

    it('survives the create of its note replaying first', async () => {
      // Offline: the user creates a list note, then adds an item to it. The
      // create's response is the note as created, without the later item.
      const first = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Milk', position: 0 });
      const added = makeNoteItem({ id: 'i2', note_id: 'n1', text: 'Added offline', position: 1 });
      await saveNote(db, makeListNote({ id: 'n1', items: [first, added] }));
      await seedQueueEntry(db, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { id: 'n1', note_type: 'list', title: '', items: [{ id: 'i1', text: 'Milk', position: 0 }] },
      });
      await queueCreateItem(added);
      mockApi.post
        .mockResolvedValueOnce({ data: makeListNote({ id: 'n1', items: [first] }) } as never)
        .mockResolvedValueOnce({ data: added } as never);
      // The create's response was held back behind the createItem, which
      // returns only the item, so the drain pulls the note afterwards (#1262).
      mockApi.get.mockResolvedValueOnce({ data: makeListNote({ id: 'n1', items: [first, added] }) } as never);

      await drainQueue(db);

      expect(await localItemIds()).toEqual([{ id: 'i1', parent_id: null }, { id: 'i2', parent_id: null }]);
      expect(await remainingQueueIds(db)).toEqual([]);
      expect(mockApi.get.mock.calls.map(([url]) => url)).toEqual(['/notes/n1']);
    });

    it('is re-homed when the prune removes its parent', async () => {
      // Offline: the user adds a child under 'p', which a collaborator has since
      // deleted on the server.
      const parent = makeNoteItem({ id: 'p', note_id: 'n1', text: 'Parent', position: 0 });
      const done = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Done', completed: true, position: 1 });
      const child = makeNoteItem({ id: 'c', note_id: 'n1', text: 'Child', position: 2, parent_id: 'p' });
      await saveNote(db, makeListNote({ id: 'n1', items: [parent, done, child] }));
      await queueDeleteCompleted(['i1']);
      await queueCreateItem(child);
      mockApi.post.mockResolvedValueOnce({ data: [] } as never).mockResolvedValueOnce({ data: { ...child, parent_id: null } } as never);

      await drainQueue(db);

      expect(await localItemIds()).toEqual([{ id: 'c', parent_id: null }]);
    });

    it('is still pruned by a local write, which lists the device\'s own items', async () => {
      const first = makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Milk', position: 0 });
      const added = makeNoteItem({ id: 'i2', note_id: 'n1', text: 'Added offline', position: 1 });
      await saveNote(db, makeListNote({ id: 'n1', items: [first, added] }));
      await queueCreateItem(added);

      await saveNote(db, makeListNote({ id: 'n1', items: [first] }));

      expect(await localItemIds()).toEqual([{ id: 'i1', parent_id: null }]);
    });
  });

  it('resolves a deleteCompletedItems replay silently on a 404 (note already gone)', async () => {
    await seedQueueEntry(db, {
      operation: 'deleteCompletedItems',
      endpoint: '/notes/n1/items/delete',
      method: 'POST',
      body: { item_ids: ['i1'] },
    });
    mockApi.post.mockRejectedValueOnce(makeAxiosError(404));

    const { discardedOperations } = await drainQueue(db);

    expect(await remainingQueueIds(db)).toEqual([]);
    expect(await deadLetterRows()).toEqual([]);
    expect(discardedOperations).toEqual([
      { operation: 'deleteCompletedItems', endpoint: '/notes/n1/items/delete', status: 404 },
    ]);
  });

  it('persists the note returned by a removeLabelFromNote replay', async () => {
    await saveNote(
      db,
      makeTextNote({
        id: 'n1',
        content: 'body',
        labels: [makeLabel({ id: 'l1', name: 'Work' })],
      }),
    );
    await seedQueueEntry(db, {
      operation: 'removeLabelFromNote',
      endpoint: '/notes/n1/labels/l1',
      method: 'DELETE',
    });
    mockApi.delete.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'body' }) } as never);

    await drainQueue(db);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/n1/labels/l1', REPLAY_CONFIG);
    expect(await db.getFirstAsync('SELECT labels_json FROM notes WHERE id = ?', ['n1'])).toEqual({
      labels_json: '[]',
    });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('processes updateSettings PATCH and sets syncedSettings in the result', async () => {
    await seedQueueEntry(db, {
      operation: 'updateSettings',
      endpoint: '/users/me',
      method: 'PATCH',
      body: { language: 'de' },
    });
    mockApi.patch.mockResolvedValueOnce({ data: {} } as never);

    const { syncedSettings } = await drainQueue(db);

    expect(mockApi.patch).toHaveBeenCalledWith('/users/me', { language: 'de' }, REPLAY_CONFIG);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(syncedSettings).toBe(true);
  });

  it('reconciles the note from the server after a share op (204 has no body)', async () => {
    const shares = [
      {
        id: 's-real', note_id: 'n1', shared_with_user_id: 'u2', shared_by_user_id: 'u1',
        username: 'bob', first_name: '', last_name: '', has_profile_icon: false,
        created_at: '', updated_at: '',
      },
    ];
    // A content edit still queued locally must survive the share reconcile.
    await saveNote(db, makeTextNote({ id: 'n1', content: 'local edit' }));
    await seedQueueEntry(db, {
      operation: 'share',
      endpoint: '/notes/n1/share',
      method: 'POST',
      body: { user_id: 'u2' },
    });
    mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockResolvedValueOnce({
      data: makeTextNote({ id: 'n1', content: 'server copy', is_shared: true, shared_with: shares }),
    } as never);

    await drainQueue(db);

    expect(mockApi.post).toHaveBeenCalledWith('/notes/n1/share', { user_id: 'u2' }, REPLAY_CONFIG);
    // The optimistic `optimistic_<userId>` share row is replaced by re-fetching
    // the canonical note (share returns 204, so there is no response body). Only
    // the share columns are written, not a full saveNote, so the local content
    // edit isn't clobbered.
    expect(mockApi.get).toHaveBeenCalledWith('/notes/n1');
    expect(await db.getFirstAsync('SELECT content, is_shared, shared_with_json FROM notes WHERE id = ?', ['n1'])).toEqual({
      content: 'local edit',
      is_shared: 1,
      shared_with_json: JSON.stringify(shares),
    });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('reconciles the note from the server after an unshare op', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', is_shared: true, shared_with: [] }));
    await seedQueueEntry(db, {
      operation: 'unshare',
      endpoint: '/notes/n1/shares/u2',
      method: 'DELETE',
    });
    mockApi.delete.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockResolvedValueOnce({
      data: makeTextNote({ id: 'n1', is_shared: false, shared_with: [] }),
    } as never);

    await drainQueue(db);

    expect(mockApi.delete).toHaveBeenCalledWith('/notes/n1/shares/u2', REPLAY_CONFIG);
    expect(mockApi.get).toHaveBeenCalledWith('/notes/n1');
    expect(await db.getFirstAsync('SELECT is_shared, shared_with_json FROM notes WHERE id = ?', ['n1'])).toEqual({
      is_shared: 0,
      shared_with_json: '[]',
    });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('still drains a share op when the post-share reconcile fetch fails', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', is_shared: false }));
    await seedQueueEntry(db, {
      operation: 'share',
      endpoint: '/notes/n1/share',
      method: 'POST',
      body: { user_id: 'u2' },
    });
    mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
    mockApi.get.mockRejectedValueOnce(makeAxiosError(500));

    await drainQueue(db);

    // The share itself succeeded, so the entry is removed even though the
    // best-effort reconcile fetch failed (the next background sync reconciles).
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(await db.getFirstAsync('SELECT is_shared FROM notes WHERE id = ?', ['n1'])).toEqual({ is_shared: 0 });
  });

  describe('applying a replayed note response (#1262)', () => {
    const localNote = () => db.getFirstAsync('SELECT content, version FROM notes WHERE id = ?', ['n1']);
    const queueUpdate = (body: Record<string, unknown>) =>
      seedQueueEntry(db, { operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body });

    it('keeps an offline edit queued behind its note\'s create', async () => {
      // Offline: create "A", keep typing to "AB".
      await saveNote(db, makeTextNote({ id: 'n1', content: 'AB', version: 1 }));
      await seedQueueEntry(db, {
        operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'n1', note_type: 'text', content: 'A' },
      });
      await queueUpdate({ content: 'AB' });
      mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'A', version: 1 }) } as never);
      mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'AB', version: 2 }) } as never);

      const { syncedNotes } = await drainQueue(db);

      expect(mockApi.patch).toHaveBeenCalledWith('/notes/n1', { content: 'AB', base_version: 1 }, REPLAY_CONFIG);
      expect(await localNote()).toEqual({ content: 'AB', version: 2 });
      // The held-back create response is not handed to the UI cache either.
      expect(syncedNotes).toEqual([]);
      // The last response settled the note, so nothing is pulled.
      expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('adopts the version a create produced so the queued edit behind it does not self-conflict', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'AB', version: 0 }));
      await seedQueueEntry(db, {
        operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'n1', note_type: 'text', content: 'A' },
      });
      await queueUpdate({ content: 'AB' });
      mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'A', version: 1 }) } as never);
      mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'AB', version: 2 }) } as never);

      await drainQueue(db);

      expect(mockApi.patch).toHaveBeenCalledWith('/notes/n1', { content: 'AB', base_version: 1 }, REPLAY_CONFIG);
    });

    it('saves the whole response when no further op for the note is queued', async () => {
      // Offline pin while a collaborator edits the content: the protected note
      // skipped that edit, so the pin's response is the first sight of it.
      await saveNote(db, makeTextNote({ id: 'n1', content: 'old', version: 5 }));
      await queueUpdate({ pinned: true });
      mockApi.patch.mockResolvedValueOnce({
        data: makeTextNote({ id: 'n1', content: 'collaborator edit', version: 6, pinned: true }),
      } as never);

      await drainQueue(db);

      expect(await localNote()).toEqual({ content: 'collaborator edit', version: 6 });
    });

    it('does not adopt an unguarded response version, so a later content edit still conflicts', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'mine', version: 5 }));
      await queueUpdate({ pinned: true });
      await queueUpdate({ content: 'mine' });
      mockApi.patch
        .mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'collaborator edit', version: 6 }) } as never)
        .mockRejectedValueOnce(makeAxiosError(409));

      await drainQueue(db);

      // Replayed against the version this device last saw, not the
      // collaborator's, so the server rejects it instead of overwriting.
      expect(mockApi.patch).toHaveBeenNthCalledWith(2, '/notes/n1', { content: 'mine', base_version: 5 }, REPLAY_CONFIG);
      expect(await getDeadLetteredOperations(db)).toMatchObject([{ operation: 'update', status: 409, note_id: 'n1' }]);
      expect(await localNote()).toEqual({ content: 'mine', version: 5 });
    });

    it('does not adopt a guarded response whose version skipped past the base', async () => {
      // A no-op content write is not version-checked, so the server can answer
      // with a version that includes a collaborator's edit.
      await saveNote(db, makeTextNote({ id: 'n1', content: 'mine', version: 5 }));
      await queueUpdate({ content: 'same' });
      await queueUpdate({ content: 'mine' });
      mockApi.patch
        .mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'same', version: 7 }) } as never)
        .mockRejectedValueOnce(makeAxiosError(409));

      await drainQueue(db);

      expect(mockApi.patch).toHaveBeenNthCalledWith(2, '/notes/n1', { content: 'mine', base_version: 5 }, REPLAY_CONFIG);
    });

    it('holds back a response when an op for the note is enqueued while it is in flight', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'A', version: 1 }));
      await seedQueueEntry(db, {
        operation: 'create', endpoint: '/notes', method: 'POST', body: { id: 'n1', note_type: 'text', content: 'A' },
      });
      mockApi.post.mockImplementationOnce(async () => {
        // The user keeps typing while the replay is in flight.
        await db.runAsync('UPDATE notes SET content = ? WHERE id = ?', ['AB', 'n1']);
        await queueUpdate({ content: 'AB' });
        return { data: makeTextNote({ id: 'n1', content: 'A', version: 1 }) } as never;
      });
      // The drain read its entries up front, so the new one waits for the next drain.
      await drainQueue(db);

      expect(await localNote()).toEqual({ content: 'AB', version: 1 });
      expect(await remainingQueueIds(db)).toHaveLength(1);
      // Still queued, so still protected: nothing to pull.
      expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('pulls a note whose held-back response no later response settled', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'old', version: 5 }));
      await queueUpdate({ pinned: true });
      await seedQueueEntry(db, { operation: 'markViewed', endpoint: '/notes/n1/view', method: 'POST' });
      mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'collaborator edit', version: 6 }) } as never);
      mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
      mockApi.get.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'collaborator edit', version: 6 }) } as never);

      await drainQueue(db);

      expect(mockApi.get.mock.calls.map(([url]) => url)).toEqual(['/notes/n1']);
      expect(await localNote()).toEqual({ content: 'collaborator edit', version: 6 });
    });

    it('keeps a failed change\'s local content when a later op for the note lands', async () => {
      // The content edit conflicts and is dead-lettered; the pin behind it then
      // lands with nothing else queued. Its response must not replace the row
      // "Keep my version" forks from.
      await saveNote(db, makeTextNote({ id: 'n1', content: 'mine', version: 5 }));
      await queueUpdate({ content: 'mine' });
      await queueUpdate({ pinned: true });
      mockApi.patch
        .mockRejectedValueOnce(makeAxiosError(409))
        .mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'collaborator edit', version: 6 }) } as never);

      await drainQueue(db);

      expect(await localNote()).toEqual({ content: 'mine', version: 5 });
      expect(await getDeadLetteredOperations(db)).toMatchObject([{ operation: 'update', status: 409, note_id: 'n1' }]);
      // Still named by a dead letter, so not pulled either.
      expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('pulls a note whose landed write returned no note', async () => {
      await saveNote(db, makeListNote({ id: 'n1', items: [] }));
      await seedQueueEntry(db, {
        operation: 'createItem', endpoint: '/notes/n1/items', method: 'POST', body: { id: 'i1', text: 'Milk', position: 0 },
      });
      mockApi.post.mockResolvedValueOnce({ data: makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Milk' }) } as never);
      mockApi.get.mockResolvedValueOnce({
        data: makeListNote({ id: 'n1', title: 'Renamed elsewhere', version: 2, items: [makeNoteItem({ id: 'i1', note_id: 'n1', text: 'Milk' })] }),
      } as never);

      await drainQueue(db);

      expect(mockApi.get.mock.calls.map(([url]) => url)).toEqual(['/notes/n1']);
      expect(await db.getFirstAsync('SELECT title, version FROM notes WHERE id = ?', ['n1'])).toEqual({ title: 'Renamed elsewhere', version: 2 });
    });

    it('pulls a note the drain deleted and then restored', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'old', version: 5 }));
      await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/n1', method: 'DELETE' });
      await seedQueueEntry(db, { operation: 'restore', endpoint: '/notes/n1/restore', method: 'POST' });
      mockApi.delete.mockResolvedValueOnce({ status: 204 } as never);
      mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
      mockApi.get.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'old', version: 5 }) } as never);

      await drainQueue(db);

      expect(mockApi.get.mock.calls.map(([url]) => url)).toEqual(['/notes/n1']);
    });

    it('does not pull a note the drain then deleted', async () => {
      await saveNote(db, makeTextNote({ id: 'n1', content: 'old', version: 5 }));
      await queueUpdate({ pinned: true });
      await seedQueueEntry(db, { operation: 'delete', endpoint: '/notes/n1', method: 'DELETE' });
      mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'old', version: 5 }) } as never);
      mockApi.delete.mockResolvedValueOnce({ status: 204 } as never);

      await drainQueue(db);

      expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('keeps the drain going when the post-drain pull fails', async () => {
      silenceConsole('warn', /^Failed to pull note/);
      await saveNote(db, makeTextNote({ id: 'n1', content: 'old', version: 5 }));
      await queueUpdate({ pinned: true });
      await seedQueueEntry(db, { operation: 'markViewed', endpoint: '/notes/n1/view', method: 'POST' });
      mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: 'n1', content: 'new', version: 6 }) } as never);
      mockApi.post.mockResolvedValueOnce({ status: 204 } as never);
      mockApi.get.mockRejectedValueOnce(makeAxiosError(500));

      await drainQueue(db);

      expect(await remainingQueueIds(db)).toEqual([]);
      expect(await localNote()).toEqual({ content: 'old', version: 5 });
    });
  });
});

// ── getLocalLabelCounts ────────────────────────────────────────────────────

describe('getLocalLabelCounts', () => {
  const home = makeLabel({ id: 'l1', name: 'Home' });
  const work = makeLabel({ id: 'l2', name: 'Work' });

  it('counts active notes per label', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [home, work] }));
    await saveNote(db, makeTextNote({ id: 'n2', labels: [home] }));
    await saveNote(db, makeTextNote({ id: 'n3', labels: [] }));

    expect(await getLocalLabelCounts(db)).toEqual({ l1: 2, l2: 1 });
  });

  it('returns an empty object when no notes exist', async () => {
    expect(await getLocalLabelCounts(db)).toEqual({});
  });

  it('ignores notes with malformed labels_json', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [home] }));
    await db.runAsync(`UPDATE notes SET labels_json = 'not-json' WHERE id = ?`, ['n1']);
    await saveNote(db, makeTextNote({ id: 'n2', labels: [work] }));

    expect(await getLocalLabelCounts(db)).toEqual({ l2: 1 });
  });

  it('counts only active (non-archived, non-trashed) notes', async () => {
    await saveNote(db, makeTextNote({ id: 'active', labels: [home] }));
    await saveNote(db, makeTextNote({ id: 'archived', labels: [home], archived: true }));
    await saveNote(db, makeTextNote({ id: 'trashed', labels: [home], deleted_at: '2026-01-02T00:00:00Z' }));

    expect(await getLocalLabelCounts(db)).toEqual({ l1: 1 });
  });
});

// ── removeLocalNotesNotIn label scope ───────────────────────────────────────

describe('removeLocalNotesNotIn', () => {
  const work = makeLabel({ id: 'l1', name: 'Work' });
  const personal = makeLabel({ id: 'l2', name: 'Personal' });

  const remainingNoteIds = async (): Promise<string[]> => {
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM notes ORDER BY id');
    return rows.map((r) => r.id);
  };

  it('deletes only notes that matched the label filter but are missing from serverIds', async () => {
    await saveNote(db, makeTextNote({ id: 'note-label-removed', labels: [work] }));
    await saveNote(db, makeTextNote({ id: 'note-other-label', labels: [personal] }));
    await saveNote(db, makeTextNote({ id: 'note-still-on-server', labels: [work] }));

    await removeLocalNotesNotIn(db, new Set(['note-still-on-server']), { label: 'l1' });

    expect(await remainingNoteIds()).toEqual(['note-other-label', 'note-still-on-server']);
  });

  it('does not delete non-label-matching notes in a label-filtered sync', async () => {
    await saveNote(db, makeTextNote({ id: 'note-unrelated', labels: [personal] }));

    await removeLocalNotesNotIn(db, new Set<string>(), { label: 'l1' });

    expect(await remainingNoteIds()).toEqual(['note-unrelated']);
  });

  it('keeps notes with a pending local edit even when the server did not return them', async () => {
    await saveNote(db, makeTextNote({ id: 'pending-edit' }));
    await saveNote(db, makeTextNote({ id: 'stale' }));

    await removeLocalNotesNotIn(db, new Set<string>(), undefined, {
      skipNoteIds: new Set(['pending-edit']),
    });

    expect(await remainingNoteIds()).toEqual(['pending-edit']);
  });

  it('leaves archived and trashed notes out of the default scope', async () => {
    await saveNote(db, makeTextNote({ id: 'active' }));
    await saveNote(db, makeTextNote({ id: 'archived', archived: true }));
    await saveNote(db, makeTextNote({ id: 'trashed', deleted_at: '2026-01-02T00:00:00Z' }));

    await removeLocalNotesNotIn(db, new Set<string>());

    expect(await remainingNoteIds()).toEqual(['archived', 'trashed']);
  });
});

// ── getLocalNotes search ───────────────────────────────────────────────────

describe('getLocalNotes search', () => {
  const ids = async (notes: { id: string }[]): Promise<string[]> => notes.map((n) => n.id).sort();

  it('searches title, content, and item text', async () => {
    await saveNote(db, makeTextNote({ id: 'by-content', content: 'say hello there' }));
    await saveNote(db, makeListNote({ id: 'by-title', title: 'hello list' }));
    await saveNote(
      db,
      makeListNote({
        id: 'by-item',
        title: 'groceries',
        items: [makeNoteItem({ id: 'i1', note_id: 'by-item', text: 'hello milk' })],
      }),
    );
    await saveNote(db, makeTextNote({ id: 'no-match', content: 'nothing here' }));

    expect(await ids(await getLocalNotes(db, { search: 'hello' }))).toEqual(['by-content', 'by-item', 'by-title']);
  });

  it('escapes LIKE wildcards in the search text so they match literally', async () => {
    await saveNote(db, makeTextNote({ id: 'literal', content: 'discount 50%_a\\b today' }));
    await saveNote(db, makeTextNote({ id: 'wildcard-would-match', content: '50XyaZb' }));

    expect(await ids(await getLocalNotes(db, { search: '50%_a\\b' }))).toEqual(['literal']);
  });

  it('returns every active note when no search param is given', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', content: 'one' }));
    await saveNote(db, makeTextNote({ id: 'n2', content: 'two' }));

    expect(await ids(await getLocalNotes(db))).toEqual(['n1', 'n2']);
  });
});

// ── removeLocalNotesNotIn search scope ────────────────────────────────────────

describe('removeLocalNotesNotIn with search', () => {
  const remainingNoteIds = async (): Promise<string[]> => {
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM notes ORDER BY id');
    return rows.map((r) => r.id);
  };

  it('does not prune on a search scope, even for notes absent from the response', async () => {
    await saveNote(db, makeTextNote({ id: 'match-content', content: 'hello world' }));
    await saveNote(
      db,
      makeListNote({
        id: 'match-item',
        title: 'list',
        items: [makeNoteItem({ id: 'i1', note_id: 'match-item', text: 'hello again' })],
      }),
    );
    // Substring-only match: the server's token search would not return it.
    await saveNote(db, makeTextNote({ id: 'substring-only', content: 'othello' }));
    await saveNote(db, makeTextNote({ id: 'outside-scope', content: 'unrelated' }));

    await removeLocalNotesNotIn(db, new Set<string>(), { search: 'hello' });

    expect(await remainingNoteIds()).toEqual(['match-content', 'match-item', 'outside-scope', 'substring-only']);
  });
});

// ── addLabelToLocalNote ──────────────────────────────────────────────────────

describe('addLabelToLocalNote', () => {
  const label = makeLabel({ id: 'l1', name: 'Work' });

  const labelsOf = async (noteId: string): Promise<unknown> => {
    const row = await db.getFirstAsync<{ labels_json: string }>(
      'SELECT labels_json FROM notes WHERE id = ?',
      [noteId],
    );
    return row ? JSON.parse(row.labels_json) : null;
  };

  it('appends the label to a note that does not yet have it', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [] }));

    await addLabelToLocalNote(db, 'n1', label);

    expect(await labelsOf('n1')).toEqual([label]);
  });

  it('is idempotent when the note already has the label (by id)', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [label] }));

    await addLabelToLocalNote(db, 'n1', { ...label, name: 'Different' });

    expect(await labelsOf('n1')).toEqual([label]);
  });

  it('is idempotent when the note already has a label of the same name', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [label] }));

    await addLabelToLocalNote(db, 'n1', { ...label, id: 'l2' });

    expect(await labelsOf('n1')).toEqual([label]);
  });

  it('is idempotent when the note already has a same-name label differing only in case', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [label] }));

    await addLabelToLocalNote(db, 'n1', { ...label, id: 'l2', name: 'WORK' });

    expect(await labelsOf('n1')).toEqual([label]);
  });

  it('does nothing when the note is not in the local cache', async () => {
    await addLabelToLocalNote(db, 'missing', label);

    expect(await labelsOf('missing')).toBeNull();
  });
});

// ── removeLabelFromLocalNote ─────────────────────────────────────────────────

describe('removeLabelFromLocalNote', () => {
  const work = makeLabel({ id: 'l1', name: 'Work' });
  const home = makeLabel({ id: 'l2', name: 'Home' });

  const labelsOf = async (noteId: string): Promise<unknown> => {
    const row = await db.getFirstAsync<{ labels_json: string }>(
      'SELECT labels_json FROM notes WHERE id = ?',
      [noteId],
    );
    return row ? JSON.parse(row.labels_json) : null;
  };

  it('removes the matching label from the note', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [work, home] }));

    await removeLabelFromLocalNote(db, 'n1', 'l1');

    expect(await labelsOf('n1')).toEqual([home]);
  });

  it('does nothing when the label is not present on the note', async () => {
    await saveNote(db, makeTextNote({ id: 'n1', labels: [home] }));
    const before = await db.getFirstAsync('SELECT labels_json, updated_at FROM notes WHERE id = ?', ['n1']);

    await removeLabelFromLocalNote(db, 'n1', 'l1');

    // Untouched, including updated_at — a no-op must not look like an edit.
    expect(await db.getFirstAsync('SELECT labels_json, updated_at FROM notes WHERE id = ?', ['n1'])).toEqual(before);
  });

  it('does nothing when the note is not in the local cache', async () => {
    await removeLabelFromLocalNote(db, 'missing', 'l1');

    expect(await labelsOf('missing')).toBeNull();
  });
});
