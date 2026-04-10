import { test, expect } from '../fixtures';

test.describe('Keyboard shortcuts help dialog', () => {
  test('focuses search with Cmd+F', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('body').click();
    await page.keyboard.press('Meta+F');

    await expect(page.locator('form[role="search"] input')).toBeFocused();
  });

  test('focuses search with Ctrl+F', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('body').click();
    await page.keyboard.press('Control+F');

    await expect(page.locator('form[role="search"] input')).toBeFocused();
  });

  test('opens a new note with n when no input is focused', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('n');

    // New notes open as text notes; text notes have a content textarea (no title input).
    const noteContentInput = page.locator('[role="dialog"][aria-modal="true"] textarea').first();
    await expect(noteContentInput).toBeVisible();
    // First Escape collapses the content area from edit to preview (two-step dismiss).
    await page.keyboard.press('Escape');
    // Second Escape closes the modal.
    await page.keyboard.press('Escape');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toHaveCount(0);
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
    await expect(shortcutsDialog.getByTestId('shortcut-key-notes-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-notes-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-my-tasks-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-my-tasks-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-archive-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-archive-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-bin-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-bin-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-escape')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-escape')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(shortcutsDialog).toBeHidden();
  });

  test('opens from profile menu keyboard shortcuts item', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.getByRole('button', { name: 'Profile menu' }).click();
    await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();

    const shortcutsDialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(shortcutsDialog).toBeVisible();
    await expect(shortcutsDialog.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('opens notes/list/archive/bin views with d/t/a/b', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/\?view=my-tasks$/);

    await page.locator('main').click();
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\/\?view=archive$/);

    await page.locator('main').click();
    await page.keyboard.press('b');
    await expect(page).toHaveURL(/\/\?view=bin$/);

    await page.locator('main').click();
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/\/$/);
  });
});
