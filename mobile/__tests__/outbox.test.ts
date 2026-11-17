/**
 * The transactional outbox (#1284, spec §8.2): a write commits its local edit
 * and its queue row together, and the drain is the only code that sends it.
 * Runs against the real SQLite adapter (see `helpers/testDb.ts`).
 */

import { getLocalNote, getLocalNoteVersion, markNotePendingCreate, saveNote, updateLocalNote } from '../src/db/noteQueries';
import { drainQueue, enqueueSettingsUpdate, enqueueWrite, subscribeToEnqueue, type EnqueueParams } from '../src/db/syncQueue';
import { recordOwnVersionStep, resolveOwnBaseVersion } from '../src/db/ownVersions';
import { setLocalModeActive } from '../src/store/localMode';
import api from '../src/api/client';
import { makeTextNote, queuedOps, remainingQueueIds, seedQueueEntry } from './helpers/fixtures';
import { createTestDb, type TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;
const NOTE_ID = 'OutboxNote000000000000';

let db: TestDatabase;
beforeEach(async () => {
  jest.clearAllMocks();
  db = globalThis.testDb;
  // The drain pulls touched notes it could not settle; nothing here cares.
  mockApi.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404 },
  }));
  silenceConsole('warn', /^Failed to pull note id=/);
  await saveNote(db, makeTextNote({ id: NOTE_ID, content: 'Old', version: 5 }));
});

afterEach(() => {
  setLocalModeActive(false);
});

function updateOp(body: Record<string, unknown>): EnqueueParams {
  return { operation: 'update', endpoint: `/notes/${NOTE_ID}`, method: 'PATCH', keys: [`note:${NOTE_ID}`], body };
}

async function queuedBodies(): Promise<Record<string, unknown>[]> {
  const rows = await db.getAllAsync<{ body: string }>('SELECT body FROM sync_queue ORDER BY id');
  return rows.map((row) => JSON.parse(row.body) as Record<string, unknown>);
}

