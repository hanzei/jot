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

/** How Settings formats a personal access token's dates. */
export const PAT_DATE_FORMAT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

/**
 * The i18n key and interpolation values describing when a personal access
 * token was last used. Writes of last_used_at are throttled server-side, so the
 * last use is shown to the day, never to the minute.
 */
export function patLastUsedMessage(
  lastUsedAt: string | null,
  locale: string | undefined,
  now: Date = new Date(),
): { key: string; values: Record<string, string | number> } {
  if (!lastUsedAt) {
    return { key: 'settings.patsNoRecordedUse', values: {} };
  }
  const date = new Date(lastUsedAt);
  const days = calendarDaysAgo(date, now);
  if (days <= 0) {
    return { key: 'settings.patsLastUsedToday', values: {} };
  }
  if (days === 1) {
    return { key: 'settings.patsLastUsedYesterday', values: {} };
  }
  if (days < 30) {
    return { key: 'settings.patsLastUsedDaysAgo', values: { days } };
  }
  return { key: 'settings.patsLastUsedOn', values: { date: date.toLocaleDateString(locale, PAT_DATE_FORMAT) } };
}
