import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { DashboardPage } from '../pages/DashboardPage';

/**
 * End-to-end coverage for the list-item autocomplete: typing in an active row
 * suggests the text of completed items, and accepting a suggestion revives that
 * completed item in place of the typed row rather than adding a duplicate.
 * Reviving applies the same parent/child cascade as unchecking the item, and a
 * revived child keeps its own group whatever row it was typed in.
 */
test.describe('Completed-item suggestions', () => {
  type ApiItem = { id: string; text: string; completed: boolean; parent_id: string | null };

  const rowCheckbox = (page: Page, index: number) =>
    page.locator('[data-testid="list-item-row"] input[type="checkbox"]').nth(index);

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
    await rowCheckbox(page, 0).check();
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
    await rowCheckbox(page, 0).check();
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    // With nothing highlighted, Enter keeps its normal add-item behavior.
    await dashboardPage.addListItem('mi');
    await expect(suggestion(page, 'Milk')).toBeVisible();
    await page.keyboard.press('Enter');
    await dashboardPage.expectListItemCount(3);
    await expect(page.getByText('Completed items (1)')).toBeVisible();

    // Arrow down highlights the suggestion; Enter then revives Milk.
    await dashboardPage.listItemInput(0).focus();
    await page.keyboard.press('End');
    await page.keyboard.type('l');
    await expect(suggestion(page, 'Milk')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Completed items/)).toHaveCount(0);
    await dashboardPage.expectListItemValue(0, 'Milk');
  });
});
