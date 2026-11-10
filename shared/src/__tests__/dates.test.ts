import { describe, expect, it } from 'vitest';
import { calendarDaysAgo, patLastUsedMessage } from '../dates';

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

describe('patLastUsedMessage', () => {
  const now = new Date(2026, 10, 10, 9, 30);

  it('picks the key for how many days ago the token was used', () => {
    expect(patLastUsedMessage(null, 'en-US', now)).toEqual({ key: 'settings.patsNoRecordedUse', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 10, 8).toISOString(), 'en-US', now)).toEqual({ key: 'settings.patsLastUsedToday', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 9, 23).toISOString(), 'en-US', now)).toEqual({ key: 'settings.patsLastUsedYesterday', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 5, 12).toISOString(), 'en-US', now)).toEqual({ key: 'settings.patsLastUsedDaysAgo', values: { days: 5 } });
  });

  it('formats the date in the given locale once a month has passed', () => {
    expect(patLastUsedMessage(new Date(2025, 2, 4, 12).toISOString(), 'en-US', now))
      .toEqual({ key: 'settings.patsLastUsedOn', values: { date: 'Mar 4, 2025' } });
  });
});
