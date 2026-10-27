import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The note modal's Version history panel: a timeline of revisions, a preview
 * or a comparison with the current note, and Restore. Opened from the modal's
 * overflow menu, as its own dialog on top of the note modal.
 */
export class NoteHistoryDialog {
  constructor(private page: Page) {}

  dialog(): Locator {
    return this.page.getByTestId('note-history-dialog');
  }

  entries(): Locator {
    return this.page.getByTestId('note-history-entry');
  }

  preview(): Locator {
    return this.page.getByTestId('note-history-preview');
  }

  diff(): Locator {
    return this.page.getByTestId('note-history-diff');
  }

  restoreButton(): Locator {
    return this.page.getByTestId('note-history-restore');
  }

  /** The note modal's overflow-menu entry that opens the panel. */
  menuItem(): Locator {
    return this.page.getByRole('menuitem', { name: 'Version history' });
  }

  /** Opens the panel from the open note modal's overflow menu. */
  async open() {
    const menuButton = this.page.getByRole('dialog').last().getByRole('button', { name: 'Note options' });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await this.menuItem().click();
    await expect(this.dialog()).toBeVisible();
  }

  async showComparison() {
    await this.dialog().getByRole('button', { name: 'Compare with current' }).click();
    await expect(this.diff()).toBeVisible();
  }

  async showPreview() {
    await this.dialog().getByRole('button', { name: 'Preview' }).click();
    await expect(this.preview()).toBeVisible();
  }

  async restore() {
    await this.restoreButton().click();
    await expect(this.dialog()).toHaveCount(0);
  }

  async close() {
    await this.dialog().getByRole('button', { name: 'Close' }).click();
    await expect(this.dialog()).toHaveCount(0);
  }
}
