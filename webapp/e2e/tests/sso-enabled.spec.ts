import type { Page } from '@playwright/test';
import { test, expect, uniqueUsername } from '../fixtures';
import { expectNoViolations } from '../fixtures/axe';

/**
 * SSO against a live identity provider: the `sso` project runs this spec, and
 * only this spec, on a second Jot instance (:8090) configured for OIDC in mixed
 * mode against the mock IdP in `e2e/fixtures/mock-idp.ts` (:8091). Nothing is
 * stubbed on Jot's side — discovery, the authorization-code + PKCE round trip,
 * ID-token verification and the flow cookie are all the server's real code.
 * See playwright.config.ts for the wiring.
 *
 * The IdP identifies people by username (subject `mock|<username>`), so every
 * test signs in under its own unique IdP username; workers run in parallel
 * against one database.
 */

const PROVIDER = 'Mock IdP';
const PASSWORD = 'testpass123';

interface Me {
  username: string;
  has_sso_linked: boolean;
  has_password: boolean;
}

/** The logged-in user as the server sees it, through the page's own session cookie. */
async function currentUser(page: Page): Promise<Me> {
  const response = await page.request.get('/api/v1/me');
  expect(response.ok(), `GET /me failed with ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { user: Me };
  return body.user;
}

function ssoLoginLink(page: Page) {
  return page.getByRole('link', { name: `Sign in with ${PROVIDER}` });
}

function ssoSection(page: Page) {
  return page.getByRole('heading', { name: 'Single Sign-On' }).locator('..');
}

test.describe('SSO enabled (mock IdP)', () => {
  test('first SSO login provisions a new account', async ({ page, loginPage, mockIdpPage }) => {
    const idpUsername = uniqueUsername('idp');

    await loginPage.goto();
    // Mixed mode: the password form and the provider button side by side.
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await ssoLoginLink(page).click();
    await mockIdpPage.approve(idpUsername);

    await loginPage.expectRedirectedToDashboard();
    await expect(page.getByRole('button', { name: 'New Note' })).toBeVisible();
    // The username is seeded from the IdP's preferred_username claim.
    expect(await currentUser(page)).toMatchObject({ username: idpUsername, has_sso_linked: true });
  });

  test('a returning SSO user signs in to the same account', async ({ page, loginPage, dashboardPage, mockIdpPage }) => {
    const idpUsername = uniqueUsername('idp');
    const noteTitle = `SSO note ${idpUsername}`;

    await loginPage.goto();
    await ssoLoginLink(page).click();
    await mockIdpPage.approve(idpUsername);
    await loginPage.expectRedirectedToDashboard();
    await dashboardPage.createNote(noteTitle);

    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    await ssoLoginLink(page).click();
    await mockIdpPage.approve(idpUsername);
    await loginPage.expectRedirectedToDashboard();
    await dashboardPage.expectNoteVisible(noteTitle);
    expect((await currentUser(page)).username).toBe(idpUsername);
  });

  test('a local account links, signs in via SSO, and unlinks', async ({ page, registerPage, loginPage, dashboardPage, settingsPage, mockIdpPage }) => {
    const localUsername = uniqueUsername('local');
    // A different IdP username than the local one, so landing on the local
    // account can only be the link, never a username coincidence.
    const idpUsername = uniqueUsername('idp');
    const noteTitle = `Linked note ${localUsername}`;

    await registerPage.goto();
    await registerPage.register(localUsername, PASSWORD);
    await expect(page).toHaveURL('/');
    await dashboardPage.createNote(noteTitle);

    await settingsPage.goto();
    await expect(ssoSection(page)).toContainText(`Connect your account to ${PROVIDER} to sign in with it.`);
    await ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` }).click();
    await mockIdpPage.approve(idpUsername);
    // A completed link lands back on the app root.
    await loginPage.expectRedirectedToDashboard();

    await settingsPage.goto();
    await expect(ssoSection(page).getByRole('button', { name: `Disconnect ${PROVIDER}` })).toBeVisible();
    await expect(ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` })).toHaveCount(0);

    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');
    await ssoLoginLink(page).click();
    await mockIdpPage.approve(idpUsername);
    await loginPage.expectRedirectedToDashboard();
    await dashboardPage.expectNoteVisible(noteTitle);
    expect(await currentUser(page)).toMatchObject({ username: localUsername, has_sso_linked: true });

    await settingsPage.goto();
    await ssoSection(page).getByRole('button', { name: `Disconnect ${PROVIDER}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: `Disconnect ${PROVIDER}` }).click();
    await settingsPage.expectSuccess('Disconnected from SSO.');
    await expect(ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` })).toBeVisible();
    expect((await currentUser(page)).has_sso_linked).toBe(false);
  });

  test('an SSO-provisioned account sets a password, signs in with it, and can then unlink', async ({ page, loginPage, dashboardPage, settingsPage, mockIdpPage }) => {
    const idpUsername = uniqueUsername('idp');
    const disconnect = () => ssoSection(page).getByRole('button', { name: `Disconnect ${PROVIDER}` });
    const confirmDisconnect = () => page.getByRole('dialog').getByRole('button', { name: `Disconnect ${PROVIDER}` });

    await loginPage.goto();
    await ssoLoginLink(page).click();
    await mockIdpPage.approve(idpUsername);
    await loginPage.expectRedirectedToDashboard();
    expect(await currentUser(page)).toMatchObject({ username: idpUsername, has_sso_linked: true, has_password: false });

    // SSO is the account's only credential, so the server refuses to unlink it.
    await settingsPage.goto();
    await disconnect().click();
    await confirmDisconnect().click();
    await expect(ssoSection(page)).toContainText('set a password first');
    expect((await currentUser(page)).has_sso_linked).toBe(true);

    // Set Password: no current-password field, since there is none to give.
    await expect(page.getByRole('heading', { name: 'Set Password' })).toBeVisible();
    await expect(page.getByLabel('Current Password')).toHaveCount(0);
    await page.getByLabel('New Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm New Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set Password' }).click();
    await settingsPage.expectSuccess('Password set.');
    await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
    await expect(page.getByLabel('Current Password')).toBeVisible();
    expect((await currentUser(page)).has_password).toBe(true);

    // The password is a working credential on its own.
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');
    await loginPage.login(idpUsername, PASSWORD);
    await loginPage.expectRedirectedToDashboard();
    expect(await currentUser(page)).toMatchObject({ username: idpUsername, has_password: true });

    // With a password in place, unlinking no longer strands the account.
    await settingsPage.goto();
    await disconnect().click();
    await confirmDisconnect().click();
    await settingsPage.expectSuccess('Disconnected from SSO.');
    await expect(ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` })).toBeVisible();
    expect((await currentUser(page)).has_sso_linked).toBe(false);
  });

  /**
   * Pins today's behavior, which is a dead end rather than a return to the
   * login page: the callback answers the IdP's `error=access_denied` with a raw
   * 401 and a plain-text error, and the browser stays on the API URL. A UX gap
   * flagged in the PR that added this spec; update this test when it is fixed.
   */
  test('denying at the IdP ends on the raw callback error', async ({ page, loginPage, mockIdpPage }) => {
    await loginPage.goto();
    await ssoLoginLink(page).click();

    const callback = page.waitForResponse((response) => response.url().includes('/api/v1/auth/oidc/callback'));
    await mockIdpPage.deny();
    const response = await callback;

    expect(response.status()).toBe(401);
    expect(new URL(response.url()).searchParams.get('error')).toBe('access_denied');
    await expect(page).toHaveURL(/\/api\/v1\/auth\/oidc\/callback\?/);
    await expect(page.locator('body')).toHaveText('identity provider returned an error: access_denied');

    // And no session was created.
    const me = await page.request.get('/api/v1/me');
    expect(me.status()).toBe(401);
  });
});

