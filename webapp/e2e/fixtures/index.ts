import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { DashboardPage } from '../pages/DashboardPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ToastPage } from '../pages/ToastPage';

export { expect };

/** Generate a unique username safe for concurrent test runs */
export function uniqueUsername(prefix = 'user'): string {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
}

type Fixtures = {
  loginPage: LoginPage;
  registerPage: RegisterPage;
  dashboardPage: DashboardPage;
  settingsPage: SettingsPage;
  toastPage: ToastPage;
  /** Register a fresh user and log them in; resolves to { username, password } */
  authenticatedUser: { username: string; password: string };
};

export const test = base.extend<Fixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  registerPage: async ({ page }, use) => {
    await use(new RegisterPage(page));
  },
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  toastPage: async ({ page }, use) => {
    await use(new ToastPage(page));
  },
  authenticatedUser: async ({ page }, use) => {
    const username = uniqueUsername();
    const password = 'testpass123';

    const registerPage = new RegisterPage(page);
    await registerPage.goto();
    await registerPage.register(username, password);
    await expect(page).toHaveURL('/');

    await use({ username, password });
  },
});
