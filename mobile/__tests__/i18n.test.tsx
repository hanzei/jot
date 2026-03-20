import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { useAuth } from '../src/store/AuthContext';
import MobileI18nProvider from '../src/i18n/MobileI18nProvider';
import i18n from '../src/i18n';
import { getLanguagePreference, resolveLanguage } from '../src/i18n/language';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockGetLocales = getLocales as jest.MockedFunction<typeof getLocales>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const makeLocale = (languageCode: string, languageTag: string) =>
  ({ languageCode, languageTag } as (typeof getLocales extends () => infer T ? T : never)[number]);

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

  it('resolves additional supported locales from the device locale', () => {
    expect(resolveLanguage('system', [makeLocale('fr', 'fr-FR')])).toBe('fr');
  });

  it('falls back to English when the device locale is unsupported', () => {
    expect(resolveLanguage('system', [makeLocale('sv', 'sv-SE')])).toBe('en');
  });

  it('uses system for invalid saved language preference', () => {
    expect(getLanguagePreference('invalid-language')).toBe('system');
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
