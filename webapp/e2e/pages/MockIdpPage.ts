import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { MOCK_IDP_ISSUER } from '../fixtures/mock-idp';

/**
 * The mock identity provider's authorize page (`e2e/fixtures/mock-idp.ts`),
 * where the `sso` project stands in for a person signing in at their IdP.
 */
export class MockIdpPage {
  constructor(private page: Page) {}

  get usernameInput(): Locator {
    return this.page.getByLabel('Username');
  }

  async expectOnAuthorizePage() {
    await expect(this.page).toHaveURL((url) => url.origin === MOCK_IDP_ISSUER && url.pathname === '/authorize');
    await expect(this.page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  }

  /** Signs in at the IdP as `username` and consents, sending the browser back to Jot. */
  async approve(username: string) {
    await this.expectOnAuthorizePage();
    await this.usernameInput.fill(username);
    await this.page.getByRole('button', { name: 'Approve' }).click();
  }

  /** Declines at the IdP, which sends the browser back to Jot with `error=access_denied`. */
  async deny() {
    await this.expectOnAuthorizePage();
    await this.page.getByRole('button', { name: 'Deny' }).click();
  }
}
