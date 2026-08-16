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
import * as labelsApi from '../src/api/labels';
import * as noteQueriesModule from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import type { Label } from '@jot/shared';

jest.mock('../src/api/labels');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockUseNetworkStatus = (
  jest.requireMock('../src/hooks/useNetworkStatus') as { useNetworkStatus: jest.Mock }
).useNetworkStatus;

// The db layer runs for real against the test database (see helpers/testDb.ts);
// each function stays a spy so the existing call assertions keep working while
// the SQL underneath them actually executes. `useSQLiteContext()` comes from the
// global mock and returns one stable database per test, which is what the
// db-dependent server-sync callback in useBackgroundSyncQuery needs to avoid
// churning. `generateClientLabelId` is the one true stub — the tests assert on
// the minted id, so it has to be deterministic.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return {
    ...actual,
    saveNote: jest.fn(actual.saveNote),
    saveNotes: jest.fn(actual.saveNotes),
    renameLabelInLocalNotes: jest.fn(actual.renameLabelInLocalNotes),
    deleteLabelFromLocalNotes: jest.fn(actual.deleteLabelFromLocalNotes),
    addLabelToLocalNote: jest.fn(actual.addLabelToLocalNote),
    removeLabelFromLocalNote: jest.fn(actual.removeLabelFromLocalNote),
    getStoredLabels: jest.fn(actual.getStoredLabels),
    upsertLabel: jest.fn(actual.upsertLabel),
    renameStoredLabel: jest.fn(actual.renameStoredLabel),
    deleteStoredLabel: jest.fn(actual.deleteStoredLabel),
    getLocalLabelCounts: jest.fn(actual.getLocalLabelCounts),
    getLocalNote: jest.fn(actual.getLocalNote),
    generateClientLabelId: jest.fn(() => 'client_label_id'),
    isNotePendingCreate: jest.fn(actual.isNotePendingCreate),
  };
});

jest.mock('../src/db/syncQueue', () => {
  const actual = jest.requireActual('../src/db/syncQueue');
  return {
    ...actual,
    enqueueOperation: jest.fn(actual.enqueueOperation),
    saveServerLabels: jest.fn(actual.saveServerLabels),
  };
});

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
}));

const mockLabelsApi = labelsApi as jest.Mocked<typeof labelsApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockSyncQueue = jest.requireMock('../src/db/syncQueue') as { enqueueOperation: jest.Mock };
const mockClientModule = jest.requireMock('../src/api/client') as { isServerSwitchInProgress: jest.Mock };

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

// A network failure produces an Axios error with no `response` (no HTTP status).
function makeNetworkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true });
}

const sampleNote = makeTextNote({ id: 'n1', content: 'body', created_at: '', updated_at: '' });

let db: TestDatabase;

/** A label already in the local store, as a prior sync would have left it. */
const storedLabel = (id: string, name: string): Label => ({
  id, user_id: 'u1', name, created_at: '', updated_at: '',
});

const storedLabelIds = async (): Promise<string[]> => {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM labels ORDER BY id');
  return rows.map((r) => r.id);
};

const queuedOperations = async (): Promise<string[]> => {
  const rows = await db.getAllAsync<{ operation: string }>(
    'SELECT operation FROM sync_queue ORDER BY id',
  );
  return rows.map((r) => r.operation);
};

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

