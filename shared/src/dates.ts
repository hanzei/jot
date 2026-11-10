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
