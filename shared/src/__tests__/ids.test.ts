import { describe, expect, it } from 'vitest';
import { generateId, isValidId } from '../ids';

describe('generateId', () => {
  it('produces a 22-character alphanumeric ID', () => {
    const id = generateId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
  });

  it('produces IDs that pass isValidId', () => {
    for (let i = 0; i < 100; i++) {
      expect(isValidId(generateId())).toBe(true);
    }
  });

  it('is collision-free across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      seen.add(generateId());
    }
    expect(seen.size).toBe(10000);
  });
});

describe('isValidId', () => {
  it('accepts a valid 22-char alphanumeric ID', () => {
    expect(isValidId('abcdefghijklmnopqrstuv')).toBe(true);
    expect(isValidId('0123456789ABCDEFGHIJKL')).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidId('tooshort')).toBe(false);
    expect(isValidId('abcdefghijklmnopqrstuvw')).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(isValidId('abcdefghijklmnopqrstu-')).toBe(false);
    expect(isValidId('abcdefghijklmnopqrstu_')).toBe(false);
    expect(isValidId('abcdefghijklmnopqrst uv')).toBe(false);
  });
});
