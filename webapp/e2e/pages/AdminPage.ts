import { Page, expect } from '@playwright/test';

export class AdminPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/admin');
  }

  async isVisible() {
    await expect(this.page.getByTestId('admin-stats-section')).toBeVisible();
    await expect(this.page.getByRole('heading', { name: 'User Management' })).toBeVisible();
    return true;
  }

  async getUsersTotal() {
    return this.page.getByTestId('admin-stats-users-total').innerText();
  }

  async getNotesTotal() {
    return this.page.getByTestId('admin-stats-notes-total').innerText();
  }

  async getSharedNotesCount() {
    return this.page.getByTestId('admin-stats-shared-notes').innerText();
  }

  async getLabelsTotal() {
    return this.page.getByTestId('admin-stats-labels-total').innerText();
  }

  async getTodoItemsTotal() {
    return this.page.getByTestId('admin-stats-todo-items-total').innerText();
  }

  async getDatabaseSizeText() {
    return this.page.getByTestId('admin-stats-database-size').innerText();
  }
}
