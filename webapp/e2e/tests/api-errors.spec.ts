import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import type { SettingsPage } from '../pages/SettingsPage';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The server's error messages are English; these tests prove the webapp shows
// its own translation of the error code instead, in a non-English locale.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type Locale = {
  apiErrors: { labelNameTaken: string; invalidImportFile: string };
  labels: { menuOptions: string; rename: string; renamePlaceholder: string };
  settings: { title: string; languageLabel: string; importButton: string };
  import: { importButton: string };
};
const readLocale = (lang: string) => JSON.parse(
  readFileSync(path.resolve(__dirname, `../../src/i18n/locales/${lang}.json`), 'utf8'),
) as Locale;
const enLocale = readLocale('en');
const deLocale = readLocale('de');

// Switches the UI to German the way a user does, which both saves the
// preference and applies it to the running app.
async function useGerman(page: Page, settingsPage: SettingsPage) {
  // Select only after Settings has loaded the saved preference, or the load
  // overwrites the selection.
  const loaded = page.waitForResponse((resp) =>
    resp.url().includes('/api/v1/me') && resp.request().method() === 'GET' && resp.ok(),
  );
  await settingsPage.goto();
  await loaded;
  const saved = page.waitForResponse((resp) =>
    resp.url().includes('/api/v1/users/me') && resp.request().method() === 'PATCH' && resp.ok(),
  );
  await page.getByLabel(enLocale.settings.languageLabel).selectOption('de');
  await saved;
  await expect(page.getByRole('heading', { level: 1, name: deLocale.settings.title })).toBeVisible();
}

test.describe('Translated API errors', () => {
  test('a duplicate label name shows the German message', async ({ page, dashboardPage, settingsPage, authenticatedUser, isMobile }) => {
    test.skip(isMobile, 'Sidebar label management is covered on desktop only.');
    void authenticatedUser;
    // Set up in English, where the page object's helpers work.
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Duplicate Label Note', 'content', ['alpha', 'beta']);

    await useGerman(page, settingsPage);
    await dashboardPage.goto();
    const sidebar = page.getByRole('complementary');
    await sidebar.getByRole('button', { name: deLocale.labels.menuOptions.replace('{{name}}', 'beta') }).click();
    await page.getByRole('menuitem', { name: deLocale.labels.rename }).click();
    const input = page.getByPlaceholder(deLocale.labels.renamePlaceholder);
    await input.fill('alpha');
    await input.press('Enter');

    // The server answers 400 label_name_taken with the English "label name already exists".
    await expect(page.getByTestId('toast').filter({ hasText: deLocale.apiErrors.labelNameTaken })).toBeVisible();
  });

  test('an unreadable import file shows the German message', async ({ page, settingsPage, authenticatedUser }) => {
    void authenticatedUser;
    await useGerman(page, settingsPage);

    await page.getByRole('button', { name: deLocale.settings.importButton }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'keep.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not JSON'),
    });
    await dialog.getByRole('button', { name: deLocale.import.importButton, exact: true }).click();

    // The server answers 400 invalid_import_file with the English "invalid JSON file".
    await expect(dialog.getByText(deLocale.apiErrors.invalidImportFile)).toBeVisible();
    await expect(dialog.getByText('invalid JSON file')).toHaveCount(0);
  });
});
