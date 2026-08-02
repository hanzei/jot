/**
 * Tests for the background-fetch path in useOfflineNotes, confirming server
 * fetches are persisted through the queue-aware saveServerNotesScope / saveServerNote
 * writers that stop a stale server fetch from transiently reverting an optimistic
 * local edit before its queued op drains (issue #487). The save/prune gating itself
 * is covered in pendingNoteSync.test.ts.
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOfflineNotes, useOfflineNote } from '../src/hooks/useOfflineNotes';
import { publishReconnectResync } from '../src/store/resyncEvents';
import * as notesApi from '../src/api/notes';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as syncQueueModule from '../src/db/syncQueue';
import type { Note } from '@jot/shared';
import { makeTextNote as buildTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/notes');

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

// The db layer runs for real against the test database (see helpers/testDb.ts);
// the writers stay spies so the existing call assertions keep working while the
// SQL underneath them actually executes. `useSQLiteContext()` comes from the
// global mock and returns one stable database per test, which is what the
// db-dependent useCallbacks/effects need to avoid churning.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return {
    ...actual,
    getLocalNotes: jest.fn(actual.getLocalNotes),
    getLocalNote: jest.fn(actual.getLocalNote),
    markLocalNoteDeleted: jest.fn(actual.markLocalNoteDeleted),
  };
});

jest.mock('../src/db/syncQueue', () => {
  const actual = jest.requireActual('../src/db/syncQueue');
  return {
    ...actual,
    saveServerNotesScope: jest.fn(actual.saveServerNotesScope),
    saveServerNote: jest.fn(actual.saveServerNote),
    getProtectedNoteIds: jest.fn(actual.getProtectedNoteIds),
  };
});

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockSyncQueue = syncQueueModule as jest.Mocked<typeof syncQueueModule>;

let db: TestDatabase;

function makeTextNote(id: string): Note {
  return buildTextNote({ id, content: 'server body', created_at: '', updated_at: '' });
}

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db = globalThis.testDb;
});

describe('useOfflineNotes background sync (#487)', () => {
  it('reconciles server notes through saveServerNotesScope (save + queue-aware prune)', async () => {
    const params = { archived: true } as const;
    const notes = [
      { ...makeTextNote('n-pending'), archived: true },
      { ...makeTextNote('n-clean'), archived: true },
    ];
    mockNotesApi.getNotes.mockResolvedValue(notes);

    renderHook(() => useOfflineNotes(params), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalled());
    // The scope params are forwarded so pruning targets the right view, and the
    // shared pending set protects both the write and the prune.
    expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      params,
    );
    // The fetched notes really landed in SQLite.
    await waitFor(async () =>
      expect(await db.getAllAsync('SELECT id FROM notes ORDER BY id')).toEqual([
        { id: 'n-clean' },
        { id: 'n-pending' },
      ]),
    );
  });

  it('leaves a note with a queued local edit untouched by the server fetch', async () => {
    // The end-to-end form of #487: the queue row, the protected-set read, and the
    // skipped write are all real here.
    await noteQueriesModule.saveNote(db, buildTextNote({ id: 'n1', content: 'local edit' }));
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('update', '/notes/n1', 'PATCH', '{}', '')`,
    );
    mockNotesApi.getNotes.mockResolvedValue([makeTextNote('n1')]);

    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalled());
    await waitFor(async () =>
      expect(await db.getFirstAsync('SELECT content FROM notes WHERE id = ?', ['n1'])).toEqual({
        content: 'local edit',
      }),
    );
  });
});

describe('useOfflineNotes catch-up on SSE reconnect', () => {
  it('re-syncs from the server when a reconnect resync is published', async () => {
    mockNotesApi.getNotes.mockResolvedValue([makeTextNote('n1')]);
    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    // Initial mount-time sync.
    await waitFor(() => expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(1));

    // A reconnect (e.g. foreground after backgrounding) triggers a catch-up pull
    // even though isConnected never flipped.
    await act(async () => {
      publishReconnectResync();
      await flushMicrotasks();
    });
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(2);
  });

  it('skips a concurrent resync while one is already in flight (Sync Loop Safety)', async () => {
    let resolveGet: ((notes: Note[]) => void) | undefined;
    mockNotesApi.getNotes.mockImplementation(
      () => new Promise<Note[]>((resolve) => { resolveGet = resolve; }),
    );
    renderHook(() => useOfflineNotes(), { wrapper: createWrapper() });

    // The mount-time sync is now in flight (getNotes pending).
    await waitFor(() => expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(1));

    // A resync arriving mid-flight is skipped rather than firing a second fetch.
    await act(async () => {
      publishReconnectResync();
      await flushMicrotasks();
    });
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(1);

    // Once the in-flight sync completes, a later resync runs normally.
    await act(async () => {
      resolveGet?.([]);
      await flushMicrotasks();
    });
    await act(async () => {
      publishReconnectResync();
      await flushMicrotasks();
    });
    expect(mockNotesApi.getNotes).toHaveBeenCalledTimes(2);
  });
});

describe('useOfflineNote background fetch (#487)', () => {
  it('persists the single-note fetch through the queue-aware saveServerNote writer', async () => {
    mockNotesApi.getNote.mockResolvedValue(makeTextNote('note-1'));

    renderHook(() => useOfflineNote('note-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.saveServerNote).toHaveBeenCalled());
    expect(mockSyncQueue.saveServerNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'note-1' }),
    );
    await waitFor(async () =>
      expect(await db.getFirstAsync('SELECT id, content FROM notes WHERE id = ?', ['note-1'])).toEqual({
        id: 'note-1',
        content: 'server body',
      }),
    );
  });

  it('tombstones a note the server reports gone (404) when it has no pending op', async () => {
    await noteQueriesModule.saveNote(db, buildTextNote({ id: 'gone' }));
    mockNotesApi.getNote.mockRejectedValue(makeAxiosError(404));

    renderHook(() => useOfflineNote('gone'), { wrapper: createWrapper() });

    await waitFor(() =>
      expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'gone'),
    );
    // The tombstone is a real deleted_at, not just a call that happened.
    await waitFor(async () => {
      const row = await db.getFirstAsync<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
        ['gone'],
      );
      expect(row?.deleted_at).toBeTruthy();
    });
  });

  it('does not tombstone a 404 note that still has a pending or failed local op (#487/#492)', async () => {
    // A queued edit/restore may be racing the fetch, or a dead-lettered edit may be
    // the version we're preserving; let the drain/resolution reconcile it rather
    // than hide the optimistic edit.
    await noteQueriesModule.saveNote(db, buildTextNote({ id: 'racing' }));
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('restore', '/notes/racing/restore', 'POST', NULL, '')`,
    );
    mockNotesApi.getNote.mockRejectedValue(makeAxiosError(404));

    renderHook(() => useOfflineNote('racing'), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.getProtectedNoteIds).toHaveBeenCalled());
    await flushMicrotasks();
    expect(mockNoteQueries.markLocalNoteDeleted).not.toHaveBeenCalled();
    expect(await db.getFirstAsync('SELECT deleted_at FROM notes WHERE id = ?', ['racing'])).toEqual({
      deleted_at: null,
    });
  });
});