describe('enqueueWrite', () => {
  it('commits the local edit and its queue row together', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    const result = await enqueueWrite(db, {
      localApply: async () => {
        await updateLocalNote(db, NOTE_ID, { content: 'New' });
        return 'applied';
      },
      op: (applied) => updateOp({ content: 'New', tag: applied }),
    });
    unsubscribe();

    expect(result).toBe('applied');
    expect((await getLocalNote(db, NOTE_ID))).toMatchObject({ content: 'New' });
    expect(await queuedBodies()).toEqual([{ content: 'New', tag: 'applied' }]);
    const keys = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_queue_keys');
    expect(keys.map((k) => k.key)).toEqual([`note:${NOTE_ID}`]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rolls back the local edit when the queue row cannot be built', async () => {
    await expect(enqueueWrite(db, {
      localApply: () => updateLocalNote(db, NOTE_ID, { content: 'New' }),
      op: () => {
        throw new Error('bad op');
      },
    })).rejects.toThrow('bad op');

    expect(await getLocalNote(db, NOTE_ID)).toMatchObject({ content: 'Old' });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('writes no queue row when the local apply fails', async () => {
    await expect(enqueueWrite(db, {
      localApply: async () => {
        await updateLocalNote(db, NOTE_ID, { content: 'New' });
        throw new Error('apply failed');
      },
      op: () => updateOp({ content: 'New' }),
    })).rejects.toThrow('apply failed');

    expect(await getLocalNote(db, NOTE_ID)).toMatchObject({ content: 'Old' });
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('inserts several rows in the order given, each with its own keys', async () => {
    const createLabel: EnqueueParams = {
      operation: 'createLabel', endpoint: '/labels', method: 'POST', keys: ['label:L1'], body: { id: 'L1', name: 'Errands' },
    };
    const addLabel: EnqueueParams = {
      operation: 'addLabelToNote', endpoint: `/notes/${NOTE_ID}/labels`, method: 'POST', keys: [`note:${NOTE_ID}`, 'label:L1'], body: { name: 'Errands' },
    };
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await enqueueWrite(db, { localApply: async () => undefined, op: () => [createLabel, addLabel] });
    unsubscribe();

    expect((await queuedOps(db)).map((op) => [op.operation, op.keys])).toEqual([
      ['createLabel', ['label:L1']],
      ['addLabelToNote', [`note:${NOTE_ID}`, 'label:L1']],
    ]);
    expect(listener.mock.calls).toEqual([['createLabel'], ['addLabelToNote']]);
  });

  it('rolls back every row and the local edit together when one row fails', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await expect(enqueueWrite(db, {
      localApply: () => updateLocalNote(db, NOTE_ID, { content: 'New' }),
      op: () => [
        updateOp({ content: 'New' }),
        // NOT NULL endpoint: the second insert fails after the first succeeded.
        { ...updateOp({ content: 'New' }), endpoint: null as unknown as string },
      ],
    })).rejects.toThrow();
    unsubscribe();

    expect(await getLocalNote(db, NOTE_ID)).toMatchObject({ content: 'Old' });
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(await db.getAllAsync('SELECT key FROM sync_queue_keys')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the local edit but queues nothing in local mode', async () => {
    setLocalModeActive(true);
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);

    await enqueueWrite(db, {
      localApply: () => updateLocalNote(db, NOTE_ID, { content: 'New' }),
      op: () => updateOp({ content: 'New' }),
    });
    unsubscribe();

    expect(await getLocalNote(db, NOTE_ID)).toMatchObject({ content: 'New' });
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('enqueueSettingsUpdate', () => {
  it('queues a PATCH /users/me keyed by settings', async () => {
    await enqueueSettingsUpdate(db, { theme: 'dark' });

    expect(await queuedOps(db)).toEqual([{
      operation: 'updateSettings',
      endpoint: '/users/me',
      method: 'PATCH',
      body: { theme: 'dark' },
      keys: ['settings'],
      readKeys: [],
    }]);
  });
});

describe('drain of an outbox content edit', () => {
  it('sends the base_version stored at enqueue, not the local version', async () => {
    // A collaborator's snapshot moved the row to v9 while the user edited from v5.
    await db.runAsync('UPDATE notes SET version = 9 WHERE id = ?', [NOTE_ID]);
    await seedQueueEntry(db, { ...updateOp({ content: 'Mine', base_version: 5 }) });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'Mine', version: 6 }) } as never);

    await drainQueue(db);

    expect(mockApi.patch).toHaveBeenCalledWith(
      `/notes/${NOTE_ID}`,
      { content: 'Mine', base_version: 5 },
      expect.anything(),
    );
  });

  it('resolves a legacy row without a stored base from the local version', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'Mine' }) });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'Mine', version: 6 }) } as never);

    await drainQueue(db);

    expect(mockApi.patch).toHaveBeenCalledWith(
      `/notes/${NOTE_ID}`,
      { content: 'Mine', base_version: 5 },
      expect.anything(),
    );
  });

  it('rebases the edits queued against the same base onto the version its landing produced', async () => {
    // Two saves from one editor, both based on v5 (the editor keeps its baseline
    // while it is dirty). Without the rebase the second would conflict with the first.
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    await seedQueueEntry(db, { ...updateOp({ content: 'Second', base_version: 5 }) });
    mockApi.patch
      .mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'First', version: 6 }) } as never)
      .mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'Second', version: 7 }) } as never);

    await drainQueue(db);

    expect(mockApi.patch.mock.calls.map((call) => call[1])).toEqual([
      { content: 'First', base_version: 5 },
      { content: 'Second', base_version: 6 },
    ]);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(await getLocalNote(db, NOTE_ID)).toMatchObject({ content: 'Second', version: 7 });
  });

  it('persists the rebase with the landing, so a later drain sends the new base', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    await seedQueueEntry(db, { ...updateOp({ content: 'Second', base_version: 5 }) });
    // The first lands; the server then drops away before the second is sent.
    mockApi.patch
      .mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'First', version: 6 }) } as never)
      .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    silenceConsole('info', /^Queue drain stopped at entry/);

    await drainQueue(db);

    expect(await queuedBodies()).toEqual([{ content: 'Second', base_version: 6 }]);
  });

  it('leaves an edit based on another version alone', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    // Made from a v3 view of the note: its conflict is real and must reach the server.
    await seedQueueEntry(db, { ...updateOp({ content: 'Stale', base_version: 3 }) });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'First', version: 6 }) } as never);
    mockApi.patch.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 409'), {
      isAxiosError: true,
      response: { status: 409 },
    }));
    silenceConsole('warn', /^Discarding queued operation/);

    await drainQueue(db);

    expect(mockApi.patch.mock.calls[1]![1]).toEqual({ content: 'Stale', base_version: 3 });
  });

  it('does not rebase when a collaborator edit is folded into the response', async () => {
    // Not version-guarded (a pin): the response version may carry someone else's edit.
    await seedQueueEntry(db, { ...updateOp({ pinned: true }) });
    await seedQueueEntry(db, { ...updateOp({ content: 'Mine', base_version: 5 }) });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, version: 8 }) } as never);
    mockApi.patch.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    silenceConsole('info', /^Queue drain stopped at entry/);

    await drainQueue(db);

    expect(await queuedBodies()).toEqual([{ content: 'Mine', base_version: 5 }]);
    expect(resolveOwnBaseVersion(db, NOTE_ID, 5)).toBe(5);
  });

  it('sends an edit queued on an offline duplicate against the copy\'s own version', async () => {
    // The local copy starts at version 1, like the server's copy (useDuplicateNote).
    const copyId = 'OutboxCopy000000000000';
    await saveNote(db, makeTextNote({ id: copyId, content: 'Old', version: 1 }));
    await markNotePendingCreate(db, copyId);
    await seedQueueEntry(db, {
      operation: 'duplicate',
      endpoint: `/notes/${NOTE_ID}/duplicate`,
      method: 'POST',
      keys: [`note:${copyId}`],
      readKeys: [`note:${NOTE_ID}`],
      body: { id: copyId },
    });
    await seedQueueEntry(db, {
      operation: 'update',
      endpoint: `/notes/${copyId}`,
      method: 'PATCH',
      keys: [`note:${copyId}`],
      body: { content: 'Edited copy', base_version: 1 },
    });
    mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: copyId, content: 'Old', version: 1 }) } as never);
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: copyId, content: 'Edited copy', version: 2 }) } as never);

    await drainQueue(db);

    expect(mockApi.patch).toHaveBeenCalledWith(
      `/notes/${copyId}`,
      { content: 'Edited copy', base_version: 1 },
      expect.anything(),
    );
    expect(await getLocalNote(db, copyId)).toMatchObject({ content: 'Edited copy', version: 2 });
  });

  it('records the step for an edit enqueued after the landing (ownVersions)', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'First', version: 6 }) } as never);

    await drainQueue(db);

    expect(await getLocalNoteVersion(db, NOTE_ID)).toBe(6);
    expect(resolveOwnBaseVersion(db, NOTE_ID, 5)).toBe(6);
  });
});

