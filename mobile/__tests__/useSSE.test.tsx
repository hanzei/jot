import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppStateStatus } from 'react-native';
import { AppState } from 'react-native';
import { useSSE } from '../src/hooks/useSSE';
import { SSEConnectionManager } from '../src/api/events';
import type { SSEEvent, User } from '@jot/shared';
import type { TestDatabase } from './helpers/testDb';
import { makeLabel, makeListNote, makeTextNote } from './helpers/fixtures';
import { saveNote } from '../src/db/noteQueries';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from '../src/hooks/queryKeys';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// Fixed CLIENT_ID for tests — matches what useSSE imports from api/client.
const TEST_CLIENT_ID = 'test-device-client-id';
jest.mock('../src/api/client', () => ({
  ...jest.requireActual('../src/api/client'),
  CLIENT_ID: TEST_CLIENT_ID,
}));

// The db layer runs for real against the test database (see helpers/testDb.ts);
// each function stays a spy so the existing call assertions keep working while
// the SQL underneath them actually executes. `useSQLiteContext()` comes from the
// global mock and returns one stable database per test.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return {
    ...actual,
    markLocalNoteDeleted: jest.fn(actual.markLocalNoteDeleted),
    permanentDeleteLocalNote: jest.fn(actual.permanentDeleteLocalNote),
    patchLocalNoteImages: jest.fn(actual.patchLocalNoteImages),
    upsertLabel: jest.fn(actual.upsertLabel),
  };
});

jest.mock('../src/api/notes', () => ({
  getNote: jest.fn(),
}));

jest.mock('../src/store/profileIconEvents', () => ({
  publishProfileIconUpdate: jest.fn(),
}));

const mockPublishProfileIconUpdate = (
  jest.requireMock('../src/store/profileIconEvents') as { publishProfileIconUpdate: jest.Mock }
).publishProfileIconUpdate;

jest.mock('../src/store/resyncEvents', () => ({
  publishReconnectResync: jest.fn(),
}));

const mockPublishReconnectResync = (
  jest.requireMock('../src/store/resyncEvents') as { publishReconnectResync: jest.Mock }
).publishReconnectResync;

jest.mock('../src/db/syncQueue', () => {
  const actual = jest.requireActual('../src/db/syncQueue');
  return {
    ...actual,
    saveServerNote: jest.fn(actual.saveServerNote),
    getProtectedNoteIds: jest.fn(actual.getProtectedNoteIds),
  };
});

const mockSaveServerNote = (jest.requireMock('../src/db/syncQueue') as { saveServerNote: jest.Mock }).saveServerNote;
const mockMarkLocalNoteDeleted = (jest.requireMock('../src/db/noteQueries') as { markLocalNoteDeleted: jest.Mock }).markLocalNoteDeleted;
const mockPermanentDeleteLocalNote = (jest.requireMock('../src/db/noteQueries') as { permanentDeleteLocalNote: jest.Mock }).permanentDeleteLocalNote;
const mockGetNote = (jest.requireMock('../src/api/notes') as { getNote: jest.Mock }).getNote;
const mockPatchLocalNoteImages = (jest.requireMock('../src/db/noteQueries') as { patchLocalNoteImages: jest.Mock }).patchLocalNoteImages;
const mockUpsertLabel = (jest.requireMock('../src/db/noteQueries') as { upsertLabel: jest.Mock }).upsertLabel;
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

let db: TestDatabase;

/**
 * Give a note a queued sync op, which is what makes `getProtectedNoteIds`
 * report it — the real mechanism behind the #487/#492 guards below.
 */
const storedImages = async (noteId: string): Promise<unknown[]> => {
  const row = await db.getFirstAsync<{ images_json: string }>(
    'SELECT images_json FROM notes WHERE id = ?',
    [noteId],
  );
  return row ? (JSON.parse(row.images_json) as unknown[]) : [];
};

const protectNote = (noteId: string) =>
  db.runAsync(
    `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
     VALUES ('update', ?, 'PATCH', '{}', '')`,
    [`/notes/${noteId}`],
  );

// Mock SSEConnectionManager
let capturedCallback: ((event: SSEEvent) => void) | null = null;
let capturedStatusCallback: ((status: string) => void) | null = null;
const mockConnect = jest.fn().mockImplementation(
  async (cb: (event: SSEEvent) => void, onStatus?: (status: string) => void) => {
    capturedCallback = cb;
    capturedStatusCallback = onStatus ?? null;
  },
);
const mockDisconnect = jest.fn();
const mockManagerIsConnected = jest.fn(() => false);

