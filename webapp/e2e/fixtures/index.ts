import { randomInt } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { DashboardPage } from '../pages/DashboardPage';
import { NoteEditorPage } from '../pages/NoteEditorPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ToastPage } from '../pages/ToastPage';
import { MobileAppHandoffPage } from '../pages/MobileAppHandoffPage';
import { MockIdpPage } from '../pages/MockIdpPage';
import { NoteConflictBanner } from '../pages/NoteConflictBanner';
import { NoteHistoryDialog } from '../pages/NoteHistoryDialog';
import { ErrorFallbackPage } from '../pages/ErrorFallbackPage';

export { expect };

/** Credentials for the bootstrap admin user (first registered → admin role). */
export const E2E_ADMIN_CREDENTIALS = { username: 'e2eadmin', password: 'testpass123' };

/**
 * A suffix unique across concurrent test runs. `randomInt` rather than
 * `Math.random()`: the value ends up in usernames sent to `/register`, which
 * CodeQL's insecure-randomness query flags on every PR that touches a caller.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(1000, 10000)}`;
}

/** Generate a unique username safe for concurrent test runs */
export function uniqueUsername(prefix = 'user'): string {
  return `${prefix}${uniqueSuffix()}`;
}

type Fixtures = {
  loginPage: LoginPage;
  registerPage: RegisterPage;
  dashboardPage: DashboardPage;
  noteEditorPage: NoteEditorPage;
  settingsPage: SettingsPage;
  toastPage: ToastPage;
  mobileAppHandoffPage: MobileAppHandoffPage;
  /** The mock IdP's authorize page; only reachable from the `sso` project. */
  mockIdpPage: MockIdpPage;
  noteConflictBanner: NoteConflictBanner;
  noteHistoryDialog: NoteHistoryDialog;
  errorFallbackPage: ErrorFallbackPage;
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
  noteEditorPage: async ({ page }, use) => {
    await use(new NoteEditorPage(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  toastPage: async ({ page }, use) => {
    await use(new ToastPage(page));
  },
  mobileAppHandoffPage: async ({ page }, use) => {
    await use(new MobileAppHandoffPage(page));
  },
  mockIdpPage: async ({ page }, use) => {
    await use(new MockIdpPage(page));
  },
  noteConflictBanner: async ({ page }, use) => {
    await use(new NoteConflictBanner(page));
  },
  noteHistoryDialog: async ({ page }, use) => {
    await use(new NoteHistoryDialog(page));
  },
  errorFallbackPage: async ({ page }, use) => {
    await use(new ErrorFallbackPage(page));
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
