import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderNotes } from '../src/hooks/useNotes';
import * as notesApi from '../src/api/notes';
import { saveNotes, getLocalNotePositions, markNotePendingCreate } from '../src/db/noteQueries';
import { getDefaultTestDb } from './helpers/testDb';
import { makeTextNote } from './helpers/fixtures';

jest.mock('../src/api/notes');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;

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

// A promise whose resolution the test controls, to hold a reorder request in
// flight while we inspect the local rows.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

describe('useReorderNotes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls reorderNotes API with note IDs', async () => {
    mockNotesApi.reorderNotes.mockResolvedValueOnce(undefined);

    const { result } = await renderHook(() => useReorderNotes(), { wrapper: createWrapper() });

    result.current.mutate(['id-1', 'id-2', 'id-3']);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockNotesApi.reorderNotes).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3']);
  });

  it('handles reorder failure', async () => {
    mockNotesApi.reorderNotes.mockRejectedValueOnce(new Error('Failed'));

    const { result } = await renderHook(() => useReorderNotes(), { wrapper: createWrapper() });

    result.current.mutate(['id-1']);

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  // The local rows have to move with the optimistic order, not trail it: the
  // list query is SQLite-backed, so rows that still hold the pre-drag positions
  // while the request is in flight are what any re-read in that window resolves
  // to — snapping the cards back to the old order until the response lands (#947).
  it('writes the new positions to SQLite before the request goes out', async () => {
    const db = getDefaultTestDb();
    await saveNotes(db, [makeTextNote({ id: 'a', position: 0 }), makeTextNote({ id: 'b', position: 1 })]);

    const pending = deferred<undefined>();
    mockNotesApi.reorderNotes.mockReturnValueOnce(pending.promise as never);

    const { result } = await renderHook(() => useReorderNotes(), { wrapper: createWrapper() });
    result.current.mutate(['b', 'a']);

    // Request is still in flight (pending unresolved), and SQLite already holds
    // the new order.
    await waitFor(() => expect(mockNotesApi.reorderNotes).toHaveBeenCalledWith(['b', 'a']));
    const positions = await getLocalNotePositions(db, ['a', 'b']);
    expect(positions.get('b')).toBe(0);
    expect(positions.get('a')).toBe(1);

    pending.resolve(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  // A note created offline (#475) has no note_user_state row on the server until
  // its queued create drains, so including it in a reorder would 403 the whole
  // batch and roll back every note's position (#956). While online but with a
  // pending-create note in the batch, the reorder must queue (draining FIFO after
  // the create) instead of calling the API.
  it('queues (does not call the API) when the batch includes a pending-create note while online', async () => {
    const db = getDefaultTestDb();
    await saveNotes(db, [makeTextNote({ id: 'a', position: 0 }), makeTextNote({ id: 'b', position: 1 })]);
    await markNotePendingCreate(db, 'b');

    const { result } = await renderHook(() => useReorderNotes(), { wrapper: createWrapper() });
    await result.current.mutateAsync(['b', 'a']);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The API is skipped and the reorder is queued for replay after the create.
    expect(mockNotesApi.reorderNotes).not.toHaveBeenCalled();
    const queued = await db.getAllAsync<{ operation: string; endpoint: string; body: string }>(
      'SELECT operation, endpoint, body FROM sync_queue',
    );
    expect(queued).toEqual([
      expect.objectContaining({ operation: 'reorder', endpoint: '/notes/reorder' }),
    ]);
    expect(JSON.parse(queued[0]!.body)).toEqual({ note_ids: ['b', 'a'] });

    // The new positions are still written locally so the optimistic order holds.
    const positions = await getLocalNotePositions(db, ['a', 'b']);
    expect(positions.get('b')).toBe(0);
    expect(positions.get('a')).toBe(1);
  });

  it('restores the pre-drag positions on a permanent failure', async () => {
    const db = getDefaultTestDb();
    await saveNotes(db, [makeTextNote({ id: 'a', position: 0 }), makeTextNote({ id: 'b', position: 1 })]);

    // A 409 is permanent, so it surfaces rather than queues.
    mockNotesApi.reorderNotes.mockRejectedValueOnce(makeAxiosError(409));

    const { result } = await renderHook(() => useReorderNotes(), { wrapper: createWrapper() });
    await result.current.mutateAsync(['b', 'a']).catch(() => {});

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The pre-flight write is undone, so the rows end up back where they started
    // rather than holding an order the server rejected.
    const positions = await getLocalNotePositions(db, ['a', 'b']);
    expect(positions.get('a')).toBe(0);
    expect(positions.get('b')).toBe(1);
  });
});
