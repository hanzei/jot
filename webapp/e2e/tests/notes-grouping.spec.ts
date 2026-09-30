import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * End-to-end coverage for grouped to-do items (issue #438): indenting items into
 * a group, the parent→child completion cascade, unchecking a child back into its
 * group, and promoting orphaned children when a parent is deleted.
 */
test.describe('Grouped to-do items', () => {
  const rowCheckbox = (page: Page, index: number) =>
    page.locator('[data-testid="list-item-row"] input[type="checkbox"]').nth(index);

  test('checking a parent cascades completion to its indented children', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();

    await dashboardPage.createListNote('Groceries', ['Produce', 'Apples', 'Bananas']);
    await dashboardPage.openNote('Groceries');

    // Indent the two children under "Produce".
    await dashboardPage.listItemInput(1).focus();
    await page.keyboard.press('Tab');
    await dashboardPage.listItemInput(2).focus();
    await page.keyboard.press('Tab');

    // Checking the parent cascades to both children in one go.
    await rowCheckbox(page, 0).check();

    await expect(page.getByText('Completed items (3)')).toBeVisible();
  });

  test('unchecking a child returns it to its group', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Trip', ['Packing', 'Socks']);
    await dashboardPage.openNote('Trip');

    // Nest "Socks" under "Packing", then check only the child.
    await dashboardPage.listItemInput(1).focus();
    await page.keyboard.press('Tab');
    await rowCheckbox(page, 1).check();

    // The completed child shows under a non-interactive ghost copy of its parent.
    await expect(page.getByLabel('Group: Packing')).toBeVisible();

    // Uncheck the completed "Socks" → it rejoins the active group and the ghost
    // disappears. force: the completed-section row can briefly reflow after the
    // check (saved indicator / reconcile), tripping the strict stability wait.
    await page.locator('[data-testid="list-item-row"]')
      .filter({ hasText: 'Socks' })
      .last()
      .locator('input[type="checkbox"]')
      // eslint-disable-next-line playwright/no-force-option -- force-uncheck avoids the strict stability wait tripping on the save/reconcile reflow
      .uncheck({ force: true });

    await expect(page.getByLabel('Group: Packing')).toHaveCount(0);
    await dashboardPage.expectListItemValue(1, 'Socks');
  });

  test('a child nested under a later item shows under it on the card', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createListNote('Einkaufsliste', ['Kaffee', 'Bandnudeln', 'Trockenwaren']);

    // page.request shares the logged-in session.
    const notesResp = await page.request.get('/api/v1/notes');
    expect(notesResp.ok()).toBeTruthy();
    const note = ((await notesResp.json()).notes as Array<{ id: string; title: string; items: Array<{ id: string; text: string }> }>)
      .find((candidate) => candidate.title === 'Einkaufsliste');
    expect(note, 'note must exist').toBeDefined();
    const itemId = (text: string) => note!.items.find((item) => item.text === text)!.id;

    // Nest Bandnudeln under the later Trockenwaren with only the re-parent
    // request, as a drag whose follow-up reorder never reached the server.
    // Before the server kept groups together, the card then listed Bandnudeln
    // above its parent.
    const patchResp = await page.request.patch(`/api/v1/notes/${note!.id}/items/${itemId('Bandnudeln')}`, {
      data: { parent_id: itemId('Trockenwaren') },
    });
    expect(patchResp.ok()).toBeTruthy();

    await dashboardPage.goto();
    await expect(dashboardPage.noteCard('Einkaufsliste')).toHaveText(/Kaffee.*Trockenwaren.*Bandnudeln/s);
  });

  test('deleting a parent promotes its children to top-level', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Chores', ['Kitchen', 'Dishes']);
    await dashboardPage.openNote('Chores');

    // Nest "Dishes" under "Kitchen" so it renders indented.
    await dashboardPage.listItemInput(1).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="list-item-row"]').nth(1))
      .toHaveCSS('margin-left', '24px');

    // Delete the parent "Kitchen" via its trash button.
    const parentRow = page.locator('[data-testid="list-item-row"]').nth(0);
    await parentRow.hover();
    await parentRow.getByRole('button').last().click();

    // "Dishes" survives and is promoted to top-level (no indent).
    await dashboardPage.expectListItemValue(0, 'Dishes');
    await expect(page.locator('[data-testid="list-item-row"]').nth(0))
      .toHaveCSS('margin-left', '0px');
  });
});
