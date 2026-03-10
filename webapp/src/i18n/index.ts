import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import { getLanguagePreference, resolveLanguage, SupportedLanguage } from '@/utils/language';

let lng: SupportedLanguage;
try {
  const pref = getLanguagePreference();
  lng = resolveLanguage(pref);
} catch {
  lng = 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
    },
    lng,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