describe('useLabels write hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db = globalThis.testDb;
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
  });

  // ── useCreateLabel ─────────────────────────────────────────────────────────

  // The other tests here fix connectivity before mounting, so they only cover
  // the value the hook was born with. These cover it flipping while the hook
  // stays mounted — the case the mutation hooks' write gate has to survive.
  describe('connectivity changes while mounted', () => {
    it('takes the offline path when connectivity drops after mount', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: true });

      const { result, rerender } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });

      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      await rerender(undefined);

      await result.current.mutateAsync({ name: 'Home' });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockLabelsApi.createLabel).not.toHaveBeenCalled();
      expect(await queuedOperations()).toEqual(['createLabel']);
    });

    it('takes the online path when connectivity returns after mount', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      const serverLabel = { id: 'srv1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' };
      mockLabelsApi.createLabel.mockResolvedValueOnce(serverLabel as never);

      const { result, rerender } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });

      mockUseNetworkStatus.mockReturnValue({ isConnected: true });
      await rerender(undefined);

      await result.current.mutateAsync({ name: 'Work' });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockLabelsApi.createLabel).toHaveBeenCalledWith('Work');
      expect(await queuedOperations()).toEqual([]);
    });
  });

  describe('useCreateLabel', () => {
    it('creates a label via the API when online', async () => {
      const serverLabel = { id: 'srv1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' };
      mockLabelsApi.createLabel.mockResolvedValueOnce(serverLabel as never);

      const { result } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: '  Work  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.createLabel).toHaveBeenCalledWith('Work');
      expect(result.current.data).toEqual(serverLabel);
      // The new label is persisted to the store so an empty label (no notes yet)
      // shows in the drawer immediately (#691).
      expect(mockNoteQueries.upsertLabel).toHaveBeenCalledWith(expect.anything(), serverLabel);
      expect(await noteQueriesModule.getStoredLabels(db)).toEqual([serverLabel]);
      expect(await queuedOperations()).toEqual([]);
    });

    it('queues the create on a transient failure and returns a local label', async () => {
      mockLabelsApi.createLabel.mockRejectedValueOnce(makeAxiosError(503));

      const { result } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Work' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'createLabel',
          endpoint: '/labels',
          method: 'POST',
          body: { id: 'client_label_id', name: 'Work' },
        }),
      );
      expect((result.current.data as { id: string }).id).toBe('client_label_id');
    });

    it('queues the create when offline', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Home' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.createLabel).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'createLabel', body: { id: 'client_label_id', name: 'Home' } }),
      );
      // The offline label is persisted to the store so it survives without a note.
      expect(mockNoteQueries.upsertLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'client_label_id', name: 'Home' }),
      );
      expect(await storedLabelIds()).toEqual(['client_label_id']);
      expect(await queuedOperations()).toEqual(['createLabel']);
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.createLabel.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Bad' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only name without calling the API or queuing', async () => {
      const { result } = await renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: '   ' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockLabelsApi.createLabel).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useAddLabelToNote ──────────────────────────────────────────────────────

  describe('useAddLabelToNote', () => {
    it('adds the label via the API when online', async () => {
      const updatedNote = { ...sampleNote, labels: [{ id: 'srv1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }] };
      mockLabelsApi.addLabelToNote.mockResolvedValueOnce(updatedNote as never);

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: '  Work  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.addLabelToNote).toHaveBeenCalledWith('n1', 'Work');
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), updatedNote);
      // The label from the server response is persisted to the store so a newly
      // minted label shows in the drawer immediately (#691).
      expect(mockNoteQueries.upsertLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'srv1', name: 'Work' }),
      );
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('on a transient failure for a new label, queues both createLabel and addLabelToNote', async () => {
      mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(503));
      await noteQueriesModule.saveNote(db, sampleNote);

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'New' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'createLabel', body: { id: 'client_label_id', name: 'New' } }),
      );
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'addLabelToNote', endpoint: '/notes/n1/labels', method: 'POST', body: { name: 'New' } }),
      );
      // The minted label is also written to the store.
      expect(mockNoteQueries.upsertLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'client_label_id', name: 'New' }),
      );
      expect(await storedLabelIds()).toEqual(['client_label_id']);
      // The create must be queued ahead of the add, or the replay 404s.
      expect(await queuedOperations()).toEqual(['createLabel', 'addLabelToNote']);
      // ...and the note really carries the label locally in the meantime.
      expect((await noteQueriesModule.getLocalNote(db, 'n1'))?.labels).toEqual([
        expect.objectContaining({ id: 'client_label_id', name: 'New' }),
      ]);
    });

    it('does not queue a createLabel or upsert when reusing a stored label (online, new label reuse guard)', async () => {
      // When the server reuses an existing label (same id already stored), upsert is
      // still idempotent, but no duplicate createLabel is queued.
      const updatedNote = { ...sampleNote, labels: [{ id: 'srv-existing', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }] };
      mockLabelsApi.addLabelToNote.mockResolvedValueOnce(updatedNote as never);

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Work' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.upsertLabel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'srv-existing', name: 'Work' }),
      );
    });

    it('queues (does not call the API) for a pending-create note even when online (#475)', async () => {
      // The note's create hasn't drained yet, so a direct API call would 404.
      // The label op queues FIFO behind the create instead.
      await noteQueriesModule.saveNote(db, sampleNote);
      await noteQueriesModule.markNotePendingCreate(db, 'n1');

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Soon' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.addLabelToNote).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'addLabelToNote', endpoint: '/notes/n1/labels' }),
      );
    });

    it('reuses an existing local label by name without queuing a createLabel', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      await noteQueriesModule.saveNote(db, sampleNote);
      await noteQueriesModule.upsertLabel(db, storedLabel('srv-existing', 'Work'));

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Work' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalledWith(
        expect.anything(),
        'n1',
        expect.objectContaining({ id: 'srv-existing', name: 'Work' }),
      );
      const createLabelCalls = mockSyncQueue.enqueueOperation.mock.calls.filter(
        ([, params]) => params.operation === 'createLabel',
      );
      expect(createLabelCalls).toHaveLength(0);
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'addLabelToNote' }),
      );
    });

    it('reuses an existing label whose name differs only in case (no createLabel queued)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      await noteQueriesModule.saveNote(db, sampleNote);
      await noteQueriesModule.upsertLabel(db, storedLabel('srv-existing', 'urgent'));

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Urgent' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      // The existing "urgent" label is reused rather than minting a new one.
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalledWith(
        expect.anything(),
        'n1',
        expect.objectContaining({ id: 'srv-existing', name: 'urgent' }),
      );
      const createLabelCalls = mockSyncQueue.enqueueOperation.mock.calls.filter(
        ([, params]) => params.operation === 'createLabel',
      );
      expect(createLabelCalls).toHaveLength(0);
    });

    it('rejects a whitespace-only name without touching the API, DB, or queue', async () => {
      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: '   ' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockLabelsApi.addLabelToNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.addLabelToLocalNote).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(403));

      const { result } = await renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Work' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useRemoveLabelFromNote ─────────────────────────────────────────────────

  describe('useRemoveLabelFromNote', () => {
    it('removes the label via the API when online', async () => {
      mockLabelsApi.removeLabelFromNote.mockResolvedValueOnce(sampleNote as never);

      const { result } = await renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.removeLabelFromNote).toHaveBeenCalledWith('n1', 'l1');
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), sampleNote);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('queues the removal on a transient failure', async () => {
      mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeNetworkError());
      await noteQueriesModule.saveNote(db, sampleNote);

      const { result } = await renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.removeLabelFromLocalNote).toHaveBeenCalledWith(expect.anything(), 'n1', 'l1');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'removeLabelFromNote', endpoint: '/notes/n1/labels/l1', method: 'DELETE' }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeAxiosError(403));

      const { result } = await renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useRenameLabel ─────────────────────────────────────────────────────────

  describe('useRenameLabel', () => {
    it('renames the label via the API when online', async () => {
      // A label already in the store, carried on a note.
      await noteQueriesModule.upsertLabel(db, storedLabel('l1', 'Work'));
      await noteQueriesModule.saveNote(db, { ...sampleNote, labels: [storedLabel('l1', 'Work')] });
      const serverLabel = { id: 'l1', user_id: 'u1', name: 'Renamed', created_at: '', updated_at: '' };
      mockLabelsApi.renameLabel.mockResolvedValueOnce(serverLabel as never);

      const { result } = await renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: '  Renamed  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.renameLabel).toHaveBeenCalledWith('l1', 'Renamed');
      expect(mockNoteQueries.renameStoredLabel).toHaveBeenCalledWith(expect.anything(), 'l1', 'Renamed');
      expect(mockNoteQueries.renameLabelInLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1', 'Renamed');
      // The rename reached both the label store and the note's embedded copy.
      expect((await noteQueriesModule.getStoredLabels(db)).map((l) => l.name)).toEqual(['Renamed']);
      expect((await noteQueriesModule.getLocalNote(db, 'n1'))?.labels).toEqual([
        expect.objectContaining({ id: 'l1', name: 'Renamed' }),
      ]);
      expect(await queuedOperations()).toEqual([]);
    });

    it('queues the rename when offline and applies it locally', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = await renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: 'Offline' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.renameLabel).not.toHaveBeenCalled();
      expect(mockNoteQueries.renameStoredLabel).toHaveBeenCalledWith(expect.anything(), 'l1', 'Offline');
      expect(mockNoteQueries.renameLabelInLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1', 'Offline');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'renameLabel', endpoint: '/labels/l1', method: 'PATCH', body: { name: 'Offline' } }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.renameLabel.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = await renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: 'Dup' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useDeleteLabel ─────────────────────────────────────────────────────────

  describe('useDeleteLabel', () => {
    it('deletes the label via the API when online', async () => {
      // A label already in the store, carried on a note.
      await noteQueriesModule.upsertLabel(db, storedLabel('l1', 'Work'));
      await noteQueriesModule.saveNote(db, { ...sampleNote, labels: [storedLabel('l1', 'Work')] });
      mockLabelsApi.deleteLabel.mockResolvedValueOnce(undefined);

      const { result } = await renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.deleteLabel).toHaveBeenCalledWith('l1');
      expect(mockNoteQueries.deleteStoredLabel).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(mockNoteQueries.deleteLabelFromLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1');
      // Gone from the label store and from the note's embedded copy.
      expect(await storedLabelIds()).toEqual([]);
      expect((await noteQueriesModule.getLocalNote(db, 'n1'))?.labels).toEqual([]);
      expect(await queuedOperations()).toEqual([]);
    });

    it('queues the deletion on a transient failure and applies it locally', async () => {
      mockLabelsApi.deleteLabel.mockRejectedValueOnce(makeAxiosError(500));

      const { result } = await renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.deleteStoredLabel).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(mockNoteQueries.deleteLabelFromLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'deleteLabel', endpoint: '/labels/l1', method: 'DELETE' }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.deleteLabel.mockRejectedValueOnce(makeAxiosError(404));

      const { result } = await renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });
});

describe('useLabels catch-up on SSE reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db = globalThis.testDb;
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockLabelsApi.getLabels.mockResolvedValue([]);
  });

  it('re-pulls labels from the server when a reconnect resync is published', async () => {
    await renderHook(() => useLabels(), { wrapper: createWrapper() });

    // Initial background sync fetches once.
    await waitFor(() => expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(1));

    // A reconnect (e.g. foreground after backgrounding) re-pulls the list so a
    // label created/renamed/deleted on another device while the stream was down
    // appears in the drawer.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(2);
  });

  it('skips a concurrent resync while one is already in flight (Sync Loop Safety)', async () => {
    let resolveGet: (() => void) | undefined;
    mockLabelsApi.getLabels.mockImplementation(
      () => new Promise((resolve) => { resolveGet = () => resolve([]); }),
    );
    await renderHook(() => useLabels(), { wrapper: createWrapper() });

    // The mount-time sync is now in flight (getLabels pending).
    await waitFor(() => expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(1));

    // A resync arriving mid-flight is skipped rather than firing a second fetch.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(1);

    // Once the in-flight sync completes, a later resync runs normally.
    await act(async () => {
      resolveGet?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(2);
  });
});
