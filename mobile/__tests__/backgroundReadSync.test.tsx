import React from 'react';
import { Text } from 'react-native';
import { renderHook, render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOfflineNotes, useOfflineNote } from '../src/hooks/useOfflineNotes';
import { useLabels } from '../src/hooks/useLabels';
import { UsersProvider, useUsers } from '../src/store/UsersContext';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as userQueriesModule from '../src/db/userQueries';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot');

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockUseNetworkStatus = (
  jest.requireMock('../src/hooks/useNetworkStatus') as { useNetworkStatus: jest.Mock }
).useNetworkStatus;

jest.mock('../src/db/noteQueries', () => ({
  getLocalNotes: jest.fn().mockResolvedValue([]),
  getLocalNote: jest.fn().mockResolvedValue(null),
  markLocalNoteDeleted: jest.fn().mockResolvedValue(undefined),
  getStoredLabels: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  saveServerNotesScope: jest.fn().mockResolvedValue(undefined),
  saveServerNote: jest.fn().mockResolvedValue(undefined),
  getProtectedNoteIds: jest.fn().mockResolvedValue(new Set()),
  saveServerLabels: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/userQueries', () => ({
  getLocalUsers: jest.fn().mockResolvedValue([]),
  saveUsers: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({
    user: { id: 'u1', username: 'me' },
    isAuthenticated: true,
  }),
}));

const mockJot = jest.mocked(jot);

const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockUserQueries = userQueriesModule as jest.Mocked<typeof userQueriesModule>;
const mockSyncQueue = jest.requireMock('../src/db/syncQueue') as {
  saveServerNotesScope: jest.Mock;
  saveServerNote: jest.Mock;
  getProtectedNoteIds: jest.Mock;
};

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

