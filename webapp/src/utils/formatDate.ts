import { dateLocale, formatDateInLocale, type DateStyle } from '@jot/shared';
import i18n from '@/i18n';

/**
 * Formats a timestamp in the app language, with the browser's regional
 * conventions (12h or 24h clock, field order). See `DateStyle` for which style
 * to use. Every date the webapp shows goes through here; ESLint rejects
 * `toLocale*String` and `Intl.DateTimeFormat` elsewhere.
 */
export function formatDate(value: string | Date, style: DateStyle): string {
  const region = new Intl.Locale(navigator.language).region;
  return formatDateInLocale(value, dateLocale(i18n.resolvedLanguage, region), style);
}
