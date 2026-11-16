import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateNote } from '../src/hooks/useNotes';
import { getLocalNote, saveNote } from '../src/db/noteQueries';
import { clearOwnVersionSteps, recordOwnVersionStep } from '../src/db/ownVersions';
import { noteLocalQueryKey, notesLocalQueryKey } from '../src/hooks/queryKeys';
import { makeListNote, makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot');

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockJot = jest.mocked(jot);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper: Wrapper, queryClient };
}

interface QueuedRow {
  operation: string;
  endpoint: string;
  method: string;
  body: Record<string, unknown>;
}

async function queuedRows(db: TestDatabase): Promise<QueuedRow[]> {
  const rows = await db.getAllAsync<{ operation: string; endpoint: string; method: string; body: string }>(
    'SELECT operation, endpoint, method, body FROM sync_queue ORDER BY id',
  );
  return rows.map((row) => ({ ...row, body: JSON.parse(row.body) as Record<string, unknown> }));
}

/**
 * useUpdateNote writes through the outbox (#1284): the edit and its queue row
 * commit together, and the hook never calls the server, online or not.
 */
describe('useUpdateNote (outbox)', () => {
  const TEXT_ID = 'TextNote00000000000000';
  const LIST_ID = 'ListNote00000000000000';
  let db: TestDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    clearOwnVersionSteps();
    db = globalThis.testDb;
    await saveNote(db, makeTextNote({ id: TEXT_ID, content: 'Old body', version: 7 }));
    await saveNote(db, makeListNote({ id: LIST_ID, title: 'Old title', version: 3 }));
  });

  it('commits a content edit locally and queues it with its base_version, without calling the server', async () => {
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    const returned = await result.current.mutateAsync({ id: TEXT_ID, data: { content: 'New body' } });

    expect(mockJot.notes.update).not.toHaveBeenCalled();
    expect(await getLocalNote(db, TEXT_ID)).toMatchObject({ content: 'New body', version: 7 });
    // Only the changed field, so a replay cannot clobber fields edited elsewhere.
    expect(await queuedRows(db)).toEqual([{
      operation: 'update',
      endpoint: `/notes/${TEXT_ID}`,
      method: 'PATCH',
      body: { content: 'New body', base_version: 7 },
    }]);
    expect(returned).toMatchObject({ content: 'New body', version: 7 });
  });

  it('stores the editor-supplied baseVersion, not the row version (#1277)', async () => {
    // A collaborator's snapshot (v7) landed in the row while the user typed from v5.
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    const returned = await result.current.mutateAsync({ id: TEXT_ID, data: { content: 'Mine' }, baseVersion: 5 });

    expect((await queuedRows(db))[0]!.body).toEqual({ content: 'Mine', base_version: 5 });
    expect(returned.version).toBe(5);
  });

  it('advances the editor baseline past its own edits that have landed', async () => {
    // The editor saved from v5 and that save landed as v6 while it stayed dirty.
    recordOwnVersionStep(TEXT_ID, 5, 6);
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    const returned = await result.current.mutateAsync({ id: TEXT_ID, data: { content: 'Next' }, baseVersion: 5 });

    expect((await queuedRows(db))[0]!.body).toEqual({ content: 'Next', base_version: 6 });
    // The editor adopts it as its new baseline.
    expect(returned.version).toBe(6);
  });

  it('queues a list-note title edit with only that field', async () => {
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    await result.current.mutateAsync({ id: LIST_ID, data: { title: 'New title' } });

    expect((await queuedRows(db))[0]!.body).toEqual({ title: 'New title', base_version: 3 });
    expect(await getLocalNote(db, LIST_ID)).toMatchObject({ title: 'New title' });
  });

  it('omits base_version for a per-user-only change', async () => {
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    await result.current.mutateAsync({ id: TEXT_ID, data: { pinned: true } });

    expect((await queuedRows(db))[0]!.body).toEqual({ pinned: true });
    expect(await getLocalNote(db, TEXT_ID)).toMatchObject({ pinned: true });
  });

  it('rejects and writes nothing when the note is missing locally', async () => {
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    await expect(result.current.mutateAsync({ id: 'missing-id', data: { title: 'X' } })).rejects.toThrow(/not found in local DB/);

    expect(await queuedRows(db)).toEqual([]);
  });

  it('reflects the edit in the cached note and list', async () => {
    const { wrapper, queryClient } = createWrapper();
    const cached = await getLocalNote(db, TEXT_ID);
    queryClient.setQueryData(noteLocalQueryKey(TEXT_ID), cached);
    queryClient.setQueryData(notesLocalQueryKey(undefined), [cached]);
    const { result } = await renderHook(() => useUpdateNote(), { wrapper });

    await result.current.mutateAsync({ id: TEXT_ID, data: { content: 'New body' } });

    await waitFor(() => {
      expect(queryClient.getQueryData<{ content: string }>(noteLocalQueryKey(TEXT_ID))!.content).toBe('New body');
    });
    expect(queryClient.getQueryData<{ content: string }[]>(notesLocalQueryKey(undefined))![0]!.content).toBe('New body');
  });
});
