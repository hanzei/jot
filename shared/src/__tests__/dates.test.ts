import { describe, expect, it } from 'vitest';
import { calendarDaysAgo } from '../dates';

describe('calendarDaysAgo', () => {
  const now = new Date(2026, 10, 10, 9, 30);

  it('is 0 for any time earlier today', () => {
    expect(calendarDaysAgo(new Date(2026, 10, 10, 0, 1), now)).toBe(0);
    expect(calendarDaysAgo(now, now)).toBe(0);
  });

  it('counts calendar days, not 24-hour periods', () => {
    expect(calendarDaysAgo(new Date(2026, 10, 9, 23, 59), now)).toBe(1);
    expect(calendarDaysAgo(new Date(2026, 10, 7, 12, 0), now)).toBe(3);
  });

  it('crosses month and year boundaries', () => {
    expect(calendarDaysAgo(new Date(2025, 11, 31), new Date(2026, 0, 1))).toBe(1);
    expect(calendarDaysAgo(new Date(2026, 9, 31), now)).toBe(10);
  });

  it('is negative for a later day', () => {
    expect(calendarDaysAgo(new Date(2026, 10, 11, 0, 5), now)).toBe(-1);
  });
});
