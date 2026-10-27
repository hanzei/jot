import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

interface ApiNote {
  id: string;
  note_type: 'text' | 'list';
  title?: string;
  content?: string;
  version: number;
  items?: { id: string; text: string }[];
}

// Writes made through page.request carry no X-Client-Id, so they count as a
// different client from the tab: each one keeps the content it replaces as a
// revision, which is what gives these tests a history to look at.
async function apiCreate(page: Page, data: Record<string, unknown>): Promise<ApiNote> {
  const response = await page.request.post('/api/v1/notes', { data });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ApiNote;
}

async function apiGet(page: Page, id: string): Promise<ApiNote> {
  const response = await page.request.get(`/api/v1/notes/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ApiNote;
}

async function apiRevisionCount(page: Page, id: string): Promise<number> {
  const response = await page.request.get(`/api/v1/notes/${id}/revisions`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { revisions: unknown[] }).revisions.length;
}

/**
 * Note version history (#1129): every content write keeps what it replaced,
 * and the note modal's Version history panel previews, compares, and restores
 * those revisions.
 */
test.describe('Note version history', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('previews, compares, and restores an earlier version of a text note', async ({ page, dashboardPage, noteHistoryDialog, noteEditorPage, toastPage }) => {
    const note = await apiCreate(page, { note_type: 'text', content: 'First draft' });
    const patched = await page.request.patch(`/api/v1/notes/${note.id}`, { data: { content: 'Second draft' } });
    expect(patched.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.openTextNote('Second draft');
    await noteHistoryDialog.open();

    await expect(noteHistoryDialog.entries()).toHaveCount(1);
    await expect(noteHistoryDialog.preview()).toHaveText('First draft');

    await noteHistoryDialog.showComparison();
    await expect(noteHistoryDialog.diff().locator('[data-diff="removed"]')).toContainText('First draft');
    await expect(noteHistoryDialog.diff().locator('[data-diff="added"]')).toContainText('Second draft');

    await noteHistoryDialog.restore();

    await expect(noteEditorPage.preview()).toHaveText('First draft');
    await expect(toastPage.toastWithText('Version restored')).toBeVisible();
    expect((await apiGet(page, note.id)).content).toBe('First draft');
    // The restore kept what it replaced, so it can be undone the same way.
    expect(await apiRevisionCount(page, note.id)).toBe(2);
  });

  test('restoring a list version converts a since-converted note back to a list', async ({ page, dashboardPage, noteHistoryDialog }) => {
    const note = await apiCreate(page, {
      note_type: 'list',
      title: 'Groceries',
      items: [{ text: 'Milk', position: 0 }, { text: 'Eggs', position: 1 }],
    });
    const converted = await page.request.post(`/api/v1/notes/${note.id}/convert`, {
      data: { note_type: 'text', content: 'Milk and eggs', base_version: note.version },
    });
    expect(converted.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.openTextNote('Milk and eggs');
    await noteHistoryDialog.open();

    await expect(noteHistoryDialog.preview().getByRole('heading', { name: 'Groceries' })).toBeVisible();
    await expect(noteHistoryDialog.preview()).toContainText('Milk');
    await noteHistoryDialog.showComparison();
    await expect(noteHistoryDialog.diff()).toContainText('This version was a list.');

    await noteHistoryDialog.restore();

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.locator('input[placeholder="Note title..."]')).toHaveValue('Groceries');
    await expect(dashboardPage.listItemInput(0)).toHaveValue('Milk');
    await expect(dashboardPage.listItemInput(1)).toHaveValue('Eggs');

    const restored = await apiGet(page, note.id);
    expect(restored.note_type).toBe('list');
    // Restored items keep their IDs.
    expect(restored.items?.map(item => item.id)).toEqual(note.items?.map(item => item.id));
  });

  test('explains an empty history', async ({ dashboardPage, noteHistoryDialog, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Fresh list');
    await dashboardPage.openNote('Fresh list');
    await noteHistoryDialog.open();

    await expect(page.getByTestId('note-history-empty')).toContainText('No earlier versions yet.');
    await noteHistoryDialog.close();
  });
});
