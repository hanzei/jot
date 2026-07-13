import { test, expect } from '../fixtures';

/**
 * The note modal's footer keeps only the frequently-used actions as primary
 * icons (color, image, pin, archive) and tucks the rest behind a three-dot
 * overflow menu, mirroring the mobile note editor. These tests lock in that
 * structure and verify the overflow actions still work end-to-end.
 */
test.describe('Note modal overflow menu', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('keeps primary actions in the toolbar and moves the rest into the overflow menu', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Overflow Menu Note');
    await dashboardPage.openNote('Overflow Menu Note');

    const dialog = page.getByRole('dialog').last();

    // Primary actions stay visible directly on the toolbar.
    await expect(dialog.getByRole('button', { name: 'Add image' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Pin note' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Archive note' })).toBeVisible();

    // Overflow actions are hidden until the three-dot menu is opened.
    await expect(dialog.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(0);
    await expect(dialog.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
    await expect(dialog.getByRole('menuitem', { name: 'Convert to list' })).toHaveCount(0);

    await dashboardPage.openModalOverflowMenu();

    // Now the overflow actions are reachable as menu items.
    await expect(dialog.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
    await expect(dialog.getByRole('menuitem', { name: 'Convert to list' })).toBeVisible();
    await expect(dialog.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  });

  test('duplicates a note from the overflow menu', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Duplicate Me');
    await dashboardPage.openNote('Duplicate Me');

    await dashboardPage.duplicateCurrentNoteFromModal();

    // Duplicating closes the modal and adds a second card with the same title.
    await expect(
      page.locator('[data-testid="note-card"]').filter({ hasText: 'Duplicate Me' }),
    ).toHaveCount(2);
  });

  test('deletes a note from the overflow menu', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Delete From Menu');
    await dashboardPage.openNote('Delete From Menu');

    const dialog = await dashboardPage.openModalOverflowMenu();
    await dialog.getByRole('menuitem', { name: 'Delete' }).click();

    const confirmDialog = page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();

    await dashboardPage.expectNoteNotVisible('Delete From Menu');
  });

  test('toggles the overflow menu open and closed via its trigger', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Toggle Overflow Note');
    await dashboardPage.openNote('Toggle Overflow Note');

    const dialog = page.getByRole('dialog').last();
    const menuButton = dialog.getByRole('button', { name: 'Note options' });
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();

    // Clicking the trigger again closes the menu; the modal itself stays open.
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