describe('drain leftBehind', () => {
  it('counts the rows the pass loaded and left queued, not rows queued while it ran', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    // An autosave lands while the request is out.
    mockApi.patch.mockImplementationOnce((async () => {
      await seedQueueEntry(db, { ...updateOp({ content: 'Second', base_version: 5 }) });
      return { data: makeTextNote({ id: NOTE_ID, content: 'First', version: 6 }) };
    }) as never);

    const { leftBehind } = await drainQueue(db);

    expect(leftBehind).toBe(0);
    expect(await remainingQueueIds(db)).toHaveLength(1);
  });

  it('counts a row that failed transiently', async () => {
    await seedQueueEntry(db, { ...updateOp({ content: 'First', base_version: 5 }) });
    mockApi.patch.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    silenceConsole('info', /^Queue drain stopped at entry/);

    const { leftBehind } = await drainQueue(db);

    expect(leftBehind).toBe(1);
  });
});

describe('ownVersions', () => {
  it('follows a chain of own steps and stops at an unknown version', () => {
    recordOwnVersionStep(db, 'n', 1, 2);
    recordOwnVersionStep(db, 'n', 2, 3);
    expect(resolveOwnBaseVersion(db, 'n', 1)).toBe(3);
    expect(resolveOwnBaseVersion(db, 'n', 7)).toBe(7);
    expect(resolveOwnBaseVersion(db, 'other', 1)).toBe(1);
  });

  it('keeps each database\'s steps to itself', () => {
    // Another server's database: note ids can repeat across servers.
    const other = createTestDb();
    recordOwnVersionStep(db, 'n', 5, 6);
    expect(resolveOwnBaseVersion(other, 'n', 5)).toBe(5);
    expect(resolveOwnBaseVersion(db, 'n', 5)).toBe(6);
  });

  it('ignores a no-op step', () => {
    recordOwnVersionStep(db, 'n', 4, 4);
    expect(resolveOwnBaseVersion(db, 'n', 4)).toBe(4);
  });
});
