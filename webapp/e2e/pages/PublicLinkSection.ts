import type { Page } from '@playwright/test';
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

  details() {
    return this.section().getByTestId('public-link-details');
  }

  /** The full URL, as Copy link puts it on the clipboard. */
  async copiedUrl(): Promise<string> {
    await this.copy();
    return readClipboard(this.page);
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
