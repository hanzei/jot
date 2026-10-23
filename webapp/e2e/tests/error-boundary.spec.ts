import { test, expect } from '../fixtures';

test.describe('Error boundaries', () => {
  test.beforeEach(async ({ context, browserName }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
  });

  test('a render error in the layout shows the app-wide fallback instead of a blank page', async ({ page, authenticatedUser, errorFallbackPage }) => {
    void authenticatedUser;
    await errorFallbackPage.breakSidebarLabels();
    await page.goto('/');

    const fallback = errorFallbackPage.root();
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(fallback.getByRole('button', { name: 'Reload page' })).toBeVisible();

    await errorFallbackPage.copyDetails(fallback);
    await expect(fallback.getByText('Error details copied')).toBeVisible();
    const details = await errorFallbackPage.clipboardText();
    expect(details).toContain('Jot error report');
    expect(details).toMatch(/App version: \S+/);
    expect(details).toContain('Route: /');
    expect(details).toContain('Stack:');

    await page.unroute('**/api/v1/labels');
    await fallback.getByRole('button', { name: 'Reload page' }).click();
    await expect(fallback).toBeHidden();
    await expect(page.getByRole('button', { name: 'New Note' })).toBeVisible();
  });

  test('a render error in a page keeps the navigation usable', async ({ page, authenticatedUser, errorFallbackPage }) => {
    void authenticatedUser;
    await errorFallbackPage.breakNoteList();
    await page.goto('/');

    const fallback = errorFallbackPage.section();
    await expect(fallback).toBeVisible();
    await expect(fallback.getByText('The rest of Jot still works.')).toBeVisible();
    await expect(errorFallbackPage.root()).toHaveCount(0);

    await errorFallbackPage.copyDetails(fallback);
    await expect(fallback.getByText('Error details copied')).toBeVisible();
    expect(await errorFallbackPage.clipboardText()).toContain('Route: /');

    // The header still works, and navigating away in-app clears the error.
    await page.getByRole('button', { name: 'Profile menu' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(fallback).toHaveCount(0);

    // Back on the broken page, "Try again" re-renders it once the data is good.
    await page.goBack();
    await expect(fallback).toBeVisible();
    await errorFallbackPage.unbreakNoteList();
    await fallback.getByRole('button', { name: 'Try again' }).click();
    await expect(fallback).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Note' })).toBeVisible();
  });
});
