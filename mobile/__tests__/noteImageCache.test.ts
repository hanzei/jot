/**
 * Tests for the note-image cache (issue #618): cache hit / miss / download
 * behaviour, mirroring profileIconCache.test.ts's structure. Note images are
 * content-addressed and immutable, so — unlike profile icons — there is no
 * staleness/version dimension to the cache key.
 *
 * Backed by the in-memory `expo-file-system` mock from jest.setup.js.
 */

import { getCachedNoteImageUri, downloadAndCacheNoteImage, deleteCachedNoteImage } from '../src/utils/noteImageCache';

const fs = globalThis.mockFileSystem;

const CACHE_DIR = 'file:///cache/note-images';

/** Pretend a previous run already cached this image variant. */
function seedCachedImage(name: string): string {
  const path = `${CACHE_DIR}/${name}`;
  fs.dirs.add(CACHE_DIR);
  fs.files.set(path, 'jpeg-bytes');
  return path;
}

beforeEach(() => {
  fs.reset();
});

describe('getCachedNoteImageUri', () => {
  it('returns the local path for the original variant when cached', async () => {
    const path = seedCachedImage('img-1');

    expect(await getCachedNoteImageUri('img-1', 'original')).toBe(path);
  });

  it('uses a distinct path for the thumbnail variant', async () => {
    seedCachedImage('img-1_thumb');

    expect(await getCachedNoteImageUri('img-1', 'thumbnail')).toBe(`${CACHE_DIR}/img-1_thumb`);
  });

  it('returns null when not cached', async () => {
    expect(await getCachedNoteImageUri('img-1', 'original')).toBeNull();
  });
});

describe('downloadAndCacheNoteImage', () => {
  const networkUrl = 'https://example.com/api/v1/images/img-1';

  it('downloads and returns the local path on success', async () => {
    const result = await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(result).toBe(`${CACHE_DIR}/img-1`);
    expect(fs.downloadFileAsync).toHaveBeenCalledWith(
      networkUrl,
      expect.objectContaining({ uri: `${CACHE_DIR}/img-1` }),
    );
  });

  it('creates the cache directory when it does not exist', async () => {
    expect(fs.dirs.has(CACHE_DIR)).toBe(false);

    await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(fs.dirs.has(CACHE_DIR)).toBe(true);
  });

  it('deletes the partial file and returns null when the download rejects', async () => {
    fs.downloadFileAsync.mockImplementationOnce((_url: string, destination: { uri: string }) => {
      fs.files.set(destination.uri, 'partial');
      return Promise.reject(new Error('UnableToDownload: 404'));
    });

    const result = await downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    expect(result).toBeNull();
    expect(fs.files.has(`${CACHE_DIR}/img-1`)).toBe(false);
  });

  it('returns null when offline (the download throws)', async () => {
    fs.downloadFileAsync.mockRejectedValueOnce(new Error('Network request failed'));

    expect(await downloadAndCacheNoteImage('img-1', 'original', networkUrl)).toBeNull();
  });

  it('deduplicates concurrent downloads for the same image + variant', async () => {
    let resolveDownload: () => void = () => {};
    fs.downloadFileAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDownload = resolve;
      }),
    );

    const first = downloadAndCacheNoteImage('img-1', 'original', networkUrl);
    const second = downloadAndCacheNoteImage('img-1', 'original', networkUrl);

    resolveDownload();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fs.downloadFileAsync).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(`${CACHE_DIR}/img-1`);
    expect(secondResult).toBeNull();
  });
});

describe('deleteCachedNoteImage', () => {
  it('deletes both the original and thumbnail cache entries', async () => {
    const original = seedCachedImage('img-1');
    const thumbnail = seedCachedImage('img-1_thumb');
    const unrelated = seedCachedImage('img-2');

    await deleteCachedNoteImage('img-1');

    expect(fs.files.has(original)).toBe(false);
    expect(fs.files.has(thumbnail)).toBe(false);
    expect(fs.files.has(unrelated)).toBe(true);
  });

  it('is a no-op when neither variant is cached', async () => {
    await expect(deleteCachedNoteImage('img-missing')).resolves.toBeUndefined();
  });
});
