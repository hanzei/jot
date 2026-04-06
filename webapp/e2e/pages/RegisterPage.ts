import { Page, expect } from '@playwright/test';

export class RegisterPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/register');
  }

  async register(username: string, password: string, confirmPassword?: string) {
    await this.page.fill('#username', username);
    await this.page.fill('#password', password);
    await this.page.fill('#confirm-password', confirmPassword ?? password);
    await this.page.click('button[type="submit"]');
  }

  async expectError(message: string) {
    await expect(this.page.getByRole('alert')).toContainText(message);
  }

  async expectRedirectedToDashboard() {
    await expect(this.page).toHaveURL('/');
  }
}
