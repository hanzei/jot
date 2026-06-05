import { test, expect } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';

/**
 * Regression coverage for the lost-update bug: editing the same list note from
 * two tabs must merge per item instead of one tab overwriting the other.
 */
test.describe('Concurrent list editing', () => {
  test('edits to different items from two tabs both survive', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();

    await dashboardPage.createListNote('Shared Tasks', ['Buy milk', 'Walk dog']);

    // Tab A: open the note and rename the first item.
    await dashboardPage.openNote('Shared Tasks');
    await dashboardPage.listItemInput(0).fill('Buy oat milk');

    // Tab B: a second tab (shares the session) opens the same note and renames
    // the second item — concurrently, before tab A has saved/closed.
    const pageB = await page.context().newPage();
    await pageB.goto('/');
    const dashboardB = new DashboardPage(pageB);
    await dashboardB.openNote('Shared Tasks');
    await dashboardB.listItemInput(1).fill('Walk the dog');

    // Closing each modal flushes its pending edits via the granular per-item
    // endpoints.
    await dashboardPage.closeNoteModal();
    await dashboardB.closeNoteModal();
    await pageB.close();

    // Reload tab A from the server and confirm both edits are present.
    await page.reload();
    await dashboardPage.openNote('Shared Tasks');
    await dashboardPage.expectListItemValue(0, 'Buy oat milk');
    await dashboardPage.expectListItemValue(1, 'Walk the dog');
  });
});
