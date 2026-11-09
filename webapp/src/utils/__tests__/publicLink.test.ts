import { describe, expect, it } from 'vitest';
import { isPublicLinkActive, publicLinkExpiresAt, publicLinkUrl } from '../publicLink';

const token = 'q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw';

describe('publicLinkUrl', () => {
  it('uses public_url when the server sets one', () => {
    expect(publicLinkUrl({ token }, 'https://jot.example.com', 'http://192.168.1.10:8080'))
      .toBe(`https://jot.example.com/share/${token}`);
  });

  it("falls back to this page's origin when public_url is null", () => {
    expect(publicLinkUrl({ token }, null, 'http://192.168.1.10:8080'))
      .toBe(`http://192.168.1.10:8080/share/${token}`);
  });

  it('defaults the fallback to window.location.origin', () => {
    expect(publicLinkUrl({ token }, null)).toBe(`${window.location.origin}/share/${token}`);
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
