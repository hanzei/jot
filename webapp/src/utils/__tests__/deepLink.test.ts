import { describe, expect, it } from 'vitest';
import { buildMobileDeepLink, mapWebPathToMobilePath } from '../deepLink';

describe('deepLink utilities', () => {
  describe('mapWebPathToMobilePath', () => {
    it('maps settings path', () => {
      expect(mapWebPathToMobilePath('/settings')).toBe('settings');
      expect(mapWebPathToMobilePath('/settings/')).toBe('settings');
    });

    it('maps note details path', () => {
      expect(mapWebPathToMobilePath('/notes/note-123')).toBe('notes/note-123');
      expect(mapWebPathToMobilePath('/notes/note-123/')).toBe('notes/note-123');
    });

    it('returns an empty mobile path for unsupported web paths', () => {
      expect(mapWebPathToMobilePath('/')).toBe('');
      expect(mapWebPathToMobilePath('/admin')).toBe('');
      expect(mapWebPathToMobilePath('/notes')).toBe('');
    });
  });

  describe('buildMobileDeepLink', () => {
    it('builds note deep link with server query parameter', () => {
      expect(buildMobileDeepLink('/notes/note-123', 'https://jot.example.com')).toBe(
        'jot://notes/note-123?server=https%3A%2F%2Fjot.example.com',
      );
    });

    it('normalizes origin and falls back to root path', () => {
      expect(buildMobileDeepLink('/unknown', 'https://jot.example.com/path?foo=bar')).toBe(
        'jot://?server=https%3A%2F%2Fjot.example.com',
      );
    });
  });
});
