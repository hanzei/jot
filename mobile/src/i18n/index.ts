// i18next picks a plural form (`_one`, `_few`, `_many`, ...) with Intl.PluralRules. Hermes
// may not provide it, and i18next then falls back to `count === 1 ? 'one' : 'other'`, which
// gives Polish the wrong word form for 2-4. The forced polyfill makes every device (and
// Jest) use the same CLDR rules. It must load before i18next first resolves a plural. A
// language without its locale-data import here falls back to English plural rules.
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
