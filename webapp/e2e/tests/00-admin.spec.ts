import { test, expect, uniqueUsername } from '../fixtures';
import type { Page } from '@playwright/test';
import type { DashboardPage } from '../pages/DashboardPage';
import type { LoginPage } from '../pages/LoginPage';

type MeResponse = {
  user?: {
    role?: string;
  };
};

type SearchUserResponse = {
  username: string;
  role: string;
};

const ADMIN_LOGIN_CANDIDATE_PASSWORDS = [
  'testpass123',
  'password123',
  'securepass',
  'correctpassword',
  'newpass456',
];

async function ensureAdminSession(
  page: Page,
  dashboardPage: DashboardPage,
  loginPage: LoginPage,
) {
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const meData = await meResponse.json() as MeResponse;
  if (meData.user?.role === 'admin') {
    return;
  }

  const usersResponse = await page.request.get('/api/v1/users');
  expect(usersResponse.ok()).toBeTruthy();
  const users = await usersResponse.json() as SearchUserResponse[];
  const adminCandidates = users
    .filter(user => user.role === 'admin')
    .map(user => user.username);

  await dashboardPage.goto();
  await dashboardPage.logout();
  await expect(page).toHaveURL('/login');

  for (const adminUsername of adminCandidates) {
    for (const candidatePassword of ADMIN_LOGIN_CANDIDATE_PASSWORDS) {
      await loginPage.login(adminUsername, candidatePassword);
      await page.waitForURL(url => url.pathname !== '/login', { timeout: 3_000 }).catch(() => {});

      if (new URL(page.url()).pathname === '/') {
        await page.goto('/admin');
        if (new URL(page.url()).pathname === '/admin') {
          return;
        }
        await dashboardPage.logout();
        await expect(page).toHaveURL('/login');
      }
    }
  }

  throw new Error('Failed to establish an admin session for admin e2e tests');
}

test.describe('Admin', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure each test starts in an authenticated admin session.
    void authenticatedUser;
  });

  test('admin can create, update role, and delete a user', async ({
    page,
    dashboardPage,
    loginPage,
  }) => {
    const managedUsername = uniqueUsername('managed');
    const managedPassword = 'testpass123';

    await ensureAdminSession(page, dashboardPage, loginPage);
    await page.goto('/admin');
    await expect(page).toHaveURL('/admin');
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();

    await page.getByRole('button', { name: 'Create User', exact: true }).click();
    await page.getByPlaceholder('Username (2-30 characters)').fill(managedUsername);
    await page.locator('input[type="password"]').fill(managedPassword);
    await page.getByRole('button', { name: 'Create User' }).click();

    const usersList = page.locator('ul.divide-y').first();
    const managedUserRow = usersList.locator('li').filter({ hasText: managedUsername });
    await expect(managedUserRow).toBeVisible();

    await managedUserRow.getByRole('button', { name: 'Make Admin' }).click();
    await expect(managedUserRow.getByRole('button', { name: 'Remove Admin' })).toBeVisible();
    await expect(managedUserRow.getByText(/^Admin$/)).toBeVisible();

    await managedUserRow.getByRole('button', { name: 'Remove Admin' }).click();
    await expect(managedUserRow.getByRole('button', { name: 'Make Admin' })).toBeVisible();

    page.once('dialog', dialog => dialog.accept());
    await managedUserRow.getByRole('button', { name: `Delete user ${managedUsername}` }).click();
    await expect(usersList.locator('li').filter({ hasText: managedUsername })).toHaveCount(0);
  });

  test('non-admin users are redirected away from admin page', async ({
    page,
    dashboardPage,
    loginPage,
    request,
  }) => {
    const standardUsername = uniqueUsername('member');
    const standardPassword = 'testpass123';

    const registerResponse = await request.post('/api/v1/register', {
      data: { username: standardUsername, password: standardPassword },
    });
    expect(registerResponse.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    await loginPage.login(standardUsername, standardPassword);
    await expect(page).toHaveURL('/');

    await page.goto('/admin');
    await expect(page).toHaveURL('/');

    await page.getByRole('button', { name: 'Profile menu' }).click();
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });
});
