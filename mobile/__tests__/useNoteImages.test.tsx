import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUploadNoteImage, useDeleteNoteImage } from '../src/hooks/useNoteImages';
import { noteLocalQueryKey } from '../src/hooks/queryKeys';
import * as imagesApi from '../src/api/images';
import * as noteQueriesModule from '../src/db/noteQueries';
import * as clientModule from '../src/api/client';
import type { NoteImage } from '@jot/shared';

jest.mock('../src/api/images', () => ({
  uploadNoteImage: jest.fn(),
  deleteNoteImage: jest.fn(),
}));

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: jest.fn(() => ({ __db: true })),
}));

jest.mock('../src/db/noteQueries', () => ({
  patchLocalNoteImages: jest.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientModule.isServerSwitchInProgress.mockReturnValue(false);
  });

  describe('useUploadNoteImage', () => {
    it('uploads the file and patches the local image cache', async () => {
      const image = makeImage();
      mockImagesApi.uploadNoteImage.mockResolvedValueOnce(image);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });

      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      await result.current.mutateAsync({ noteId: 'note-1', file });

      expect(mockImagesApi.uploadNoteImage).toHaveBeenCalledWith('note-1', file, undefined);
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );

      // The patcher appends the new image without duplicating an existing one.
      const updater = mockNoteQueries.patchLocalNoteImages.mock.calls[0][2];
      expect(updater([])).toEqual([image]);
      expect(updater([image])).toEqual([image]);
    });

    it('rejects and leaves the local cache untouched when the server switch is in progress', async () => {
      mockClientModule.isServerSwitchInProgress.mockReturnValue(true);
      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });

      const file = { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' };
      await expect(result.current.mutateAsync({ noteId: 'note-1', file })).rejects.toThrow();

      expect(mockImagesApi.uploadNoteImage).not.toHaveBeenCalled();
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
    });

    it('surfaces an upload failure (e.g. 413 for an oversized file) without patching the cache', async () => {
      const error = Object.assign(new Error('Payload Too Large'), {
        isAxiosError: true,
        response: { status: 413 },
      });
      mockImagesApi.uploadNoteImage.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useUploadNoteImage(), { wrapper: createWrapper() });
      const file = { uri: 'file:///big.png', name: 'big.png', mimeType: 'image/png' };

      await expect(result.current.mutateAsync({ noteId: 'note-1', file })).rejects.toBe(error);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
    });
  });

  describe('useDeleteNoteImage', () => {
    it('deletes the image and removes it from the local cache', async () => {
      mockImagesApi.deleteNoteImage.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' });

      expect(mockImagesApi.deleteNoteImage).toHaveBeenCalledWith('img-1');
      expect(mockNoteQueries.patchLocalNoteImages).toHaveBeenCalledWith(
        expect.anything(),
        'note-1',
        expect.any(Function),
      );

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

    it('propagates a delete failure without patching the cache', async () => {
      const error = new Error('Network Error');
      mockImagesApi.deleteNoteImage.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useDeleteNoteImage(), { wrapper: createWrapper() });
      await expect(result.current.mutateAsync({ noteId: 'note-1', imageId: 'img-1' })).rejects.toBe(error);
      expect(mockNoteQueries.patchLocalNoteImages).not.toHaveBeenCalled();
    });
  });
});
