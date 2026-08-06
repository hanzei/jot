import { test, expect } from '../fixtures';

/**
 * End-to-end coverage for the list bulk actions (uncheck all / delete checked):
 * the two overflow-menu options only appear when the list has checked items,
 * "Uncheck all items" returns them to the active list, and "Delete checked
 * items" hides them behind an in-modal undo bar before the deferred bulk delete
 * lands.
 */
test.describe('Checked-item bulk actions', () => {
  const rowCheckbox = (page: import('@playwright/test').Page, index: number) =>
    page.locator('[data-testid="list-item-row"] input[type="checkbox"]').nth(index);

  // Checks the first active item and waits for the completed section to appear.
  // A single forced click checks exactly one item: a plain .check() would
  // re-resolve nth(0) as the checked item reflows into the completed section and
  // end up clicking (and completing) every item in turn.
  const checkFirstItem = async (page: import('@playwright/test').Page) => {
    // eslint-disable-next-line playwright/no-force-option
    await rowCheckbox(page, 0).click({ force: true });
    await expect(page.getByText(/Completed items/)).toBeVisible();
  };

  test('bulk options appear only when the list has checked items', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Shopping', ['Milk', 'Bread']);
    await dashboardPage.openNote('Shopping');

    // Nothing checked yet → neither option is present in the menu.
    await dashboardPage.openModalOverflowMenu();
    await expect(page.getByTestId('note-uncheck-all')).toHaveCount(0);
    await expect(page.getByTestId('note-delete-checked')).toHaveCount(0);
    // Close the menu (not the modal) before interacting with the list.
    const menuButton = page.getByRole('dialog').last().getByRole('button', { name: 'Note options' });
    await page.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    // Check an item, and now both options show up.
    await checkFirstItem(page);
    await dashboardPage.openModalOverflowMenu();
    await expect(page.getByTestId('note-uncheck-all')).toBeVisible();
    await expect(page.getByTestId('note-delete-checked')).toBeVisible();
  });

  test('uncheck all returns every completed item to the active list', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Chores', ['Sweep', 'Mop', 'Dust']);
    await dashboardPage.openNote('Chores');

    // Complete two items (the first reflows into the completed section, so the
    // second forced click lands on what is now the first active row).
    await checkFirstItem(page);
    // eslint-disable-next-line playwright/no-force-option -- see checkFirstItem above
    await rowCheckbox(page, 0).click({ force: true });
    await expect(page.getByText('Completed items (2)')).toBeVisible();

    await dashboardPage.uncheckAllItemsFromModal();

    // The completed section is gone and all three items are active and unchecked.
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await dashboardPage.expectListItemCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(rowCheckbox(page, i)).not.toBeChecked();
    }
  });

  test('undo after uncheck all re-checks the items', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Habits', ['Water', 'Stretch']);
    await dashboardPage.openNote('Habits');

    await checkFirstItem(page);
    await dashboardPage.uncheckAllItemsFromModal();

    // Everything is now active and the "unchecked — Undo" bar is showing.
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await expect(page.getByTestId('unchecked-items-bar')).toBeVisible();

    // Undo re-checks the snapshot: the completed section comes back.
    await page.getByTestId('unchecked-items-undo').click();
    await expect(page.getByTestId('unchecked-items-bar')).toHaveCount(0);
    await expect(page.getByText(/Completed items/)).toBeVisible();
  });

  test('delete checked hides items behind an undo bar; undo restores them', async ({ page, dashboardPage, authenticatedUser }) => {
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Trip', ['Passport', 'Tickets', 'Charger']);
    await dashboardPage.openNote('Trip');

    await checkFirstItem(page);

    await dashboardPage.deleteCheckedItemsFromModal();

    // The completed section disappears and the undo bar appears.
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await expect(page.getByTestId('checked-items-removed-bar')).toBeVisible();

    // Undo brings the checked items back into the completed section.
    await page.getByTestId('checked-items-undo').click();
    await expect(page.getByTestId('checked-items-removed-bar')).toHaveCount(0);
    await expect(page.getByText(/Completed items/)).toBeVisible();
  });

  test('delete checked permanently removes checked items once the undo window elapses', async ({ page, dashboardPage, authenticatedUser }) => {
    // The deferred bulk delete only fires after the ~10s undo window.
    test.setTimeout(45_000);
    expect(authenticatedUser.username).toBeTruthy();
    await dashboardPage.createListNote('Cleanup', ['Remove me']);
    await dashboardPage.openNote('Cleanup');

    // Check the existing item, then add a fresh unchecked item that must survive.
    await checkFirstItem(page);
    // Wait for the new item's create to persist, so its autosave can't race the
    // reopen at the end of the test.
    const keepCreated = page.waitForResponse(
      (res) => /\/items$/.test(res.url()) && res.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('dialog').last().getByRole('button', { name: 'Add item' }).click();
    await page.keyboard.type('Keep me');
    // Active items render before the completed section, so the new unchecked
    // item is the first input.
    await dashboardPage.expectListItemValue(0, 'Keep me');
    await keepCreated;

    // The bulk delete only fires after the undo window; wait for that request.
    const deleteResponse = page.waitForResponse(
      (res) => /\/items\/delete$/.test(res.url()) && res.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await dashboardPage.deleteCheckedItemsFromModal();
    await expect(page.getByTestId('checked-items-removed-bar')).toBeVisible();
    await deleteResponse;
    await expect(page.getByTestId('checked-items-removed-bar')).toHaveCount(0);

    // Reopen the note: only the untouched item survives, and it is unchecked.
    await dashboardPage.closeNoteModal();
    await dashboardPage.openNote('Cleanup');
    await dashboardPage.expectListItemValue(0, 'Keep me');
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
  });
});
