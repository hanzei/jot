import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreateLabel,
  useAddLabelToNote,
  useRemoveLabelFromNote,
  useRenameLabel,
  useDeleteLabel,
  useLabels,
} from '../src/hooks/useLabels';
import { publishReconnectResync } from '../src/store/resyncEvents';
import * as noteQueriesModule from '../src/db/noteQueries';
import { makeLabel, makeTextNote, queuedOps } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import type { Label } from '@jot/shared';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockUseNetworkStatus = (
  jest.requireMock('../src/hooks/useNetworkStatus') as { useNetworkStatus: jest.Mock }
).useNetworkStatus;

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
}));

const mockJot = jest.mocked(jot);
const mockClientModule = jest.requireMock('../src/api/client') as { isServerSwitchInProgress: jest.Mock };

/** A server-format id (22 base62 characters), as a label created here gets (#546). */
const ID_RE = /^[0-9a-zA-Z]{22}$/;

let db: TestDatabase;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Mounts a mutation hook and returns a runner that performs one mutation inside act. */
async function mountMutation<TVars, TResult>(
  useHook: () => { mutateAsync: (vars: TVars) => Promise<TResult> },
): Promise<(vars: TVars) => Promise<TResult>> {
  const { result } = await renderHook(() => useHook(), { wrapper: createWrapper() });
  return async (vars) => {
    let returned!: TResult;
    await act(async () => {
      returned = await result.current.mutateAsync(vars);
    });
    return returned;
  };
}

