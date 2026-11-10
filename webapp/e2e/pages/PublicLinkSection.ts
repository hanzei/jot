import { expect, type Page } from '@playwright/test';
import { confirmDialog } from './dialogs';
import { readClipboard } from '../fixtures/clipboard';

export type ExpiryLabel = 'Never' | 'In 7 days' | 'In 30 days' | 'In 3 months';

/** The "Public link" section of the share dialog (ShareModal). */
export class PublicLinkSection {
  constructor(private page: Page) {}

  section() {
    return this.page.getByRole('dialog', { name: 'Collaborators' }).getByRole('region', { name: 'Public link' });
  }

  createButton() {
    return this.section().getByRole('button', { name: 'Create link' });
  }

  /** The link as shown: shortened, never with the full token. */
  urlField() {
    return this.section().getByTestId('public-link-url');
  }

  /** The shortened link's visible text, without its screen-reader label. */
  shownUrl() {
    return this.urlField().locator('[aria-hidden="true"]');
  }

  /** The full URL, offered in a selectable field only when copying failed. */
  fullUrlFallback() {
    return this.section().getByLabel('Public link URL');
  }

  details() {
    return this.section().getByTestId('public-link-details');
  }

  /**
   * The full URL, as Copy link puts it on the clipboard. The clipboard is
   * cleared first and polled after, since the write finishes asynchronously
   * and a stale value from an earlier copy must not count.
   */
  async copiedUrl(): Promise<string> {
    await this.page.evaluate(() => navigator.clipboard.writeText(''));
    await this.copy();
    let text = '';
    await expect.poll(async () => (text = await readClipboard(this.page))).not.toBe('');
    return text;
  }

  async create(expiry: ExpiryLabel = 'Never') {
    await this.section().getByLabel('Expires').selectOption({ label: expiry });
    await this.createButton().click();
    await this.urlField().waitFor();
  }

  async copy() {
    await this.section().getByRole('button', { name: 'Copy link' }).click();
  }

  async changeExpiry(expiry: ExpiryLabel) {
    await this.section().getByLabel('New expiry').selectOption({ label: expiry });
    await this.section().getByRole('button', { name: 'Change expiry' }).click();
  }

  async revoke() {
    await this.section().getByRole('button', { name: 'Revoke link' }).click();
    await confirmDialog(this.page, 'Revoke');
  }
}
