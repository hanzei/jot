import { Page, expect } from '@playwright/test';

export class SettingsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/settings');
  }

  async changeUsername(newUsername: string) {
    await this.page.getByLabel('Username').fill(newUsername);
    await this.page.getByRole('button', { name: 'Save Changes' }).click();
  }

  async changePassword(currentPassword: string, newPassword: string) {
    await this.page.getByLabel('Current password').fill(currentPassword);
    await this.page.getByLabel('New password').fill(newPassword);
    await this.page.getByLabel('Confirm password').fill(newPassword);
    await this.page.getByRole('button', { name: 'Change Password' }).click();
  }

  async expectSuccess(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  async expectError(message: string) {
    await expect(this.page.locator('[role="alert"]').filter({ hasText: message })).toBeVisible();
  }
}
