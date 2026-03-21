import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { useAuth } from '../src/store/AuthContext';
import MobileI18nProvider from '../src/i18n/MobileI18nProvider';
import i18n from '../src/i18n';
import {
  SUPPORTED_LANGUAGES,
  getLanguagePreference,
  resolveLanguage,
  type SupportedLanguage,
} from '../src/i18n/language';
import de from '../src/i18n/locales/de.json';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import fr from '../src/i18n/locales/fr.json';
import it from '../src/i18n/locales/it.json';
import nl from '../src/i18n/locales/nl.json';
import pl from '../src/i18n/locales/pl.json';
import pt from '../src/i18n/locales/pt.json';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockGetLocales = getLocales as jest.MockedFunction<typeof getLocales>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const makeLocale = (languageCode: string, languageTag: string) =>
  ({ languageCode, languageTag } as (typeof getLocales extends () => infer T ? T : never)[number]);
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

function TranslationProbe() {
  const { t } = useTranslation();
  return <Text testID="settings-title">{t('settings.title')}</Text>;
}

describe('mobile i18n', () => {
  beforeEach(async () => {
    mockGetLocales.mockReturnValue([makeLocale('en', 'en-US')]);
    mockUseAuth.mockReturnValue({ settings: { language: 'system' } } as unknown as ReturnType<typeof useAuth>);
    await i18n.changeLanguage('en');
  });

  it('resolves system language from the device locale', () => {
    expect(resolveLanguage('system', [makeLocale('de', 'de-DE')])).toBe('de');
  });

  it.each([
    ['en', 'en-US'],
    ['es', 'es-ES'],
    ['fr', 'fr-FR'],
    ['pt', 'pt-PT'],
    ['it', 'it-IT'],
    ['nl', 'nl-NL'],
    ['pl', 'pl-PL'],
  ] as const)('resolves supported locale %s from the device locale', (languageCode, languageTag) => {
    expect(resolveLanguage('system', [makeLocale(languageCode, languageTag)])).toBe(languageCode);
  });

  it('falls back to English when the device locale is unsupported', () => {
    expect(resolveLanguage('system', [makeLocale('sv', 'sv-SE')])).toBe('en');
  });

  it('uses system for invalid saved language preference', () => {
    expect(getLanguagePreference('invalid-language')).toBe('system');
  });

  it.each(SUPPORTED_LANGUAGES)('uses the %s translation bundle', async (language) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('settings.title')).toBe(bundles[language].settings.title);
  });

  it('switches the active language when auth settings change', async () => {
    mockUseAuth.mockReturnValue({ settings: { language: 'en' } } as unknown as ReturnType<typeof useAuth>);

    const { getByTestId, rerender } = render(
      <MobileI18nProvider>
        <TranslationProbe />
      </MobileI18nProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('settings-title').props.children).toBe('Settings');
    });

    mockUseAuth.mockReturnValue({ settings: { language: 'de' } } as unknown as ReturnType<typeof useAuth>);
    rerender(
      <MobileI18nProvider>
        <TranslationProbe />
      </MobileI18nProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('settings-title').props.children).toBe('Einstellungen');
    });
    expect(i18n.language).toBe('de');
  });
});
