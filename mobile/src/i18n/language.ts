import { getLocales, type Locale } from 'expo-localization';

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;

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
  if (value === 'system' || value === 'en' || value === 'de') {
    return value;
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
