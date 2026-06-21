import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState, AppStateStatus } from 'react-native';
import { useSSE } from '../src/hooks/useSSE';
import { SSEConnectionManager } from '../src/api/events';
import type { Note, SSEEvent } from '@jot/shared';
import { noteLocalQueryKey, notesLocalQueryScopeKey } from '../src/hooks/queryKeys';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: jest.fn(() => ({
    runAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Fixed CLIENT_ID for tests — matches what useSSE imports from api/client.
const TEST_CLIENT_ID = 'test-device-client-id';
jest.mock('../src/api/client', () => ({
  ...jest.requireActual('../src/api/client'),
  CLIENT_ID: TEST_CLIENT_ID,
}));

jest.mock('../src/db/noteQueries', () => ({
  markLocalNoteDeleted: jest.fn().mockResolvedValue(undefined),
  permanentDeleteLocalNote: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/api/notes', () => ({
  getNote: jest.fn(),
}));

let mockProtectedNoteIds = new Set<string>();
jest.mock('../src/db/syncQueue', () => ({
  saveServerNote: jest.fn().mockResolvedValue(undefined),
  getProtectedNoteIds: jest.fn(() => Promise.resolve(mockProtectedNoteIds)),
}));

const mockSaveServerNote = (jest.requireMock('../src/db/syncQueue') as { saveServerNote: jest.Mock }).saveServerNote;
const mockMarkLocalNoteDeleted = (jest.requireMock('../src/db/noteQueries') as { markLocalNoteDeleted: jest.Mock }).markLocalNoteDeleted;
const mockPermanentDeleteLocalNote = (jest.requireMock('../src/db/noteQueries') as { permanentDeleteLocalNote: jest.Mock }).permanentDeleteLocalNote;
const mockGetNote = (jest.requireMock('../src/api/notes') as { getNote: jest.Mock }).getNote;
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mock SSEConnectionManager
let capturedCallback: ((event: SSEEvent) => void) | null = null;
const mockConnect = jest.fn().mockImplementation(async (cb: (event: SSEEvent) => void) => {
  capturedCallback = cb;
});
const mockDisconnect = jest.fn();

jest.mock('../src/api/events', () => ({
  SSEConnectionManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
  })),
}));

// Mock useAuth
const mockUser = { id: 'current-user', username: 'testuser' };
let mockIsAuthenticated = true;
jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({
    user: mockIsAuthenticated ? mockUser : null,
    isAuthenticated: mockIsAuthenticated,
  }),
}));

// Mock useNetworkStatus — default connected
let mockIsConnected = true;
jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ isConnected: mockIsConnected }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return { queryClient, Wrapper: ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  ) };
}

