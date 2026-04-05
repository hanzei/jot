import { Page, expect } from '@playwright/test';

export class ToastPage {
  constructor(private page: Page) {}

  async waitForNoToasts() {
    await expect(this.page.getByTestId('toast')).toHaveCount(0, { timeout: 8000 });
  }

  async clickUndoOnLatestToast() {
    const toast = this.page.getByTestId('toast').last();
    await expect(toast).toBeVisible();
    const undoButton = toast.getByRole('button', { name: 'Undo' });
    await expect(undoButton).toBeVisible();
    await undoButton.click();
    await this.waitForNoToasts();
  }
}
