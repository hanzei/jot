import type { Page } from '@playwright/test';

/** The read-only viewer behind a public note link (`/share/{token}`). */
export class PublicNotePage {
  constructor(private page: Page) {}

  async goto(token: string) {
    await this.page.goto(`/share/${token}`);
  }

  note() {
    return this.page.getByTestId('public-note');
  }

  heading() {
    return this.page.getByRole('heading', { level: 1 });
  }

  content() {
    return this.page.getByTestId('public-note-content');
  }

  activeItems() {
    return this.page.getByTestId('public-note-items').getByRole('listitem');
  }

  completedToggle() {
    return this.page.getByRole('button', { name: /^Completed items/ });
  }

  completedItems() {
    return this.page.getByTestId('public-note-completed-items');
  }

  /** The bar offering a signed-in visitor who can open the note a link to it. */
  openInAppBar() {
    return this.page.getByTestId('public-note-open-in-app');
  }

  openInAppLink() {
    return this.openInAppBar().getByRole('link', { name: 'Open note' });
  }

  notFound() {
    return this.page.getByRole('heading', { name: 'Note not found' });
  }
}
