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

    const firstUpload = await page.request.post('/api/v1/images', {
      multipart: { note_id: note!.id, file: noteImageFile },
    });
    expect(firstUpload.ok()).toBeTruthy();

    await page.reload();
    await dashboardPage.openNote(title);

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();
    await expect(dialog.getByTestId('note-image-grid')).not.toBeAttached();

    await dashboardPage.closeNoteModal();

    // A second image switches the gallery from a banner to a grid.
    const secondUpload = await page.request.post('/api/v1/images', {
      multipart: { note_id: note!.id, file: noteImageFile },
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

  test('shows the first image as a cover thumbnail on the note card, with a +N badge for extra images', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    const title = `Cover note ${Date.now()}`;
    await dashboardPage.createNote(title);

    const notesResponse = await page.request.get('/api/v1/notes');
    const notesList: Array<{ id: string; title?: string }> = await notesResponse.json();
    const note = notesList.find((n) => n.title === title);
    expect(note).toBeTruthy();

    const firstUpload = await page.request.post('/api/v1/images', {
      multipart: { note_id: note!.id, file: noteImageFile },
    });
    expect(firstUpload.ok()).toBeTruthy();

    await page.reload();

    const card = page.locator('[data-testid="note-card"]').filter({
      has: page.locator('h3').getByText(title, { exact: true }),
    });
    await expect(card.getByTestId('note-card-cover')).toBeVisible();
    await expect(card.getByAltText('test-icon.png')).toBeVisible();
    await expect(card.getByText(/^\+\d+$/)).not.toBeAttached();

    // A second image adds a "+N" badge on the same cover.
    const secondUpload = await page.request.post('/api/v1/images', {
      multipart: { note_id: note!.id, file: noteImageFile },
    });
    expect(secondUpload.ok()).toBeTruthy();

    await page.reload();
    await expect(card.getByText('+1')).toBeVisible();
  });

  test('uploads an image via the toolbar picker', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    const title = `Toolbar upload note ${Date.now()}`;
    await dashboardPage.createNote(title);
    await dashboardPage.openNote(title);

    const dialog = page.getByRole('dialog').last();
    await dialog.getByTestId('note-image-file-input').setInputFiles(path.join(__dirname, '../fixtures/test-icon.png'));

    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();
    await expect(dialog.getByTestId('image-upload-tile')).not.toBeAttached();

    // Re-check in the SAME session, after the upload placeholder is gone —
    // the uploading tab's own note_image_added SSE event is dropped (self-
    // echo suppression), so this specifically guards against the real tile
    // only ever showing up after a reload instead of right away.
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();

    // Persisted across a reload — the upload actually landed server-side.
    await dashboardPage.closeNoteModal();
    await page.reload();
    await dashboardPage.openNote(title);
    await expect(page.getByRole('dialog').last().getByAltText('test-icon.png')).toBeVisible();
  });

  test('still shows an uploaded image after closing and reopening the note, without a page reload', async ({ page, dashboardPage }) => {
    // Regression test: closing the modal destroys NoteModal's local
    // optimistic-image overlay, so reopening the note relies entirely on
    // Dashboard's own note list having been corrected — which only happens
    // if the upload success handler explicitly refreshes it (the uploader's
    // own note_image_added SSE event is dropped by self-echo suppression).
    await dashboardPage.goto();
    const title = `Reopen upload note ${Date.now()}`;
    await dashboardPage.createNote(title);
    await dashboardPage.openNote(title);

    const dialog = page.getByRole('dialog').last();
    await dialog.getByTestId('note-image-file-input').setInputFiles(path.join(__dirname, '../fixtures/test-icon.png'));
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();
    await expect(dialog.getByTestId('image-upload-tile')).not.toBeAttached();

    // Close and reopen the SAME note — deliberately no page.reload() here.
    await dashboardPage.closeNoteModal();
    await dashboardPage.openNote(title);
    await expect(page.getByRole('dialog').last().getByAltText('test-icon.png')).toBeVisible();
  });

  test('removes an image via the bin icon and undo restores it', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    const title = `Remove undo note ${Date.now()}`;
    await dashboardPage.createNote(title);

    const notesResponse = await page.request.get('/api/v1/notes');
    const notesList: Array<{ id: string; title?: string }> = await notesResponse.json();
    const note = notesList.find((n) => n.title === title);
    expect(note).toBeTruthy();

    const upload = await page.request.post('/api/v1/images', {
      multipart: { note_id: note!.id, file: noteImageFile },
    });
    expect(upload.ok()).toBeTruthy();

    await page.reload();
    await dashboardPage.openNote(title);

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();

    await dialog.getByRole('button', { name: 'Remove test-icon.png' }).click();
    await expect(dialog.getByAltText('test-icon.png')).not.toBeAttached();

    // The undo control is rendered inline inside the modal (not the app-wide
    // toast) so clicking it can never be mistaken for an outside click that
    // closes the dialog.
    await expect(dialog.getByText('Image removed')).toBeVisible();
    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog.getByAltText('test-icon.png')).toBeVisible();

    // The undo cancelled the deferred DELETE — the image is still there
    // server-side, not just re-added client-side.
    await dashboardPage.closeNoteModal();
    await page.reload();
    await dashboardPage.openNote(title);
    await expect(page.getByRole('dialog').last().getByAltText('test-icon.png')).toBeVisible();
  });
});
