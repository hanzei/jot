import React from 'react';
import { Text } from 'react-native';
import { renderHook, render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOfflineNotes, useOfflineNote } from '../src/hooks/useOfflineNotes';
import { useLabels } from '../src/hooks/useLabels';
import { UsersProvider, useUsers } from '../src/store/UsersContext';
import * as notesApi from '../src/api/notes';
import * as labelsApi from '../src/api/labels';
import * as usersApi from '../src/api/users';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as userQueriesModule from '../src/db/userQueries';

jest.mock('../src/api/notes');
jest.mock('../src/api/labels');
jest.mock('../src/api/users');

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

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;
const mockLabelsApi = labelsApi as jest.Mocked<typeof labelsApi>;
const mockUsersApi = usersApi as jest.Mocked<typeof usersApi>;
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
    mockNotesApi.getNotes
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce([sampleNote] as never);

    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(1);
    expect(mockSyncQueue.saveServerNotesScope).not.toHaveBeenCalled();

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalledWith(expect.anything(), [sampleNote], undefined);
  });

  it('keeps the local cache when notes-list retries are exhausted', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockNotesApi.getNotes.mockRejectedValue(makeAxiosError(503));

    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000 * 2); });
    // 2 attempts (initial + 1 retry), then give up without writing.
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNotesScope).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Background notes sync failed after retries:', expect.anything());
    warnSpy.mockRestore();
  });

  it('does not retry while offline', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
    expect(mockNotesApi.getNotes).not.toHaveBeenCalled();
  });

  // ── useOfflineNote (single note) ────────────────────────────────────────────

  it('retries a transient single-note sync failure and then persists the note', async () => {
    mockNotesApi.getNote
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockResolvedValueOnce(sampleNote as never);

    renderHook(() => useOfflineNote('n1'), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockNotesApi.getNote).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockNotesApi.getNote).toHaveBeenCalledTimes(2);
    expect(mockSyncQueue.saveServerNote).toHaveBeenCalledWith(expect.anything(), sampleNote);
  });

  it('tombstones a single note on a permanent 404 without retrying', async () => {
    mockNotesApi.getNote.mockRejectedValue(makeAxiosError(404));

    renderHook(() => useOfflineNote('n1'), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
    expect(mockNotesApi.getNote).toHaveBeenCalledTimes(1);
    expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'n1');
  });

  // ── useLabels ───────────────────────────────────────────────────────────────

  it('retries a transient labels sync failure and then caches server labels', async () => {
    const serverLabels = [{ id: 'l1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }];
    mockLabelsApi.getLabels
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce(serverLabels as never);

    const { result } = renderHook(() => useLabels(), { wrapper: createWrapper() });

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockLabelsApi.getLabels).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data).toEqual(serverLabels));
  });

  // ── UsersContext ──────────────────────────────────────────────────────────────

  it('retries a transient users sync failure and then exposes server users', async () => {
    const serverUsers = [{ id: 'u2', username: 'other' }];
    mockUsersApi.getUsers
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce(serverUsers as never);

    function Consumer() {
      const { usersById } = useUsers();
      return <Text>{usersById.has('u2') ? 'has-other' : 'no-other'}</Text>;
    }

    render(
      <QueryClientProvider client={new QueryClient()}>
        <UsersProvider>
          <Consumer />
        </UsersProvider>
      </QueryClientProvider>,
    );

    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockUsersApi.getUsers).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(mockUsersApi.getUsers).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('has-other')).toBeTruthy());
  });
});
