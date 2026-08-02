import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import { useUploadNoteImage, useDeleteNoteImage } from '../src/hooks/useNoteImages';
import { noteLocalQueryKey } from '../src/hooks/queryKeys';
import * as imagesApi from '../src/api/images';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as clientModule from '../src/api/client';
import * as syncQueueModule from '../src/db/syncQueue';
import * as imageUploadQueueModule from '../src/db/imageUploadQueue';
import * as noteImageCacheModule from '../src/utils/noteImageCache';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { isLocalModeActive } from '../src/store/localMode';
import { saveNote } from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import type { NoteImage } from '@jot/shared';

const fs = globalThis.mockFileSystem;

jest.mock('../src/api/images', () => ({
  uploadNoteImage: jest.fn(),
  deleteNoteImage: jest.fn(),
}));

// The db layer runs for real against the test database (see helpers/testDb.ts);
// these stay spies so the existing call assertions keep working while the SQL
// underneath them actually executes. `useSQLiteContext()` comes from the global
// mock and returns one stable database per test.
jest.mock('../src/db/noteQueries', () => {
  const actual = jest.requireActual('../src/db/noteQueries');
  return { ...actual, patchLocalNoteImages: jest.fn(actual.patchLocalNoteImages) };
});

jest.mock('../src/db/syncQueue', () => {
  const actual = jest.requireActual('../src/db/syncQueue');
  return { ...actual, enqueueOperation: jest.fn(actual.enqueueOperation) };
});

jest.mock('../src/db/imageUploadQueue', () => {
  const actual = jest.requireActual('../src/db/imageUploadQueue');
  return { ...actual, enqueueImageUpload: jest.fn(actual.enqueueImageUpload) };
});

jest.mock('../src/utils/noteImageCache', () => ({
  deleteCachedNoteImage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn(() => ({ isConnected: true })),
}));

jest.mock('../src/store/localMode', () => ({
  isLocalModeActive: jest.fn(() => false),
}));

jest.mock('../src/api/client', () => {
  const isServerSwitchInProgress = jest.fn(() => false);
  return {
    isServerSwitchInProgress,
    getActiveServerId: jest.fn(() => 'test-server-id'),
    assertSwitchWriteAllowed: jest.fn(() => {
      if (isServerSwitchInProgress()) {
        throw new Error('Server switch in progress; write blocked');
      }
    }),
  };
});

const mockImagesApi = imagesApi as jest.Mocked<typeof imagesApi>;
const mockNoteQueries = noteQueriesModule as jest.Mocked<typeof noteQueriesModule>;
const mockClientModule = clientModule as jest.Mocked<typeof clientModule>;
const mockEnqueueOperation = syncQueueModule.enqueueOperation as jest.Mock;
const mockEnqueueImageUpload = imageUploadQueueModule.enqueueImageUpload as jest.Mock;
const mockDeleteCachedNoteImage = noteImageCacheModule.deleteCachedNoteImage as jest.Mock;
const mockUseNetworkStatus = useNetworkStatus as jest.Mock;
const mockIsLocalModeActive = isLocalModeActive as jest.Mock;

