import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreateLabel,
  useAddLabelToNote,
  useRemoveLabelFromNote,
  useRenameLabel,
  useDeleteLabel,
} from '../src/hooks/useLabels';
import * as labelsApi from '../src/api/labels';
import * as noteQueriesModule from '../src/db/noteQueries';

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
  renameLabelInLocalNotes: jest.fn().mockResolvedValue(undefined),
  deleteLabelFromLocalNotes: jest.fn().mockResolvedValue(undefined),
  addLabelToLocalNote: jest.fn().mockResolvedValue(undefined),
  removeLabelFromLocalNote: jest.fn().mockResolvedValue(undefined),
  getLocalLabels: jest.fn().mockResolvedValue([]),
  getLocalLabelCounts: jest.fn().mockResolvedValue({}),
  getLocalNote: jest.fn().mockResolvedValue(null),
  generateLocalId: jest.fn(() => 'local_label_id'),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
}));

const mockLabelsApi = labelsApi as jest.Mocked<typeof labelsApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockSyncQueue = jest.requireMock('../src/db/syncQueue') as { enqueueOperation: jest.Mock };
const mockClientModule = jest.requireMock('../src/api/client') as { isServerSwitchInProgress: jest.Mock };

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

// A network failure produces an Axios error with no `response` (no HTTP status).
function makeNetworkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true });
}

