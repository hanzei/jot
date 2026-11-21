import type { Page } from '@playwright/test';
import { test, expect, E2E_ADMIN_CREDENTIALS } from '../fixtures';

/**
 * Self-service account deletion from Settings (`DELETE /users/me`).
 *
 * Every test but the last-admin one deletes (or tries to delete) the fresh user
 * the `authenticatedUser` fixture registered. Global setup registered the
 * bootstrap admin first, so those users are never the instance's only admin.
 * The SSO-only (username) path runs against the SSO instance, in
 * `sso-enabled.spec.ts`.
 */

/** The number of admins on the instance, read through the page's admin session. */
async function adminCount(page: Page): Promise<number> {
  const response = await page.request.get('/api/v1/admin/users');
  expect(response.ok(), `GET /admin/users failed with ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { users: { role: string }[] };
  return body.users.filter((u) => u.role === 'admin').length;
}

test.describe('Delete account', () => {
  test('a user deletes their account, lands on login, and cannot sign in again', async ({ page, authenticatedUser, settingsPage, loginPage }) => {
    await settingsPage.goto();
    await expect(settingsPage.deleteAccountSection()).toContainText('Permanently delete your account');

    const dialog = await settingsPage.openDeleteAccountDialog();
    await expect(dialog).toContainText('Your notes, images, labels, sessions and access tokens are deleted.');
    await expect(dialog).toContainText('Notes other people shared with you stay with their owners.');
    // Not SSO-linked, so no re-provisioning note.
    await expect(dialog).not.toContainText('Signing in with SSO again');
    await expect(settingsPage.deleteAccountConfirmButton()).toBeDisabled();

    await settingsPage.deleteAccountField().fill(authenticatedUser.password);
    await settingsPage.deleteAccountConfirmButton().click();

    await expect(page).toHaveURL('/login');
    // The session is gone server-side too, not just in the client.
    expect((await page.request.get('/api/v1/users/me')).status()).toBe(401);

    await loginPage.login(authenticatedUser.username, authenticatedUser.password);
    await loginPage.expectError('Invalid username or password.');
    await expect(page).toHaveURL('/login');
  });

  test('a wrong password shows the error on the field and keeps the account', async ({ page, authenticatedUser, settingsPage }) => {
    await settingsPage.goto();
    await settingsPage.deleteAccount('not-the-password');

    await expect(settingsPage.deleteAccountDialog()).toContainText('Current password is incorrect.');
    await expect(settingsPage.deleteAccountField()).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL('/settings');

    const me = await page.request.get('/api/v1/users/me');
    expect(me.ok()).toBeTruthy();
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe(authenticatedUser.username);
  });

  test('the only admin is told to promote someone first', async ({ page, settingsPage }) => {
    const login = await page.request.post('/api/v1/login', { data: E2E_ADMIN_CREDENTIALS });
    expect(login.ok(), `admin login failed with ${login.status()}`).toBeTruthy();
    // The correct password goes through below, so if another admin existed the
    // bootstrap admin really would be deleted, taking the rest of the suite with
    // it. Refuse to run rather than risk that.
    expect(await adminCount(page), 'the bootstrap admin must be the only admin').toBe(1);

    await settingsPage.goto();
    await settingsPage.deleteAccount(E2E_ADMIN_CREDENTIALS.password);

    await expect(settingsPage.deleteAccountDialog()).toContainText('You are the only admin');
    await expect(settingsPage.deleteAccountDialog()).toContainText('Promote another user to admin before you delete your account.');
    await expect(settingsPage.deleteAccountField()).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL('/settings');
    expect((await page.request.get('/api/v1/users/me')).ok()).toBeTruthy();
  });

  test('cancel closes the dialog without deleting', async ({ page, authenticatedUser, settingsPage }) => {
    void authenticatedUser;
    await settingsPage.goto();
    const dialog = await settingsPage.openDeleteAccountDialog();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await page.request.get('/api/v1/users/me')).ok()).toBeTruthy();
  });
});
