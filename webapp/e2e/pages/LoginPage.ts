import type { Page} from '@playwright/test';
import { expect } from '@playwright/test';

export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async login(username: string, password: string) {
    await this.page.fill('#username', username);
    await this.page.fill('#password', password);
    await this.page.click('button[type="submit"]');
  }

  async expectError(message: string) {
    await expect(this.page.getByRole('alert')).toContainText(message);
  }

  /** Warning shown after a sign-out whose `POST /logout` never reached the server. */
  pendingLogoutNotice() {
    return this.page.getByTestId('pending-logout-notice');
  }

  async retryPendingLogout() {
    await this.pendingLogoutNotice().getByRole('button', { name: 'Try again' }).click();
  }

  async expectRedirectedToDashboard() {
    await expect(this.page).toHaveURL('/');
  }
}
