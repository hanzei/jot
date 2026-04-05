import { test, expect } from '../fixtures';

test.use({ video: 'on' });

// These assertions enforce user-facing behavior: Undo/action toasts are visible
// for 7s, while standard toasts auto-dismiss in 4s.
const UNDO_TOAST_VISIBLE_MS = 7000;
const STANDARD_TOAST_VISIBLE_MS = 4000;

test.describe('Toast timing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('keeps Undo toasts visible longer than standard toasts', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Toast Timing Note');

    await dashboardPage.archiveNote('Toast Timing Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.deleteNote('Toast Timing Note');

    const undoToast = page.getByTestId('toast').last();
    await expect(undoToast).toBeVisible();
    await expect(undoToast.getByRole('button', { name: 'Undo' })).toBeVisible();

    await page.waitForTimeout(UNDO_TOAST_VISIBLE_MS - 1000);
    await expect(undoToast).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: STANDARD_TOAST_VISIBLE_MS });

    await dashboardPage.switchToBin();
    await dashboardPage.permanentlyDeleteNoteFromBin('Toast Timing Note');

    const standardToast = page.getByTestId('toast').last();
    await expect(standardToast).toBeVisible();
    await expect(standardToast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await page.waitForTimeout(STANDARD_TOAST_VISIBLE_MS);
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 1200 });
  });
});
