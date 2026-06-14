import {
  isJotSchemeUrl,
  parseDeepLink,
  getDeepLinkPath,
  isProtectedDeepLinkPath,
  normalizeServerOrigin,
} from '../src/utils/deepLink';

jest.mock('@jot/shared', () => ({
  canonicalizeServerOrigin: (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.origin.toLowerCase();
    } catch {
      return null;
    }
  },
}));

describe('isJotSchemeUrl', () => {
  it('returns true for jot:// URLs', () => {
    expect(isJotSchemeUrl('jot://notes/abc')).toBe(true);
  });

  it('is case-insensitive for the scheme', () => {
    expect(isJotSchemeUrl('JOT://notes/abc')).toBe(true);
  });

  it('returns false for https:// URLs', () => {
    expect(isJotSchemeUrl('https://example.com')).toBe(false);
  });

  it('returns false for plain paths', () => {
    expect(isJotSchemeUrl('notes/abc')).toBe(false);
  });
});

describe('parseDeepLink', () => {
  it('parses a basic deep link with no query params', () => {
    const result = parseDeepLink('jot://notes/abc123');
    expect(result.path).toBe('notes/abc123');
    expect(result.hasServerParam).toBe(false);
    expect(result.serverOrigin).toBeNull();
  });

  it('extracts a server param and normalizes the origin', () => {
    const result = parseDeepLink('jot://notes/abc123?server=https://my.server.com');
    expect(result.hasServerParam).toBe(true);
    expect(result.serverOrigin).toBe('https://my.server.com');
  });

  it('marks hasServerParam true but serverOrigin null when server value is empty string', () => {
    const result = parseDeepLink('jot://notes/abc?server=');
    expect(result.hasServerParam).toBe(true);
    expect(result.serverOrigin).toBeNull();
  });

  it('sets serverOrigin to null for an invalid server URL', () => {
    const result = parseDeepLink('jot://notes/abc?server=not-a-url');
    expect(result.hasServerParam).toBe(true);
    expect(result.serverOrigin).toBeNull();
  });

  it('parses the settings path', () => {
    const result = parseDeepLink('jot://settings');
    expect(result.path).toBe('settings');
  });

  it('handles trailing slashes in the path', () => {
    const result = parseDeepLink('jot://notes/abc/');
    expect(result.path).toBe('notes/abc');
  });
});

describe('getDeepLinkPath', () => {
  it('returns the path portion of the URL', () => {
    expect(getDeepLinkPath('jot://notes/abc123')).toBe('notes/abc123');
  });

  it('strips the server query param from the path', () => {
    const path = getDeepLinkPath('jot://notes/abc?server=https://example.com');
    expect(path).toBe('notes/abc');
  });
});

describe('isProtectedDeepLinkPath', () => {
  it('marks the notes path as protected', () => {
    expect(isProtectedDeepLinkPath('notes/abc')).toBe(true);
  });

  it('marks the share path as protected', () => {
    expect(isProtectedDeepLinkPath('share/abc')).toBe(true);
  });

  it('marks the settings path as protected', () => {
    expect(isProtectedDeepLinkPath('settings')).toBe(true);
  });

  it('marks an empty path as protected (root)', () => {
    expect(isProtectedDeepLinkPath('')).toBe(true);
  });

  it('marks a leading-slash path correctly', () => {
    expect(isProtectedDeepLinkPath('/notes/abc')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isProtectedDeepLinkPath('NOTES/abc')).toBe(true);
  });

  it('returns false for an unprotected path segment', () => {
    expect(isProtectedDeepLinkPath('public')).toBe(false);
  });
});

describe('normalizeServerOrigin', () => {
  it('returns the lowercased origin for a valid URL', () => {
    expect(normalizeServerOrigin('https://My.Server.Com')).toBe('https://my.server.com');
  });

  it('returns null for an invalid URL', () => {
    expect(normalizeServerOrigin('not-a-url')).toBeNull();
  });
});
