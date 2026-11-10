import { describe, expect, it } from 'vitest';
import { publicLinkUrl } from '@jot/shared';
import { shortPublicLinkUrl } from '../publicLink';

const token = 'W15wQx3kP9zR2mN7vB4cL8tY6hJ1sD5fG0aE-uI_oKq';

describe('shortPublicLinkUrl', () => {
  it('shortens a link built on public_url', () => {
    const url = publicLinkUrl({ token }, 'https://jot.example.com', 'http://internal:8080');
    expect(shortPublicLinkUrl(url)).toBe('jot.example.com/share/W15w…');
  });

  it('shortens a link built on the page origin when public_url is unset', () => {
    const url = publicLinkUrl({ token }, null, 'https://notes.example.org');
    expect(shortPublicLinkUrl(url)).toBe('notes.example.org/share/W15w…');
  });

  it('keeps the port of an origin that has one', () => {
    const url = publicLinkUrl({ token }, null, 'http://192.168.1.10:8080');
    expect(shortPublicLinkUrl(url)).toBe('192.168.1.10:8080/share/W15w…');
  });

  it('keeps a path prefix in public_url', () => {
    const url = publicLinkUrl({ token }, 'https://example.com/jot/', 'http://localhost');
    expect(shortPublicLinkUrl(url)).toBe('example.com/jot/share/W15w…');
  });

  it('never shows the token in full', () => {
    for (const t of [token, 'abcd', 'abc', 'a']) {
      const short = shortPublicLinkUrl(publicLinkUrl({ token: t }, null, 'https://jot.example.com'));
      expect(short).not.toContain(`/share/${t}`);
      expect(short.endsWith('…')).toBe(true);
    }
  });
});
