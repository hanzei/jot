import { test, expect } from '../fixtures';

test.describe('/new deep link', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('opens the create-note modal ready to type', async ({ page, dashboardPage }) => {
    await page.goto('/new');

    await expect(page.locator('textarea[placeholder="Take a note..."]')).toBeVisible();

    await page.fill('textarea[placeholder="Take a note..."]', 'Quick capture via /new');
    await dashboardPage.closeNoteModal();
    await dashboardPage.expectNoteVisible('Quick capture via /new');
  });

  test('opens a new list note via ?type=list', async ({ page, dashboardPage }) => {
    await page.goto('/new?type=list');

    await expect(page.locator('input[placeholder="Note title..."]')).toBeVisible();

    await page.fill('input[placeholder="Note title..."]', 'Groceries via shortcut');
    await dashboardPage.closeNoteModal();
    await dashboardPage.expectNoteVisible('Groceries via shortcut');
  });

  test('prefills note content from Web Share Target query params', async ({ page, dashboardPage }) => {
    const sharedUrl = 'https://example.com/recipe';
    await page.goto(`/new?title=Recipe&text=Looks%20tasty&url=${encodeURIComponent(sharedUrl)}`);

    const content = page.locator('textarea[placeholder="Take a note..."]');
    await expect(content).toHaveValue(`Recipe\n\nLooks tasty\n\n${sharedUrl}`);

    await dashboardPage.closeNoteModal();
    await dashboardPage.expectNoteVisible('Looks tasty');
    // The /new deep link is one-shot: closing the modal returns to the dashboard.
    await expect(page).toHaveURL('/');
  });
});
