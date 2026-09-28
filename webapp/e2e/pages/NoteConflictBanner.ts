import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The note modal's "This note was changed elsewhere" banner, shown when an
 * autosave of the title/content is rejected as stale (409 on base_version).
 */
export class NoteConflictBanner {
  constructor(private page: Page) {}

  banner(): Locator {
    return this.page.getByTestId('note-conflict-banner');
  }

  async expectVisible() {
    await expect(this.banner()).toBeVisible();
    await expect(this.banner()).toContainText('This note was changed elsewhere');
  }

  async expectHidden() {
    await expect(this.banner()).toHaveCount(0);
  }

  async reload() {
    await this.banner().getByRole('button', { name: 'Reload' }).click();
  }

  async overwrite() {
    await this.banner().getByRole('button', { name: 'Overwrite' }).click();
  }
}
