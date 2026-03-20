import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import { resolveLanguage } from './language';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
    },
    lng: resolveLanguage('system'),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
