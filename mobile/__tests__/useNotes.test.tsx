import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useNotes,
  useNote,
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
  useShareNote,
  useUnshareNote,
} from '../src/hooks/useNotes';
import * as notesApi from '../src/api/notes';
import * as usersApi from '../src/api/users';
import * as noteQueriesModule from '../src/db/noteQueries';

jest.mock('../src/api/notes');
jest.mock('../src/api/users', () => ({
  getNoteShares: jest.fn(),
  shareNote: jest.fn().mockResolvedValue(undefined),
  unshareNote: jest.fn().mockResolvedValue(undefined),
}));

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
}));

jest.mock('../src/db/syncQueue', () => ({
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;
const mockUsersApi = usersApi as jest.Mocked<typeof usersApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;

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

      result.current.mutate({ title: 'Created', content: '', note_type: 'text' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(newNote);
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), newNote);
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

  describe('share hooks', () => {
    it('shares a note by username', async () => {
      const { result } = renderHook(() => useShareNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'note-1', username: 'alice' });

      expect(mockUsersApi.shareNote).toHaveBeenCalledWith('note-1', 'alice');
    });

    it('unshares a note by username', async () => {
      const { result } = renderHook(() => useUnshareNote(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'note-1', username: 'alice' });

      expect(mockUsersApi.unshareNote).toHaveBeenCalledWith('note-1', 'alice');
    });
  });
});
