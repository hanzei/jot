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

  // Polish uses `few` for 2-4 and 22-24 and `many` for 5-21. A plural key missing either
  // form falls back to English, which `task check-translations` now rejects.
  test.each([
    [1, 'Trwale usunąć 1 notatkę z kosza? Tej operacji nie można cofnąć.'],
    [3, 'Trwale usunąć wszystkie 3 notatki z kosza? Tej operacji nie można cofnąć.'],
    [5, 'Trwale usunąć wszystkie 5 notatek z kosza? Tej operacji nie można cofnąć.'],
    [22, 'Trwale usunąć wszystkie 22 notatki z kosza? Tej operacji nie można cofnąć.'],
  ])('uses the Polish plural form for a count of %i', async (count, expected) => {
    await i18n.changeLanguage('pl');
    expect(i18n.t('dashboard.emptyTrashConfirmMessage', { count })).toBe(expected);
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });
});