describe('useSSE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;
    mockIsAuthenticated = true;
    mockIsConnected = true;
    mockProtectedNoteIds = new Set<string>();
  });

  it('starts SSE connection when authenticated', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(SSEConnectionManager).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
  });

  it('does not start connection when not authenticated', () => {
    mockIsAuthenticated = false;
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', () => {
    const { Wrapper } = createWrapper();
    const { unmount } = renderHook(() => useSSE(), { wrapper: Wrapper });

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('persists the note payload and invalidates queries on note_created event', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const note = { id: 'new-note', note_type: 'text', content: 'hi' } as unknown as Note;
    await act(async () => {
      capturedCallback?.({
        type: 'note_created',
        source_user_id: 'other-user',
        data: { note_id: 'new-note', note },
      });
    });

    // The list/detail queries read from SQLite (staleTime: Infinity), so the note
    // must be written before invalidation or the new note wouldn't appear until the
    // next reconnect-triggered resync.
    await waitFor(() => expect(mockSaveServerNote).toHaveBeenCalledWith(expect.anything(), note));
    expect(mockGetNote).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() }));
  });

  it('fetches the note when a note_created/note_shared event carries no payload', async () => {
    const fetched = { id: 'new-note', note_type: 'text', content: 'fetched' } as unknown as Note;
    mockGetNote.mockResolvedValueOnce(fetched);

    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    await act(async () => {
      capturedCallback?.({
        type: 'note_shared',
        source_user_id: 'other-user',
        target_user_id: 'current-user',
        data: { note_id: 'new-note', note: null },
      });
    });

    await waitFor(() => expect(mockGetNote).toHaveBeenCalledWith('new-note'));
    await waitFor(() => expect(mockSaveServerNote).toHaveBeenCalledWith(expect.anything(), fetched));
  });

  it('invalidates notes list and specific note on note_updated event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
  });

  it('persists the note payload through the queue-aware saveServerNote (#487)', async () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    const note = { id: 'note-123', note_type: 'text', content: 'fresh' } as unknown as Note;
    await act(async () => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note },
      });
    });

    // saveServerNote defers to any pending local edit on the note, so the server
    // version can't overwrite an unsynced optimistic edit (gating verified in
    // pendingNoteSync.test.ts).
    await waitFor(() => expect(mockSaveServerNote).toHaveBeenCalledWith(expect.anything(), note));
  });

  it('persists the note to SQLite before invalidating queries so the refetch reads fresh data', async () => {
    // Regression: the notes list and single-note queries read straight from SQLite
    // (staleTime: Infinity), so invalidating before saveServerNote lands makes the
    // refetch read stale rows — the remote change (item toggle, edited text) never
    // surfaces on the dashboard until the next background sync.
    let resolveSave: (() => void) | undefined;
    mockSaveServerNote.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSave = resolve; }),
    );

    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const note = { id: 'note-123', note_type: 'list', title: 'Groceries' } as unknown as Note;
    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note },
      });
    });

    // While the write is in flight, queries must not be invalidated yet.
    await flushMicrotasks();
    expect(mockSaveServerNote).toHaveBeenCalledWith(expect.anything(), note);
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Once the write lands, both the single note and the dashboard list refresh.
    await act(async () => {
      resolveSave?.();
      await flushMicrotasks();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
  });

  it('invalidates notes list and tombstones the note on note_deleted event', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(async () => {
      capturedCallback?.({
        type: 'note_deleted',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') }));
    expect(mockMarkLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'note-123');
    // The list is refreshed only after the tombstone lands, so the refetch can't
    // read the still-present row.
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() }));
  });

  it('does not tombstone a deleted note that still has a pending or failed local op (#487/#492)', async () => {
    // A queued edit/restore may be racing the remote delete, or a dead-lettered edit
    // may be the version we're preserving; defer to the drain/resolution rather than
    // hide the optimistic edit.
    mockProtectedNoteIds = new Set(['note-123']);
    const { queryClient, Wrapper } = createWrapper();
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    await act(async () => {
      capturedCallback?.({
        type: 'note_deleted',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });
    await flushMicrotasks();

    expect(mockMarkLocalNoteDeleted).not.toHaveBeenCalled();
    // The note's query cache is also left intact, so an open detail view isn't dropped.
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('invalidates queries for same-user events from a different device', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    // Clear the initial invalidation call from the connect effect
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user', // Same user, different device
        client_id: 'other-device-client-id', // Different device — must not be filtered
        data: { note_id: 'note-123', note: null },
      });
    });

    // Queries must be invalidated so the current device syncs the remote change
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
  });

  it('filters out events from the same device (matching client_id)', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user',
        client_id: TEST_CLIENT_ID, // Same device — must be filtered
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('does not call notification callback for same-user events', () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user', // Same user — should not show "updated by another user" toast
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(onNotify).not.toHaveBeenCalled();
  });

  it('calls notification callback on note_updated from another user', () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    const event: SSEEvent = {
      type: 'note_updated',
      source_user_id: 'other-user',
      data: { note_id: 'note-123', note: null },
    };

    act(() => {
      capturedCallback?.(event);
    });

    expect(onNotify).toHaveBeenCalledWith(event);
  });

  it('hard-removes the note for the recipient who lost access on note_unshared', async () => {
    // The recipient gets no note payload and can no longer see the note in any
    // scope, so it must be hard-deleted (not tombstoned — it must not linger in
    // their local trash view).
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(async () => {
      capturedCallback?.({
        type: 'note_unshared',
        source_user_id: 'other-user',
        target_user_id: 'current-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    await waitFor(() => expect(mockPermanentDeleteLocalNote).toHaveBeenCalledWith(expect.anything(), 'note-123'));
    expect(mockMarkLocalNoteDeleted).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() }));
  });

  it('refreshes (does not remove) the note on note_unshared for the owner or other collaborators', async () => {
    // The owner/remaining collaborators receive the event too; they keep the note
    // but its shared_with changed. The event has no payload and SQLite-backed
    // queries don't refetch on a bare invalidation, so the note is fetched and
    // saved, and both the detail and list caches are invalidated.
    const fetched = { id: 'note-123', note_type: 'text', is_shared: false } as unknown as Note;
    mockGetNote.mockResolvedValueOnce(fetched);

    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(async () => {
      capturedCallback?.({
        type: 'note_unshared',
        source_user_id: 'current-user',
        target_user_id: 'someone-else',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(mockPermanentDeleteLocalNote).not.toHaveBeenCalled();
    await waitFor(() => expect(mockGetNote).toHaveBeenCalledWith('note-123'));
    await waitFor(() => expect(mockSaveServerNote).toHaveBeenCalledWith(expect.anything(), fetched));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') }));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() }));
  });

  it('does not hard-remove an unshared note that has a pending or failed local op (#487/#492)', async () => {
    mockProtectedNoteIds = new Set(['note-123']);
    const { queryClient, Wrapper } = createWrapper();
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    await act(async () => {
      capturedCallback?.({
        type: 'note_unshared',
        source_user_id: 'other-user',
        target_user_id: 'current-user',
        data: { note_id: 'note-123', note: null },
      });
    });
    await flushMicrotasks();

    expect(mockPermanentDeleteLocalNote).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('does not start connection when offline', () => {
    mockIsConnected = false;
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('stops connection when going offline and reconnects when coming back online', () => {
    const { Wrapper } = createWrapper();

    // Start online
    mockIsConnected = true;
    const { rerender } = renderHook(() => useSSE(), { wrapper: Wrapper });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Go offline — re-render with updated mock value
    mockIsConnected = false;
    mockDisconnect.mockClear();
    rerender({});
    expect(mockDisconnect).toHaveBeenCalled();

    // Come back online — should reconnect
    mockIsConnected = true;
    mockConnect.mockClear();
    rerender({});
    expect(mockConnect).toHaveBeenCalled();
  });

  it('registers AppState listener for foreground/background management', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('disconnects on background and reconnects on foreground', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    // Get the AppState change handler
    const appStateHandler = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;

    // Going to background should disconnect
    act(() => {
      appStateHandler('background');
    });
    expect(mockDisconnect).toHaveBeenCalled();

    // Returning to foreground should reconnect
    mockConnect.mockClear();
    act(() => {
      appStateHandler('active');
    });
    expect(mockConnect).toHaveBeenCalled();
  });
});
