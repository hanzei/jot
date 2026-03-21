import { test, expect } from '../fixtures';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(__dirname, '../../src/i18n/locales');
const enLocale = JSON.parse(
  readFileSync(path.join(localesDir, 'en.json'), 'utf8'),
) as { settings: { title: string; languageLabel: string }; pageTitle: { settings: string } };
const deLocale = JSON.parse(
  readFileSync(path.join(localesDir, 'de.json'), 'utf8'),
) as { settings: { title: string; languageLabel: string }; pageTitle: { settings: string } };

if (!enLocale.settings?.title || !enLocale.settings?.languageLabel || !enLocale.pageTitle?.settings) {
  throw new Error('Invalid en locale fixture for settings localization e2e test');
}
if (!deLocale.settings?.title || !deLocale.settings?.languageLabel || !deLocale.pageTitle?.settings) {
  throw new Error('Invalid de locale fixture for settings localization e2e test');
}

test.describe('Localization', () => {
  test('persists selected language and renders translated settings UI', async ({
    page,
    settingsPage,
    authenticatedUser,
  }) => {
    const loadSettingsResponse = page.waitForResponse((resp) =>
      resp.url().includes('/api/v1/me') && resp.request().method() === 'GET' && resp.ok(),
    );
    await settingsPage.goto();
    await loadSettingsResponse;
    await expect(page.getByRole('heading', { level: 1, name: enLocale.settings.title })).toBeVisible();

    // Language preference is saved by PATCHing the current user profile.
    const saveLanguageResponse = page.waitForResponse((resp) => {
      if (!resp.url().includes('/api/v1/users/me') || resp.request().method() !== 'PATCH') {
        return false;
      }
      return resp.ok();
    });
    await page.getByLabel(enLocale.settings.languageLabel).selectOption('de');
    await saveLanguageResponse;

    await expect(page.getByRole('heading', { level: 1, name: deLocale.settings.title })).toBeVisible();
    await expect(page).toHaveTitle(deLocale.pageTitle.settings);

    const reloadSettingsResponse = page.waitForResponse((resp) =>
      resp.url().includes('/api/v1/me') && resp.request().method() === 'GET' && resp.ok(),
    );
    await page.reload();
    await reloadSettingsResponse;

    await expect(page.getByRole('heading', { level: 1, name: deLocale.settings.title })).toBeVisible();
    await expect(page.getByLabel(deLocale.settings.languageLabel)).toHaveValue('de');
    void authenticatedUser;
  });
});
