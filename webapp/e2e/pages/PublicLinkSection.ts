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

  /** The shortened link on show; the full URL is only ever copied. */
  urlField() {
    return this.section().getByTestId('public-link-url');
  }

  changeButton() {
    return this.section().getByRole('button', { name: 'Change expiry' });
  }

  /** The expiry editor's select, shown after Change. */
  newExpirySelect() {
    return this.section().getByLabel('New expiry');
  }

  saveButton() {
    return this.section().getByRole('button', { name: 'Save' });
  }

  cancelButton() {
    return this.section().getByRole('button', { name: 'Cancel' });
  }

  details() {
    return this.section().getByTestId('public-link-details');
  }

  /**
   * The full URL, read from the clipboard after Copy link: the section only
   * shows a shortened one. The test must grant `clipboard-read` and
   * `clipboard-write`.
   */
  async url(): Promise<string> {
    await this.copy();
    return readClipboard(this.page);
  }

  /** The section shows `url` only shortened: never its full token, in text or in a field. */
  async expectTokenHidden(url: string) {
    const token = new URL(url).pathname.split('/').pop()!;
    await expect(this.urlField()).toHaveText(new RegExp(`/share/${token.slice(0, 4)}…$`));
    await expect(this.section()).not.toContainText(token);
    await expect(this.section().locator('input')).toHaveCount(0);
  }

  async create(expiry: ExpiryLabel = 'Never') {
    await this.section().getByLabel('Expires').selectOption({ label: expiry });
    await this.createButton().click();
    await this.urlField().waitFor();
  }

  async copy() {
    await this.section().getByRole('button', { name: 'Copy link' }).click();
  }

  /** Change → pick `expiry` → Save, waiting for the editor to close. */
  async changeExpiry(expiry: ExpiryLabel) {
    await this.changeButton().click();
    await this.newExpirySelect().selectOption({ label: expiry });
    await this.saveButton().click();
    await this.changeButton().waitFor();
  }

  async revoke() {
    await this.section().getByRole('button', { name: 'Revoke link' }).click();
    await confirmDialog(this.page, 'Revoke');
  }
}
