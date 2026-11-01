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

  // The toggle endpoint returns the note's full item list as of its own write.
  // Checking rows off faster than responses come back meant the response to the
  // first tap still reported the later-tapped rows unchecked, and applying it
  // put them back in the active list.
  test('items checked off in quick succession stay checked as each response lands', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createListNote('Quick Checks', ['Eggs', 'Flour', 'Sugar']);
    await dashboardPage.openNote('Quick Checks');

    // Let each toggle reach the server — so its response body is a snapshot
    // taken right after its own write — but hold the response back until the
    // test releases it, as a slow connection would.
    const held: Array<() => void> = [];
    await page.route('**/api/v1/notes/*/items/*/toggle-completed', async route => {
      const response = await route.fetch();
      await new Promise<void>(resolve => { held.push(resolve); });
      await route.fulfill({ response });
    });
    const toggleLanded = () => page.waitForResponse(res => res.url().includes('/toggle-completed'));

    const activeCheckbox = page.locator('[data-testid="list-item-row"] input[type="checkbox"]:not(:checked)');
    for (let tapped = 1; tapped <= 3; tapped++) {
      // eslint-disable-next-line playwright/no-force-option -- one forced click checks exactly one item before it reflows into the completed section
      await activeCheckbox.first().click({ force: true });
      await expect(page.getByText(`Completed items (${tapped})`)).toBeVisible();
      // Wait for this write to reach the server before the next tap, so the
      // first response's snapshot predates the later writes.
      await expect.poll(() => held.length).toBe(tapped);
    }

    // Without the fix the follow-up note refetch heals the list a round trip
    // later, so a polling assertion alone would miss it: record the most rows
    // ever back in the unchecked state from here on instead.
    await page.evaluate(() => {
      const w = window as unknown as { maxUnchecked: number };
      w.maxUnchecked = 0;
      const measure = () => {
        const n = document.querySelectorAll('[data-testid="list-item-row"] input[type="checkbox"]:not(:checked)').length;
        w.maxUnchecked = Math.max(w.maxUnchecked, n);
      };
      new MutationObserver(measure).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    const maxUnchecked = () => page.evaluate(() => (window as unknown as { maxUnchecked: number }).maxUnchecked);

    // The first response lands, reporting Flour and Sugar unchecked.
    let landed = toggleLanded();
    held[0]!();
    await landed;
    await expect(page.getByText('Completed items (3)')).toBeVisible();
    await expect(activeCheckbox).toHaveCount(0);

    // The other two land out of order.
    landed = toggleLanded();
    held[2]!();
    await landed;
    landed = toggleLanded();
    held[1]!();
    await landed;
    await expect(page.getByText('Completed items (3)')).toBeVisible();
    await expect(activeCheckbox).toHaveCount(0);
    expect(await maxUnchecked()).toBe(0);

    // And the server agrees.
    await page.unroute('**/api/v1/notes/*/items/*/toggle-completed');
    await dashboardPage.closeNoteModal();
    await page.reload();
    await dashboardPage.openNote('Quick Checks');
    await expect(page.getByText('Completed items (3)')).toBeVisible();
  });
});
