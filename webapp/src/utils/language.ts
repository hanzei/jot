export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;

const LANGUAGE_KEY = 'language';

export const getLanguagePreference = (): LanguagePreference => {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored === 'system' || (SUPPORTED_LANGUAGES as readonly string[]).includes(stored ?? '')) {
      return stored as LanguagePreference;
    }
  } catch {
    // localStorage unavailable (e.g. SecurityError in private browsing)
  }
  return 'system';
};

export const setLanguagePreference = (pref: LanguagePreference): void => {
  try {
    localStorage.setItem(LANGUAGE_KEY, pref);
  } catch {
    // localStorage unavailable; preference will not persist
  }
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
