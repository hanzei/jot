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
