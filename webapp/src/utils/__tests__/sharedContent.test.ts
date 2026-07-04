import { describe, expect, it } from 'vitest';
import { VALIDATION } from '@jot/shared';
import { buildSharedContent } from '@/utils/sharedContent';

describe('buildSharedContent', () => {
  it('joins title, text and url with blank lines', () => {
    expect(buildSharedContent({ title: 'Recipe', text: 'Looks tasty', url: 'https://example.com' }))
      .toBe('Recipe\n\nLooks tasty\n\nhttps://example.com');
  });

  it('omits missing parts', () => {
    expect(buildSharedContent({ text: 'Just text' })).toBe('Just text');
    expect(buildSharedContent({ url: 'https://example.com' })).toBe('https://example.com');
    expect(buildSharedContent({})).toBe('');
  });

  it('trims whitespace-only fields', () => {
    expect(buildSharedContent({ title: '  ', text: '  Hello  ', url: null })).toBe('Hello');
  });

  it('drops duplicate parts', () => {
    expect(buildSharedContent({ title: 'Same', text: 'Same' })).toBe('Same');
    expect(buildSharedContent({ text: 'https://example.com', url: 'https://example.com' })).toBe('https://example.com');
  });

  it('caps the result to the note content limit', () => {
    const long = 'a'.repeat(VALIDATION.CONTENT_MAX_LENGTH + 500);
    const result = buildSharedContent({ text: long });
    expect(result.length).toBe(VALIDATION.CONTENT_MAX_LENGTH);
  });
});
