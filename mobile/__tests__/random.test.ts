import { randomUUID, getRandomBytes } from '../src/utils/random';

describe('randomUUID', () => {
  it('returns a string matching UUID v4 format', () => {
    const id = randomUUID();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns a different value each call', () => {
    expect(randomUUID()).not.toBe(randomUUID());
  });
});

describe('getRandomBytes', () => {
  it('fills every element in the supplied Uint8Array', () => {
    const bytes = new Uint8Array(16);
    getRandomBytes(bytes);
    for (const b of bytes) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
    // Ensure the array was actually written to (not left as all-zeros)
    expect(bytes.some(b => b !== 0)).toBe(true);
  });

  it('produces different output on successive calls', () => {
    const a = new Uint8Array(8);
    const b = new Uint8Array(8);
    getRandomBytes(a);
    getRandomBytes(b);
    // Extremely unlikely to match with 8 random bytes each
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
