import type { Page } from '@playwright/test';
import { confirmDialog } from './dialogs';

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

  urlField() {
    return this.section().getByLabel('Public link URL');
  }

  details() {
    return this.section().getByTestId('public-link-details');
  }

  async url(): Promise<string> {
    return this.urlField().inputValue();
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
