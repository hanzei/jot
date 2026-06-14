/**
 * Tests for profile icon cache: hit / miss / refresh behaviour.
 */

import { getCachedIconUri, downloadAndCacheIcon, refreshIconCacheForUsers } from '../src/utils/profileIconCache';

// ── Mocks ────────────────────────────────────────────────────────────────────

type FileInfo = { exists: boolean };

const mockGetInfoAsync = jest.fn<Promise<FileInfo>, [string]>();
const mockMakeDirectoryAsync = jest.fn<Promise<void>, [string, { intermediates: boolean }]>();
const mockDownloadAsync = jest.fn<Promise<{ status: number }>, [string, string]>();
const mockDeleteAsync = jest.fn<Promise<void>, [string, { idempotent: boolean }]>();
const mockReadDirectoryAsync = jest.fn<Promise<string[]>, [string]>();

jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: (path: string) => mockGetInfoAsync(path),
  makeDirectoryAsync: (path: string, opts: { intermediates: boolean }) => mockMakeDirectoryAsync(path, opts),
  downloadAsync: (url: string, path: string) => mockDownloadAsync(url, path),
  deleteAsync: (path: string, opts: { idempotent: boolean }) => mockDeleteAsync(path, opts),
  readDirectoryAsync: (path: string) => mockReadDirectoryAsync(path),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const CACHE_DIR = 'file:///cache/profile-icons/';

function iconFilePath(userId: string, updatedAt: string): string {
  const safeVersion = updatedAt.replace(/[^a-zA-Z0-9-]/g, '_');
  return `${CACHE_DIR}${userId}_${safeVersion}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: cache directory exists.
  mockGetInfoAsync.mockResolvedValue({ exists: true });
});

// ── getCachedIconUri ──────────────────────────────────────────────────────────

describe('getCachedIconUri', () => {
  it('returns null when updatedAt is empty', async () => {
    const result = await getCachedIconUri('user1', '');
    expect(result).toBeNull();
    expect(mockGetInfoAsync).not.toHaveBeenCalled();
  });

  it('returns the local file path when the cached file exists', async () => {
    const updatedAt = '2024-01-15T10:00:00Z';
    const expectedPath = iconFilePath('user1', updatedAt);
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });

    const result = await getCachedIconUri('user1', updatedAt);

    expect(result).toBe(expectedPath);
    expect(mockGetInfoAsync).toHaveBeenCalledWith(expectedPath);
  });

  it('returns null when the cached file does not exist', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: false });

    const result = await getCachedIconUri('user1', '2024-01-15T10:00:00Z');

    expect(result).toBeNull();
  });

  it('returns null when getInfoAsync throws', async () => {
    mockGetInfoAsync.mockRejectedValueOnce(new Error('FS error'));

    const result = await getCachedIconUri('user1', '2024-01-15T10:00:00Z');

    expect(result).toBeNull();
  });

  it('sanitises special characters in updatedAt when forming the path', async () => {
    const updatedAt = '2024-01-15T10:00:00.000Z';
    const expectedPath = iconFilePath('user1', updatedAt);
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });

    const result = await getCachedIconUri('user1', updatedAt);

    expect(result).toBe(expectedPath);
    // The filename portion (after the last /) must not contain raw colons or dots.
    const filename = result?.split('/').pop() ?? '';
    expect(filename).not.toContain(':');
    expect(filename).not.toContain('.');
  });
});

// ── downloadAndCacheIcon ──────────────────────────────────────────────────────

describe('downloadAndCacheIcon', () => {
  const userId = 'user1';
  const updatedAt = '2024-01-15T10:00:00Z';
  const networkUrl = 'https://example.com/api/v1/users/user1/profile-icon';

  it('returns null when updatedAt is empty', async () => {
    const result = await downloadAndCacheIcon(userId, '', networkUrl);
    expect(result).toBeNull();
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('downloads the icon and returns the local path on success', async () => {
    const expectedPath = iconFilePath(userId, updatedAt);
    mockGetInfoAsync
      .mockResolvedValueOnce({ exists: true }) // ensureCacheDir check
      .mockResolvedValueOnce({ exists: true }); // purgeStaleIcons dir check
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });
    mockReadDirectoryAsync.mockResolvedValueOnce([]);

    const result = await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(mockDownloadAsync).toHaveBeenCalledWith(networkUrl, expectedPath);
    expect(result).toBe(expectedPath);
  });

  it('creates the cache directory when it does not exist', async () => {
    mockGetInfoAsync
      .mockResolvedValueOnce({ exists: false }) // ensureCacheDir: dir missing
      .mockResolvedValueOnce({ exists: true }); // purgeStaleIcons dir check
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });
    mockReadDirectoryAsync.mockResolvedValueOnce([]);

    await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(mockMakeDirectoryAsync).toHaveBeenCalledWith(CACHE_DIR, { intermediates: true });
  });

  it('deletes the file and returns null when download returns non-200', async () => {
    const expectedPath = iconFilePath(userId, updatedAt);
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });
    mockDownloadAsync.mockResolvedValueOnce({ status: 404 });

    const result = await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(result).toBeNull();
    expect(mockDeleteAsync).toHaveBeenCalledWith(expectedPath, { idempotent: true });
  });

  it('returns null when the download throws', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true });
    mockDownloadAsync.mockRejectedValueOnce(new Error('Network error'));

    const result = await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(result).toBeNull();
  });

  it('purges stale icon files for the same user after a successful download', async () => {
    const oldFile = `${userId}_2024-01-01T00_00_00Z`;
    mockGetInfoAsync
      .mockResolvedValueOnce({ exists: true }) // ensureCacheDir
      .mockResolvedValueOnce({ exists: true }); // purgeStaleIcons dir check
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });
    mockReadDirectoryAsync.mockResolvedValueOnce([oldFile, `${userId}_${updatedAt.replace(/[^a-zA-Z0-9-]/g, '_')}`]);

    await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    // Old file should be deleted; current file should be kept.
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${CACHE_DIR}${oldFile}`, { idempotent: true });
    expect(mockDeleteAsync).not.toHaveBeenCalledWith(
      iconFilePath(userId, updatedAt),
      expect.anything(),
    );
  });
});

