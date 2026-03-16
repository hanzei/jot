import { describe, it, expect } from 'vitest';
import {
  hashUsername,
  getAvatarColor,
  AVATAR_COLORS,
  NOTE_COLORS,
} from '../colors';

describe('hashUsername', () => {
  it('returns a non-negative integer', () => {
    expect(hashUsername('alice')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashUsername('alice'))).toBe(true);
  });

  it('returns the same value for the same input', () => {
    expect(hashUsername('bob')).toBe(hashUsername('bob'));
  });

  it('returns different values for different inputs', () => {
    expect(hashUsername('alice')).not.toBe(hashUsername('bob'));
  });

  it('handles empty string', () => {
    expect(hashUsername('')).toBe(0);
  });

  it('handles single character', () => {
    expect(hashUsername('a')).toBe('a'.charCodeAt(0));
  });
});

describe('getAvatarColor', () => {
  it('returns a color from AVATAR_COLORS', () => {
    expect(AVATAR_COLORS).toContain(getAvatarColor('alice'));
    expect(AVATAR_COLORS).toContain(getAvatarColor('bob'));
    expect(AVATAR_COLORS).toContain(getAvatarColor(''));
  });

  it('returns the same color for the same username', () => {
    expect(getAvatarColor('alice')).toBe(getAvatarColor('alice'));
  });

  it('returns a valid hex color string', () => {
    expect(getAvatarColor('test')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('color palettes', () => {
  it('AVATAR_COLORS has 16 entries', () => {
    expect(AVATAR_COLORS).toHaveLength(16);
  });

  it('NOTE_COLORS has 12 entries starting with white', () => {
    expect(NOTE_COLORS).toHaveLength(12);
    expect(NOTE_COLORS[0]).toBe('#ffffff');
  });

  it('all AVATAR_COLORS are valid hex colors', () => {
    for (const color of AVATAR_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('all NOTE_COLORS are valid hex colors', () => {
    for (const color of NOTE_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

});
