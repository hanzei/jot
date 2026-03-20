import { getSettings } from './auth';

export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;

export const getLanguagePreference = (): LanguagePreference => {
  const settings = getSettings();
  if (!settings) return 'system';
  const lang = settings.language;
  if (lang === 'system' || (SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) {
    return lang as LanguagePreference;
  }
  return 'system';
};

export const resolveLanguage = (pref: LanguagePreference): SupportedLanguage => {
  if (pref !== 'system') {
    return pref;
  }
  const browserLang = navigator.language.split('-')[0].toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(browserLang)) {
    return browserLang as SupportedLanguage;
  }
  return 'en';
};
