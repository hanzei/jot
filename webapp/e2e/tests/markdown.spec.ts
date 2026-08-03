import { test, expect } from '../fixtures';

test.describe('Markdown note editing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure we're logged in for every test in this suite
    void authenticatedUser;
  });

  test('markdown renders in note card after saving', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    // Text notes have content (not title); create one with markdown content.
    await dashboardPage.createTextNote('**bold text**');

    // Find the card by its rendered content text.
    const card = dashboardPage.noteCardByText('bold text');
    // Card content should render as <strong>, not raw **
    await expect(card.locator('strong')).toHaveText('bold text');
    await expect(card).not.toContainText('**bold text**');
  });

  test('preview renders markdown and clicking enters edit mode', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    // Intentionally keep the modal open after creation to test in-modal interactions,
    // so we bypass dashboardPage.createNote() which closes the dialog before returning.
    await dashboardPage.clickNewNote();
    // Text notes have no title input; fill content directly.
    await page.fill('textarea[placeholder="Take a note..."]', '## Heading');

    // Escape collapses the content area from edit mode to preview (modal stays open)
    await page.keyboard.press('Escape');

    const dialog = page.getByRole('dialog');
    const preview = dialog.getByTestId('note-content-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h2')).toBeVisible();
    await expect(dialog.locator('textarea[placeholder="Take a note..."]')).toHaveCount(0);

    // Clicking the preview div re-enters edit mode
    await preview.click();
    await expect(dialog.locator('textarea[placeholder="Take a note..."]')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  // The full feature set is specified in docs/specs/markdown-rendering.md and
  // pinned per-construct by the unit tests on both clients; these two cover it
  // end to end, on real note content, in the browser.
  test('renders the supported syntax in the preview', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill(
      'textarea[placeholder="Take a note..."]',
      [
        '### Third heading',
        '',
        '#### Fourth heading',
        '',
        '**bold** and ~~struck~~',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '```',
        'const a = 1;',
        '```',
        '',
        '---',
        '',
        'visit https://example.com now',
      ].join('\n'),
    );
    await page.keyboard.press('Escape');

    const preview = page.getByRole('dialog').getByTestId('note-content-preview');
    await expect(preview.locator('h3')).toHaveText('Third heading');
    // h4 and below are headings, but sized as bold body text.
    await expect(preview.locator('h4')).toHaveText('Fourth heading');
    const bodySize = await preview.locator('p').first().evaluate((el) => getComputedStyle(el).fontSize);
    await expect(preview.locator('h4')).toHaveCSS('font-size', bodySize);
    await expect(preview.locator('h4')).toHaveCSS('font-weight', '700');
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('del')).toHaveText('struck');
    await expect(preview.locator('li').nth(0)).toHaveText('☑ done');
    await expect(preview.locator('li').nth(1)).toHaveText('☐ todo');
    // Checkboxes are glyphs, not inputs — nothing to toggle.
    await expect(preview.locator('input')).toHaveCount(0);
    await expect(preview.locator('pre')).toContainText('const a = 1;');
    await expect(preview.locator('hr')).toHaveCount(1);
    await expect(preview.locator('a[href="https://example.com"]')).toBeVisible();
  });

  test('shows unsupported syntax as literal source and refuses unsupported link schemes', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill(
      'textarea[placeholder="Take a note..."]',
      [
        '![alt](https://example.com/y.png)',
        '',
        'a | b',
        '--- | ---',
        '1 | 2',
        '',
        '[call](tel:+15550100)',
      ].join('\n'),
    );
    await page.keyboard.press('Escape');

    const preview = page.getByRole('dialog').getByTestId('note-content-preview');
    await expect(preview).toContainText('![alt](https://example.com/y.png)');
    await expect(preview.locator('img')).toHaveCount(0);
    await expect(preview).toContainText('a | b');
    await expect(preview.locator('table')).toHaveCount(0);
    // tel: renders as its label, with nothing to follow.
    await expect(preview).toContainText('call');
    await expect(preview.locator('a')).toHaveCount(0);
  });

  // List-item text renders the inline subset (docs/specs/markdown-rendering.md
  // §2.1). The card is the display surface; the editor row deliberately still
  // shows source, which is what the second test below pins.
  test('renders the inline subset in list-note item text on the card', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Shopping', [
      'buy **milk** and *bread*',
      '~~cancelled~~ item',
      'run `npm ci`',
      'see https://example.com',
      '[docs](https://example.com/docs)',
    ]);

    const card = dashboardPage.noteCardByText('Shopping');
    await expect(card.locator('strong')).toHaveText('milk');
    await expect(card.locator('em')).toHaveText('bread');
    await expect(card.locator('del')).toHaveText('cancelled');
    await expect(card.locator('code')).toHaveText('npm ci');
    await expect(card.locator('a[href="https://example.com"]')).toBeVisible();
    await expect(card.locator('a[href="https://example.com/docs"]')).toHaveText('docs');
    // The source markers are gone, not merely restyled.
    await expect(card).not.toContainText('**milk**');
  });

  test('leaves block syntax literal in list items and keeps the editor row showing source', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Literal', [
      '# not a heading',
      '- [ ] not a checkbox',
      '[call](tel:+15550100)',
    ]);

    // An item is already a list item, so block syntax has nothing to describe.
    const card = dashboardPage.noteCardByText('Literal');
    await expect(card).toContainText('# not a heading');
    await expect(card).toContainText('- [ ] not a checkbox');
    await expect(card.locator('h1')).toHaveCount(0);
    // tel: renders as its label, with nothing to follow.
    await expect(card).toContainText('call');
    await expect(card.locator('a')).toHaveCount(0);

    // Reopening the note shows the raw source in the editable row — rendering
    // there is #824, and this assertion is what will need updating when it lands.
    await dashboardPage.openNote('Literal');
    await dashboardPage.expectListItemValue(0, '# not a heading');
  });

  test('two-step Escape dismiss: first Escape collapses to preview, second Escape closes modal', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    // Intentionally keep the modal open — see comment in previous test.
    await dashboardPage.clickNewNote();
    // Text notes have no title input; fill content directly.
    await page.fill('textarea[placeholder="Take a note..."]', 'Some content');

    const dialog = page.getByRole('dialog');
    const textarea = dialog.locator('textarea[placeholder="Take a note..."]');
    await expect(textarea).toBeVisible();

    // First Escape: textarea's onKeyDown collapses to preview; modal stays open
    await textarea.focus();
    await page.keyboard.press('Escape');

    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(textarea).toHaveCount(0);
    await expect(dialog.getByTestId('note-content-preview')).toBeVisible();

    // Second Escape: isEditingContent is now false, so onClose closes the modal
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
