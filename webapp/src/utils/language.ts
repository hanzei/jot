import { getSettings } from './auth';
import { SUPPORTED_LANGUAGES, type LanguagePreference, type SupportedLanguage } from '@jot/shared';

export { SUPPORTED_LANGUAGES };
export type { SupportedLanguage, LanguagePreference };

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