/**
 * The SSO-enabled surfaces only exist on this instance, so their axe scans live
 * here rather than in accessibility.spec.ts, done the same way: once per theme,
 * after confirming the theme actually reached the DOM.
 */
for (const theme of ['light', 'dark'] as const) {
  test.describe(`SSO accessibility (${theme} theme)`, () => {
    test.use({ colorScheme: theme });

    async function expectTheme(page: Page) {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark');
    }

    test('SSO-enabled login page has no WCAG A/AA violations', async ({ page, loginPage }) => {
      await loginPage.goto();
      await expect(ssoLoginLink(page)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expectTheme(page);

      await expectNoViolations(page);
    });

    // A whole-page scan, as in accessibility.spec.ts: the section has no
    // selector of its own to scope to, and the rest of the page is cheap.
    test('Single Sign-On settings section has no WCAG A/AA violations', async ({ page, registerPage, loginPage, settingsPage, mockIdpPage }) => {
      await registerPage.goto();
      await registerPage.register(uniqueUsername('a11y'), PASSWORD);
      await expect(page).toHaveURL('/');

      // Unlinked: the Connect link.
      await settingsPage.goto();
      await expect(ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` })).toBeVisible();
      await expectTheme(page);
      await expectNoViolations(page);

      // Linked: the Disconnect button, whose red text is the likelier contrast
      // failure in dark mode.
      await ssoSection(page).getByRole('link', { name: `Connect ${PROVIDER}` }).click();
      await mockIdpPage.approve(uniqueUsername('idp'));
      await loginPage.expectRedirectedToDashboard();
      await settingsPage.goto();
      await expect(ssoSection(page).getByRole('button', { name: `Disconnect ${PROVIDER}` })).toBeVisible();
      await expectTheme(page);
      await expectNoViolations(page);
    });
  });
}
