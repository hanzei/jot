import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The "open this note in the Jot app" overlay, and the settings row that
 * controls it.
 *
 * Only meaningful in the `mobile-chrome` project: the handoff is gated on a
 * coarse pointer, so on desktop every locator here is correctly empty.
 */
export class MobileAppHandoffPage {
  /** Selector for the prompt, for scoping an axe scan to the overlay. */
  static readonly PROMPT_SELECTOR = '[data-testid="mobile-app-handoff-prompt"]';

  constructor(private page: Page) {}

  get prompt(): Locator {
    return this.page.getByTestId('mobile-app-handoff-prompt');
  }

  /** The spinner shown while a `jot://` navigation is in flight. */
  get attempting(): Locator {
    return this.page.getByTestId('mobile-app-handoff-attempting');
  }

  /** The "app did not answer" note, shown after a failed attempt. */
  get failureNotice(): Locator {
    return this.page.getByTestId('mobile-app-handoff-failed');
  }

  get openInAppButton(): Locator {
    return this.page.getByTestId('mobile-app-handoff-open');
  }

  get stayInBrowserButton(): Locator {
    return this.page.getByTestId('mobile-app-handoff-stay');
  }

  /** The Settings checkbox that turns the handoff back on after a dismissal. */
  get preferenceToggle(): Locator {
    return this.page.getByTestId('mobile-app-handoff-preference').getByRole('checkbox');
  }

  async expectPromptVisible() {
    await expect(this.prompt).toBeVisible();
  }

  async expectPromptHidden() {
    await expect(this.prompt).toBeHidden();
  }

  async openInApp() {
    await this.openInAppButton.click();
  }

  async stayInBrowser() {
    await this.stayInBrowserButton.click();
    await this.expectPromptHidden();
  }

  /** Turn the handoff back on from Settings, asserting it was off first. */
  async enableFromSettings() {
    await this.page.goto('/settings');
    await expect(this.preferenceToggle).not.toBeChecked();
    await this.preferenceToggle.check();
  }

  /**
   * Pretend a previous handoff from this browser reached the app, which is what
   * turns the prompt into an automatic attempt. Must run before the navigation
   * it should affect.
   */
  async seedAppInstalled() {
    await this.page.addInitScript((key) => {
      window.localStorage.setItem(key, '1');
    }, MobileAppHandoffPage.INSTALLED_KEY);
  }

  /** The stored "this browser has reached the app" flag, or null if cleared. */
  installedFlag(): Promise<string | null> {
    return this.page.evaluate(
      (key) => window.localStorage.getItem(key),
      MobileAppHandoffPage.INSTALLED_KEY,
    );
  }

  /**
   * Chromium has no `jot://` handler, so it never actually leaves the page.
   * Drive the signal the component listens for instead: the browser losing
   * visibility to another app.
   */
  async simulateAppTookOver() {
    await this.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  /** Owned by webapp/src/utils/mobileAppHandoff.ts. */
  private static readonly INSTALLED_KEY = 'jot_mobile_app_installed';
}
