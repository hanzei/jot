import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLabelCounts } from '../src/hooks/useLabels';
import {
  useCreateNote,
  useDeleteNote,
  useDuplicateNote,
  useRestoreNote,
  useUpdateNote,
} from '../src/hooks/useNotes';
import * as labelsApi from '../src/api/labels';
import * as notesApi from '../src/api/notes';
import { saveNote } from '../src/db/noteQueries';
import { makeLabel, makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/labels');
jest.mock('../src/api/notes');

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'u1', username: 'me' }, isAuthenticated: true }),
}));

const mockLabelsApi = labelsApi as jest.Mocked<typeof labelsApi>;
const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const work = makeLabel({ id: 'l1', name: 'Work' });

/**
 * The drawer's per-label counts are derived from the notes table, not the labels
 * one, so a note write that touches no label still changes them. These cover the
 * local-write paths: the counts must follow the SQLite rows without waiting for a
 * reconnect resync or an app restart.
 */
describe('label counts follow local note writes', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = globalThis.testDb as TestDatabase;
    // The server agrees with SQLite at mount time; every later change below is
    // local, so only an invalidation can move the count.
    mockLabelsApi.getLabelCounts.mockResolvedValue({ l1: 1 } as never);
    await saveNote(db, makeTextNote({ id: 'n1', content: 'hi', labels: [work] }));
  });

  it('drops the count when a note is archived', async () => {
    const { result } = await renderHook(
      () => ({ counts: useLabelCounts(), update: useUpdateNote() }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));

    mockNotesApi.updateNote.mockResolvedValue(
      makeTextNote({ id: 'n1', content: 'hi', labels: [work], archived: true }) as never,
    );
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'n1', data: { archived: true } });
    });

    await waitFor(() => expect(result.current.counts.data).toEqual({}));
  });

  it('drops the count when a note is trashed, and restores it on undelete', async () => {
    const { result } = await renderHook(
      () => ({ counts: useLabelCounts(), del: useDeleteNote(), restore: useRestoreNote() }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));

    mockNotesApi.deleteNote.mockResolvedValue(undefined as never);
    await act(async () => { await result.current.del.mutateAsync('n1'); });
    await waitFor(() => expect(result.current.counts.data).toEqual({}));

    mockNotesApi.restoreNote.mockResolvedValue(undefined as never);
    await act(async () => { await result.current.restore.mutateAsync('n1'); });
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));
  });

  it('raises the count when a labelled note is duplicated', async () => {
    const { result } = await renderHook(
      () => ({ counts: useLabelCounts(), duplicate: useDuplicateNote() }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));

    mockNotesApi.duplicateNote.mockResolvedValue(
      makeTextNote({ id: 'n2', content: 'hi', labels: [work] }) as never,
    );
    await act(async () => { await result.current.duplicate.mutateAsync('n1'); });

    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 2 }));
  });

  it('raises the count when a note is created with labels', async () => {
    const { result } = await renderHook(
      () => ({ counts: useLabelCounts(), create: useCreateNote() }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));

    mockNotesApi.createNote.mockResolvedValue(
      makeTextNote({ id: 'n2', content: 'forked', labels: [work] }) as never,
    );
    await act(async () => {
      await result.current.create.mutateAsync({ note_type: 'text', content: 'forked', labels: ['Work'] });
    });

    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 2 }));
  });

  it('leaves the counts alone for a note edit that cannot change them', async () => {
    const { result } = await renderHook(
      () => ({ counts: useLabelCounts(), update: useUpdateNote() }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.counts.data).toEqual({ l1: 1 }));
    const before = result.current.counts.dataUpdatedAt;

    mockNotesApi.updateNote.mockResolvedValue(
      makeTextNote({ id: 'n1', content: 'edited', labels: [work] }) as never,
    );
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'n1', data: { content: 'edited' } });
    });

    // A debounced content save must not re-scan every note's labels.
    expect(result.current.counts.dataUpdatedAt).toBe(before);
    expect(result.current.counts.data).toEqual({ l1: 1 });
  });
});