const sampleNote = {
  id: 'n1', content: 'body', note_type: 'text',
  color: '#ffffff', pinned: false, archived: false, position: 0,
  checked_items_collapsed: false, is_shared: false, deleted_at: null,
  user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('background read-sync retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockNoteQueries.getLocalNotes.mockResolvedValue([]);
    mockNoteQueries.getLocalNote.mockResolvedValue(null);
    mockNoteQueries.getStoredLabels.mockResolvedValue([]);
    mockUserQueries.getLocalUsers.mockResolvedValue([]);
    mockSyncQueue.saveServerNotesScope.mockResolvedValue(undefined);
    mockSyncQueue.saveServerNote.mockResolvedValue(undefined);
    mockSyncQueue.getProtectedNoteIds.mockResolvedValue(new Set());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── useOfflineNotes ────────────────────────────────────────────────────────

  it('retries a transient notes-list sync failure and then persists server data', async () => {
    mockJot.notes.getAll
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce([sampleNote] as never);

    await renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockJot.notes.getAll).toHaveBeenCalledTimes(1);
    expect(mockSyncQueue.saveServerNotesScope).not.toHaveBeenCalled();

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockJot.notes.getAll).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalledWith(expect.anything(), [sampleNote], undefined);
  });

  it('keeps the local cache when notes-list retries are exhausted', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockJot.notes.getAll.mockRejectedValue(makeAxiosError(503));

    await renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000 * 2); });
    // 2 attempts (initial + 1 retry), then give up without writing.
    expect(mockJot.notes.getAll).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNotesScope).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Background notes sync failed after retries:', expect.anything());
    warnSpy.mockRestore();
  });

  it('does not retry while offline', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    await renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
    expect(mockJot.notes.getAll).not.toHaveBeenCalled();
  });

  // ── useOfflineNote (single note) ────────────────────────────────────────────

  it('retries a transient single-note sync failure and then persists the note', async () => {
    mockJot.notes.getById
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockResolvedValueOnce(sampleNote as never);

    await renderHook(() => useOfflineNote('n1'), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockJot.notes.getById).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockJot.notes.getById).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNote).toHaveBeenCalledWith(expect.anything(), sampleNote);
  });

  it('tombstones a single note on a permanent 404 without retrying', async () => {
    mockJot.notes.getById.mockRejectedValue(makeAxiosError(404));

    await renderHook(() => useOfflineNote('n1'), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
    expect(mockJot.notes.getById).toHaveBeenCalledTimes(1);
    expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'n1');
  });

  // ── useOfflineNote → notes list (issue: stale dashboard cards) ──────────────

  it('refreshes the notes list after a single-note sync writes fresh data to SQLite', async () => {
    const staleNote = {
      ...sampleNote, note_type: 'list', title: 'Groceries', content: '',
      items: [{ id: 'i1', text: 'Milk', completed: true, position: 0, parent_id: null, assigned_to: '' }],
    };
    const freshNote = {
      ...staleNote,
      items: [
        ...staleNote.items,
        { id: 'i2', text: 'Bread', completed: false, position: 1, parent_id: null, assigned_to: '' },
      ],
    };

    mockNoteQueries.getLocalNotes.mockResolvedValue([staleNote] as never);
    mockNoteQueries.getLocalNote.mockResolvedValue(staleNote as never);
    // The list-level background sync never lands (still in flight), so the note
    // sync is the only thing that writes fresh rows — exactly the case where the
    // dashboard used to keep rendering the stale item set until an app restart.
    mockJot.notes.getAll.mockReturnValue(new Promise(() => {}) as never);
    mockJot.notes.getById.mockResolvedValue(freshNote as never);
    mockSyncQueue.saveServerNote.mockImplementation(async () => {
      mockNoteQueries.getLocalNotes.mockResolvedValue([freshNote] as never);
      mockNoteQueries.getLocalNote.mockResolvedValue(freshNote as never);
    });

    const wrapper = createWrapper();
    const { result } = await renderHook(
      () => ({ list: useOfflineNotes(), note: useOfflineNote('n1') }),
      { wrapper },
    );

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });

    expect(mockSyncQueue.saveServerNote).toHaveBeenCalledWith(expect.anything(), freshNote);
    await waitFor(() => expect(result.current.note.data).toEqual(freshNote));
    await waitFor(() => expect(result.current.list.data).toEqual([freshNote]));
  });

  it('refreshes the notes list after a single-note 404 tombstones the note', async () => {
    mockNoteQueries.getLocalNotes.mockResolvedValue([sampleNote] as never);
    mockNoteQueries.getLocalNote.mockResolvedValue(sampleNote as never);
    mockJot.notes.getAll.mockReturnValue(new Promise(() => {}) as never);
    mockJot.notes.getById.mockRejectedValue(makeAxiosError(404));
    mockNoteQueries.markLocalNoteDeleted.mockImplementation(async () => {
      mockNoteQueries.getLocalNotes.mockResolvedValue([]);
      mockNoteQueries.getLocalNote.mockResolvedValue(null);
    });

    const wrapper = createWrapper();
    const { result } = await renderHook(
      () => ({ list: useOfflineNotes(), note: useOfflineNote('n1') }),
      { wrapper },
    );

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });

    expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'n1');
    await waitFor(() => expect(result.current.list.data).toEqual([]));
  });

  // ── useLabels ───────────────────────────────────────────────────────────────

  it('retries a transient labels sync failure and then caches server labels', async () => {
    const serverLabels = [{ id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }];
    mockJot.labels.getAll
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce(serverLabels as never);

    const { result } = await renderHook(() => useLabels(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockJot.labels.getAll).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockJot.labels.getAll).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data).toEqual(serverLabels));
  });

  // ── UsersContext ──────────────────────────────────────────────────────────────

  it('retries a transient users sync failure and then exposes server users', async () => {
    const serverUsers = [{ id: 'u2', username: 'other' }];
    mockJot.users.list
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce(serverUsers as never);

    function Consumer() {
      const { usersById } = useUsers();
      return <Text>{usersById.has('u2') ? 'has-other' : 'no-other'}</Text>;
    }

    await render(
      <QueryClientProvider client={new QueryClient()}>
        <UsersProvider>
          <Consumer />
        </UsersProvider>
      </QueryClientProvider>,
    );

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockJot.users.list).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockJot.users.list).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('has-other')).toBeTruthy());
  });
});
