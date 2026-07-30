import { VALIDATION } from '@jot/shared';
import { extractSharedText } from '../src/utils/shareIntent';
import {
  getPendingShare,
  setPendingShare,
  subscribePendingShare,
} from '../src/store/shareIntent';

describe('extractSharedText', () => {
  it('returns null for empty/missing intents', () => {
    expect(extractSharedText(null)).toBeNull();
    expect(extractSharedText(undefined)).toBeNull();
    expect(extractSharedText({})).toBeNull();
    expect(extractSharedText({ text: '   ' })).toBeNull();
  });

  it('returns shared plain text, trimmed', () => {
    expect(extractSharedText({ text: '  hello world  ' })).toBe('hello world');
  });

  it('falls back to the shared URL when there is no text', () => {
    expect(extractSharedText({ webUrl: 'https://example.com' })).toBe('https://example.com');
  });

  it('appends the URL when it differs from the text', () => {
    expect(extractSharedText({ text: 'Check this', webUrl: 'https://example.com' })).toBe(
      'Check this\n\nhttps://example.com',
    );
  });

  it('does not duplicate the URL when it equals the text', () => {
    expect(extractSharedText({ text: 'https://example.com', webUrl: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('caps the result at the note content limit', () => {
    const long = 'a'.repeat(VALIDATION.CONTENT_MAX_LENGTH + 50);
    expect(extractSharedText({ text: long })).toHaveLength(VALIDATION.CONTENT_MAX_LENGTH);
  });

  it('caps by code point and keeps astral characters whole', () => {
    // Shared text is a prime source of emoji. A UTF-16 slice would cut the
    // last one in half, and the lone surrogate becomes U+FFFD on save.
    const long = `a${'\u{1F600}'.repeat(VALIDATION.CONTENT_MAX_LENGTH)}`;
    const result = extractSharedText({ text: long }) ?? '';

    expect([...result]).toHaveLength(VALIDATION.CONTENT_MAX_LENGTH);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('pending share store', () => {
  afterEach(() => {
    setPendingShare(null);
  });

  it('stores and clears the pending share', () => {
    expect(getPendingShare()).toBeNull();
    setPendingShare({ text: 'note body' });
    expect(getPendingShare()).toEqual({ text: 'note body' });
    setPendingShare(null);
    expect(getPendingShare()).toBeNull();
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePendingShare(listener);

    setPendingShare({ text: 'a', targetServerId: 'srv1' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPendingShare()).toEqual({ text: 'a', targetServerId: 'srv1' });

    unsubscribe();
    setPendingShare({ text: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
