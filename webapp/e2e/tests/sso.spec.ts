import type { Page } from '@playwright/test';
import { test, expect, uniqueUsername } from '../fixtures';

/**
 * SSO/OIDC is a server-configured feature (JOT_OIDC_* env). The e2e server runs
 * with it unset, so these specs pin the *SSO-disabled default*: the login and
 * settings surfaces must look and behave exactly as they did before the SSO UI
 * existed. The enabled states (provider button, connect/disconnect, the full
 * authorization-code redirect) need a live identity provider to exercise and
 * are covered by the Vitest unit specs plus a follow-up IdP fixture — see the
 * PR description.
 */
test.describe('SSO disabled (default)', () => {
  test('login page shows the local form and no SSO button', async ({ page, loginPage }) => {
    await loginPage.goto();

    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Sign in with/ })).toHaveCount(0);
  });

  test('settings page has no Single Sign-On section', async ({ page, registerPage }) => {
    await registerPage.goto();
    await registerPage.register(uniqueUsername('sso'), 'password123');
    await expect(page).toHaveURL('/');

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Single Sign-On' })).toHaveCount(0);
  });
});

/**
 * Pretends the server has SSO enabled and the account is linked, by rewriting
 * the /config and /me responses. Enough to pin which Settings controls render
 * for each mode; the flows themselves need a live identity provider.
 */
async function mockLinkedSso(page: Page, localLoginEnabled: boolean, hasPassword = true) {
  await page.route('**/api/v1/config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: localLoginEnabled } },
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, user: { ...body.user, has_sso_linked: true, has_password: hasPassword } } });
  });
}

test.describe('SSO enabled, linked account (mocked config)', () => {
  test('mixed mode offers Disconnect', async ({ page, authenticatedUser, settingsPage }) => {
    void authenticatedUser;
    await mockLinkedSso(page, true);
    await settingsPage.goto();

    await expect(page.getByRole('heading', { name: 'Single Sign-On' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect Keycloak' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
  });

  test('SSO-only mode hides Disconnect and Change Password', async ({ page, authenticatedUser, settingsPage }) => {
    void authenticatedUser;
    await mockLinkedSso(page, false);
    await settingsPage.goto();

    await expect(page.getByRole('heading', { name: 'Single Sign-On' })).toBeVisible();
    await expect(page.getByText('Your account is linked to Keycloak.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect Keycloak' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect Keycloak' })).toHaveCount(0);
    // A password cannot sign in either, so there is nothing to change.
    await expect(page.getByRole('heading', { name: 'Change Password' })).toHaveCount(0);
  });
});

test.describe('SSO-provisioned account without a password (mocked config)', () => {
  test('sets a first password without the current one', async ({ page, authenticatedUser, settingsPage }) => {
    void authenticatedUser;
    await mockLinkedSso(page, true, false);
    // The real account has a password, so the server would demand the current
    // one; stand in for it and capture what the form sends.
    let sentBody: unknown = null;
    await page.route('**/api/v1/users/me/password', async (route) => {
      sentBody = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    await settingsPage.goto();

    await expect(page.getByRole('heading', { name: 'Set Password' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change Password' })).toHaveCount(0);
    await expect(page.getByLabel('Current Password')).toHaveCount(0);

    await page.getByLabel('New Password', { exact: true }).fill('newpassword123');
    await page.getByLabel('Confirm New Password').fill('newpassword123');
    await page.getByRole('button', { name: 'Set Password' }).click();

    await expect(page.getByText('Password set.')).toBeVisible();
    expect(sentBody).toEqual({ new_password: 'newpassword123' });
    // The account has a password now, so the card becomes Change Password.
    await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
    await expect(page.getByLabel('Current Password')).toBeVisible();
  });
});
