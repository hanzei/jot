import { afterEach, describe, expect, test } from 'vitest';
import i18n from './index';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import nl from './locales/nl.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/utils/language';

const bundles: Record<SupportedLanguage, typeof en> = {
  en,
  de,
  es,
  fr,
  pt,
  it,
  nl,
  pl,
};

describe('i18n locale resources', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    test(`uses the ${language} translation bundle`, async () => {
      await i18n.changeLanguage(language);
      expect(i18n.t('settings.title')).toBe(bundles[language].settings.title);
    });
  }

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });
});
