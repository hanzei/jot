import { Page, expect } from '@playwright/test';

export class SettingsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/settings');
  }

  async changeUsername(newUsername: string) {
    await this.page.fill('#username', newUsername);
    await this.page.click('button:has-text("Save Changes")');
  }

  async changePassword(currentPassword: string, newPassword: string) {
    await this.page.fill('#current-password', currentPassword);
    await this.page.fill('#new-password', newPassword);
    await this.page.fill('#confirm-password', newPassword);
    await this.page.click('button:has-text("Change Password")');
  }

  async expectSuccess(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  async expectError(message: string) {
    await expect(this.page.locator('[role="alert"]').filter({ hasText: message })).toBeVisible();
  }
}
