import { test, expect } from '../fixtures';
import {
  TOAST_ACTION_AUTO_DISMISS_MS,
} from '../../src/utils/toastTiming';

test.describe('Toast timing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('keeps Undo toasts visible longer than standard toasts', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Toast Timing Note');

    await dashboardPage.archiveNote('Toast Timing Note');

    const standardToast = page.getByTestId('toast').last();
    await expect(standardToast).toBeVisible();
    await expect(standardToast.getByRole('button', { name: 'Undo' })).toHaveCount(0);

    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 6000 });

    await dashboardPage.switchToArchived();
    await dashboardPage.deleteNote('Toast Timing Note');

    const undoToast = page.getByTestId('toast').last();
    await expect(undoToast).toBeVisible();
    await expect(undoToast.getByRole('button', { name: 'Undo' })).toBeVisible();

    await page.waitForTimeout(TOAST_ACTION_AUTO_DISMISS_MS - 1000);
    await expect(undoToast).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 4000 });
  });
});
