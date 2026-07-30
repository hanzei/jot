import { describe, expect, it } from 'vitest';
import { codePointLength, exceedsCodePointLimit, truncateToCodePoints } from '../text';

// Matches a high surrogate not followed by a low one, or a low surrogate not
// preceded by a high one. Either means the string is ill-formed UTF-16, which
// is what turns an emoji into U+FFFD once it round-trips through the server.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const EMOJI = '😀'; // U+1F600, two UTF-16 units

describe('codePointLength', () => {
  it('counts BMP characters the same as .length', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('a')).toBe(1);
    expect(codePointLength('hello wörld')).toBe(11);
  });

  it('counts an astral character as one, where .length counts two', () => {
    expect(EMOJI.length).toBe(2);
    expect(codePointLength(EMOJI)).toBe(1);
    expect(codePointLength(EMOJI.repeat(300))).toBe(300);
  });

  it('counts mixed BMP and astral text by code point', () => {
    expect(codePointLength(`a${EMOJI}b`)).toBe(3);
  });
});

describe('exceedsCodePointLimit', () => {
  it('agrees with codePointLength for BMP text', () => {
    expect(exceedsCodePointLimit('abc', 3)).toBe(false);
    expect(exceedsCodePointLimit('abcd', 3)).toBe(true);
    expect(exceedsCodePointLimit('', 3)).toBe(false);
  });

  it('does not flag astral text that fits by code point', () => {
    // 300 emoji is 600 UTF-16 units but only 300 code points, which the server
    // accepts under a 500 limit.
    expect(exceedsCodePointLimit(EMOJI.repeat(300), 500)).toBe(false);
  });

  it('flags astral text that genuinely exceeds the limit', () => {
    expect(exceedsCodePointLimit(EMOJI.repeat(501), 500)).toBe(true);
  });

  it('is exact at the boundary', () => {
    expect(exceedsCodePointLimit(EMOJI.repeat(500), 500)).toBe(false);
  });
});

describe('truncateToCodePoints', () => {
  it('leaves strings that already fit untouched', () => {
    expect(truncateToCodePoints('abc', 5)).toBe('abc');
    expect(truncateToCodePoints('', 5)).toBe('');
    expect(truncateToCodePoints(EMOJI.repeat(3), 5)).toBe(EMOJI.repeat(3));
  });

  it('truncates BMP text by character', () => {
    expect(truncateToCodePoints('abcdef', 3)).toBe('abc');
  });

  it('keeps astral characters whole when the cut lands mid-pair', () => {
    // .slice(0, 3) would cut the second emoji in half; this must not.
    const text = EMOJI.repeat(4);
    const truncated = truncateToCodePoints(text, 3);

    expect(truncated).toBe(EMOJI.repeat(3));
    expect(LONE_SURROGATE.test(truncated)).toBe(false);
  });

  it('produces well-formed UTF-16 at every cut point of mixed text', () => {
    const text = `a${EMOJI}b${EMOJI}${EMOJI}c`;
    for (let max = 0; max <= codePointLength(text) + 1; max++) {
      const truncated = truncateToCodePoints(text, max);
      expect(LONE_SURROGATE.test(truncated)).toBe(false);
      expect(codePointLength(truncated)).toBe(Math.min(max, codePointLength(text)));
    }
  });

  it('returns an empty string for a zero limit', () => {
    expect(truncateToCodePoints(`${EMOJI}abc`, 0)).toBe('');
  });
});