/** The write side never reads; any server call would be the old online path. */
function expectNoServerCalls(): void {
  for (const group of [mockJot.labels, mockJot.notes]) {
    for (const fn of Object.values(group)) {
      if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
  }
}

async function storedLabels(): Promise<Label[]> {
  return noteQueriesModule.getStoredLabels(db);
}

async function noteLabelIds(noteId: string): Promise<string[]> {
  return ((await noteQueriesModule.getLocalNote(db, noteId))?.labels ?? []).map((l) => l.id);
}

/**
 * Every label write goes through the outbox (#1285): the local edit and its
 * queue rows commit together, and the hook never calls the server.
 */
describe('useLabels write hooks (outbox)', () => {
  const NOTE_ID = 'LabelNote0000000000000';
  const work = makeLabel({ id: 'WorkLabel0000000000000', name: 'Work' });

  beforeEach(async () => {
    jest.clearAllMocks();
    db = globalThis.testDb;
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
    await noteQueriesModule.upsertLabel(db, work);
    await noteQueriesModule.saveNote(db, makeTextNote({ id: NOTE_ID, content: 'body', labels: [work] }));
  });

  afterEach(() => {
    expectNoServerCalls();
  });

  describe('useCreateLabel', () => {
    it('stores the label under a server-valid client id and queues its create', async () => {
      const create = await mountMutation(() => useCreateLabel());

      const label = await create({ name: '  Errands ' });

      expect(label).toMatchObject({ name: 'Errands', user_id: 'test-user-id' });
      expect(label.id).toMatch(ID_RE);
      expect((await storedLabels()).map((l) => l.name)).toEqual(['Errands', 'Work']);
      expect(await queuedOps(db)).toEqual([{
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: { id: label.id, name: 'Errands' },
        keys: [`label:${label.id}`],
        readKeys: [],
      }]);
    });

    it('returns the label a name already belongs to and queues nothing, as the server get-or-creates', async () => {
      const create = await mountMutation(() => useCreateLabel());

      const label = await create({ name: work.name.toUpperCase() });

      expect(label).toEqual(work);
      expect(await storedLabels()).toEqual([work]);
      expect(await queuedOps(db)).toEqual([]);
    });

    it('rejects a whitespace-only name and writes nothing', async () => {
      const create = await mountMutation(() => useCreateLabel());

      await expect(create({ name: '   ' })).rejects.toThrow('Label name must not be empty');

      expect(await storedLabels()).toEqual([work]);
      expect(await queuedOps(db)).toEqual([]);
    });

    it('writes nothing while a server switch is in progress', async () => {
      mockClientModule.isServerSwitchInProgress.mockReturnValue(true);
      const create = await mountMutation(() => useCreateLabel());

      await expect(create({ name: 'Errands' })).rejects.toThrow('Server switch in progress');

      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('useAddLabelToNote', () => {
    it('creates an unknown label first, attaches it and queues both in order', async () => {
      await noteQueriesModule.saveNote(db, makeTextNote({ id: NOTE_ID, content: 'body' }));
      const add = await mountMutation(() => useAddLabelToNote());

      await add({ noteId: NOTE_ID, name: 'Errands' });

      const errands = (await storedLabels()).find((l) => l.name === 'Errands');
      expect(errands?.id).toMatch(ID_RE);
      expect(await noteLabelIds(NOTE_ID)).toEqual([errands!.id]);
      // The attach shares the label's key, so it waits for the create to land.
      expect(await queuedOps(db)).toEqual([
        {
          operation: 'createLabel',
          endpoint: '/labels',
          method: 'POST',
          body: { id: errands!.id, name: 'Errands' },
          keys: [`label:${errands!.id}`],
          readKeys: [],
        },
        {
          operation: 'addLabelToNote',
          endpoint: `/notes/${NOTE_ID}/labels`,
          method: 'POST',
          body: { name: 'Errands' },
          keys: [`note:${NOTE_ID}`, `label:${errands!.id}`],
          readKeys: [],
        },
      ]);
    });

    it('reuses a stored label matched case-insensitively and queues no create', async () => {
      await noteQueriesModule.saveNote(db, makeTextNote({ id: NOTE_ID, content: 'body' }));
      const add = await mountMutation(() => useAddLabelToNote());

      await add({ noteId: NOTE_ID, name: 'work' });

      expect(await storedLabels()).toEqual([work]);
      expect(await noteLabelIds(NOTE_ID)).toEqual([work.id]);
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'addLabelToNote',
        body: { name: 'work' },
        keys: [`note:${NOTE_ID}`, `label:${work.id}`],
      })]);
    });

    it('rolls back the minted label when the note is not stored locally', async () => {
      const add = await mountMutation(() => useAddLabelToNote());

      await expect(add({ noteId: 'MissingNote00000000000', name: 'Errands' })).rejects.toThrow(/not found in local DB/);

      expect(await storedLabels()).toEqual([work]);
      expect(await queuedOps(db)).toEqual([]);
    });

    it('rejects a whitespace-only name and writes nothing', async () => {
      const add = await mountMutation(() => useAddLabelToNote());

      await expect(add({ noteId: NOTE_ID, name: '  ' })).rejects.toThrow('Label name must not be empty');

      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('useRemoveLabelFromNote', () => {
    it('detaches the label locally and queues the removal', async () => {
      const remove = await mountMutation(() => useRemoveLabelFromNote());

      await remove({ noteId: NOTE_ID, labelId: work.id });

      expect(await noteLabelIds(NOTE_ID)).toEqual([]);
      // The label itself stays; only the note loses it.
      expect(await storedLabels()).toEqual([work]);
      expect(await queuedOps(db)).toEqual([{
        operation: 'removeLabelFromNote',
        endpoint: `/notes/${NOTE_ID}/labels/${work.id}`,
        method: 'DELETE',
        body: null,
        keys: [`note:${NOTE_ID}`, `label:${work.id}`],
        readKeys: [],
      }]);
    });
  });

  describe('useRenameLabel', () => {
    it('renames the stored label and the copies on local notes, and queues the rename', async () => {
      const rename = await mountMutation(() => useRenameLabel());

      const renamed = await rename({ labelId: work.id, name: ' Office ' });

      expect(renamed).toMatchObject({ id: work.id, name: 'Office' });
      expect((await storedLabels()).map((l) => l.name)).toEqual(['Office']);
      expect((await noteQueriesModule.getLocalNote(db, NOTE_ID))?.labels.map((l) => l.name)).toEqual(['Office']);
      expect(await queuedOps(db)).toEqual([{
        operation: 'renameLabel',
        endpoint: `/labels/${work.id}`,
        method: 'PATCH',
        body: { name: 'Office' },
        keys: [`label:${work.id}`],
        readKeys: [],
      }]);
    });

    it('rejects a name another label has and writes nothing, since the server would reject it later', async () => {
      const create = await mountMutation(() => useCreateLabel());
      const rename = await mountMutation(() => useRenameLabel());
      const errands = await create({ name: 'Errands' });
      const before = await queuedOps(db);

      await expect(rename({ labelId: errands.id, name: ` ${work.name.toLowerCase()} ` })).rejects.toThrow('A label with this name already exists');

      expect((await storedLabels()).map((l) => l.name)).toEqual(['Errands', 'Work']);
      expect(await queuedOps(db)).toEqual(before);
    });

    it('allows a rename that only changes the case of its own name', async () => {
      const rename = await mountMutation(() => useRenameLabel());

      await rename({ labelId: work.id, name: work.name.toUpperCase() });

      expect((await storedLabels()).map((l) => l.name)).toEqual([work.name.toUpperCase()]);
    });

    it('queues the rename of a label created here behind its create (#546)', async () => {
      const create = await mountMutation(() => useCreateLabel());
      const rename = await mountMutation(() => useRenameLabel());

      const label = await create({ name: 'Errands' });
      await rename({ labelId: label.id, name: 'Chores' });

      expect((await queuedOps(db)).map((op) => [op.operation, op.keys])).toEqual([
        ['createLabel', [`label:${label.id}`]],
        ['renameLabel', [`label:${label.id}`]],
      ]);
    });
  });

  describe('useDeleteLabel', () => {
    it('removes the label from the store and from local notes, and queues the delete', async () => {
      const del = await mountMutation(() => useDeleteLabel());

      await del({ labelId: work.id });

      expect(await storedLabels()).toEqual([]);
      expect(await noteLabelIds(NOTE_ID)).toEqual([]);
      expect(await queuedOps(db)).toEqual([{
        operation: 'deleteLabel',
        endpoint: `/labels/${work.id}`,
        method: 'DELETE',
        body: null,
        keys: [`label:${work.id}`],
        readKeys: [],
      }]);
    });
  });
});

describe('useLabels catch-up on SSE reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db = globalThis.testDb;
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockJot.labels.getAll.mockResolvedValue([]);
  });

  it('re-pulls labels from the server when a reconnect resync is published', async () => {
    await renderHook(() => useLabels(), { wrapper: createWrapper() });

    // Initial background sync fetches once.
    await waitFor(() => expect(mockJot.labels.getAll).toHaveBeenCalledTimes(1));

    // A reconnect (e.g. foreground after backgrounding) re-pulls the list so a
    // label created/renamed/deleted on another device while the stream was down
    // appears in the drawer.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockJot.labels.getAll).toHaveBeenCalledTimes(2);
  });

  it('skips a concurrent resync while one is already in flight (Sync Loop Safety)', async () => {
    let resolveGet: (() => void) | undefined;
    mockJot.labels.getAll.mockImplementation(
      () => new Promise((resolve) => { resolveGet = () => resolve([]); }),
    );
    await renderHook(() => useLabels(), { wrapper: createWrapper() });

    // The mount-time sync is now in flight (getLabels pending).
    await waitFor(() => expect(mockJot.labels.getAll).toHaveBeenCalledTimes(1));

    // A resync arriving mid-flight is skipped rather than firing a second fetch.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockJot.labels.getAll).toHaveBeenCalledTimes(1);

    // Once the in-flight sync completes, a later resync runs normally.
    await act(async () => {
      resolveGet?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockJot.labels.getAll).toHaveBeenCalledTimes(2);
  });
});

describe('useLabels note_count', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db = globalThis.testDb;
  });

  it('serves counts derived from local notes offline, then the server note_count after sync', async () => {
    const work = makeLabel({ id: 'l1', name: 'Work' });
    await noteQueriesModule.upsertLabel(db, work);
    await noteQueriesModule.saveNote(db, makeTextNote({ id: 'n1', content: 'a', labels: [work] }));
    // The server knows about a note the local cache does not hold.
    mockJot.labels.getAll.mockResolvedValue([{ ...work, note_count: 5 }]);

    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    const offline = await renderHook(() => useLabels(), { wrapper: createWrapper() });
    await waitFor(() => expect(offline.result.current.data?.[0]?.note_count).toBe(1));
    expect(mockJot.labels.getAll).not.toHaveBeenCalled();

    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    const online = await renderHook(() => useLabels(), { wrapper: createWrapper() });
    await waitFor(() => expect(online.result.current.data?.[0]?.note_count).toBe(5));
  });
});
