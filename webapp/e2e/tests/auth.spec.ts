import { test, expect, uniqueUsername } from '../fixtures';

test.describe('Authentication', () => {
  test('registers a new user and redirects to dashboard', async ({ page, registerPage }) => {
    const username = uniqueUsername('reg');
    await registerPage.goto();
    await registerPage.register(username, 'password123');
    await expect(page).toHaveURL('/');
  });

  test('shows error for username that is too short', async ({ registerPage }) => {
    await registerPage.goto();
    await registerPage.register('a', 'password123');
    await registerPage.expectError('Username must be at least 2 characters');
  });

  test('shows error when passwords do not match', async ({ registerPage }) => {
    const username = uniqueUsername('reg');
    await registerPage.goto();
    await registerPage.register(username, 'password123', 'different456');
    await registerPage.expectError('Passwords do not match');
  });

  test('shows error for password that is too short', async ({ registerPage }) => {
    const username = uniqueUsername('reg');
    await registerPage.goto();
    await registerPage.register(username, 'abc', 'abc');
    await registerPage.expectError('Password must be at least 4 characters');
  });

  test('shows error for duplicate username', async ({ page, registerPage, dashboardPage }) => {
    const username = uniqueUsername('dup');
    // Register once
    await registerPage.goto();
    await registerPage.register(username, 'password123');
    await expect(page).toHaveURL('/');

    // Log out
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    // Try to register with the same username
    await registerPage.goto();
    await registerPage.register(username, 'password123');
    await registerPage.expectError('username already taken');
  });

  test('logs in with valid credentials and redirects to dashboard', async ({ page, loginPage, registerPage, dashboardPage }) => {
    const username = uniqueUsername('login');
    const password = 'securepass';

    // Register first
    await registerPage.goto();
    await registerPage.register(username, password);
    await expect(page).toHaveURL('/');

    // Logout
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    // Login
    await loginPage.goto();
    await loginPage.login(username, password);
    await loginPage.expectRedirectedToDashboard();
  });

  test('shows error on login with wrong password', async ({ loginPage, registerPage, page, dashboardPage }) => {
    const username = uniqueUsername('badpw');
    await registerPage.goto();
    await registerPage.register(username, 'correctpassword');
    await expect(page).toHaveURL('/');
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    await loginPage.goto();
    await loginPage.login(username, 'wrongpassword');
    await loginPage.expectError('invalid username or password');
  });

  test('logs out and redirects to login', async ({ page, authenticatedUser, dashboardPage }) => {
    // authenticatedUser fixture already logged in
    void authenticatedUser;
    await expect(page).toHaveURL('/');
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');
  });

  test('redirects unauthenticated users from dashboard to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });

  test('redirects authenticated users away from login page', async ({ page, authenticatedUser }) => {
    void authenticatedUser;
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });

  test('restores session after localStorage is cleared', async ({ page, authenticatedUser }) => {
    void authenticatedUser;
    await expect(page).toHaveURL('/');

    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Session cookie is still valid — should land on the dashboard, not /login
    await expect(page).toHaveURL('/');
  });
});
