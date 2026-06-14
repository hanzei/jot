/**
 * Tests for the background-fetch path in useOfflineNotes, confirming server
 * fetches are persisted through the queue-aware saveServerNotesScope / saveServerNote
 * writers that stop a stale server fetch from transiently reverting an optimistic
 * local edit before its queued op drains (issue #487). The save/prune gating itself
 * is covered in pendingNoteSync.test.ts.
 */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOfflineNotes, useOfflineNote } from '../src/hooks/useOfflineNotes';
import * as notesApi from '../src/api/notes';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as syncQueueModule from '../src/db/syncQueue';
import type { Note } from '@jot/shared';

jest.mock('../src/api/notes');

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: jest.fn(() => ({ __db: true })),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

jest.mock('../src/db/noteQueries', () => ({
  getLocalNotes: jest.fn().mockResolvedValue([]),
  getLocalNote: jest.fn().mockResolvedValue(null),
  markLocalNoteDeleted: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  saveServerNotesScope: jest.fn().mockResolvedValue(undefined),
  saveServerNote: jest.fn().mockResolvedValue(undefined),
  getProtectedNoteIds: jest.fn().mockResolvedValue(new Set<string>()),
}));

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockSyncQueue = syncQueueModule as jest.Mocked<typeof syncQueueModule>;

function makeTextNote(id: string): Note {
  return {
    id,
    user_id: 'u1',
    note_type: 'text',
    content: 'server body',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    labels: [],
    shared_with: [],
  };
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

describe('useOfflineNotes background sync (#487)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconciles server notes through saveServerNotesScope (save + queue-aware prune)', async () => {
    const params = { archived: true } as const;
    mockNotesApi.getNotes.mockResolvedValue([makeTextNote('n-pending'), makeTextNote('n-clean')]);

    renderHook(() => useOfflineNotes(params), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalled());
    // The scope params are forwarded so pruning targets the right view, and the
    // shared pending set protects both the write and the prune.
    expect(mockSyncQueue.saveServerNotesScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      params,
    );
  });
});

describe('useOfflineNote background fetch (#487)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists the single-note fetch through the queue-aware saveServerNote writer', async () => {
    mockNotesApi.getNote.mockResolvedValue(makeTextNote('note-1'));

    renderHook(() => useOfflineNote('note-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.saveServerNote).toHaveBeenCalled());
    expect(mockSyncQueue.saveServerNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'note-1' }),
    );
  });

  it('tombstones a note the server reports gone (404) when it has no pending op', async () => {
    mockNotesApi.getNote.mockRejectedValue(makeAxiosError(404));
    mockSyncQueue.getProtectedNoteIds.mockResolvedValue(new Set<string>());

    renderHook(() => useOfflineNote('gone'), { wrapper: createWrapper() });

    await waitFor(() =>
      expect(mockNoteQueries.markLocalNoteDeleted).toHaveBeenCalledWith(expect.anything(), 'gone'),
    );
  });

  it('does not tombstone a 404 note that still has a pending or failed local op (#487/#492)', async () => {
    // A queued edit/restore may be racing the fetch, or a dead-lettered edit may be
    // the version we're preserving; let the drain/resolution reconcile it rather
    // than hide the optimistic edit.
    mockNotesApi.getNote.mockRejectedValue(makeAxiosError(404));
    mockSyncQueue.getProtectedNoteIds.mockResolvedValue(new Set(['racing']));

    renderHook(() => useOfflineNote('racing'), { wrapper: createWrapper() });

    await waitFor(() => expect(mockSyncQueue.getProtectedNoteIds).toHaveBeenCalled());
    await flushMicrotasks();
    expect(mockNoteQueries.markLocalNoteDeleted).not.toHaveBeenCalled();
  });
});
