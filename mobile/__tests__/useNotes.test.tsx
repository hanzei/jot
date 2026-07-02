import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateNote, useUpdateNote, useDeleteNote, useDuplicateNote, useCreateNoteItem, useToggleNoteItemCompleted } from '../src/hooks/useNotes';
import { noteLocalQueryKey, notesLocalQueryKey } from '../src/hooks/queryKeys';
import * as notesApi from '../src/api/notes';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as clientModule from '../src/api/client';

jest.mock('../src/api/notes');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockUseNetworkStatus = (
  jest.requireMock('../src/hooks/useNetworkStatus') as { useNetworkStatus: jest.Mock }
).useNetworkStatus;

jest.mock('../src/db/noteQueries', () => ({
  saveNote: jest.fn().mockResolvedValue(undefined),
  saveNotes: jest.fn().mockResolvedValue(undefined),
  getLocalNote: jest.fn().mockResolvedValue(null),
  markLocalNoteDeleted: jest.fn().mockResolvedValue(undefined),
  markLocalNoteRestored: jest.fn().mockResolvedValue(undefined),
  permanentDeleteLocalNote: jest.fn().mockResolvedValue(undefined),
  updateLocalNote: jest.fn().mockResolvedValue(undefined),
  generateClientNoteId: jest.fn(() => 'ClientNoteId000000000A'),
  markNotePendingCreate: jest.fn().mockResolvedValue(undefined),
  isNotePendingCreate: jest.fn().mockResolvedValue(false),
  isLocalId: jest.fn((id: string) => id.startsWith('local_')),
  createLocalItem: jest.fn().mockResolvedValue(undefined),
  patchLocalItem: jest.fn().mockResolvedValue(undefined),
  deleteLocalItem: jest.fn().mockResolvedValue(undefined),
  reorderLocalItems: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

jest.mock('../src/api/client', () => {
  const isServerSwitchInProgress = jest.fn(() => false);
  return {
    isServerSwitchInProgress,
    getActiveServerId: jest.fn(() => 'test-server-id'),
    assertSwitchWriteAllowed: jest.fn(() => {
      if (isServerSwitchInProgress()) {
        throw new Error('Server switch in progress; write blocked');
      }
    }),
  };
});

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockClientModule = clientModule as jest.Mocked<typeof clientModule>;
const mockSyncQueue = jest.requireMock('../src/db/syncQueue') as { enqueueOperation: jest.Mock };

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

// Like createWrapper, but exposes the QueryClient so a test can seed and inspect
// the cache to assert optimistic (onMutate) updates and their rollback.
function createWrapperWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper: Wrapper, queryClient };
}

// A promise whose resolution the test controls, to model a request that is still
// in flight (a slow / half-open connection) while we assert the optimistic cache.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useNotes hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default online state after any test that changed it
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
  });

  describe('useCreateNote (online)', () => {
    it('creates a note via API and caches locally', async () => {
      const newNote = {
        id: 'server-id', title: 'Created', content: '', note_type: 'text',
        color: '#ffffff', pinned: false, archived: false, position: 0,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      };
      mockNotesApi.createNote.mockResolvedValueOnce(newNote as never);

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      result.current.mutate({ content: 'Created', note_type: 'text' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(newNote);
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), newNote);
    });

    it('creates a list note via API and caches locally', async () => {
      const newListNote = {
        id: 'server-list-id', title: 'My List', note_type: 'list',
        color: '#ffffff', pinned: false, archived: false, position: 0,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
        items: [],
      };
      mockNotesApi.createNote.mockResolvedValueOnce(newListNote as never);

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ title: 'My List', note_type: 'list', items: [] });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(newListNote);
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), newListNote);
    });

    it('blocks write when server switch is in progress', async () => {
      mockClientModule.isServerSwitchInProgress.mockReturnValue(true);

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      await expect(
        result.current.mutateAsync({ content: 'Blocked', note_type: 'text' }),
      ).rejects.toThrow('Server switch in progress; write blocked');

      expect(mockNotesApi.createNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.saveNote).not.toHaveBeenCalled();
    });
  });

  describe('useCreateNote (offline)', () => {
    it('queues a create with a server-valid client id and flags it pending (#475)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ content: 'Offline note', note_type: 'text' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // The note is saved locally with the client id and marked unsynced; the
      // queued create carries that id (not a legacy local_id) so the replay is
      // idempotent on the server.
      expect(mockNotesApi.createNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.markNotePendingCreate).toHaveBeenCalledWith(
        expect.anything(),
        'ClientNoteId000000000A',
      );
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'create',
          endpoint: '/notes',
          method: 'POST',
          body: { id: 'ClientNoteId000000000A', content: 'Offline note', note_type: 'text' },
        }),
      );
      expect(result.current.data?.id).toBe('ClientNoteId000000000A');
    });
  });

  describe('permanent server-format item IDs in local/offline creates (#513)', () => {
    const ID_RE = /^[0-9a-zA-Z]{22}$/;

    it('assigns inline list items a permanent server-format ID and sends it in the create body', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      const created = await result.current.mutateAsync({
        title: 'Groceries',
        note_type: 'list',
        items: [
          { text: 'Fruit', position: 0 },
          { text: 'Apples', position: 1, indent_level: 1 },
        ],
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // The local rows carry permanent server-format IDs, never a `local_*`
      // placeholder that would need server reconciliation.
      const localItems = created.note_type === 'list' ? created.items ?? [] : [];
      expect(localItems).toHaveLength(2);
      for (const item of localItems) {
        expect(item.id).toMatch(ID_RE);
      }
      // The indented item is parented to the preceding top-level item by its new ID.
      expect(localItems[1].parent_id).toBe(localItems[0].id);

      // The queued create carries the *same* IDs so the server keeps them (no
      // `local_* → server ID` reconciliation on drain).
      const enqueueCall = mockSyncQueue.enqueueOperation.mock.calls.find(
        (call) => call[1].operation === 'create',
      );
      expect(enqueueCall).toBeDefined();
      const body = enqueueCall?.[1].body as { id: string; items: { id: string }[] };
      expect(body.id).toBe('ClientNoteId000000000A');
      expect(body.items.map((i) => i.id)).toEqual(localItems.map((i) => i.id));
    });

    it('assigns duplicated list items a permanent server-format ID with remapped parents', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce({
        id: 'src', title: 'List', content: '', note_type: 'list', version: 1,
        color: '#ffffff', pinned: false, archived: false, position: 0,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
        items: [
          { id: 'srcItem1', note_id: 'src', text: 'A', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
          { id: 'srcItem2', note_id: 'src', text: 'B', completed: false, position: 1, parent_id: 'srcItem1', assigned_to: '', created_at: '', updated_at: '' },
        ],
      } as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });
      const dup = await result.current.mutateAsync('src');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const dupItems = dup.note_type === 'list' ? dup.items ?? [] : [];
      expect(dupItems).toHaveLength(2);
      for (const item of dupItems) {
        expect(item.id).toMatch(ID_RE);
      }
      // New IDs, not the source's, and parent_id is remapped to the new top-level ID.
      expect(dupItems[0].id).not.toBe('srcItem1');
      expect(dupItems[1].parent_id).toBe(dupItems[0].id);
    });
  });

  describe('useDuplicateNote guard (#475)', () => {
    it('queues (does not call the API) when duplicating a pending-create note even while online', async () => {
      // The source note has a server-valid id but its create hasn't drained, so a
      // direct API call would 404. The duplicate queues FIFO behind the create
      // and uses a server-valid client id so the replay is idempotent.
      mockNoteQueries.isNotePendingCreate.mockResolvedValueOnce(true);
      mockNoteQueries.getLocalNote.mockResolvedValueOnce({
        id: 'ServerValidButPending00', title: '', content: 'Hi', note_type: 'text',
        color: '#ffffff', pinned: false, archived: false, position: 0, version: 1,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      } as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync('ServerValidButPending00');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNotesApi.duplicateNote).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'duplicate',
          endpoint: '/notes/ServerValidButPending00/duplicate',
          method: 'POST',
          body: { id: 'ClientNoteId000000000A' },
        }),
      );
      expect(mockNoteQueries.markNotePendingCreate).toHaveBeenCalledWith(
        expect.anything(),
        'ClientNoteId000000000A',
      );
    });
  });

  describe('useUpdateNote (online)', () => {
    it('updates a note via API and caches locally', async () => {
      const updated = {
        id: '123', title: 'Updated', content: '', note_type: 'text',
        color: '#ffffff', pinned: false, archived: false, position: 0,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      };
      mockNotesApi.updateNote.mockResolvedValueOnce(updated as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      result.current.mutate({ id: '123', data: { title: 'Updated' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(updated);
      expect(mockNotesApi.updateNote).toHaveBeenCalledWith('123', { title: 'Updated' });
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), updated);
    });
  });

  describe('useUpdateNote (offline)', () => {
    const existingTextNote = {
      id: '123', title: '', content: 'Old body', note_type: 'text', version: 7,
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const existingListNote = {
      id: '456', title: 'Old title', content: '', note_type: 'list', version: 3,
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      items: [],
    };

    it('queues only the changed fields for a text note (no full-snapshot clobber)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingTextNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Only the user-changed field is queued; pinned/archived/color are absent,
      // so replaying this PATCH cannot overwrite them with the stale local snapshot.
      // base_version is NOT stored in the queued body — drainQueue resolves it from
      // the note's local version at replay time so a chain doesn't self-conflict (#489).
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'update',
          endpoint: '/notes/123',
          method: 'PATCH',
          body: { content: 'New body' },
        }),
      );
    });

    it('queues only the changed fields for a list note (no full-snapshot clobber)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingListNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '456', data: { title: 'New title' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // title is a list-note-specific field; only it is queued — checked_items_collapsed,
      // pinned, archived, and color stay absent so a replay cannot clobber them.
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'update',
          endpoint: '/notes/456',
          method: 'PATCH',
          body: { title: 'New title' },
        }),
      );
    });

    it('omits base_version for a per-user-only change (no content edit)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingTextNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { pinned: true } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // pinned is a per-user field; it is not version-guarded, so no base_version
      // is attached (sending one would cause false conflicts for other devices).
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'update',
          endpoint: '/notes/123',
          method: 'PATCH',
          body: { pinned: true },
        }),
      );
    });

    it('rejects and does not enqueue or write to DB when note is missing from local cache', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: 'missing-id', data: { title: 'X' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      const { enqueueOperation } = jest.requireMock('../src/db/syncQueue') as { enqueueOperation: jest.Mock };
      expect(result.current.error).toBeInstanceOf(Error);
      expect((result.current.error as Error).message).toMatch(/not found in local DB/);
      expect(enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.updateLocalNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.saveNote).not.toHaveBeenCalled();
    });
  });

  describe('useUpdateNote (online write failures)', () => {
    const existingNote = {
      id: '123', title: 'Old', content: 'Old body', note_type: 'text', version: 9,
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };

    it('sends base_version on an online content update', async () => {
      const updated = { ...existingNote, content: 'New body', version: 10 };
      mockNotesApi.updateNote.mockResolvedValueOnce(updated as never);
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // The note's current version is echoed so the server can reject a write
      // that raced a concurrent edit (#489).
      expect(mockNotesApi.updateNote).toHaveBeenCalledWith('123', { content: 'New body', base_version: 9 });
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('falls back to the local queue when a transient failure (5xx) occurs', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(makeAxiosError(503));
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // The edit is persisted locally and queued for replay rather than lost,
      // and the mutation resolves so the editor can exit normally.
      expect(mockNoteQueries.updateLocalNote).toHaveBeenCalledWith(expect.anything(), '123', { content: 'New body' });
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'update', endpoint: '/notes/123', method: 'PATCH' }),
      );
      expect((result.current.data as { content: string }).content).toBe('New body');
    });

    it('falls back to the local queue on a network error (no response)', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(makeNetworkError());
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(existingNote as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalled();
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      // A real validation/auth error must reach the UI, not be silently queued
      // or written to the local DB (the offline fallback path).
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.updateLocalNote).not.toHaveBeenCalled();
    });

    it('surfaces a 401 without queuing (the interceptor logs the user out)', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(makeAxiosError(401));

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.updateLocalNote).not.toHaveBeenCalled();
    });

    it('rethrows a non-Axios (local) error instead of queuing it', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(new Error('boom'));

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.updateLocalNote).not.toHaveBeenCalled();
    });
  });

  describe('item mutations (online write failures)', () => {
    it('useCreateNoteItem falls back to the local queue on a transient failure', async () => {
      mockNotesApi.createNoteItem.mockRejectedValueOnce(makeAxiosError(503));

      const { result } = renderHook(() => useCreateNoteItem(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'n1', item: { id: 'i1', text: 'New item', position: 0 } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNoteQueries.createLocalItem).toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'createItem', endpoint: '/notes/n1/items', method: 'POST' }),
      );
    });

    it('useToggleNoteItemCompleted falls back to the local queue on a transient failure', async () => {
      mockNotesApi.toggleItemCompleted.mockRejectedValueOnce(makeAxiosError(503));
      mockNoteQueries.getLocalNote.mockResolvedValueOnce({
        id: 'n1', note_type: 'list', title: 'L', checked_items_collapsed: false,
        color: '#ffffff', pinned: false, archived: false, position: 0, is_shared: false,
        deleted_at: null, user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
        items: [{ id: 'i1', note_id: 'n1', text: 'a', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' }],
      } as never);

      const { result } = renderHook(() => useToggleNoteItemCompleted(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'n1', itemId: 'i1', completed: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'toggleItemCompleted', endpoint: '/notes/n1/items/i1/toggle-completed' }),
      );
    });

    it('useCreateNoteItem surfaces a permanent failure (4xx) without queuing', async () => {
      mockNotesApi.createNoteItem.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = renderHook(() => useCreateNoteItem(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'n1', item: { id: 'i1', text: 'New item', position: 0 } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  describe('useDeleteNote (online)', () => {
    it('deletes a note via API and marks it deleted locally', async () => {
      mockNotesApi.deleteNote.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteNote(), { wrapper: createWrapper() });

      result.current.mutate('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNotesApi.deleteNote).toHaveBeenCalledWith('123');
      expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), '123');
    });
  });

  describe('optimistic cache updates on a stalled connection', () => {
    const existingTextNote = {
      id: '123', title: '', content: 'Old body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };
    const listNote = {
      id: 'n1', title: 'L', note_type: 'list',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      items: [
        { id: 'p', note_id: 'n1', text: 'parent', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        { id: 'c', note_id: 'n1', text: 'child', completed: false, position: 1, parent_id: 'p', assigned_to: '', created_at: '', updated_at: '' },
      ],
    };

    it('useUpdateNote reflects the edit in the cache before the request resolves', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      queryClient.setQueryData(noteLocalQueryKey('123'), existingTextNote);
      queryClient.setQueryData(notesLocalQueryKey(undefined), [existingTextNote]);

      // The server call stays in flight for the duration of the assertions.
      // Reset first: clearAllMocks does not drain a leftover mock*Once queue.
      const pending = deferred<typeof existingTextNote>();
      mockNotesApi.updateNote.mockReset();
      mockNotesApi.updateNote.mockReturnValueOnce(pending.promise as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper });
      result.current.mutate({ id: '123', data: { content: 'New body' } });

      // Optimistic update is visible while the request is still in flight (we
      // have not resolved `pending` yet) — the UI does not wait on the network.
      await waitFor(() => {
        expect((queryClient.getQueryData(noteLocalQueryKey('123')) as { content: string }).content).toBe('New body');
      });
      expect(mockNotesApi.updateNote).toHaveBeenCalledWith('123', { content: 'New body' });
      expect((queryClient.getQueryData(notesLocalQueryKey(undefined)) as Array<{ content: string }>)[0].content).toBe('New body');

      // Let the request finish so the hook settles cleanly.
      pending.resolve({ ...existingTextNote, content: 'New body' } as never);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('useUpdateNote rolls back the optimistic edit on a permanent (4xx) failure', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      queryClient.setQueryData(noteLocalQueryKey('123'), existingTextNote);
      queryClient.setQueryData(notesLocalQueryKey(undefined), [existingTextNote]);
      mockNotesApi.updateNote.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = renderHook(() => useUpdateNote(), { wrapper });
      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      // The phantom edit is reverted and nothing was queued.
      expect((queryClient.getQueryData(noteLocalQueryKey('123')) as { content: string }).content).toBe('Old body');
      expect((queryClient.getQueryData(notesLocalQueryKey(undefined)) as Array<{ content: string }>)[0].content).toBe('Old body');
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('rolling back a failed update preserves a concurrent optimistic edit to another note in the same list', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      const noteA = { ...existingTextNote, id: 'a', content: 'A-old' };
      const noteB = { ...existingTextNote, id: 'b', content: 'B-old' };
      queryClient.setQueryData(noteLocalQueryKey('a'), noteA);
      queryClient.setQueryData(notesLocalQueryKey(undefined), [noteA, noteB]);

      // Note A's request stays in flight so we can interleave a concurrent edit.
      const pending = deferred<typeof noteA>();
      mockNotesApi.updateNote.mockReset();
      mockNotesApi.updateNote.mockReturnValueOnce(pending.promise as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper });
      result.current.mutate({ id: 'a', data: { content: 'A-new' } });

      // Wait until A's optimistic edit lands (its onMutate has snapshotted the list).
      await waitFor(() => {
        const list = queryClient.getQueryData(notesLocalQueryKey(undefined)) as Array<{ id: string; content: string }>;
        expect(list.find((n) => n.id === 'a')!.content).toBe('A-new');
      });

      // A different in-flight mutation optimistically edits note B in the same list.
      queryClient.setQueryData<Array<{ id: string; content: string }>>(
        notesLocalQueryKey(undefined),
        (old) => old!.map((n) => (n.id === 'b' ? { ...n, content: 'B-new' } : n)),
      );

      // Now A fails permanently → its rollback runs.
      pending.reject(makeAxiosError(400));
      await waitFor(() => expect(result.current.isError).toBe(true));

      const list = queryClient.getQueryData(notesLocalQueryKey(undefined)) as Array<{ id: string; content: string }>;
      expect(list.find((n) => n.id === 'a')!.content).toBe('A-old'); // A reverted
      expect(list.find((n) => n.id === 'b')!.content).toBe('B-new'); // B's concurrent edit preserved
    });

    it('useToggleNoteItemCompleted toggles the cached item (and cascades) before the request resolves', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      queryClient.setQueryData(noteLocalQueryKey('n1'), listNote);

      const pending = deferred<unknown[]>();
      mockNotesApi.toggleItemCompleted.mockReset();
      mockNotesApi.toggleItemCompleted.mockReturnValueOnce(pending.promise as never);

      const { result } = renderHook(() => useToggleNoteItemCompleted(), { wrapper });
      result.current.mutate({ noteId: 'n1', itemId: 'p', completed: true });

      await waitFor(() => {
        const cached = queryClient.getQueryData(noteLocalQueryKey('n1')) as { items: Array<{ id: string; completed: boolean }> };
        expect(cached.items.find((i) => i.id === 'p')!.completed).toBe(true);
        // Toggling a top-level item cascades to its children.
        expect(cached.items.find((i) => i.id === 'c')!.completed).toBe(true);
      });
      expect(mockNotesApi.toggleItemCompleted).toHaveBeenCalledWith('n1', 'p', true);

      pending.resolve([]);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('useToggleNoteItemCompleted un-completes an already-completed parent when a child is unchecked', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      const completedListNote = {
        ...listNote,
        items: [
          { ...listNote.items[0], completed: true },
          { ...listNote.items[1], completed: true },
        ],
      };
      queryClient.setQueryData(noteLocalQueryKey('n1'), completedListNote);

      const pending = deferred<unknown[]>();
      mockNotesApi.toggleItemCompleted.mockReset();
      mockNotesApi.toggleItemCompleted.mockReturnValueOnce(pending.promise as never);

      const { result } = renderHook(() => useToggleNoteItemCompleted(), { wrapper });
      result.current.mutate({ noteId: 'n1', itemId: 'c', completed: false });

      await waitFor(() => {
        const cached = queryClient.getQueryData(noteLocalQueryKey('n1')) as { items: Array<{ id: string; completed: boolean }> };
        expect(cached.items.find((i) => i.id === 'c')!.completed).toBe(false);
        // A parent can never stay "done" while one of its children is not.
        expect(cached.items.find((i) => i.id === 'p')!.completed).toBe(false);
      });
      expect(mockNotesApi.toggleItemCompleted).toHaveBeenCalledWith('n1', 'c', false);

      pending.resolve([]);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('useToggleNoteItemCompleted rolls back the optimistic toggle on a permanent failure', async () => {
      const { wrapper, queryClient } = createWrapperWithClient();
      queryClient.setQueryData(noteLocalQueryKey('n1'), listNote);
      mockNotesApi.toggleItemCompleted.mockRejectedValueOnce(makeAxiosError(404));

      const { result } = renderHook(() => useToggleNoteItemCompleted(), { wrapper });
      await result.current.mutateAsync({ noteId: 'n1', itemId: 'p', completed: true }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      const cached = queryClient.getQueryData(noteLocalQueryKey('n1')) as { items: Array<{ id: string; completed: boolean }> };
      expect(cached.items.find((i) => i.id === 'p')!.completed).toBe(false);
      expect(cached.items.find((i) => i.id === 'c')!.completed).toBe(false);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  describe('useDuplicateNote (online)', () => {
    it('duplicates a note via API and caches it locally', async () => {
      const duplicated = {
        id: 'duplicate-id', title: 'Copy of Updated', content: '', note_type: 'text',
        color: '#ffffff', pinned: false, archived: false, position: 0,
        checked_items_collapsed: false, is_shared: false, deleted_at: null,
        user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
      };
      mockNotesApi.duplicateNote.mockResolvedValueOnce(duplicated as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      result.current.mutate('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(duplicated);
      expect(mockNotesApi.duplicateNote).toHaveBeenCalledWith('123');
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), duplicated);
    });
  });

  describe('useDuplicateNote (offline)', () => {
    const sourceTextNote = {
      id: '123', title: '', content: 'Hello', note_type: 'text',
      color: '#ffeecc', pinned: true, archived: false, position: 2,
      checked_items_collapsed: false, is_shared: true, deleted_at: null,
      user_id: 'u1', created_at: 'old', updated_at: 'old',
      labels: [{ id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }],
      shared_with: [{ id: 's1', note_id: '123', shared_with_user_id: 'u2', shared_by_user_id: 'u1', permission_level: 'write', username: 'bob', first_name: 'Bob', last_name: 'B', has_profile_icon: false, created_at: '', updated_at: '' }],
    };
    const sourceListNote = {
      id: '456', title: 'My List', content: '', note_type: 'list',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: 'old', updated_at: 'old',
      labels: [], shared_with: [],
      items: [
        { id: 'i1', note_id: '456', text: 'Item A', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        { id: 'i2', note_id: '456', text: 'Item B', completed: true, position: 1, parent_id: 'i1', assigned_to: '', created_at: '', updated_at: '' },
      ],
    };

    it('creates a local copy of a text note with a server-valid client id and enqueues the duplicate op', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(sourceTextNote as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      const localDuplicate = await result.current.mutateAsync('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Local copy should reset sharing/pinned/position but keep content and labels,
      // and use a server-valid client id (no local_ prefix) for idempotent replay.
      expect(localDuplicate.id).toBe('ClientNoteId000000000A');
      expect(localDuplicate.note_type).toBe('text');
      expect((localDuplicate as { content: string }).content).toBe('Hello');
      expect(localDuplicate.color).toBe('#ffeecc');
      expect(localDuplicate.pinned).toBe(false);
      expect(localDuplicate.position).toBe(0);
      expect(localDuplicate.is_shared).toBe(false);
      expect(localDuplicate.shared_with).toEqual([]);
      expect(localDuplicate.labels).toEqual(sourceTextNote.labels);

      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), localDuplicate);
      expect(mockNoteQueries.markNotePendingCreate).toHaveBeenCalledWith(
        expect.anything(),
        'ClientNoteId000000000A',
      );
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'duplicate',
          endpoint: '/notes/123/duplicate',
          method: 'POST',
          body: { id: 'ClientNoteId000000000A' },
        }),
      );
    });

    it('creates a local copy of a list note with new item ids and remapped parent_id', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(sourceListNote as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      const localDuplicate = await result.current.mutateAsync('456');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(localDuplicate.note_type).toBe('list');
      const dupList = localDuplicate as {
        note_type: 'list';
        items: Array<{ id: string; note_id: string; text: string; parent_id: string | null }>;
      };
      expect(dupList.items).toHaveLength(2);
      // Item ids are regenerated (permanent server-format, #513); note_id points to
      // the client-id duplicate.
      expect(dupList.items[0].note_id).toBe('ClientNoteId000000000A');
      expect(dupList.items[0].text).toBe('Item A');
      expect(dupList.items[0].parent_id).toBeNull();
      expect(dupList.items[1].text).toBe('Item B');
      // parent_id must point to the new id of Item A (the regenerated id), not the
      // source note's item id 'i1'.
      expect(dupList.items[1].parent_id).toBe(dupList.items[0].id);
      expect(dupList.items[1].parent_id).not.toBe('i1');

      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'duplicate', endpoint: '/notes/456/duplicate' }),
      );
    });

    it('throws when the source note is missing from the local cache', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync('missing').catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect((result.current.error as Error).message).toMatch(/not found/i);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  describe('useDuplicateNote (online write failures)', () => {
    const sourceTextNote = {
      id: '123', title: '', content: 'Hello', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };

    it('falls back to the local queue on a transient failure (5xx)', async () => {
      mockNotesApi.duplicateNote.mockRejectedValueOnce(makeAxiosError(503));
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(sourceTextNote as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNoteQueries.saveNote).toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'duplicate', endpoint: '/notes/123/duplicate', method: 'POST' }),
      );
    });

    it('falls back to the local queue on a network error (no response)', async () => {
      mockNotesApi.duplicateNote.mockRejectedValueOnce(makeNetworkError());
      mockNoteQueries.getLocalNote.mockResolvedValueOnce(sourceTextNote as never);

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalled();
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockNotesApi.duplicateNote.mockRejectedValueOnce(makeAxiosError(403));

      const { result } = renderHook(() => useDuplicateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync('123').catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
    });
  });
});
