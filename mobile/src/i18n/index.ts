// i18next picks plural forms with Intl.PluralRules, which Hermes lacks; without it every
// language gets `count === 1 ? 'one' : 'other'`. The forced polyfill gives every device
// (and Jest) the same CLDR rules, and must load before i18next. Each supported language
// needs its locale-data import, or it falls back to English plural rules.
import '@formatjs/intl-pluralrules/polyfill-force.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';
import '@formatjs/intl-pluralrules/locale-data/de.js';
import '@formatjs/intl-pluralrules/locale-data/es.js';
import '@formatjs/intl-pluralrules/locale-data/fr.js';
import '@formatjs/intl-pluralrules/locale-data/it.js';
import '@formatjs/intl-pluralrules/locale-data/nl.js';
import '@formatjs/intl-pluralrules/locale-data/pl.js';
import '@formatjs/intl-pluralrules/locale-data/pt.js';
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
