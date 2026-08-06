import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/** The six actions on the Markdown formatting toolbar, by testid suffix. */
export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'heading'
  | 'bullet'
  | 'checkbox';

/**
 * The text-note editor inside the note modal: its textarea, the Markdown
 * formatting toolbar, and the rendered preview it collapses to.
 *
 * List-note editing lives on DashboardPage with the rest of the modal; this
 * covers the text-note content surface only.
 */
export class NoteEditorPage {
  constructor(private page: Page) {}

  dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  textarea(): Locator {
    return this.dialog().locator('textarea[placeholder="Take a note..."]');
  }

  toolbar(): Locator {
    return this.page.getByTestId('markdown-toolbar');
  }

  formatButton(action: FormatAction): Locator {
    return this.page.getByTestId(`format-${action}-btn`);
  }

  preview(): Locator {
    return this.page.getByTestId('note-content-preview');
  }

  /** Opens a new text note and waits for the editor to be ready to type into. */
  async openNewNote(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'New Note' }).click();
    const textarea = this.textarea();
    await expect(textarea).toBeVisible();
    return textarea;
  }

  async setContent(content: string) {
    await this.textarea().fill(content);
  }

  /**
   * Selects a character range in the textarea.
   *
   * Playwright has no selection API, and the toolbar reads the live selection,
   * so the range has to be set in the page.
   */
  async selectRange(start: number, end: number) {
    await this.textarea().evaluate(
      (node: HTMLTextAreaElement, range: { start: number; end: number }) => {
        node.focus();
        node.setSelectionRange(range.start, range.end);
      },
      { start, end },
    );
  }

  async clickFormat(action: FormatAction) {
    await this.formatButton(action).click();
  }

  /** Collapses the editor to its rendered preview (the Escape half of #829). */
  async collapseToPreview() {
    await this.textarea().press('Escape');
    await expect(this.preview()).toBeVisible();
  }

  async expectContent(expected: string) {
    await expect(this.textarea()).toHaveValue(expected);
  }
}