jest.mock('../src/api/events', () => ({
  SSEConnectionManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    isConnected: mockManagerIsConnected,
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
    capturedStatusCallback = null;
    mockIsAuthenticated = true;
    mockIsConnected = true;
    db = globalThis.testDb;
    // Default: not yet connected, so foreground rebuilds like it always did.
    mockManagerIsConnected.mockReturnValue(false);
  });

  it('starts SSE connection when authenticated', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(SSEConnectionManager).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
  });

  it('does not start connection when not authenticated', async () => {
    mockIsAuthenticated = false;
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', async () => {
    const { Wrapper } = createWrapper();
    const { unmount } = await renderHook(() => useSSE(), { wrapper: Wrapper });

    await unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('persists the note payload and invalidates queries on note_created event', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const note = makeTextNote({ id: 'new-note', content: 'hi' });
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
    // The row is really in SQLite — the queries read from there, not from the event.
    expect(await db.getFirstAsync('SELECT id, content FROM notes WHERE id = ?', ['new-note'])).toEqual({
      id: 'new-note',
      content: 'hi',
    });
  });

  it('fetches the note when a note_created/note_shared event carries no payload', async () => {
    const fetched = makeTextNote({ id: 'new-note', content: 'fetched' });
    mockGetNote.mockResolvedValueOnce(fetched);

    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

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

  it('invalidates notes list and specific note on note_updated event', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
  });

  // The drawer's label list/counts are derived from notes' labels_json, so every
  // note mutation must also refresh the label queries — otherwise a collaborator's
  // label attach/detach (which fires note_updated) leaves the drawer stale (#689).
  it.each([
    ['note_updated', { type: 'note_updated', source_user_id: 'other-user', data: { note_id: 'note-123', note: null } }],
    ['note_created', { type: 'note_created', source_user_id: 'other-user', data: { note_id: 'note-123', note: null } }],
    ['note_shared', { type: 'note_shared', source_user_id: 'other-user', target_user_id: 'current-user', data: { note_id: 'note-123', note: null } }],
    ['note_deleted', { type: 'note_deleted', source_user_id: 'other-user', data: { note_id: 'note-123', note: null } }],
    ['note_unshared', { type: 'note_unshared', source_user_id: 'current-user', target_user_id: 'someone-else', data: { note_id: 'note-123', note: null } }],
  ] as [string, SSEEvent][])('invalidates label queries on %s event', async (_label, event) => {
    mockGetNote.mockResolvedValue(makeTextNote({ id: 'note-123' }));
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(async () => {
      capturedCallback?.(event);
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: labelsQueryKey() }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: labelCountsQueryKey() });
  });

  it('upserts the label into the store and invalidates label queries on labels_changed event', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const label = makeLabel({ id: 'label-1', user_id: 'other-user', name: 'Urgent' });
    await act(async () => {
      capturedCallback?.({
        type: 'labels_changed',
        source_user_id: 'other-user',
        data: { label },
      });
    });

    // The label is written to the canonical store so an empty label (created on
    // another device, zero notes) appears in the drawer immediately (#691).
    await waitFor(() => expect(mockUpsertLabel).toHaveBeenCalledWith(expect.anything(), label));
    // The row is really in the labels table, which is what the drawer reads.
    expect(await db.getAllAsync('SELECT id, name FROM labels')).toEqual([
      { id: 'label-1', name: 'Urgent' },
    ]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: labelsQueryKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: labelCountsQueryKey() });
  });

  it('publishes to the profile-icon bus on profile_icon_updated event', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    const updatedUser = { id: 'collaborator-1', username: 'bob', updated_at: '2024-02-02T00:00:00Z' } as unknown as User;
    await act(() => {
      capturedCallback?.({
        type: 'profile_icon_updated',
        source_user_id: 'collaborator-1',
        data: { user: updatedUser },
      });
    });

    expect(mockPublishProfileIconUpdate).toHaveBeenCalledWith(updatedUser);
  });

  // SSE is a live stream with no backfill, so anything that changed while it was
  // down (notably while the app was backgrounded) must be caught up on reconnect.
  // The first connect is already covered by the read hooks' mount-time sync, so it
  // must NOT publish; every subsequent connect must.
  it('publishes a reconnect resync on every connect after the first', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    // Initial connect: no catch-up (mount-time sync already ran).
    await act(() => capturedStatusCallback?.('connecting'));
    await act(() => capturedStatusCallback?.('connected'));
    expect(mockPublishReconnectResync).not.toHaveBeenCalled();

    // A drop + reconnect (e.g. foreground after backgrounding): catch up now.
    await act(() => capturedStatusCallback?.('reconnecting'));
    await act(() => capturedStatusCallback?.('connected'));
    expect(mockPublishReconnectResync).toHaveBeenCalledTimes(1);

    // Every further reconnect publishes again.
    await act(() => capturedStatusCallback?.('connected'));
    expect(mockPublishReconnectResync).toHaveBeenCalledTimes(2);
  });

  it('forwards status changes to the onStatusChange callback', async () => {
    const onStatusChange = jest.fn();
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(undefined, onStatusChange), { wrapper: Wrapper });

    await act(() => capturedStatusCallback?.('connected'));
    expect(onStatusChange).toHaveBeenCalledWith('connected');
  });

  it('patches local images and invalidates queries on note_image_added event', async () => {
    // patchLocalNoteImages no-ops on a missing row, so the note has to exist for
    // the patch to be observable at all.
    await saveNote(db, makeTextNote({ id: 'note-123' }));
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const image = { id: 'img-1', filename: 'a.png', content_type: 'image/png', width: 10, height: 10, created_at: '2024-01-01T00:00:00Z' };
    await act(async () => {
      capturedCallback?.({
        type: 'note_image_added',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', image },
      });
    });

    await waitFor(() => expect(mockPatchLocalNoteImages).toHaveBeenCalledWith(expect.anything(), 'note-123', expect.any(Function)));
    const updater = mockPatchLocalNoteImages.mock.calls[0][2] as (images: unknown[]) => unknown[];
    expect(updater([])).toEqual([image]);
    expect(updater([image])).toEqual([image]);
    // The image really landed on the stored note.
    expect(await storedImages('note-123')).toEqual([image]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
  });

  it('patches local images and invalidates queries on note_image_removed event', async () => {
    const image = { id: 'img-1', filename: 'a.png', content_type: 'image/png', width: 10, height: 10, created_at: '2024-01-01T00:00:00Z' };
    await saveNote(db, makeTextNote({ id: 'note-123', images: [image] }));
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(async () => {
      capturedCallback?.({
        type: 'note_image_removed',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', image_id: 'img-1' },
      });
    });

    await waitFor(() => expect(mockPatchLocalNoteImages).toHaveBeenCalledWith(expect.anything(), 'note-123', expect.any(Function)));
    const updater = mockPatchLocalNoteImages.mock.calls[0][2] as (images: { id: string }[]) => { id: string }[];
    expect(updater([{ id: 'img-1' }, { id: 'img-2' }])).toEqual([{ id: 'img-2' }]);
    // The removal really landed on the stored note.
    expect(await storedImages('note-123')).toEqual([]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesLocalQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-123') });
  });

  it('persists the note payload through the queue-aware saveServerNote (#487)', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    const note = makeTextNote({ id: 'note-123', content: 'fresh' });
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

    await renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    const note = makeListNote({ id: 'note-123', title: 'Groceries' });
    await act(() => {
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

    await renderHook(() => useSSE(), { wrapper: Wrapper });
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
    await protectNote('note-123');
    const { queryClient, Wrapper } = createWrapper();
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });

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

  it('invalidates queries for same-user events from a different device', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });

    // Clear the initial invalidation call from the connect effect
    invalidateSpy.mockClear();

    await act(() => {
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

  it('filters out events from the same device (matching client_id)', async () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onNotify = jest.fn();

    await renderHook(() => useSSE(onNotify), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    await act(() => {
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

  it('does not call notification callback for same-user events', async () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    await renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    await act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user', // Same user — should not show "updated by another user" toast
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(onNotify).not.toHaveBeenCalled();
  });

  it('calls notification callback on note_updated from another user', async () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    await renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    const event: SSEEvent = {
      type: 'note_updated',
      source_user_id: 'other-user',
      data: { note_id: 'note-123', note: null },
    };

    await act(() => {
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

    await renderHook(() => useSSE(), { wrapper: Wrapper });
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
    const fetched = makeTextNote({ id: 'note-123', is_shared: false });
    mockGetNote.mockResolvedValueOnce(fetched);

    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });
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
    await protectNote('note-123');
    const { queryClient, Wrapper } = createWrapper();
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    await renderHook(() => useSSE(), { wrapper: Wrapper });

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

  it('does not start connection when offline', async () => {
    mockIsConnected = false;
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('stops connection when going offline and reconnects when coming back online', async () => {
    const { Wrapper } = createWrapper();

    // Start online
    mockIsConnected = true;
    const { rerender } = await renderHook(() => useSSE(), { wrapper: Wrapper });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Go offline — re-render with updated mock value
    mockIsConnected = false;
    mockDisconnect.mockClear();
    await rerender({});
    expect(mockDisconnect).toHaveBeenCalled();

    // Come back online — should reconnect
    mockIsConnected = true;
    mockConnect.mockClear();
    await rerender({});
    expect(mockConnect).toHaveBeenCalled();
  });

  it('registers AppState listener for foreground/background management', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('disconnects on background and reconnects on foreground', async () => {
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    // Get the AppState change handler
    const appStateHandler = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;

    // Going to background should disconnect
    await act(() => {
      appStateHandler('background');
    });
    expect(mockDisconnect).toHaveBeenCalled();

    // Returning to foreground should reconnect
    mockConnect.mockClear();
    await act(() => {
      appStateHandler('active');
    });
    expect(mockConnect).toHaveBeenCalled();
  });

  it('does not tear down a healthy connection on a brief inactive→active foreground blip', async () => {
    // A control-center / notification-shade peek sends active→inactive→active
    // without a 'background', so the manager is still connected. Rebuilding would
    // throw away a working stream and pay a fresh TLS handshake on a weak link.
    mockManagerIsConnected.mockReturnValue(true);
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    const appStateHandler = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;

    mockConnect.mockClear();
    mockDisconnect.mockClear();
    await act(() => {
      appStateHandler('active');
    });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('rebuilds on foreground when the existing connection is not healthy', async () => {
    mockManagerIsConnected.mockReturnValue(false);
    const { Wrapper } = createWrapper();
    await renderHook(() => useSSE(), { wrapper: Wrapper });

    const appStateHandler = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;

    mockConnect.mockClear();
    await act(() => {
      appStateHandler('active');
    });

    expect(mockConnect).toHaveBeenCalled();
  });

  // #806: a failed SQLite write must be logged, not swallowed — otherwise a note
  // created/updated on another device silently never appears locally.
  describe('logs a warning when the local write fails', () => {
    let warnSpy: jest.SpiedFunction<typeof console.warn>;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('on note_updated when saveServerNote throws', async () => {
      mockSaveServerNote.mockRejectedValueOnce(new Error('constraint violation'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      const note = makeTextNote({ id: 'note-123' });
      await act(async () => {
        capturedCallback?.({
          type: 'note_updated',
          source_user_id: 'other-user',
          data: { note_id: 'note-123', note },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_updated for note id=note-123:',
        expect.any(Error),
      ));
    });

    it('on note_created when saveServerNote throws', async () => {
      mockSaveServerNote.mockRejectedValueOnce(new Error('NOT NULL constraint failed'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      const note = makeTextNote({ id: 'new-note' });
      await act(async () => {
        capturedCallback?.({
          type: 'note_created',
          source_user_id: 'other-user',
          data: { note_id: 'new-note', note },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_created for note id=new-note:',
        expect.any(Error),
      ));
    });

    it('on note_deleted when markLocalNoteDeleted throws', async () => {
      mockMarkLocalNoteDeleted.mockRejectedValueOnce(new Error('db locked'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      await act(async () => {
        capturedCallback?.({
          type: 'note_deleted',
          source_user_id: 'other-user',
          data: { note_id: 'note-123', note: null },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_deleted for note id=note-123:',
        expect.any(Error),
      ));
    });

    it('on note_unshared (recipient) when permanentDeleteLocalNote throws', async () => {
      mockPermanentDeleteLocalNote.mockRejectedValueOnce(new Error('db locked'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      await act(async () => {
        capturedCallback?.({
          type: 'note_unshared',
          source_user_id: 'other-user',
          target_user_id: 'current-user',
          data: { note_id: 'note-123', note: null },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_unshared for note id=note-123:',
        expect.any(Error),
      ));
    });

    it('on note_unshared (owner/collaborator) when saveServerNote throws', async () => {
      mockGetNote.mockResolvedValueOnce(makeTextNote({ id: 'note-123' }));
      mockSaveServerNote.mockRejectedValueOnce(new Error('network error'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      await act(async () => {
        capturedCallback?.({
          type: 'note_unshared',
          source_user_id: 'current-user',
          target_user_id: 'someone-else',
          data: { note_id: 'note-123', note: null },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_unshared for note id=note-123:',
        expect.any(Error),
      ));
    });

    it('on note_image_added when patchLocalNoteImages throws', async () => {
      mockPatchLocalNoteImages.mockRejectedValueOnce(new Error('note not found'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      const image = { id: 'img-1', filename: 'a.png', content_type: 'image/png', width: 10, height: 10, created_at: '2024-01-01T00:00:00Z' };
      await act(async () => {
        capturedCallback?.({
          type: 'note_image_added',
          source_user_id: 'other-user',
          data: { note_id: 'note-123', image },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE note_image_added for note id=note-123:',
        expect.any(Error),
      ));
    });

    it('on labels_changed when upsertLabel throws', async () => {
      mockUpsertLabel.mockRejectedValueOnce(new Error('constraint violation'));
      const { Wrapper } = createWrapper();
      await renderHook(() => useSSE(), { wrapper: Wrapper });

      const label = makeLabel({ id: 'label-1', user_id: 'other-user', name: 'Urgent' });
      await act(async () => {
        capturedCallback?.({
          type: 'labels_changed',
          source_user_id: 'other-user',
          data: { label },
        });
      });

      await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        'Failed to persist SSE labels_changed for label id=label-1:',
        expect.any(Error),
      ));
    });
  });
});
