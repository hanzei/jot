import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderNotes } from '../src/hooks/useNotes';
import { saveNotes, markNotePendingCreate } from '../src/db/noteQueries';
import { notesLocalQueryKey } from '../src/hooks/queryKeys';
import { getDefaultTestDb, type TestDatabase } from './helpers/testDb';
import { makeTextNote, queuedOps } from './helpers/fixtures';
import { jot } from '../src/api/jot';
import type { Note } from '@jot/shared';

jest.mock('../src/api/jot');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockJot = jest.mocked(jot);

function createWrapper() {
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

async function positions(db: TestDatabase): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ id: string; position: number }>('SELECT id, position FROM notes ORDER BY id');
  return Object.fromEntries(rows.map((row) => [row.id, row.position]));
}

/**
 * useReorderNotes writes through the outbox (#1285): the new positions and the
 * queued reorder commit together, and the hook never calls the server.
 */
describe('useReorderNotes', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = getDefaultTestDb();
    await saveNotes(db, [makeTextNote({ id: 'a', position: 0 }), makeTextNote({ id: 'b', position: 1 })]);
  });

  it('commits the new positions and queues the reorder, keyed by every note it names', async () => {
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useReorderNotes(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(['b', 'a']);
    });

    expect(mockJot.notes.reorder).not.toHaveBeenCalled();
    // SQLite holds the new order, so any re-read shows it (#945, #947).
    expect(await positions(db)).toEqual({ a: 1, b: 0 });
    expect(await queuedOps(db)).toEqual([{
      operation: 'reorder',
      endpoint: '/notes/reorder',
      method: 'POST',
      body: { note_ids: ['b', 'a'] },
      keys: ['note:b', 'note:a'],
      readKeys: [],
    }]);
  });

  // The server rejects a reorder naming a note it does not know yet (#956);
  // the reorder's keys hold it behind the note's queued create.
  it('queues behind a pending create in the batch like any other write', async () => {
    await markNotePendingCreate(db, 'b');
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useReorderNotes(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(['b', 'a']);
    });

    expect(mockJot.notes.reorder).not.toHaveBeenCalled();
    expect(await db.getAllAsync('SELECT operation FROM sync_queue')).toEqual([{ operation: 'reorder' }]);
  });

  it('re-sorts the cached list before the write commits', async () => {
    const { wrapper, queryClient } = createWrapper();
    const cached: Note[] = [makeTextNote({ id: 'a', position: 0 }), makeTextNote({ id: 'b', position: 1 })];
    queryClient.setQueryData(notesLocalQueryKey(), cached);
    const { result } = await renderHook(() => useReorderNotes(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(['b', 'a']);
    });

    expect(queryClient.getQueryData<Note[]>(notesLocalQueryKey())?.map((n) => n.id)).toEqual(['b', 'a']);
  });

  // A failed enqueue rolls the whole transaction back: no phantom order is
  // left in SQLite for onSettled's re-read to pull back out (#957).
  it('leaves the positions untouched when the local write fails', async () => {
    await db.execAsync('DROP TABLE sync_queue_keys');
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useReorderNotes(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(['b', 'a']).catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(await positions(db)).toEqual({ a: 0, b: 1 });
  });
});
