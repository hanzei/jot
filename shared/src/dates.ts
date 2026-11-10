const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * How many local calendar days before `now` the day of `date` is: 0 for any
 * time today, 1 for yesterday. Negative when `date` falls on a later day,
 * e.g. when the server clock is ahead of the device.
 *
 * Rounded because a day spanning a daylight saving change is 23 or 25 hours.
 */
export function calendarDaysAgo(date: Date, now: Date = new Date()): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / MS_PER_DAY);
}

/**
 * How much of a timestamp to show. Pick by the precision the reader needs:
 *
 * - `date`: only the day matters, and a time would be noise or claim more
 *   precision than the data has (created on, expires on, last used on).
 * - `dateTime`: the moment matters and can lie days back (last edited,
 *   signed in, server started, build time).
 * - `time`: the timestamp is from the current session, so the day is
 *   implied, and seconds tell events apart (live diagnostics).
 *
 * The clock (12h or 24h), field order, and month names come from the locale,
 * never from the style.
 */
export type DateStyle = 'date' | 'dateTime' | 'time';

// `dateTime` extends `date` rather than using `dateStyle: 'medium'`, which
// differs from it outside English ("10.11.2026" vs "10. Nov. 2026" in German).
const DATE_STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  time: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
};

/**
 * Formats a timestamp for display, or "—" when it does not parse. Clients
 * call their own `formatDate(value, style)`, which supplies the app locale;
 * call this directly only to format in an explicit locale.
 */
export function formatDateInLocale(value: string, locale: string | undefined, style: DateStyle): string {
  const date = new Date(value);
  // eslint-disable-next-line no-restricted-syntax -- the one place dates are formatted; everything else calls this
  return isNaN(date.getTime()) ? '—' : date.toLocaleString(locale, DATE_STYLE_OPTIONS[style]);
}

// A region subtag: two letters (GB) or three digits (419).
const REGION = /^(?:[A-Za-z]{2}|\d{3})$/;

/**
 * The locale to format dates in: the app language from Settings, plus the
 * device's region when it has one. The language alone gives every English
 * user US conventions (12-hour clock, month first); with the region, English
 * in the UK formats as en-GB. A pairing `Intl` has no data for falls back to
 * the language, so "de-US" still formats as German.
 */
export function dateLocale(language: string | undefined, region: string | null | undefined): string | undefined {
  if (!language) return undefined;
  return region && REGION.test(region) ? `${language}-${region}` : language;
}

/**
 * The i18n key and interpolation values describing when a personal access
 * token was last used. Writes of last_used_at are throttled server-side, so the
 * last use is shown to the day, never to the minute.
 */
export function patLastUsedMessage(
  lastUsedAt: string | null,
  formatDate: (value: string, style: DateStyle) => string,
  now: Date = new Date(),
): { key: string; values: Record<string, string | number> } {
  if (!lastUsedAt) {
    return { key: 'settings.patsNoRecordedUse', values: {} };
  }
  const days = calendarDaysAgo(new Date(lastUsedAt), now);
  if (days <= 0) {
    return { key: 'settings.patsLastUsedToday', values: {} };
  }
  if (days === 1) {
    return { key: 'settings.patsLastUsedYesterday', values: {} };
  }
  if (days < 30) {
    return { key: 'settings.patsLastUsedDaysAgo', values: { days } };
  }
  return { key: 'settings.patsLastUsedOn', values: { date: formatDate(lastUsedAt, 'date') } };
}
