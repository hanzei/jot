import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { failRequests } from '../fixtures/apiErrors';
import type { DashboardPage } from '../pages/DashboardPage';

/**
 * End-to-end coverage for the list-item autocomplete: typing in an active row
 * suggests the text of completed items, and accepting a suggestion revives that
 * completed item in place of the typed row rather than adding a duplicate.
 * Reviving applies the same parent/child cascade as unchecking the item, and a
 * revived child keeps its own group whatever row it was typed in. Because the
 * typed row is consumed, suggestions are only offered on a row that started
 * empty, never while editing an existing item.
 */
test.describe('Completed-item suggestions', () => {
  type ApiItem = { id: string; text: string; completed: boolean; parent_id: string | null };

  // One click, not .check(): once checked, the item moves to the completed
  // section and row 0 becomes the next item, which .check() would then see
  // unchecked and click too.
  const checkFirstItem = (dashboardPage: DashboardPage) => dashboardPage.listItemCheckbox(0).click();

  const suggestion = (page: Page, text: string) =>
    page.getByRole('listbox', { name: 'Suggestions from completed items' })
      .getByRole('option', { name: text, exact: true });

  // The note's items as the server holds them. page.request shares the
  // logged-in session.
  const serverItems = async (page: Page, title: string): Promise<ApiItem[]> => {
    const resp = await page.request.get('/api/v1/notes');
    expect(resp.ok()).toBeTruthy();
    const note = ((await resp.json()).notes as Array<{ title: string; items: ApiItem[] }>)
      .find((candidate) => candidate.title === title);
    expect(note, 'note must exist').toBeDefined();
    return note!.items;
  };

  // A "Produce" group with two children, checked as a whole via the parent.
  const createCheckedGroup = async (page: Page, dashboardPage: DashboardPage) => {
    await dashboardPage.createListNote('Groceries', ['Produce', 'Apples', 'Bananas']);
    await dashboardPage.openNote('Groceries');
    await dashboardPage.listItemInput(1).focus();
    await page.keyboard.press('Tab');
    await dashboardPage.listItemInput(2).focus();
    await page.keyboard.press('Tab');
    await checkFirstItem(dashboardPage);
    await expect(page.getByText('Completed items (3)')).toBeVisible();
  };

  test('reviving a child un-checks its parent and returns it to its group', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await createCheckedGroup(page, dashboardPage);

    await dashboardPage.addListItem('ban');
    await suggestion(page, 'Bananas').click();

    // The parent is un-checked with it; the sibling stays checked.
    await expect(page.getByText('Completed items (1)')).toBeVisible();
    await dashboardPage.expectListItemCount(3);
    await dashboardPage.expectListItemValue(0, 'Produce');
    await dashboardPage.expectListItemValue(1, 'Bananas');
    await expect(dashboardPage.listItemRow(1)).toHaveCSS('margin-left', '24px');

    // The server agrees, and the typed row was consumed rather than saved.
    await expect.poll(async () => {
      const items = await serverItems(page, 'Groceries');
      const byText = new Map(items.map((it) => [it.text, it]));
      return {
        texts: items.map((it) => it.text).sort(),
        produce: byText.get('Produce')?.completed,
        bananas: byText.get('Bananas')?.completed,
        apples: byText.get('Apples')?.completed,
        bananasInGroup: byText.get('Bananas')?.parent_id === byText.get('Produce')?.id,
      };
    }).toEqual({
      texts: ['Apples', 'Bananas', 'Produce'],
      produce: false,
      bananas: false,
      apples: true,
      bananasInGroup: true,
    });
  });

  test('reviving a parent un-checks all of its children', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await createCheckedGroup(page, dashboardPage);

    await dashboardPage.addListItem('prod');
    await suggestion(page, 'Produce').click();

    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await dashboardPage.expectListItemCount(3);
    await dashboardPage.expectListItemValue(0, 'Produce');

    await expect.poll(async () =>
      (await serverItems(page, 'Groceries')).map((it) => `${it.text}:${it.completed}`).sort(),
    ).toEqual(['Apples:false', 'Bananas:false', 'Produce:false']);
  });

  test('Enter accepts only a highlighted suggestion', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createListNote('Errands', ['Milk']);
    await dashboardPage.openNote('Errands');
    await checkFirstItem(dashboardPage);
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    // With nothing highlighted, Enter keeps its normal add-item behavior.
    await dashboardPage.addListItem('mi');
    await expect(suggestion(page, 'Milk')).toBeVisible();
    await page.keyboard.press('Enter');
    await dashboardPage.expectListItemCount(3);
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    // Enter focused a fresh row (deferred, so wait for it before typing).
    // Arrow down highlights the suggestion there, and Enter then revives Milk
    // in that row's place.
    await dashboardPage.expectListItemFocused(1);
    await page.keyboard.type('mil');
    await expect(suggestion(page, 'Milk')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await dashboardPage.expectListItemValue(0, 'mi');
    await dashboardPage.expectListItemValue(1, 'Milk');
  });

  test('a failed revive keeps the typed row and the item checked', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createListNote('Basket', ['Milk']);
    await dashboardPage.openNote('Basket');
    await checkFirstItem(dashboardPage);
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    await failRequests(page, '**/api/v1/notes/*/items/*/toggle-completed', 'POST', {
      status: 500, code: 'internal', message: 'internal server error', requestId: 'e2e0123456789abc',
    });

    await dashboardPage.addListItem('mil');
    await suggestion(page, 'Milk').click();

    await expect(page.getByText('Failed to save changes. Please try again.')).toBeVisible();
    await expect(page.getByText('Completed items (1)')).toBeVisible();
    await dashboardPage.expectListItemValue(0, 'mil');

    // Nothing was revived, and the typed row was not deleted behind the error.
    await expect.poll(async () =>
      (await serverItems(page, 'Basket')).map((it) => `${it.text}:${it.completed}`).sort(),
    ).toEqual(['Milk:true', 'mil:false']);
  });

  test('editing an existing item offers no suggestions', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createListNote('Pantry', ['Milk', 'Bread']);
    await dashboardPage.openNote('Pantry');
    await checkFirstItem(dashboardPage);
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    // Accepting would consume "Bread", so retyping it must not offer "Milk".
    await dashboardPage.listItemInput(0).fill('mil');
    await expect(dashboardPage.listItemInput(0)).toHaveValue('mil');
    await expect(page.getByRole('listbox', { name: 'Suggestions from completed items' })).toHaveCount(0);
  });
});
