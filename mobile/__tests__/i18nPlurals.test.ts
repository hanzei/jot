import type { i18n as I18n } from 'i18next';
import { SUPPORTED_LANGUAGES } from '../src/i18n/language';

// The app runs on Hermes, whose Intl implements only these members; it has no
// PluralRules and no Locale. Without PluralRules, i18next falls back to
// `count === 1 ? 'one' : 'other'`, so Polish never reaches `_few`/`_many`. This suite
// strips Intl down to the Hermes surface before loading src/i18n (which the app
// imports at startup), proving that the polyfill it imports loads and resolves
// plurals there on its own. i18next builds its plural rules lazily on the first t(),
// so Intl stays stripped until every test has run.
const HERMES_INTL = new Set(['Collator', 'DateTimeFormat', 'NumberFormat', 'getCanonicalLocales']);
const nativeIntl = Object.getOwnPropertyDescriptors(Intl);

describe('mobile i18n plural forms on a Hermes-like Intl', () => {
  let i18n: I18n;

  beforeAll(async () => {
    for (const name of Reflect.ownKeys(Intl)) {
      if (typeof name === 'string' && !HERMES_INTL.has(name)) Reflect.deleteProperty(Intl, name);
    }
    expect(Object.keys(nativeIntl)).toContain('PluralRules');
    expect('PluralRules' in Intl).toBe(false);
    expect('Locale' in Intl).toBe(false);

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- require() loads src/i18n only after Intl is stripped
      i18n = (require('../src/i18n') as typeof import('../src/i18n')).default;
    });
  });

  afterAll(() => {
    for (const name of Reflect.ownKeys(Intl)) Reflect.deleteProperty(Intl, name);
    Object.defineProperties(Intl, nativeIntl);
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('installs the polyfill without needing Intl.Locale', () => {
    expect(Intl.PluralRules).toBeDefined();
    expect('Locale' in Intl).toBe(false);
  });

  it.each([
    [1, 'Zaimportowano 1 notatkę'],
    [3, 'Zaimportowano 3 notatki'],
    [5, 'Zaimportowano 5 notatek'],
    [12, 'Zaimportowano 12 notatek'],
    [22, 'Zaimportowano 22 notatki'],
  ])('uses the Polish form for a count of %i', async (count, expected) => {
    await i18n.changeLanguage('pl');
    expect(i18n.t('import.importedNotes', { count })).toBe(expected);
  });

  it.each(SUPPORTED_LANGUAGES)('resolves a plural in %s', async (language) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('import.importedNotes', { count: 2 })).toContain('2');
  });

  it('does not hard-code the count in a French `_one` form, which also covers 0', async () => {
    await i18n.changeLanguage('fr');
    expect(i18n.t('note.itemsPasted', { count: 0 })).toBe('0 élément collé');
  });

  it('loads plural rules for every supported language', () => {
    // A language added to SUPPORTED_LANGUAGES without its locale-data import in
    // src/i18n/index.ts would silently resolve with English plural rules.
    expect(Intl.PluralRules.supportedLocalesOf([...SUPPORTED_LANGUAGES])).toEqual([...SUPPORTED_LANGUAGES]);
  });
});
