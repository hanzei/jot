import { test, expect, uniqueUsername } from '../fixtures';

test.describe('Active Sessions', () => {
  test('shows current session in settings', async ({ authenticatedUser, settingsPage, page }) => {
    await settingsPage.goto();

    const section = settingsPage.sessionsSection();
    await expect(section).toBeVisible();
    await expect(section.getByText('Active Sessions')).toBeVisible();

    const items = settingsPage.sessionItems();
    await expect(items).toHaveCount(1);
    await expect(items.first().getByText('Current')).toBeVisible();

    void authenticatedUser;
  });

  test('shows multiple sessions after logging in from another context', async ({
    authenticatedUser,
    settingsPage,
    page,
    browser,
  }) => {
    // Create a second session by logging in from a new browser context
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto('/login');
    await secondPage.getByPlaceholder('Username').fill(authenticatedUser.username);
    await secondPage.getByPlaceholder('Password').fill(authenticatedUser.password);
    await secondPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(secondPage).toHaveURL('/');
    await secondContext.close();

    // Now the original session should see 2 sessions
    await settingsPage.goto();

    const items = settingsPage.sessionItems();
    await expect(items).toHaveCount(2);

    // Exactly one should be marked "Current"
    const currentBadges = settingsPage.sessionsSection().getByText('Current');
    await expect(currentBadges).toHaveCount(1);
  });

  test('can revoke another session', async ({
    authenticatedUser,
    settingsPage,
    page,
    browser,
  }) => {
    // Create a second session
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto('/login');
    await secondPage.getByPlaceholder('Username').fill(authenticatedUser.username);
    await secondPage.getByPlaceholder('Password').fill(authenticatedUser.password);
    await secondPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(secondPage).toHaveURL('/');
    await secondContext.close();

    await settingsPage.goto();
    await expect(settingsPage.sessionItems()).toHaveCount(2);

    // Find the non-current session and revoke it
    const revokeResponse = page.waitForResponse(
      resp => resp.url().includes('/api/v1/sessions/') && resp.request().method() === 'DELETE'
    );
    await settingsPage.openRevokeDialog(0);
    await expect(settingsPage.revokeDialogTitle()).toBeVisible();
    await settingsPage.clickRevokeConfirm();
    await revokeResponse;

    await expect(settingsPage.sessionItems()).toHaveCount(1);
    await expect(settingsPage.sessionItems().first().getByText('Current')).toBeVisible();
  });

  test('canceling revoke confirmation keeps the session active', async ({
    authenticatedUser,
    settingsPage,
    browser,
  }) => {
    // Create a second session
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto('/login');
    await secondPage.getByPlaceholder('Username').fill(authenticatedUser.username);
    await secondPage.getByPlaceholder('Password').fill(authenticatedUser.password);
    await secondPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(secondPage).toHaveURL('/');
    await secondContext.close();

    await settingsPage.goto();
    await expect(settingsPage.sessionItems()).toHaveCount(2);

    await settingsPage.openRevokeDialog(0);
    await expect(settingsPage.revokeDialogTitle()).toBeVisible();
    await settingsPage.clickRevokeCancel();
    await expect(settingsPage.revokeDialogTitle()).toHaveCount(0);
    await expect(settingsPage.sessionItems()).toHaveCount(2);
  });

  test('current session has no revoke button', async ({ authenticatedUser, settingsPage }) => {
    await settingsPage.goto();

    const items = settingsPage.sessionItems();
    await expect(items).toHaveCount(1);
    await expect(items.first().getByText('Current')).toBeVisible();
    await expect(items.first().getByRole('button', { name: 'Revoke' })).toHaveCount(0);

    void authenticatedUser;
  });
});
