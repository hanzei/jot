import { describe, expect, it } from 'vitest';
import { shortPublicLinkUrl } from '../publicLink';

const token = 'W15wq3Zr8kPLx0aYbN2cD4eF6gH8iJ0kL2mN4oP6qR8';

describe('shortPublicLinkUrl', () => {
  it('shortens a link built on public_url', () => {
    expect(shortPublicLinkUrl('https://jot.example.com', token)).toBe('jot.example.com/share/W15w…');
  });

  it('shortens a link built on the page origin when public_url is unset', () => {
    expect(shortPublicLinkUrl('https://notes.internal', token)).toBe('notes.internal/share/W15w…');
  });

  it('keeps the port of an origin that has one', () => {
    expect(shortPublicLinkUrl('http://192.168.1.20:8080', token)).toBe('192.168.1.20:8080/share/W15w…');
  });

  it('never shows the token in full', () => {
    for (const base of ['https://jot.example.com', 'http://localhost:8080']) {
      const shortened = shortPublicLinkUrl(base, token);
      expect(shortened).not.toContain(token);
      expect(shortened).not.toContain(token.slice(0, 5));
    }
  });
});
