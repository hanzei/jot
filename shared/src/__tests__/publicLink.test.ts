import { describe, expect, it } from 'vitest';
import { isPublicLinkActive, publicLinkExpiresAt, publicLinkUrl, publicNoteUrl, shortPublicLinkUrl } from '../publicLink';

const token = 'q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw';

describe('publicNoteUrl', () => {
  it('builds the share URL from a base without a trailing slash', () => {
    expect(publicNoteUrl('https://jot.example.com', token)).toBe(`https://jot.example.com/share/${token}`);
  });

  it('builds the same URL from a base with a trailing slash', () => {
    expect(publicNoteUrl('https://jot.example.com/', token)).toBe(`https://jot.example.com/share/${token}`);
    expect(publicNoteUrl('https://jot.example.com///', token)).toBe(`https://jot.example.com/share/${token}`);
  });

  it('keeps a port and an IP host', () => {
    expect(publicNoteUrl('http://192.168.1.10:8080', token)).toBe(`http://192.168.1.10:8080/share/${token}`);
  });

  it('keeps base64url tokens as they are', () => {
    expect(publicNoteUrl('https://jot.example.com', 'a-b_c')).toBe('https://jot.example.com/share/a-b_c');
  });
});

describe('publicLinkUrl', () => {
  it('uses public_url when the server sets one', () => {
    expect(publicLinkUrl({ token }, 'https://jot.example.com', 'http://192.168.1.10:8080'))
      .toBe(`https://jot.example.com/share/${token}`);
  });

  it("falls back to the client's own address when public_url is unset", () => {
    expect(publicLinkUrl({ token }, null, 'http://192.168.1.10:8080'))
      .toBe(`http://192.168.1.10:8080/share/${token}`);
    expect(publicLinkUrl({ token }, undefined, 'http://192.168.1.10:8080'))
      .toBe(`http://192.168.1.10:8080/share/${token}`);
  });
});

describe('publicLinkExpiresAt', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');

  it('sends null for a link that never expires', () => {
    expect(publicLinkExpiresAt('never', now)).toBeNull();
  });

  it.each([
    ['7d', '2026-11-16T12:00:00.000Z'],
    ['30d', '2026-12-09T12:00:00.000Z'],
    ['3m', '2027-02-09T12:00:00.000Z'],
  ] as const)('counts %s from now', (choice, expected) => {
    expect(publicLinkExpiresAt(choice, now)).toBe(expected);
  });
});

describe('isPublicLinkActive', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const link = { token, created_by: null, created_at: '2026-11-01T00:00:00Z' };

  it('treats a missing link as inactive', () => {
    expect(isPublicLinkActive(null, now)).toBe(false);
    expect(isPublicLinkActive(undefined, now)).toBe(false);
  });

  it('keeps a link without expiry active', () => {
    expect(isPublicLinkActive({ ...link, expires_at: null }, now)).toBe(true);
  });

  it('drops a link that expired since the note was loaded', () => {
    expect(isPublicLinkActive({ ...link, expires_at: '2026-11-09T11:59:59Z' }, now)).toBe(false);
    expect(isPublicLinkActive({ ...link, expires_at: '2026-11-09T12:00:01Z' }, now)).toBe(true);
  });
});

describe('shortPublicLinkUrl', () => {
  it('shortens a link built on public_url', () => {
    const url = publicLinkUrl({ token }, 'https://jot.example.com', 'http://internal:8080');
    expect(shortPublicLinkUrl(url)).toBe('jot.example.com/share/q3Xv…');
  });

  it('shortens a link built on the client origin when public_url is unset', () => {
    const url = publicLinkUrl({ token }, null, 'https://notes.example.org');
    expect(shortPublicLinkUrl(url)).toBe('notes.example.org/share/q3Xv…');
  });

  it('keeps the port of an origin that has one', () => {
    const url = publicLinkUrl({ token }, null, 'http://192.168.1.10:8080');
    expect(shortPublicLinkUrl(url)).toBe('192.168.1.10:8080/share/q3Xv…');
  });

  it('shows an internationalized domain as configured, not in punycode', () => {
    const url = publicLinkUrl({ token }, 'https://notizen.müller.de', 'http://localhost');
    expect(shortPublicLinkUrl(url)).toBe('notizen.müller.de/share/q3Xv…');
  });

  it('never shows the token in full', () => {
    for (const t of [token, 'abcd', 'abc', 'a']) {
      const short = shortPublicLinkUrl(publicLinkUrl({ token: t }, null, 'https://jot.example.com'));
      expect(short).not.toContain(`/share/${t}`);
      expect(short.endsWith('…')).toBe(true);
    }
  });
});
