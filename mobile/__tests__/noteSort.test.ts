import i18n from '../src/i18n';
import { getNoteSortLabel } from '../src/utils/noteSort';

describe('mobile noteSort', () => {
  it('returns translated labels for sort modes', async () => {
    await i18n.changeLanguage('en');
    expect(getNoteSortLabel('manual', i18n.t)).toBe('Manual');
    expect(getNoteSortLabel('updated_at', i18n.t)).toBe('Last modified');
    expect(getNoteSortLabel('created_at', i18n.t)).toBe('Date created');
  });

  it('follows the active language', async () => {
    await i18n.changeLanguage('de');
    try {
      expect(getNoteSortLabel('manual', i18n.t)).toBe('Manuell');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
