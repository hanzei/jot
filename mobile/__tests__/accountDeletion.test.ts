/**
 * Deleting the account (#1317): the server delete, then the local wipe, then
 * the local end of the session, with the drain held so no queued write reaches
 * the server once the account is gone. Runs against the real SQLite adapter.
 */

import { deleteAccount } from '../src/store/accountDeletion';
import { claimLocalData, getAccountOwner } from '../src/db/accountOwner';
import * as accountOwner from '../src/db/accountOwner';
import { drainQueue, subscribeToEnqueue } from '../src/db/syncQueue';
import { saveNote } from '../src/db/noteQueries';
import api from '../src/api/client';
import { jot } from '../src/api/jot';
import { makeTextNote, remainingQueueIds, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
  getActiveServerId: jest.fn(() => 'server-1'),
}));

jest.mock('../src/api/jot', () => ({
  jot: { users: { deleteMe: jest.fn() } },
}));

const mockApi = api as jest.Mocked<typeof api>;
const mockDeleteMe = jest.mocked(jot.users.deleteMe);
const NOTE_ID = 'DeleteAccountNote00000';

let db: TestDatabase;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function seedUpdate(content: string): Promise<number> {
  return seedQueueEntry(db, {
    operation: 'update',
    endpoint: `/notes/${NOTE_ID}`,
    method: 'PATCH',
    keys: [`note:${NOTE_ID}`],
    body: { content, base_version: 1 },
  });
}

async function noteCount(): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM notes');
  return row?.count ?? 0;
}

beforeEach(async () => {
  jest.clearAllMocks();
  db = globalThis.testDb;
  globalThis.mockFileSystem.reset();
  mockApi.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404 },
  }));
  silenceConsole('warn', /^Failed to pull note id=/);
  await claimLocalData(db, 'user-1', 'server-1');
  await saveNote(db, makeTextNote({ id: NOTE_ID, version: 1 }));
});

describe('deleteAccount', () => {
  it('wipes local data, then ends the session, after the server deleted the account', async () => {
    await seedUpdate('unsynced');
    mockDeleteMe.mockResolvedValueOnce(undefined);
    const ownerAtEnd: (string | null)[] = [];
    const endSession = jest.fn(async () => {
      ownerAtEnd.push(await getAccountOwner(db));
    });

    await deleteAccount(db, { current_password: 'secret' }, endSession);

    expect(mockDeleteMe).toHaveBeenCalledWith({ current_password: 'secret' });
    expect(endSession).toHaveBeenCalledTimes(1);
    // The wipe ran first: by the time the session ended, the data was gone.
    expect(ownerAtEnd).toEqual(['']);
    expect(await noteCount()).toBe(0);
    expect(await remainingQueueIds(db)).toEqual([]);
    // The queued write was dropped, never sent.
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('changes nothing locally when the server refuses, and lets the queue drain again', async () => {
    const queued = await seedUpdate('unsynced');
    const refusal = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'incorrect_password', message: 'incorrect password' } } },
    });
    mockDeleteMe.mockRejectedValueOnce(refusal);
    const listener = jest.fn();
    const unsubscribe = subscribeToEnqueue(listener);
    const endSession = jest.fn(async () => undefined);

    await expect(deleteAccount(db, { current_password: 'wrong' }, endSession)).rejects.toBe(refusal);
    unsubscribe();

    expect(endSession).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
    expect(await noteCount()).toBe(1);
    expect(await remainingQueueIds(db)).toEqual([queued]);
    // The release asks for a drain, and the drain sends again.
    expect(listener).toHaveBeenCalledTimes(1);
    mockApi.patch.mockResolvedValueOnce({ data: makeTextNote({ id: NOTE_ID, content: 'unsynced', version: 2 }) } as never);
    await drainQueue(db);
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('still ends the session when the wipe fails after the delete, and the next sign-in wipes the leftovers', async () => {
    await seedUpdate('unsynced');
    mockDeleteMe.mockResolvedValueOnce(undefined);
    jest.spyOn(accountOwner, 'wipeLocalData').mockRejectedValueOnce(new Error('disk I/O error'));
    silenceConsole('warn', /^Failed to wipe local data after deleting the account:/);
    silenceConsole('info', /^Local data belonged to another account/);
    const endSession = jest.fn(async () => undefined);

    await expect(deleteAccount(db, { username: 'alice' }, endSession)).resolves.toBeUndefined();

    expect(endSession).toHaveBeenCalledTimes(1);
    // The leftovers still name the deleted account, which no sign-in can be.
    expect(await getAccountOwner(db)).toBe('user-1');
    expect(await noteCount()).toBe(1);

    // The next account to sign in on this server claims the data first, which wipes it.
    expect(await claimLocalData(db, 'user-2', 'server-1')).toBe(true);
    expect(await getAccountOwner(db)).toBe('user-2');
    expect(await noteCount()).toBe(0);
    expect(await remainingQueueIds(db)).toEqual([]);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('waits for a running drain to finish before sending the delete', async () => {
    await seedUpdate('first');
    await seedUpdate('second');
    const firstSend = deferred<{ data: unknown }>();
    mockApi.patch.mockReturnValueOnce(firstSend.promise as never);
    mockDeleteMe.mockResolvedValueOnce(undefined);

    const drain = drainQueue(db);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(mockApi.patch).toHaveBeenCalledTimes(1);

    const deletion = deleteAccount(db, { current_password: 'secret' }, async () => undefined);
    await new Promise((r) => setImmediate(r));
    // The pass has a write in flight under the still-valid session: the delete waits.
    expect(mockDeleteMe).not.toHaveBeenCalled();

    firstSend.resolve({ data: makeTextNote({ id: NOTE_ID, content: 'first', version: 2 }) });
    await drain;
    await deletion;

    // The pass stopped before its second write, which the wipe then dropped.
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(mockDeleteMe).toHaveBeenCalledTimes(1);
    expect(await remainingQueueIds(db)).toEqual([]);
  });

  it('sends nothing from a drain that starts while the delete is in flight', async () => {
    await seedUpdate('unsynced');
    const response = deferred<void>();
    mockDeleteMe.mockReturnValueOnce(response.promise);

    const deletion = deleteAccount(db, { current_password: 'secret' }, async () => undefined);
    await new Promise((r) => setImmediate(r));
    expect(mockDeleteMe).toHaveBeenCalledTimes(1);

    const result = await drainQueue(db);
    expect(result.leftBehind).toBe(1);
    expect(mockApi.patch).not.toHaveBeenCalled();

    response.resolve();
    await deletion;
    // Nor after the 204: the wipe dropped the write before any drain could send it.
    await drainQueue(db);
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(await remainingQueueIds(db)).toEqual([]);
  });
});
