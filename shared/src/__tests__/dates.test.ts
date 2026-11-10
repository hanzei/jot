import { describe, expect, it } from 'vitest';
import { calendarDaysAgo, dateLocale, formatDateInLocale, patLastUsedMessage, type DateStyle } from '../dates';

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

describe('formatDateInLocale', () => {
  // Built in local time, so the expectations hold in whatever time zone the suite runs in.
  const evening = new Date(2026, 10, 10, 21, 34, 8).toISOString();

  it.each<[string, DateStyle, string]>([
    ['en-US', 'date', 'Nov 10, 2026'],
    ['en-US', 'dateTime', 'Nov 10, 2026, 9:34 PM'],
    ['en-US', 'time', '9:34:08 PM'],
    ['en-GB', 'date', '10 Nov 2026'],
    ['en-GB', 'dateTime', '10 Nov 2026, 21:34'],
    ['en-GB', 'time', '21:34:08'],
    ['de', 'date', '10. Nov. 2026'],
    ['de', 'dateTime', '10. Nov. 2026, 21:34'],
    ['de', 'time', '21:34:08'],
  ])('formats %s %s', (locale, style, expected) => {
    // ICU puts a narrow no-break space before AM/PM.
    expect(formatDateInLocale(evening, locale, style).replace(/\u202f/g, ' ')).toBe(expected);
  });

  it('shows a dash for a value that does not parse', () => {
    expect(formatDateInLocale('not a date', 'en-US', 'date')).toBe('—');
    expect(formatDateInLocale('', 'en-US', 'dateTime')).toBe('—');
  });
});

describe('dateLocale', () => {
  it('adds the device region to the app language', () => {
    expect(dateLocale('en', 'GB')).toBe('en-GB');
    expect(dateLocale('es', '419')).toBe('es-419');
    // The language still decides the words; the region only adjusts conventions.
    expect(dateLocale('de', 'US')).toBe('de-US');
  });

  it('is the language alone without a usable region', () => {
    expect(dateLocale('en', null)).toBe('en');
    expect(dateLocale('en', undefined)).toBe('en');
    expect(dateLocale('en', '')).toBe('en');
    expect(dateLocale('en', 'Latn')).toBe('en');
  });

  it('is undefined without a language', () => {
    expect(dateLocale(undefined, 'GB')).toBeUndefined();
  });
});

describe('patLastUsedMessage', () => {
  const now = new Date(2026, 10, 10, 9, 30);
  const format = (value: string, style: DateStyle) => formatDateInLocale(value, 'en-US', style);

  it('picks the key for how many days ago the token was used', () => {
    expect(patLastUsedMessage(null, format, now)).toEqual({ key: 'settings.patsNoRecordedUse', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 10, 8).toISOString(), format, now)).toEqual({ key: 'settings.patsLastUsedToday', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 9, 23).toISOString(), format, now)).toEqual({ key: 'settings.patsLastUsedYesterday', values: {} });
    expect(patLastUsedMessage(new Date(2026, 10, 5, 12).toISOString(), format, now)).toEqual({ key: 'settings.patsLastUsedDaysAgo', values: { days: 5 } });
  });

  it('formats the date with the given formatter once a month has passed', () => {
    expect(patLastUsedMessage(new Date(2025, 2, 4, 12).toISOString(), format, now))
      .toEqual({ key: 'settings.patsLastUsedOn', values: { date: 'Mar 4, 2025' } });
  });
});