function makeImage(overrides: Partial<NoteImage> = {}): NoteImage {
  return {
    id: 'img-1',
    filename: 'photo.png',
    content_type: 'image/png',
    width: 800,
    height: 600,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useNoteImages hooks', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockIsLocalModeActive.mockReturnValue(false);
    fs.reset();
    // The picked source file the offline queue copies to a stable path.
    fs.files.set('file:///photo.png', 'png-bytes');
    fs.files.set('file:///big.png', 'png-bytes');

    db = globalThis.testDb;
    // pending_image_uploads has a foreign key to notes, so the note has to exist.
    await saveNote(db, makeTextNote({ id: 'note-1' }));
  });

  const imagesOf = async (noteId: string): Promise<NoteImage[]> => {
    const row = await db.getFirstAsync<{ images_json: string }>(
      'SELECT images_json FROM notes WHERE id = ?',
      [noteId],
    );
    return row ? (JSON.parse(row.images_json) as NoteImage[]) : [];
  };

  const queuedOps = () =>
    db.getAllAsync<{ operation: string; endpoint: string; body: string | null }>(
      'SELECT operation, endpoint, body FROM sync_queue ORDER BY id',
    );

  describe('useUploadNoteImage', () => {
    it('uploads the file and patches the local image cache', async () => {
      const image = makeImage();
      mockImagesApi.uploadNoteImage.mockResolvedValueOnce(image);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });

      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      const outcome = await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file });

      expect(outcome).toEqual({ status: 'uploaded', image });
      expect(mockImagesApi.uploadNoteImage).toHaveBeenCalledWith('note-1', file, undefined, undefined);
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );
      // The image really landed on the note's cached metadata.
      expect(await imagesOf('note-1')).toEqual([image]);

      // The patcher appends the new image without duplicating an existing one.
      const updater = mockNoteQueries.patchLocalNoteImages.mock.calls[0][2];
      expect(updater([])).toEqual([image]);
      expect(updater([image])).toEqual([image]);
    });

    it('does not duplicate an image the note already carries', async () => {
      const image = makeImage();
      await saveNote(db, makeTextNote({ id: 'note-1', images: [image] }));
      mockImagesApi.uploadNoteImage.mockResolvedValueOnce(image);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file });

      expect(await imagesOf('note-1')).toEqual([image]);
    });

    it('rejects and leaves the local cache untouched when the server switch is in progress', async () => {
      mockClientModule.isServerSwitchInProgress.mockReturnValue(true);
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });

      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      await expect(result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file })).rejects.toThrow();

      expect(mockImagesApi.uploadNoteImage).not.toHaveBeenCalled();
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
      expect(mockEnqueueImageUpload).not.toHaveBeenCalled();
    });

    it('surfaces a permanent upload failure (e.g. 413 for an oversized file) without queuing it', async () => {
      const error = Object.assign(new Error('Payload Too Large'), {
        isAxiosError: true,
        response: { status: 413 },
      });
      mockImagesApi.uploadNoteImage.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///big.png', name: 'big.png', mimeType: 'image/png' };

      await expect(result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file })).rejects.toBe(error);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
      expect(mockEnqueueImageUpload).not.toHaveBeenCalled();
    });

    it('queues the upload instead of attempting the request when offline (issue #618)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };

      const outcome = await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file });

      expect(outcome).toEqual({ status: 'queued' });
      expect(mockImagesApi.uploadNoteImage).not.toHaveBeenCalled();
      expect(mockEnqueueImageUpload).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'upload-1', noteId: 'note-1', file },
      );
      // A real row in the upload queue, with the picked file copied to a stable path.
      expect(await db.getAllAsync('SELECT id, note_id, status FROM pending_image_uploads')).toEqual([
        { id: 'upload-1', note_id: 'note-1', status: 'queued' },
      ]);
      expect(fs.files.has('file:///docs/pending-image-uploads/upload-1')).toBe(true);
    });

    it('falls back to the offline queue after a transient failure (e.g. a network error) while connected', async () => {
      const error = Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined });
      mockImagesApi.uploadNoteImage.mockRejectedValueOnce(error);
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };

      const outcome = await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file });

      expect(outcome).toEqual({ status: 'queued' });
      expect(mockEnqueueImageUpload).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'upload-1', noteId: 'note-1', file },
      );
    });

    it('never queues in local mode — no server exists to replay against (epic #511)', async () => {
      mockIsLocalModeActive.mockReturnValue(true);
      const image = makeImage();
      mockImagesApi.uploadNoteImage.mockResolvedValueOnce(image);
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };

      const outcome = await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file });

      expect(outcome).toEqual({ status: 'uploaded', image });
      expect(mockImagesApi.uploadNoteImage).toHaveBeenCalledWith('note-1', file, undefined, undefined);
      expect(mockEnqueueImageUpload).not.toHaveBeenCalled();
    });

    it('passes the caller-provided abort signal through to the upload request', async () => {
      const image = makeImage();
      mockImagesApi.uploadNoteImage.mockResolvedValueOnce(image);
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      const controller = new AbortController();

      await result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file, signal: controller.signal });

      expect(mockImagesApi.uploadNoteImage).toHaveBeenCalledWith('note-1', file, undefined, controller.signal);
    });

    it('propagates a cancelled upload without queuing it or converting it into a permanent error (issue #695)', async () => {
      const controller = new AbortController();
      const cancelError = new axios.CanceledError('canceled');
      mockImagesApi.uploadNoteImage.mockRejectedValueOnce(cancelError);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };

      await expect(
        result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file, signal: controller.signal }),
      ).rejects.toBe(cancelError);
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
      expect(mockEnqueueImageUpload).not.toHaveBeenCalled();
    });

    it('propagates a cancelled upload as-is even in local mode', async () => {
      mockIsLocalModeActive.mockReturnValue(true);
      const cancelError = new axios.CanceledError('canceled');
      mockImagesApi.uploadNoteImage.mockRejectedValueOnce(cancelError);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };

      await expect(
        result.current.mutateAsync({ noteId: 'note-1', uploadId: 'upload-1', file }),
      ).rejects.toBe(cancelError);
      expect(mockEnqueueImageUpload).not.toHaveBeenCalled();
    });
  });

  describe('useDeleteNoteImage', () => {
    it('deletes the image, removes it from the local cache, and clears the image cache', async () => {
      mockImagesApi.deleteNoteImage.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      expect(mockImagesApi.deleteNoteImage).toHaveBeenCalledWith('img-1');
      expect(mockDeleteCachedNoteImage).toHaveBeenCalledWith('img-1');
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );
      expect(mockEnqueueOperation).not.toHaveBeenCalled();

      const updater = mockNoteQueries.patchLocalNoteImages.mock.calls[0][2];
      const images = [makeImage({ id: 'img-1' }), makeImage({ id: 'img-2' })];
      expect(updater(images)).toEqual([makeImage({ id: 'img-2' })]);
    });

    it('invalidates the note and notes-list caches on success', async () => {
      mockImagesApi.deleteNoteImage.mockResolvedValueOnce(undefined);
      const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      function Wrapper({ children }: { children: React.ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      }

      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: Wrapper });
      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteLocalQueryKey('note-1') });
    });

    it('propagates a permanent delete failure without queuing it', async () => {
      const error = new Error('Not axios, not queueable');
      mockImagesApi.deleteNoteImage.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });
      await expect(result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' })).rejects.toBe(error);
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });

    it('hides the image locally and queues the hard-delete for replay when offline (issue #618)', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      expect(mockImagesApi.deleteNoteImage).not.toHaveBeenCalled();
      expect(mockDeleteCachedNoteImage).toHaveBeenCalledWith('img-1');
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );
      expect(mockEnqueueOperation).toHaveBeenCalledWith(expect.anything(), {
        operation: 'removeImage',
        endpoint: '/images/img-1',
        method: 'DELETE',
        body: { note_id: 'note-1' },
      });
      // The op is really in sync_queue for the drain to replay.
      expect(await queuedOps()).toEqual([
        { operation: 'removeImage', endpoint: '/images/img-1', body: '{"note_id":"note-1"}' },
      ]);
    });

    it('hides the image from the note locally when the delete is queued offline', async () => {
      mockUseNetworkStatus.mockReturnValue({ isConnected: false });
      await saveNote(db, makeTextNote({
        id: 'note-1',
        images: [makeImage({ id: 'img-1' }), makeImage({ id: 'img-2' })],
      }));
      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      expect(await imagesOf('note-1')).toEqual([makeImage({ id: 'img-2' })]);
    });

    it('falls back to the offline queue after a transient delete failure while connected', async () => {
      const error = Object.assign(new Error('Server Error'), { isAxiosError: true, response: { status: 503 } });
      mockImagesApi.deleteNoteImage.mockRejectedValueOnce(error);
      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      // The replayed delete's side effects must match the offline path exactly
      // (same hide-locally + cache-cleanup + enqueue), or a regression here
      // would leave the image visible or its cached bytes lingering.
      expect(mockDeleteCachedNoteImage).toHaveBeenCalledWith('img-1');
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );
      const updater = mockNoteQueries.patchLocalNoteImages.mock.calls[0][2];
      const images = [makeImage({ id: 'img-1' }), makeImage({ id: 'img-2' })];
      expect(updater(images)).toEqual([makeImage({ id: 'img-2' })]);

      expect(mockEnqueueOperation).toHaveBeenCalledWith(expect.anything(), {
        operation: 'removeImage',
        endpoint: '/images/img-1',
        method: 'DELETE',
        body: { note_id: 'note-1' },
      });
    });
  });
});
