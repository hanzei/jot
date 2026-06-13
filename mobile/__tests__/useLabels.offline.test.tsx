import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAddLabelToNote, useRemoveLabelFromNote } from '../src/hooks/useLabels';
import * as labelsApi from '../src/api/labels';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as clientModule from '../src/api/client';

jest.mock('../src/api/labels');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

const mockUseNetworkStatus = (
  jest.requireMock('../src/hooks/useNetworkStatus') as { useNetworkStatus: jest.Mock }
).useNetworkStatus;

jest.mock('../src/db/noteQueries', () => ({
  saveNote: jest.fn().mockResolvedValue(undefined),
  saveNotes: jest.fn().mockResolvedValue(undefined),
  getLocalNote: jest.fn().mockResolvedValue(null),
  getLocalLabels: jest.fn().mockResolvedValue([]),
  getLocalLabelCounts: jest.fn().mockResolvedValue({}),
  renameLabelInLocalNotes: jest.fn().mockResolvedValue(undefined),
  deleteLabelFromLocalNotes: jest.fn().mockResolvedValue(undefined),
  generateLocalId: jest.fn(() => 'local_lbl_test'),
  isLocalId: jest.fn((id: string) => id.startsWith('local_')),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/api/client', () => ({
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
}));

const mockLabelsApi = labelsApi as jest.Mocked<typeof labelsApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockClientModule = clientModule as jest.Mocked<typeof clientModule>;
const mockSyncQueue = jest.requireMock('../src/db/syncQueue') as { enqueueOperation: jest.Mock };

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

function makeNetworkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true });
}

const baseNote = {
  id: 'note-1', title: '', content: 'body', note_type: 'text',
  color: '#ffffff', pinned: false, archived: false, position: 0,
  checked_items_collapsed: false, is_shared: false, deleted_at: null,
  user_id: 'u1', created_at: '', updated_at: '', labels: [] as unknown[], shared_with: [],
};

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

describe('useAddLabelToNote (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
    mockNoteQueries.getLocalLabels.mockResolvedValue([]);
  });

  it('mints a local label, attaches it locally, and queues an addLabel op with local_label_id', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({ ...baseNote, labels: [] } as never);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'urgent' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockLabelsApi.addLabelToNote).not.toHaveBeenCalled();
    expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'note-1',
        labels: [expect.objectContaining({ id: 'local_lbl_test', name: 'urgent' })],
      }),
    );
    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'addLabel',
        endpoint: '/notes/note-1/labels',
        method: 'POST',
        body: { name: 'urgent', local_label_id: 'local_lbl_test' },
      }),
    );
  });

  it('reuses a known label id (no local_label_id) when one with the same name exists', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({ ...baseNote, labels: [] } as never);
    mockNoteQueries.getLocalLabels.mockResolvedValueOnce([
      { id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' },
    ]);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'urgent' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: { name: 'urgent' } }),
    );
  });

  it('reuses a known label case-insensitively (adds "Urgent" when "urgent" exists)', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({ ...baseNote, labels: [] } as never);
    mockNoteQueries.getLocalLabels.mockResolvedValueOnce([
      { id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' },
    ]);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'Urgent' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Reused the existing server label (no local_label_id minted), keeping the
    // user-entered casing in the request body.
    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: { name: 'Urgent' } }),
    );
  });

  it('does not write or queue when the same label is already attached under a different case', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({
      ...baseNote,
      labels: [{ id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' }],
    } as never);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'URGENT' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockNoteQueries.saveNote).not.toHaveBeenCalled();
    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name without touching the DB or queue', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: '   ' }).catch(() => {});

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as Error).message).toMatch(/must not be empty/);
    expect(mockLabelsApi.addLabelToNote).not.toHaveBeenCalled();
    expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
    expect(mockNoteQueries.saveNote).not.toHaveBeenCalled();
    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
  });

  it('does not write or queue when the label is already attached', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({
      ...baseNote,
      labels: [{ id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' }],
    } as never);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'urgent' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockNoteQueries.saveNote).not.toHaveBeenCalled();
    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
  });

  it('falls back to the local queue on a transient (5xx) online failure', async () => {
    mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(503));
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({ ...baseNote, labels: [] } as never);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'urgent' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'addLabel' }),
    );
  });

  it('surfaces a permanent (4xx) online failure without queuing', async () => {
    mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(400));

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', name: 'urgent' }).catch(() => {});

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
  });

  it('rejects without queuing when the note is missing from the local cache', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'missing', name: 'urgent' }).catch(() => {});

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as Error).message).toMatch(/not found in local DB/);
    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
  });
});

describe('useRemoveLabelFromNote (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
  });

  it('detaches the label locally and queues a removeLabel op', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({
      ...baseNote,
      labels: [{ id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' }],
    } as never);

    const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', labelId: 'server-l' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockLabelsApi.removeLabelFromNote).not.toHaveBeenCalled();
    expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'note-1', labels: [] }),
    );
    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'removeLabel',
        endpoint: '/notes/note-1/labels/server-l',
        method: 'DELETE',
      }),
    );
  });

  it('falls back to the local queue on a network error', async () => {
    mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeNetworkError());
    mockNoteQueries.getLocalNote.mockResolvedValueOnce({
      ...baseNote,
      labels: [{ id: 'server-l', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' }],
    } as never);

    const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', labelId: 'server-l' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'removeLabel' }),
    );
  });

  it('surfaces a permanent (4xx) online failure without queuing', async () => {
    mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeAxiosError(403));

    const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ noteId: 'note-1', labelId: 'server-l' }).catch(() => {});

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
  });
});
