import { getLocales, type Locale } from 'expo-localization';
import { SUPPORTED_LANGUAGES, type LanguagePreference, type SupportedLanguage } from '@jot/shared';

export { SUPPORTED_LANGUAGES };
export type { SupportedLanguage, LanguagePreference };

function getDeviceLanguage(locales: Locale[]): string | null {
  const primary = locales[0];
  if (!primary) {
    return null;
  }

  const fromCode = primary.languageCode?.toLowerCase();
  if (fromCode) {
    return fromCode;
  }

  const fromTag = primary.languageTag?.split('-')[0]?.toLowerCase();
  return fromTag || null;
}

export function getLanguagePreference(value?: string | null): LanguagePreference {
  if (value === 'system' || (SUPPORTED_LANGUAGES as readonly string[]).includes(value ?? '')) {
    return value as LanguagePreference;
  }

  return 'system';
}

export function resolveLanguage(
  preference: LanguagePreference,
  locales: Locale[] = getLocales(),
): SupportedLanguage {
  if (preference !== 'system') {
    return preference;
  }

  const deviceLanguage = getDeviceLanguage(locales);
  if (deviceLanguage && (SUPPORTED_LANGUAGES as readonly string[]).includes(deviceLanguage)) {
    return deviceLanguage as SupportedLanguage;
  }

  return 'en';
}
