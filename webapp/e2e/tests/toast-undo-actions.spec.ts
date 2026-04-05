import { test, expect } from '../fixtures';

test.use({ video: 'on' });

test.describe('Undo actions on success toasts', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('supports undo for pin/unpin and archive/unarchive', async ({ toastPage, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Undo Toggle Note');

    await dashboardPage.pinNote('Undo Toggle Note');
    await toastPage.clickUndoOnLatestToast();
    await expect(dashboardPage.noteCard('Undo Toggle Note').locator('[data-testid="pin-icon"]')).toHaveCount(0);

    await dashboardPage.archiveNote('Undo Toggle Note');
    await toastPage.clickUndoOnLatestToast();
    await dashboardPage.expectNoteVisible('Undo Toggle Note');

    await dashboardPage.archiveNote('Undo Toggle Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Undo Toggle Note');

    const archivedCard = dashboardPage.noteCard('Undo Toggle Note')
    await expect(archivedCard.locator('[data-testid="pin-icon"]')).toHaveCount(0);
    await dashboardPage.unarchiveNote('Undo Toggle Note');
    await toastPage.clickUndoOnLatestToast();
    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Undo Toggle Note');
  });

  test('supports undo for restore and duplicate', async ({ page, toastPage, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Undo Duplicate Note');

    const noteCards = page.locator('[data-testid="note-card"]');
    const countBeforeDuplicate = await noteCards.count();
    await dashboardPage.duplicateNoteFromMenu('Undo Duplicate Note');
    await expect(noteCards).toHaveCount(countBeforeDuplicate + 1);
    await toastPage.clickUndoOnLatestToast();
    await expect(noteCards).toHaveCount(countBeforeDuplicate);

    await dashboardPage.createNote('Undo Restore Note');
    await dashboardPage.archiveNote('Undo Restore Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.deleteNote('Undo Restore Note');
    const deleteToast = page.getByTestId('toast').last();
    await expect(deleteToast).toBeVisible();
    await deleteToast.getByRole('button', { name: /close/i }).click();
    await toastPage.waitForNoToasts();

    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Undo Restore Note');
    await dashboardPage.restoreNoteFromBin('Undo Restore Note');
    await toastPage.clickUndoOnLatestToast();
    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Undo Restore Note');
  });
});
