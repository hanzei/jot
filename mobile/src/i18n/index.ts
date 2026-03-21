import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import pt from './locales/pt.json';
import it from './locales/it.json';
import nl from './locales/nl.json';
import pl from './locales/pl.json';
import { SUPPORTED_LANGUAGES, type SupportedLanguage, resolveLanguage } from './language';

const localeBundles: Record<SupportedLanguage, typeof en> = {
  en,
  de,
  es,
  fr,
  pt,
  it,
  nl,
  pl,
};

const resources = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((language) => [language, { translation: localeBundles[language] }]),
) as Record<SupportedLanguage, { translation: typeof en }>;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: resolveLanguage('system'),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
