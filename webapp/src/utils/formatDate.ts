import { formatDateInLocale, type DateStyle } from '@jot/shared';
import i18n from '@/i18n';

/**
 * Formats a timestamp in the app language. See `DateStyle` for which style to
 * use. Every date the webapp shows goes through here; ESLint rejects
 * `toLocale*String` and `Intl.DateTimeFormat` elsewhere.
 */
export function formatDate(value: string | Date, style: DateStyle): string {
  return formatDateInLocale(value, i18n.resolvedLanguage, style);
}
