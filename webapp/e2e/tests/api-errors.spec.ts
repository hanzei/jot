import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The server's error messages are English; these tests prove the webapp shows
// its own translation of the error code instead, in a non-English locale.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deLocale = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/i18n/locales/de.json'), 'utf8'),
) as {
  apiErrors: { labelNameTaken: string; invalidImportFile: string };
  settings: { importButton: string };
  import: { importButton: string };
};

async function useGerman(page: Page) {
  const response = await page.request.patch('/api/v1/users/me', { data: { language: 'de' } });
  expect(response.ok()).toBe(true);
}

test.describe('Translated API errors', () => {
  test('a duplicate label name shows the German message', async ({ page, dashboardPage, authenticatedUser, isMobile }) => {
    test.skip(isMobile, 'Sidebar label management is covered on desktop only.');
    void authenticatedUser;
    await useGerman(page);
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Doppeltes Label', 'Inhalt', ['alpha', 'beta']);

    await dashboardPage.submitSidebarLabelRename('beta', 'alpha');

    await expect(page.getByTestId('toast').filter({ hasText: deLocale.apiErrors.labelNameTaken })).toBeVisible();
  });

  test('an unreadable import file shows the German message', async ({ page, settingsPage, authenticatedUser }) => {
    void authenticatedUser;
    await useGerman(page);
    await settingsPage.goto();

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
