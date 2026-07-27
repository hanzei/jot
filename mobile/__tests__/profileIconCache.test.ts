/**
 * Tests for profile icon cache: hit / miss / refresh behaviour.
 *
 * These run against the in-memory `expo-file-system` mock from jest.setup.js
 * (via `globalThis.mockFileSystem`) rather than stubbing individual filesystem
 * calls, so the real `src/utils/fs.ts` code path is exercised.
 */

import { getCachedIconUri, downloadAndCacheIcon, refreshIconCacheForUsers } from '../src/utils/profileIconCache';

const fs = globalThis.mockFileSystem;

const CACHE_DIR = 'file:///cache/profile-icons';

function iconFilePath(userId: string, updatedAt: string): string {
  const safeVersion = updatedAt.replace(/[^a-zA-Z0-9-]/g, '_');
  return `${CACHE_DIR}/${userId}_${safeVersion}`;
}

/** Pretend a previous run already cached this icon. */
function seedCachedIcon(userId: string, updatedAt: string): string {
  const path = iconFilePath(userId, updatedAt);
  fs.dirs.add(CACHE_DIR);
  fs.files.set(path, 'png-bytes');
  return path;
}

beforeEach(() => {
  fs.reset();
});

// ── getCachedIconUri ──────────────────────────────────────────────────────────

describe('getCachedIconUri', () => {
  it('returns null when updatedAt is empty', async () => {
    expect(await getCachedIconUri('user1', '')).toBeNull();
  });

  it('returns the local file path when the cached file exists', async () => {
    const updatedAt = '2024-01-15T10:00:00Z';
    const expectedPath = seedCachedIcon('user1', updatedAt);

    expect(await getCachedIconUri('user1', updatedAt)).toBe(expectedPath);
  });

  it('returns null when the cached file does not exist', async () => {
    expect(await getCachedIconUri('user1', '2024-01-15T10:00:00Z')).toBeNull();
  });

  it('sanitises special characters in updatedAt when forming the path', async () => {
    const updatedAt = '2024-01-15T10:00:00.000Z';
    const expectedPath = seedCachedIcon('user1', updatedAt);

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
    expect(await downloadAndCacheIcon(userId, '', networkUrl)).toBeNull();
    expect(fs.downloadFileAsync).not.toHaveBeenCalled();
  });

  it('downloads the icon and returns the local path on success', async () => {
    const expectedPath = iconFilePath(userId, updatedAt);

    const result = await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(result).toBe(expectedPath);
    expect(fs.downloadFileAsync).toHaveBeenCalledWith(
      networkUrl,
      expect.objectContaining({ uri: expectedPath }),
    );
    expect(fs.files.has(expectedPath)).toBe(true);
  });

  it('creates the cache directory when it does not exist', async () => {
    expect(fs.dirs.has(CACHE_DIR)).toBe(false);

    await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(fs.dirs.has(CACHE_DIR)).toBe(true);
  });

  it('deletes the partial file and returns null when the download rejects', async () => {
    // The modern API rejects on a non-2xx response rather than resolving with a
    // status, but can still leave a partial file behind on Android.
    const expectedPath = iconFilePath(userId, updatedAt);
    fs.downloadFileAsync.mockImplementationOnce((_url: string, destination: { uri: string }) => {
      fs.files.set(destination.uri, 'partial');
      return Promise.reject(new Error('UnableToDownload: 404'));
    });

    const result = await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(result).toBeNull();
    expect(fs.files.has(expectedPath)).toBe(false);
  });

  it('returns null when the download throws', async () => {
    fs.downloadFileAsync.mockRejectedValueOnce(new Error('Network error'));

    expect(await downloadAndCacheIcon(userId, updatedAt, networkUrl)).toBeNull();
  });

  it('purges stale icon files for the same user after a successful download', async () => {
    const stalePath = seedCachedIcon(userId, '2024-01-01T00:00:00Z');
    const otherUserPath = seedCachedIcon('user2', '2024-01-01T00:00:00Z');

    await downloadAndCacheIcon(userId, updatedAt, networkUrl);

    expect(fs.files.has(stalePath)).toBe(false);
    expect(fs.files.has(iconFilePath(userId, updatedAt))).toBe(true);
    // Another user's icons are never touched.
    expect(fs.files.has(otherUserPath)).toBe(true);
  });
});

// ── refreshIconCacheForUsers ──────────────────────────────────────────────────

describe('refreshIconCacheForUsers', () => {
  const baseUrl = 'https://example.com';

  it('downloads icons for users with has_profile_icon=true and no cached file', async () => {
    const users = [{ id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' }];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(fs.downloadFileAsync).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/users/u1/profile-icon`,
      expect.objectContaining({ uri: expect.stringContaining('u1') }),
    );
  });

  it('skips download when cached file already exists', async () => {
    seedCachedIcon('u1', '2024-01-15T10:00:00Z');
    const users = [{ id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' }];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(fs.downloadFileAsync).not.toHaveBeenCalled();
  });

  it('skips users with has_profile_icon=false', async () => {
    const users = [{ id: 'u2', has_profile_icon: false, updated_at: '2024-01-15T10:00:00Z' }];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(fs.downloadFileAsync).not.toHaveBeenCalled();
  });

  it('skips users with empty updated_at', async () => {
    const users = [{ id: 'u3', has_profile_icon: true, updated_at: '' }];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(fs.downloadFileAsync).not.toHaveBeenCalled();
  });

  it('processes multiple users, downloading only those with cache misses', async () => {
    seedCachedIcon('u1', '2024-01-15T10:00:00Z');
    const users = [
      { id: 'u1', has_profile_icon: true, updated_at: '2024-01-15T10:00:00Z' },
      { id: 'u2', has_profile_icon: true, updated_at: '2024-01-16T10:00:00Z' },
      { id: 'u3', has_profile_icon: false, updated_at: '2024-01-17T10:00:00Z' },
    ];

    await refreshIconCacheForUsers(users, baseUrl);

    expect(fs.downloadFileAsync).toHaveBeenCalledTimes(1);
    expect(fs.downloadFileAsync).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/users/u2/profile-icon`,
      expect.objectContaining({ uri: expect.stringContaining('u2') }),
    );
  });
});
