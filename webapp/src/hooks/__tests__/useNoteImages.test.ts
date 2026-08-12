import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Note, NoteImage } from '@jot/shared';
import { useNoteImages, IMAGE_REMOVE_UNDO_MS } from '../useNoteImages';
import { images as imagesApi } from '@/utils/api';
import { createMockNote } from '@/utils/__tests__/test-helpers';

vi.mock('@/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@/utils/api')>('@/utils/api');
  return {
    ...actual,
    images: {
      ...actual.images,
      upload: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const makeImage = (overrides: Partial<NoteImage> = {}): NoteImage => ({
  id: 'img1',
  filename: 'photo.png',
  content_type: 'image/png',
  width: 800,
  height: 600,
  created_at: '2023-01-01T00:00:00Z',
  ...overrides,
});

// Only file.size is ever inspected (validateImageFile), so a small buffer
// with size overridden avoids allocating a real 15-26 MB Uint8Array per call.
const makeFile = (name = 'photo.png', type = 'image/png', size = 1024) => {
  const file = new File([new Uint8Array(8)], name, { type });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
};

const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

interface RenderOpts {
  note?: Note | null;
  uploadMaxBytes?: number;
  onRefresh?: () => void;
  showError?: (message: string) => void;
}

const renderNoteImages = ({ note = createMockNote({ images: [] }), uploadMaxBytes = UPLOAD_MAX_BYTES, onRefresh = vi.fn(), showError = vi.fn() }: RenderOpts = {}) => {
  const hook = renderHook(
    (props: { note?: Note | null }) => useNoteImages({ note: props.note, uploadMaxBytes, onRefresh, showError }),
    { initialProps: { note } },
  );
  return { ...hook, onRefresh, showError };
};

describe('useNoteImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(imagesApi.upload).mockResolvedValue(makeImage());
    vi.mocked(imagesApi.delete).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('queueImageFiles validation', () => {
    it('rejects a non-image file and reports the error without uploading', () => {
      const { result, showError } = renderNoteImages();

      act(() => {
        result.current.handleImageFileInputChange({
          target: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(imagesApi.upload).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith('Only images can be attached.');
    });

    it('rejects an oversized file against the configured cap', () => {
      const { result, showError } = renderNoteImages({ uploadMaxBytes: 10 * 1024 * 1024 });

      act(() => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile('big.png', 'image/png', 15 * 1024 * 1024)], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(imagesApi.upload).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith('Image exceeds the 10 MB limit.');
    });

    it('combines validation errors from every invalid file in one batch', () => {
      const { result, showError } = renderNoteImages();

      act(() => {
        result.current.handleImageFileInputChange({
          target: {
            files: [
              new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
              makeFile('big.png', 'image/png', 26 * 1024 * 1024),
            ],
            value: '',
          },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(imagesApi.upload).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('Only images can be attached.'));
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('Image exceeds the 25 MB limit.'));
    });

    it('stops queueing once the per-note cap is reached, uploading only what fits', () => {
      const existingImages = Array.from({ length: 9 }, (_, i) => makeImage({ id: `img${i}` }));
      const note = createMockNote({ images: existingImages });
      const { result, showError } = renderNoteImages({ note });

      act(() => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile('a.png'), makeFile('b.png')], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(imagesApi.upload).toHaveBeenCalledTimes(1);
      expect(showError).toHaveBeenCalledWith('Notes can have up to 10 images.');
    });

    it('does nothing when there is no note to attach to', () => {
      const { result, showError } = renderNoteImages({ note: null });

      act(() => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(imagesApi.upload).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });
  });

  describe('upload lifecycle', () => {
    it('adds an uploading tile immediately and clears it once the request resolves', async () => {
      let resolveUpload: (image: NoteImage) => void = () => {};
      vi.mocked(imagesApi.upload).mockReturnValue(new Promise((resolve) => { resolveUpload = resolve; }));
      const { result } = renderNoteImages();

      act(() => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      });

      expect(result.current.imageUploads).toHaveLength(1);
      expect(result.current.imageUploads[0]).toMatchObject({ status: 'uploading', filename: 'photo.png' });

      await act(async () => {
        resolveUpload(makeImage({ id: 'uploaded' }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.imageUploads).toHaveLength(0);
    });

    it('adds a confirmed upload to displayedImages via the optimistic overlay even if note.images never updates', async () => {
      vi.mocked(imagesApi.upload).mockResolvedValue(makeImage({ id: 'newimg', filename: 'uploaded.png' }));
      const note = createMockNote({ images: [] });
      const { result } = renderNoteImages({ note });

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile('uploaded.png')], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.displayedImages.map(i => i.id)).toContain('newimg');
    });

    it('calls onRefresh after a successful upload', async () => {
      const onRefresh = vi.fn();
      const { result } = renderNoteImages({ onRefresh });

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onRefresh).toHaveBeenCalled();
    });

    it('marks the tile as errored when the upload fails, keeping it retryable', async () => {
      vi.mocked(imagesApi.upload).mockRejectedValueOnce(new Error('network error'));
      const { result } = renderNoteImages();

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.imageUploads[0]).toMatchObject({ status: 'error' });
    });

    it('shows a size-specific error message on a 413 response', async () => {
      vi.mocked(imagesApi.upload).mockRejectedValueOnce({ response: { status: 413 } });
      const { result } = renderNoteImages({ uploadMaxBytes: 10 * 1024 * 1024 });

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.imageUploads[0]).toMatchObject({ errorMessage: 'Image exceeds the 10 MB limit.' });
    });

    it('retries a failed upload for the same file', async () => {
      vi.mocked(imagesApi.upload).mockRejectedValueOnce(new Error('network error'));
      const { result } = renderNoteImages();

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });
      const uploadId = result.current.imageUploads[0]!.id;

      vi.mocked(imagesApi.upload).mockResolvedValueOnce(makeImage({ id: 'retried' }));
      await act(async () => {
        result.current.retryImageUpload(uploadId);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(imagesApi.upload).toHaveBeenCalledTimes(2);
      expect(result.current.imageUploads).toHaveLength(0);
    });

    it('ignores a duplicate retry while one for the same upload is already in flight', async () => {
      vi.mocked(imagesApi.upload).mockRejectedValueOnce(new Error('network error'));
      const { result } = renderNoteImages();

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile()], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });
      const uploadId = result.current.imageUploads[0]!.id;

      let resolveRetry: (image: NoteImage) => void = () => {};
      vi.mocked(imagesApi.upload).mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));

      act(() => {
        result.current.retryImageUpload(uploadId);
        result.current.retryImageUpload(uploadId);
      });

      // One call for the initial failed upload, one for the retry — the
      // second rapid retry call must not fire a duplicate request.
      expect(imagesApi.upload).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRetry(makeImage({ id: 'retried' }));
        await Promise.resolve();
        await Promise.resolve();
      });
    });
  });

  describe('removal and undo', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('hides an image immediately without deleting it', () => {
      const image = makeImage();
      const note = createMockNote({ images: [image] });
      const { result } = renderNoteImages({ note });

      act(() => {
        result.current.removeNoteImage(image);
      });

      expect(result.current.displayedImages).toHaveLength(0);
      expect(result.current.removedImages).toEqual([image]);
      expect(imagesApi.delete).not.toHaveBeenCalled();
    });

    it('undo restores the image and cancels the deferred delete', async () => {
      const image = makeImage();
      const note = createMockNote({ images: [image] });
      const { result } = renderNoteImages({ note });

      act(() => {
        result.current.removeNoteImage(image);
        result.current.undoRemoveImage(image.id);
      });

      expect(result.current.displayedImages).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
      });
      expect(imagesApi.delete).not.toHaveBeenCalled();
    });

    it('fires the delete once the undo window elapses without an undo', async () => {
      const image = makeImage();
      const note = createMockNote({ images: [image] });
      const { result } = renderNoteImages({ note });

      act(() => {
        result.current.removeNoteImage(image);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
      });

      expect(imagesApi.delete).toHaveBeenCalledWith(image.id);
    });

    it('calls onRefresh once the deferred delete succeeds', async () => {
      const image = makeImage();
      const note = createMockNote({ images: [image] });
      const onRefresh = vi.fn();
      const { result } = renderNoteImages({ note, onRefresh });

      act(() => {
        result.current.removeNoteImage(image);
      });
      onRefresh.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
      });

      expect(onRefresh).toHaveBeenCalled();
    });

    it('restores the image if the deferred delete fails', async () => {
      vi.mocked(imagesApi.delete).mockRejectedValueOnce(new Error('network error'));
      const image = makeImage();
      const note = createMockNote({ images: [image] });
      const { result } = renderNoteImages({ note });

      act(() => {
        result.current.removeNoteImage(image);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
      });

      expect(result.current.displayedImages).toHaveLength(1);
    });

    it('keeps a still-pending removal hidden across a note switch before the undo window elapses', async () => {
      const image = makeImage();
      const noteA = createMockNote({ id: 'noteA', images: [image] });
      const noteB = createMockNote({ id: 'noteB', images: [] });
      const { result, rerender } = renderNoteImages({ note: noteA });

      act(() => {
        result.current.removeNoteImage(image);
      });

      // Navigate to a different note, then back to noteA before the undo
      // window elapses — the modal doesn't unmount on a note switch, so the
      // deferred-delete timer keeps running throughout.
      rerender({ note: noteB });
      act(() => {
        result.current.resetForNoteSwitch();
      });
      rerender({ note: noteA });
      act(() => {
        result.current.resetForNoteSwitch();
      });

      // Still hidden with its undo bar, not silently reappeared.
      expect(result.current.removedImages).toEqual([image]);

      act(() => {
        result.current.undoRemoveImage(image.id);
      });
      expect(result.current.displayedImages).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
      });
      expect(imagesApi.delete).not.toHaveBeenCalled();
    });

    it('does not resurrect an image uploaded this session once its deferred delete lands', async () => {
      vi.mocked(imagesApi.upload).mockResolvedValueOnce(makeImage({ id: 'newimg', filename: 'uploaded.png' }));
      const note = createMockNote({ images: [] });
      const { result } = renderNoteImages({ note });

      await act(async () => {
        result.current.handleImageFileInputChange({
          target: { files: [makeFile('uploaded.png')], value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>);
        await Promise.resolve();
        await Promise.resolve();
      });
      const uploaded = result.current.displayedImages.find(i => i.id === 'newimg')!;

      act(() => {
        result.current.removeNoteImage(uploaded);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(IMAGE_REMOVE_UNDO_MS);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(imagesApi.delete).toHaveBeenCalledWith('newimg');
      expect(result.current.displayedImages.map(i => i.id)).not.toContain('newimg');
    });
  });

  describe('drag and drop', () => {
    it('toggles the dragging flag on enter and leave', () => {
      const { result } = renderNoteImages();

      act(() => {
        result.current.handleImageDragEnter({
          preventDefault: vi.fn(),
          dataTransfer: { items: [{ kind: 'file' }] },
        } as unknown as React.DragEvent);
      });
      expect(result.current.isDraggingImage).toBe(true);

      act(() => {
        result.current.handleImageDragLeave();
      });
      expect(result.current.isDraggingImage).toBe(false);
    });

    it('queues files from a drop', async () => {
      const { result } = renderNoteImages();
      const file = makeFile();

      await act(async () => {
        result.current.handleImageDrop({
          preventDefault: vi.fn(),
          dataTransfer: { files: [file] },
        } as unknown as React.DragEvent);
        await Promise.resolve();
      });

      expect(imagesApi.upload).toHaveBeenCalledWith('1', file, expect.any(Function));
    });

    it('reports a wrong-type error when a drop contains only non-image files', () => {
      const { result, showError } = renderNoteImages();

      act(() => {
        result.current.handleImageDrop({
          preventDefault: vi.fn(),
          dataTransfer: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })] },
        } as unknown as React.DragEvent);
      });

      expect(imagesApi.upload).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith('Only images can be attached.');
    });

    it('queues files from a paste', async () => {
      const { result } = renderNoteImages();
      const file = makeFile();

      await act(async () => {
        result.current.handleModalPaste({
          preventDefault: vi.fn(),
          clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
        } as unknown as React.ClipboardEvent);
        await Promise.resolve();
      });

      expect(imagesApi.upload).toHaveBeenCalledWith('1', file, expect.any(Function));
    });
  });
});
