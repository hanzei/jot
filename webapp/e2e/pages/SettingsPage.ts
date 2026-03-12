import path from 'path';
import { fileURLToPath } from 'url';
import { Page, expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    await this.page.getByLabel('New Password', { exact: true }).fill(newPassword);
    await this.page.getByLabel('Confirm New Password').fill(newPassword);
    await this.page.getByRole('button', { name: 'Change Password' }).click();
  }

  async expectSuccess(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  async expectError(message: string) {
    await expect(this.page.locator('[role="alert"]').filter({ hasText: message })).toBeVisible();
  }

  async selectTheme(theme: 'System Default' | 'Light' | 'Dark') {
    await this.page.getByLabel('App theme').selectOption(theme);
  }

  async getThemeSelectValue() {
    return this.page.getByLabel('App theme').inputValue();
  }

  async isDarkMode() {
    return this.page.evaluate(() => document.documentElement.classList.contains('dark'));
  }

  async uploadProfileIcon(fixtureName = 'test-icon.png') {
    const filePath = path.join(__dirname, '../fixtures', fixtureName);
    const fileInput = this.page.locator('input[type="file"][accept]');
    await fileInput.setInputFiles(filePath);
  }

  async removeProfileIcon() {
    await this.page.getByRole('button', { name: 'Remove icon' }).click();
  }

  profileIconPreview() {
    // Navigate from the "Profile Icon" heading up to the card div, then find img inside it
    return this.page.getByRole('heading', { name: 'Profile Icon', exact: true })
      .locator('..')
      .locator('img');
  }

  navProfileIcon() {
    return this.page.locator('header img[alt]').filter({ visible: true }).first();
  }
}
