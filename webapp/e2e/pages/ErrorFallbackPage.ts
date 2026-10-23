import type { Page, Locator } from '@playwright/test';

/**
 * The error boundaries' fallback. A render error is forced test-side by
 * answering an API call with a body the UI cannot render (a `null` entry in a
 * list), so no crash switch ships in the app.
 */
export class ErrorFallbackPage {
  constructor(private page: Page) {}

  /** The whole-app fallback, shown when the layout itself fails. */
  root(): Locator {
    return this.page.getByTestId('error-fallback-root');
  }

  /** The route-level fallback, shown inside the layout. */
  section(): Locator {
    return this.page.getByTestId('error-fallback-section');
  }

  /** Breaks the sidebar label list, which renders outside the route boundary. */
  async breakSidebarLabels() {
    await this.page.route('**/api/v1/labels', (route) =>
      route.fulfill({ json: { labels: [null] } }));
  }

  async unbreakSidebarLabels() {
    await this.page.unroute('**/api/v1/labels');
  }

  /** Breaks the dashboard's note list, which renders inside the route boundary. */
  async breakNoteList() {
    await this.page.route('**/api/v1/notes?*', (route) =>
      route.fulfill({ json: { notes: [null] } }));
  }

  async unbreakNoteList() {
    await this.page.unroute('**/api/v1/notes?*');
  }

  async copyDetails(fallback: Locator) {
    await fallback.getByRole('button', { name: 'Copy error details' }).click();
  }

  async clipboardText(): Promise<string> {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }
}