const sampleNote = {
  id: 'n1', content: 'body', note_type: 'text',
  color: '#ffffff', pinned: false, archived: false, position: 0,
  checked_items_collapsed: false, is_shared: false, deleted_at: null,
  user_id: 'u1', created_at: '', updated_at: '', labels: [], shared_with: [],
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

describe('useLabels write hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
    mockNoteQueries.getLocalLabels.mockResolvedValue([]);
    mockNoteQueries.getLocalNote.mockResolvedValue(null);
  });

  // ── useCreateLabel ─────────────────────────────────────────────────────────

  describe('useCreateLabel', () => {
    it('creates a label via the API when online', async () => {
      const serverLabel = { id: 'srv1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' };
      mockLabelsApi.createLabel.mockResolvedValueOnce(serverLabel as never);

      const { result } = renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: '  Work  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.createLabel).toHaveBeenCalledWith('Work');
      expect(result.current.data).toEqual(serverLabel);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('queues the create on a transient failure and returns a local label', async () => {
      mockLabelsApi.createLabel.mockRejectedValueOnce(makeAxiosError(503));

      const { result } = renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Work' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'createLabel',
          endpoint: '/labels',
          method: 'POST',
          body: { local_id: 'local_label_id', name: 'Work' },
        }),
      );
      expect((result.current.data as { id: string }).id).toBe('local_label_id');
    });

    it('queues the create when offline', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Home' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.createLabel).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'createLabel', body: { local_id: 'local_label_id', name: 'Home' } }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.createLabel.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: 'Bad' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only name without calling the API or queuing', async () => {
      const { result } = renderHook(() => useCreateLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ name: '   ' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockLabelsApi.createLabel).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useAddLabelToNote ──────────────────────────────────────────────────────

  describe('useAddLabelToNote', () => {
    it('adds the label via the API when online', async () => {
      const updatedNote = { ...sampleNote, labels: [{ id: 'srv1', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' }] };
      mockLabelsApi.addLabelToNote.mockResolvedValueOnce(updatedNote as never);

      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: '  Work  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.addLabelToNote).toHaveBeenCalledWith('n1', 'Work');
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), updatedNote);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('on a transient failure for a new label, queues both createLabel and addLabelToNote', async () => {
      mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(503));
      mockNoteQueries.getLocalNote.mockResolvedValue(sampleNote as never);
      mockNoteQueries.getLocalLabels.mockResolvedValue([]);

      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'New' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'createLabel', body: { local_id: 'local_label_id', name: 'New' } }),
      );
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'addLabelToNote', endpoint: '/notes/n1/labels', method: 'POST', body: { name: 'New' } }),
      );
    });

    it('reuses an existing local label by name without queuing a createLabel', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValue(sampleNote as never);
      mockNoteQueries.getLocalLabels.mockResolvedValue([
        { id: 'srv-existing', user_id: 'u1', name: 'Work', created_at: '', updated_at: '' },
      ] as never);

      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Work' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalledWith(
        expect.anything(),
        'n1',
        expect.objectContaining({ id: 'srv-existing', name: 'Work' }),
      );
      const createLabelCalls = mockSyncQueue.enqueueOperation.mock.calls.filter(
        ([, params]) => params.operation === 'createLabel',
      );
      expect(createLabelCalls).toHaveLength(0);
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'addLabelToNote' }),
      );
    });

    it('reuses an existing label whose name differs only in case (no createLabel queued)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      mockNoteQueries.getLocalNote.mockResolvedValue(sampleNote as never);
      mockNoteQueries.getLocalLabels.mockResolvedValue([
        { id: 'srv-existing', user_id: 'u1', name: 'urgent', created_at: '', updated_at: '' },
      ] as never);

      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Urgent' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      // The existing "urgent" label is reused rather than minting a new one.
      expect(mockNoteQueries.addLabelToLocalNote).toHaveBeenCalledWith(
        expect.anything(),
        'n1',
        expect.objectContaining({ id: 'srv-existing', name: 'urgent' }),
      );
      const createLabelCalls = mockSyncQueue.enqueueOperation.mock.calls.filter(
        ([, params]) => params.operation === 'createLabel',
      );
      expect(createLabelCalls).toHaveLength(0);
    });

    it('rejects a whitespace-only name without touching the API, DB, or queue', async () => {
      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: '   ' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockLabelsApi.addLabelToNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.getLocalNote).not.toHaveBeenCalled();
      expect(mockNoteQueries.addLabelToLocalNote).not.toHaveBeenCalled();
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.addLabelToNote.mockRejectedValueOnce(makeAxiosError(403));

      const { result } = renderHook(() => useAddLabelToNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', name: 'Work' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useRemoveLabelFromNote ─────────────────────────────────────────────────

  describe('useRemoveLabelFromNote', () => {
    it('removes the label via the API when online', async () => {
      mockLabelsApi.removeLabelFromNote.mockResolvedValueOnce(sampleNote as never);

      const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.removeLabelFromNote).toHaveBeenCalledWith('n1', 'l1');
      expect(mockNoteQueries.saveNote).toHaveBeenCalledWith(expect.anything(), sampleNote);
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('queues the removal on a transient failure', async () => {
      mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeNetworkError());
      mockNoteQueries.getLocalNote.mockResolvedValue(sampleNote as never);

      const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.removeLabelFromLocalNote).toHaveBeenCalledWith(expect.anything(), 'n1', 'l1');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'removeLabelFromNote', endpoint: '/notes/n1/labels/l1', method: 'DELETE' }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.removeLabelFromNote.mockRejectedValueOnce(makeAxiosError(403));

      const { result } = renderHook(() => useRemoveLabelFromNote(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'n1', labelId: 'l1' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useRenameLabel ─────────────────────────────────────────────────────────

  describe('useRenameLabel', () => {
    it('renames the label via the API when online', async () => {
      const serverLabel = { id: 'l1', user_id: 'u1', name: 'Renamed', created_at: '', updated_at: '' };
      mockLabelsApi.renameLabel.mockResolvedValueOnce(serverLabel as never);

      const { result } = renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: '  Renamed  ' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.renameLabel).toHaveBeenCalledWith('l1', 'Renamed');
      expect(mockNoteQueries.renameLabelInLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1', 'Renamed');
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('queues the rename when offline and applies it locally', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });

      const { result } = renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: 'Offline' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.renameLabel).not.toHaveBeenCalled();
      expect(mockNoteQueries.renameLabelInLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1', 'Offline');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'renameLabel', endpoint: '/labels/l1', method: 'PATCH', body: { name: 'Offline' } }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.renameLabel.mockRejectedValueOnce(makeAxiosError(400));

      const { result } = renderHook(() => useRenameLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1', name: 'Dup' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── useDeleteLabel ─────────────────────────────────────────────────────────

  describe('useDeleteLabel', () => {
    it('deletes the label via the API when online', async () => {
      mockLabelsApi.deleteLabel.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockLabelsApi.deleteLabel).toHaveBeenCalledWith('l1');
      expect(mockNoteQueries.deleteLabelFromLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });

    it('queues the deletion on a transient failure and applies it locally', async () => {
      mockLabelsApi.deleteLabel.mockRejectedValueOnce(makeAxiosError(500));

      const { result } = renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockNoteQueries.deleteLabelFromLocalNotes).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(mockSyncQueue.enqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'deleteLabel', endpoint: '/labels/l1', method: 'DELETE' }),
      );
    });

    it('surfaces a permanent failure (4xx) without queuing', async () => {
      mockLabelsApi.deleteLabel.mockRejectedValueOnce(makeAxiosError(404));

      const { result } = renderHook(() => useDeleteLabel(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ labelId: 'l1' }).catch(() => {});

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockSyncQueue.enqueueOperation).not.toHaveBeenCalled();
    });
  });
});
