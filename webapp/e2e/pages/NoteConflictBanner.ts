import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The note modal's "This note was changed elsewhere" banner, shown when an
 * autosave of the title/content is rejected as stale (409 on base_version).
 */
export class NoteConflictBanner {
  constructor(private page: Page) {}

  /** The always-mounted live region the banner renders into. */
  region(): Locator {
    return this.page.getByTestId('note-conflict-region');
  }

  banner(): Locator {
    return this.page.getByTestId('note-conflict-banner');
  }

  reloadButton(): Locator {
    return this.banner().getByRole('button', { name: 'Reload' });
  }

  overwriteButton(): Locator {
    return this.banner().getByRole('button', { name: 'Overwrite' });
  }

  async expectVisible() {
    await expect(this.banner()).toBeVisible();
    await expect(this.banner()).toContainText('This note was changed elsewhere');
  }

  async expectHidden() {
    await expect(this.banner()).toHaveCount(0);
  }

  async reload() {
    await this.reloadButton().click();
  }

  async overwrite() {
    await this.overwriteButton().click();
  }
}
