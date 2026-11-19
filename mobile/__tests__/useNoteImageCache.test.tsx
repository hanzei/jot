/**
 * Tests for useCachedNoteImageUri: which local file a gallery tile or the
 * lightbox shows. Backed by the in-memory `expo-file-system` mock.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useCachedNoteImageUri } from '../src/hooks/useNoteImageCache';

jest.mock('../src/api/client', () => ({
  sessionCookieHeaders: jest.fn().mockResolvedValue({}),
}));

const fs = globalThis.mockFileSystem;
const CACHE_DIR = 'file:///cache/note-images';
const THUMB_URL = 'http://test-server/api/v1/images/img-1/thumbnail';

function seed(name: string): string {
  const path = `${CACHE_DIR}/${name}`;
  fs.dirs.add(CACHE_DIR);
  fs.files.set(path, 'jpeg-bytes');
  return path;
}

beforeEach(() => {
  fs.reset();
});

describe('useCachedNoteImageUri', () => {
  it('serves a cached thumbnail without downloading', async () => {
    const thumb = seed('img-1_thumb');
    seed('img-1');

    const { result } = await renderHook(() => useCachedNoteImageUri('img-1', 'thumbnail', THUMB_URL));

    await waitFor(() => expect(result.current).toBe(thumb));
    expect(fs.downloadFileAsync).not.toHaveBeenCalled();
  });

  it('falls back to the cached original offline when no thumbnail is cached', async () => {
    // An image uploaded from this device: original cached, thumbnail never fetched.
    const original = seed('img-1');
    fs.downloadFileAsync.mockRejectedValueOnce(new Error('Network request failed'));

    const { result } = await renderHook(() => useCachedNoteImageUri('img-1', 'thumbnail', THUMB_URL));

    await waitFor(() => expect(fs.downloadFileAsync).toHaveBeenCalled());
    expect(result.current).toBe(original);
  });

  it('switches from the original to the thumbnail once it downloads', async () => {
    seed('img-1');

    const { result } = await renderHook(() => useCachedNoteImageUri('img-1', 'thumbnail', THUMB_URL));

    await waitFor(() => expect(result.current).toBe(`${CACHE_DIR}/img-1_thumb`));
  });

  it('does not use a cached thumbnail for the original', async () => {
    seed('img-1_thumb');
    fs.downloadFileAsync.mockRejectedValueOnce(new Error('Network request failed'));

    const { result } = await renderHook(() => useCachedNoteImageUri('img-1', 'original', 'http://test-server/api/v1/images/img-1'));

    await waitFor(() => expect(fs.downloadFileAsync).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
