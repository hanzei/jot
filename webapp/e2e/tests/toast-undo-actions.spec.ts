import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

test.use({ video: 'on' });

async function waitForNoToasts(page: Page) {
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 8000 });
}

async function clickUndoOnLatestToast(page: Page) {
  const toast = page.getByTestId('toast').last();
  await expect(toast).toBeVisible();
  const undoButton = toast.getByRole('button', { name: 'Undo' });
  await expect(undoButton).toBeVisible();
  await undoButton.click();
  await waitForNoToasts(page);
}

test.describe('Undo actions on success toasts', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('supports undo for pin/unpin and archive/unarchive', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Undo Toggle Note');

    await dashboardPage.pinNote('Undo Toggle Note');
    await clickUndoOnLatestToast(page);
    await expect(dashboardPage.noteCard('Undo Toggle Note').locator('[data-testid="pin-icon"]')).toHaveCount(0);

    await dashboardPage.archiveNote('Undo Toggle Note');
    await clickUndoOnLatestToast(page);
    await dashboardPage.expectNoteVisible('Undo Toggle Note');

    await dashboardPage.archiveNote('Undo Toggle Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Undo Toggle Note');

    const archivedCard = dashboardPage.noteCard('Undo Toggle Note')
    await expect(archivedCard.locator('[data-testid="pin-icon"]')).toHaveCount(0);
    await dashboardPage.unarchiveNote('Undo Toggle Note');
    await clickUndoOnLatestToast(page);
    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Undo Toggle Note');
  });

  test('supports undo for restore and duplicate', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Undo Duplicate Note');

    const noteCards = page.locator('[data-testid="note-card"]');
    const countBeforeDuplicate = await noteCards.count();
    await dashboardPage.duplicateNoteFromMenu('Undo Duplicate Note');
    await expect(noteCards).toHaveCount(countBeforeDuplicate + 1);
    await clickUndoOnLatestToast(page);
    await expect(noteCards).toHaveCount(countBeforeDuplicate);

    await dashboardPage.createNote('Undo Restore Note');
    await dashboardPage.archiveNote('Undo Restore Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.deleteNote('Undo Restore Note');
    const deleteToast = page.getByTestId('toast').last();
    await expect(deleteToast).toBeVisible();
    await deleteToast.getByRole('button', { name: /close/i }).click();
    await waitForNoToasts(page);

    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Undo Restore Note');
    await dashboardPage.restoreNoteFromBin('Undo Restore Note');
    await clickUndoOnLatestToast(page);
    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Undo Restore Note');
  });
});
