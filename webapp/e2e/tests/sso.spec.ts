import type { Page } from '@playwright/test';
import { test, expect, uniqueUsername } from '../fixtures';

/**
 * SSO/OIDC is a server-configured feature (JOT_OIDC_* env). The main e2e server
 * runs with it unset, so these specs pin the *SSO-disabled default*: the login
 * and settings surfaces must look and behave exactly as they did before the SSO
 * UI existed. The enabled states (provider button, connect/disconnect, the full
 * authorization-code redirect) run against a live mock identity provider in
 * `sso-enabled.spec.ts`, on a second, SSO-enabled instance (`sso` project).
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
 * Pretends the server is SSO-only (local login disabled) and the account is
 * linked, by rewriting the /config and /me responses. The SSO-enabled instance
 * in `sso-enabled.spec.ts` runs mixed mode, so this is the only coverage of
 * which Settings controls SSO-only mode hides; the flows themselves are there.
 */
async function mockSsoOnlyLinked(page: Page) {
  await page.route('**/api/v1/config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: false } },
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, user: { ...body.user, has_sso_linked: true } } });
  });
}

// The mocked /me handler awaits route.fetch(); a refetch still in flight when a
// test ends would otherwise throw "Test ended" outside any test and fail the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.describe('SSO-only mode, linked account (mocked config)', () => {
  test('hides Disconnect and Change Password', async ({ page, authenticatedUser, settingsPage }) => {
    void authenticatedUser;
    await mockSsoOnlyLinked(page);
    await settingsPage.goto();

    await expect(page.getByRole('heading', { name: 'Single Sign-On' })).toBeVisible();
    await expect(page.getByText('Your account is linked to Keycloak.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect Keycloak' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect Keycloak' })).toHaveCount(0);
    // A password cannot sign in either, so there is nothing to change or set.
    await expect(page.getByRole('heading', { name: 'Change Password' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Set Password' })).toHaveCount(0);
  });
});
