import { describe, expect, it } from 'vitest';
import { publicLinkUrl } from '@jot/shared';
import { shortPublicLinkUrl } from '../publicLink';

const token = 'W15wq3Zr8kPLx0aYbN2cD4eF6gH8iJ0kL2mN4oP6qR8';

describe('shortPublicLinkUrl', () => {
  it('shortens a link built on public_url', () => {
    const url = publicLinkUrl({ token }, 'https://jot.example.com', 'http://localhost:5173');
    expect(shortPublicLinkUrl(url)).toBe('jot.example.com/share/W15w…');
  });

  it('keeps a path that public_url carries', () => {
    const url = publicLinkUrl({ token }, 'https://example.com/jot/', 'http://localhost:5173');
    expect(shortPublicLinkUrl(url)).toBe('example.com/jot/share/W15w…');
  });

  it('shortens a link built on the page origin when public_url is unset', () => {
    const url = publicLinkUrl({ token }, null, 'https://notes.internal');
    expect(shortPublicLinkUrl(url)).toBe('notes.internal/share/W15w…');
  });

  it('keeps the port of an origin that has one', () => {
    const url = publicLinkUrl({ token }, null, 'http://192.168.1.20:8080');
    expect(shortPublicLinkUrl(url)).toBe('192.168.1.20:8080/share/W15w…');
  });

  it('never shows the token in full', () => {
    for (const base of ['https://jot.example.com', 'http://localhost:8080']) {
      const shortened = shortPublicLinkUrl(publicLinkUrl({ token }, null, base));
      expect(shortened).not.toContain(token);
      expect(shortened).not.toContain(token.slice(0, 5));
    }
  });
});
