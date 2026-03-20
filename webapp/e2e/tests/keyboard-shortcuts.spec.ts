import { test, expect } from '../fixtures';

test.describe('Keyboard shortcuts help dialog', () => {
  test('focuses search with Shift+F', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('body').click();
    await page.keyboard.press('Shift+F');

    await expect(page.locator('form[role="search"] input')).toBeFocused();
  });

  test('opens a new note with n when no input is focused', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('n');

    const noteTitleInput = page.getByPlaceholder('Note title...');
    await expect(noteTitleInput).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(noteTitleInput).toHaveCount(0);
  });

  test('opens with ? and closes with Escape', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('Shift+/');

    const shortcutsDialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(shortcutsDialog).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-focus-search')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-focus-search')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-new-note')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-new-note')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-escape')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-escape')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(shortcutsDialog).toBeHidden();
  });
});
