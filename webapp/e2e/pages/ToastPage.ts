import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class ToastPage {
  constructor(private page: Page) {}

  toastWithText(text: string) {
    return this.page.getByTestId('toast').filter({ hasText: text });
  }

  /** The copyable request-ID reference a server error toast carries. */
  referenceOf(toast: Locator) {
    return toast.getByTestId('toast-reference');
  }

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
