import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

// A server error toast shows the failed request's X-Request-Id, so a user can
// quote it and an operator can find the matching server log line and trace.

const REQUEST_ID = 'e2e0123456789abc';
const DELETE_FAILED = 'Failed to move note to trash.';

// Answers every note DELETE with the given status and error envelope.
async function failDeletes(page: Page, status: number, code: string, message: string) {
  await page.route('**/api/v1/notes/*', async route => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      headers: { 'X-Request-Id': REQUEST_ID },
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message } }),
    });
  });
}

test.describe('Error toast reference', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('a server error shows its request ID and copies it', async ({ page, context, dashboardPage, toastPage }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dashboardPage.goto();
    await dashboardPage.createNote('Doomed Delete');
    await failDeletes(page, 500, 'internal', 'internal server error');

    await dashboardPage.deleteNote('Doomed Delete', { waitForRemoval: false });

    const toast = toastPage.toastWithText(DELETE_FAILED);
    await expect(toast).toBeVisible();
    const reference = toastPage.referenceOf(toast);
    await expect(reference).toHaveText(`Ref: ${REQUEST_ID}`);

    await reference.click();
    await expect(reference).toHaveText('Copied!');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REQUEST_ID);
  });

  test('a client error shows no reference', async ({ page, dashboardPage, toastPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Missing Delete');
    await failDeletes(page, 404, 'not_found', 'note not found');

    await dashboardPage.deleteNote('Missing Delete', { waitForRemoval: false });

    const toast = toastPage.toastWithText(DELETE_FAILED);
    await expect(toast).toBeVisible();
    await expect(toastPage.referenceOf(toast)).toHaveCount(0);
  });
});
