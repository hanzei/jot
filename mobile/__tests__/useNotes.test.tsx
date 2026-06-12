import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNotes, useNote, useCreateNote, useUpdateNote, useDeleteNote, useDuplicateNote, useCreateNoteItem, useToggleNoteItemCompleted } from '../src/hooks/useNotes';
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
  generateLocalId: jest.fn(() => 'local_test_id'),
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

jest.mock('../src/api/client', () => ({
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
}));

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

describe('useNotes hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default online state after any test that changed it
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
  });

  describe('useNotes', () => {
    it('fetches and returns notes', async () => {
      const mockNotes = [{ id: '1', title: 'Note 1' }];
      mockNotesApi.getNotes.mockResolvedValueOnce(mockNotes as never);

      const { result } = renderHook(() => useNotes(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockNotes);
      expect(mockNotesApi.getNotes).toHaveBeenCalledWith(undefined);
    });

    it('passes params to getNotes', async () => {
      mockNotesApi.getNotes.mockResolvedValueOnce([] as never);

      const params = { archived: true };
      const { result } = renderHook(() => useNotes(params), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNotesApi.getNotes).toHaveBeenCalledWith(params);
    });

    it('passes my_tasks param to getNotes', async () => {
      mockNotesApi.getNotes.mockResolvedValueOnce([] as never);

      const params = { my_tasks: true };
      const { result } = renderHook(() => useNotes(params), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNotesApi.getNotes).toHaveBeenCalledWith(params);
    });
  });

  describe('useNote', () => {
    it('fetches a single note by ID', async () => {
      const mockNote = { id: '123', title: 'My Note' };
      mockNotesApi.getNote.mockResolvedValueOnce(mockNote as never);

      const { result } = renderHook(() => useNote('123'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockNote);
      expect(mockNotesApi.getNote).toHaveBeenCalledWith('123');
    });

    it('does not fetch when id is null', () => {
      const { result } = renderHook(() => useNote(null), { wrapper: createWrapper() });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockNotesApi.getNote).not.toHaveBeenCalled();
    });
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
      id: '123', title: 'Old', content: 'Old body', note_type: 'text',
      color: '#ffffff', pinned: false, archived: false, position: 0,
      checked_items_collapsed: false, is_shared: false, deleted_at: null,
      user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
    };

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

      // A real validation/auth error must reach the UI, not be silently queued.
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
    });

    it('surfaces a 401 without queuing (the interceptor logs the user out)', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(makeAxiosError(401));

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
    });

    it('rethrows a non-Axios (local) error instead of queuing it', async () => {
      mockNotesApi.updateNote.mockRejectedValueOnce(new Error('boom'));

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ id: '123', data: { content: 'New body' } }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
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
});
