import path from 'path';
import { fileURLToPath } from 'url';
import { Page, expect, Locator } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SettingsPage {
  constructor(private page: Page) {}

  private sidebar(): Locator {
    return this.page.locator('aside[aria-label="Main navigation"]');
  }

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

  sessionsSection() {
    return this.page.getByRole('heading', { name: 'Active Sessions', exact: true }).locator('..');
  }

  sessionItems() {
    return this.sessionsSection().locator('li');
  }

  revokeDialog() {
    return this.page.getByRole('dialog', { name: 'Revoke session' });
  }

  revokeDialogTitle() {
    return this.page.getByRole('heading', { name: 'Revoke session' });
  }

  revokeSessionDialog() {
    return this.revokeDialog();
  }

  async openRevokeDialog(index?: number) {
    const revokeButtons = this.sessionsSection().getByRole('button', { name: 'Revoke' });
    if (typeof index === 'number') {
      await revokeButtons.nth(index).click();
      return;
    }

    await revokeButtons.first().click();
  }

  async openRevokeSessionDialog(index?: number) {
    await this.openRevokeDialog(index);
  }

  async clickRevokeConfirm() {
    await this.revokeDialog().getByRole('button', { name: 'Revoke' }).click();
  }

  async confirmRevokeSession() {
    await this.clickRevokeConfirm();
  }

  async clickRevokeCancel() {
    await this.revokeDialog().getByRole('button', { name: 'Cancel' }).click();
  }

  async cancelRevokeSession() {
    await this.clickRevokeCancel();
  }

  async revokeSessionWithConfirmation(index?: number) {
    await this.openRevokeSessionDialog(index);
    await this.confirmRevokeSession();
  }

  async openSidebar() {
    await this.page.getByRole('button', { name: 'Toggle sidebar' }).click();
  }

  async isSidebarVisible() {
    await expect(this.sidebar()).toBeVisible();
  }

  async isSidebarHidden() {
    await expect(this.sidebar()).toBeHidden();
  }

  async clickMobileLabel(labelName = 'settings-mobile-label') {
    await this.sidebar().locator('ul').getByRole('button', { name: labelName, exact: true }).click();
  }

  private sidebarTab(label: string) {
    return this.sidebar().locator(`[aria-label="${label}"]`);
  }

  sidebarNotesTab() { return this.sidebarTab('Notes'); }
  sidebarMyTodoTab() { return this.sidebarTab('My Todo'); }
  sidebarArchiveTab() { return this.sidebarTab('Archive'); }
  sidebarBinTab() { return this.sidebarTab('Bin'); }

  private allNavTabs() {
    return [this.sidebarNotesTab(), this.sidebarMyTodoTab(), this.sidebarArchiveTab(), this.sidebarBinTab()];
  }

  async expectSidebarNavTabsVisible() {
    await Promise.all(this.allNavTabs().map(tab => expect(tab).toBeVisible()));
  }

  async expectNoTabActive() {
    await Promise.all(this.allNavTabs().map(tab => expect(tab).not.toHaveAttribute('aria-current', 'page')));
  }
}
