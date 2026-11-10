import { test, expect } from '../fixtures';

test.describe('Personal access tokens', () => {
  test('shows when each token was last used', async ({ page, playwright, baseURL, settingsPage, authenticatedUser }) => {
    void authenticatedUser;
    await settingsPage.goto();

    await settingsPage.createPAT('Used token');
    const token = await settingsPage.takeNewPATToken();
    await settingsPage.createPAT('Idle token');
    await settingsPage.takeNewPATToken();

    await expect(settingsPage.patLastUsed('Used token')).toHaveText('No recorded use');
    await expect(settingsPage.patLastUsed('Idle token')).toHaveText('No recorded use');

    // A script authenticating with the token, with no session cookie. The
    // Playwright config always sets baseURL.
    const api = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    const response = await api.get('/api/v1/users/me');
    expect(response.status()).toBe(200);
    await api.dispose();

    await page.reload();
    await expect(settingsPage.patLastUsed('Used token')).toHaveText('Last used today');
    await expect(settingsPage.patLastUsed('Idle token')).toHaveText('No recorded use');
  });
});