// ── refreshIconCacheForUsers ──────────────────────────────────────────────────

describe('refreshIconCacheForUsers', () => {
  const baseUrl = 'https://example.com';

  it('downloads icons for users with has_profile_icon=true and no cached file', async () => {
    const users = [
      { id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' },
    ];
    mockGetInfoAsync
      .mockResolvedValueOnce({ exists: false }) // getCachedIconUri: no cache
      .mockResolvedValueOnce({ exists: true }) // ensureCacheDir
      .mockResolvedValueOnce({ exists: true }); // purgeStaleIcons
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });
    mockReadDirectoryAsync.mockResolvedValueOnce([]);

    await refreshIconCacheForUsers(users, baseUrl);

    expect(mockDownloadAsync).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/users/u1/profile-icon`,
      expect.stringContaining('u1'),
    );
  });

  it('skips download when cached file already exists', async () => {
    const users = [
      { id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' },
    ];
    mockGetInfoAsync.mockResolvedValueOnce({ exists: true }); // cache hit

    await refreshIconCacheForUsers(users, baseUrl);

    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('skips users with has_profile_icon=false', async () => {
    const users = [
      { id: 'u2', has_profile_icon: false, updated_at: '2024-01-15T10:00:00Z' },
    ];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(mockGetInfoAsync).not.toHaveBeenCalled();
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('skips users with empty updated_at', async () => {
    const users = [
      { id: 'u3', has_profile_icon: true, updated_at: '' },
    ];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('processes multiple users, downloading only those with cache misses', async () => {
    const users = [
      { id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' },
      { id: 'u2', has_profile_icon: true, updated_at: '2024-01-16T10:00:00Z' },
      { id: 'u3', has_profile_icon: false, updated_at: '2024-01-17T10:00:00Z' },
    ];
    // u1: cache hit; u2: cache miss → download
    mockGetInfoAsync
      .mockResolvedValueOnce({ exists: true }) // u1 cache hit
      .mockResolvedValueOnce({ exists: false }) // u2 cache miss
      .mockResolvedValueOnce({ exists: true }) // u2 ensureCacheDir
      .mockResolvedValueOnce({ exists: true }); // u2 purgeStaleIcons dir
    mockDownloadAsync.mockResolvedValueOnce({ status: 200 });
    mockReadDirectoryAsync.mockResolvedValueOnce([]);

    await refreshIconCacheForUsers(users, baseUrl);

    expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
    expect(mockDownloadAsync).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/users/u2/profile-icon`,
      expect.stringContaining('u2'),
    );
  });
});
