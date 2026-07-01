import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/test-icon.png'));
const noteImageFile = { name: 'test-icon.png', mimeType: 'image/png', buffer: fixtureBuffer };

test.describe('Note image gallery', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('renders a banner for one image, a grid for two, and opens the lightbox', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    const title = `Gallery note ${Date.now()}`;
    await dashboardPage.createNote(title);

    const notesResponse = await page.request.get('/api/v1/notes');
    const notesList: Array<{ id: string; title?: string }> = await notesResponse.json();
    const note = notesList.find((n) => n.title === title);
    expect(note).toBeTruthy();

    const firstUpload = await page.request.post(`/api/v1/notes/${note!.id}/images`, {
      multipart: { file: noteImageFile },
    });
    expect(firstUpload.ok()).toBeTruthy();

    await page.reload();
    await dashboardPage.openNote(title);

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();
    await expect(dialog.getByTestId('note-image-grid')).not.toBeAttached();

    await dashboardPage.closeNoteModal();

    // A second image switches the gallery from a banner to a grid.
    const secondUpload = await page.request.post(`/api/v1/notes/${note!.id}/images`, {
      multipart: { file: noteImageFile },
    });
    expect(secondUpload.ok()).toBeTruthy();

    await page.reload();
    await dashboardPage.openNote(title);

    const grid = page.getByTestId('note-image-grid');
    await expect(grid.locator('img')).toHaveCount(2);

    await grid.locator('img').first().click();
    await expect(page.getByText('1 / 2')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText('1 / 2')).toBeHidden();
  });
});
