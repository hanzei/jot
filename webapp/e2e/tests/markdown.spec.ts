import { test, expect } from '../fixtures';

test.describe('Markdown note editing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure we're logged in for every test in this suite
    void authenticatedUser;
  });

  test('markdown renders in note card after saving', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Bold Note', '**bold text**');

    const card = dashboardPage.noteCard('Bold Note');
    // Card content should render as <strong>, not raw **
    await expect(card.locator('strong')).toHaveText('bold text');
    await expect(card).not.toContainText('**bold text**');
  });

  test('preview renders markdown and clicking enters edit mode', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill('input[placeholder="Note title..."]', 'Heading Note');
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

  test('two-step backdrop dismiss: first click collapses to preview, second closes modal', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill('input[placeholder="Note title..."]', 'Backdrop Test');
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
