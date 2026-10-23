import { test, expect } from '../fixtures';

// A server error toast shows the failed request's X-Request-Id, so a user can
// quote it and an operator can find the matching server log line and trace.

test.describe('Error toast reference', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('a server error shows its request ID and copies it', async ({ page, context, dashboardPage }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dashboardPage.goto();
    await dashboardPage.createNote('Doomed Delete');

    await page.route('**/api/v1/notes/*', async route => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        headers: { 'X-Request-Id': 'e2e0123456789abc' },
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'internal server error' } }),
      });
    });

    await dashboardPage.deleteNote('Doomed Delete', { waitForRemoval: false });

    const toast = page.getByTestId('toast').filter({ hasText: 'Failed to move note to trash.' });
    await expect(toast).toBeVisible();
    const reference = toast.getByTestId('toast-reference');
    await expect(reference).toHaveText('Ref: e2e0123456789abc');

    await reference.click();
    await expect(reference).toHaveText('Copied!');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('e2e0123456789abc');
  });

  test('a client error shows no reference', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Missing Delete');

    await page.route('**/api/v1/notes/*', async route => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 404,
        headers: { 'X-Request-Id': 'e2e0123456789abc' },
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'not_found', message: 'note not found' } }),
      });
    });

    await dashboardPage.deleteNote('Missing Delete', { waitForRemoval: false });

    const toast = page.getByTestId('toast').filter({ hasText: 'Failed to move note to trash.' });
    await expect(toast).toBeVisible();
    await expect(toast.getByTestId('toast-reference')).toHaveCount(0);
  });
});
