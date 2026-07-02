/**
 * Tests for the note-image cache (issue #618): cache hit / miss / download
 * behaviour, mirroring profileIconCache.test.ts's structure. Note images are
 * content-addressed and immutable, so — unlike profile icons — there is no
 * staleness/version dimension to the cache key.
 */

import { getCachedNoteImageUri, downloadAndCacheNoteImage, deleteCachedNoteImage } from '../src/utils/noteImageCache';

type FileInfo = { exists: boolean };

const mockGetInfoAsync = jest.fn<Promise<FileInfo>, [string]>();
const mockMakeDirectoryAsync = jest.fn<Promise<void>, [string, { intermediates: boolean }]>();
const mockDownloadAsync = jest.fn<Promise<{ status: number }>, [string, string]>();
const mockDeleteAsync = jest.fn<Promise<void>, [string, { idempotent: boolean }]>();

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: (path: string) => mockGetInfoAsync(path),
  makeDirectoryAsync: (path: string, opts: { intermediates: boolean }) => mockMakeDirectoryAsync(path, opts),
  downloadAsync: (url: string, path: string) => mockDownloadAsync(url, path),
  deleteAsync: (path: string, opts: { idempotent: boolean }) => mockDeleteAsync(path, opts),
}));

const CACHE_DIR = 'file:///cache/note-images/';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetInfoAsync.mockResolvedValue({ exists: true });
});

describe('getCachedNoteImageUri', () => {
  it('returns the local path for the original variant when cached', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });

    const result = await getCachedNoteImageUri('img-1', 'original');

    expect(result).toBe(`${CACHE_DIR}img-1`);
    expect(mockGetInfoAsync).toHaveBeenCalledWith(`${CACHE_DIR}img-1`);
  });

  it('uses a distinct path for the thumbnail variant', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });

    const result = await getCachedNoteImageUri('img-1', 'thumbnail');

    expect(result).toBe(`${CACHE_DIR}img-1_thumb`);
  });

  it('returns null when not cached', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });

    const result = await getCachedNoteImageUri('img-1', 'original');

    expect(result).toBeNull();
  });

  it('returns null when getInfoAsync throws', async () => {
    mockGetInfoAsync.mockRejectedValueOnce(new Error('FS error'));

    const result = await getCachedNoteImageUri('img-1', 'original');

    expect(result).toBeNull();
  });
});

describe('downloadAndCacheNoteImage', () => {
  const networkUrl = 'https://example.com/api/v1/images/img-1';

  it('downloads and returns the local path on success', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true }); // ensureCacheDir
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });

    const result = await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(mockDownloadAsync).toHaveBeenCalledWith(networkUrl, `${CACHE_DIR}img-1`);
    expect(result).toBe(`${CACHE_DIR}img-1`);
  });

  it('creates the cache directory when it does not exist', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });

    await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(mockMakeDirectoryAsync).toHaveBeenCalledWith(CACHE_DIR, { intermediates: true });
  });

  it('deletes the partial file and returns null on a non-200 response', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });
    mockDownloadAsync.mockResolvedValueOnce({ status: 404 });

    const result = await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(result).toBeNull();
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${CACHE_DIR}img-1`, { idempotent: true });
  });

  it('returns null when offline (the download throws)', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });
    mockDownloadAsync.mockRejectedValueOnce(new Error('Network request failed'));

    const result = await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(result).toBeNull();
  });

  it('deduplicates concurrent downloads for the same image + variant', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true });
    let resolveDownload: (value: { status: number }) => void = () => {};
    mockDownloadAsync.mockReturnValueOnce(new Promise((resolve) => { resolveDownload = resolve; }));

    const first = downloadAndCacheNoteImage('img-1', 'original', networkUrl);
    const second = downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    resolveDownload({ status: 200 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(`${CACHE_DIR}img-1`);
    expect(secondResult).toBeNull();
  });
});

describe('deleteCachedNoteImage', () => {
  it('deletes both the original and thumbnail cache entries', async () => {
    await deleteCachedNoteImage('img-1');

    expect(mockDeleteAsync).toHaveBeenCalledWith(`${CACHE_DIR}img-1`, { idempotent: true });
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${CACHE_DIR}img-1_thumb`, { idempotent: true });
  });
});
