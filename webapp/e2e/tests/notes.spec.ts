import { test, expect } from '../fixtures';

test.describe('Notes', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure we're logged in for every test in this suite
    void authenticatedUser;
  });

  test('creates a text note and shows it on the dashboard', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('My First Note', 'Some content here');
    await dashboardPage.expectNoteVisible('My First Note');
  });

  test('creates a note without content', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Title Only Note');
    await dashboardPage.expectNoteVisible('Title Only Note');
  });

  test('edits a note title and content', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Original Title', 'Original content');

    await dashboardPage.editNote('Original Title', 'Updated Title', 'Updated content');

    await dashboardPage.expectNoteVisible('Updated Title');
    await dashboardPage.expectNoteNotVisible('Original Title');
  });

  test('deletes a note', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to Delete');
    await dashboardPage.expectNoteVisible('Note to Delete');

    await dashboardPage.deleteNote('Note to Delete');
    await dashboardPage.expectNoteNotVisible('Note to Delete');
  });

  test('restores a deleted note from bin', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Restore Me');

    await dashboardPage.deleteNote('Restore Me');
    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Restore Me');

    await dashboardPage.restoreNoteFromBin('Restore Me');
    await dashboardPage.expectNoteNotVisible('Restore Me');

    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteVisible('Restore Me');
  });

  test('permanently deletes a note from bin', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Delete Forever');

    await dashboardPage.deleteNote('Delete Forever');
    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Delete Forever');

    await dashboardPage.permanentlyDeleteNoteFromBin('Delete Forever');
    await dashboardPage.expectNoteNotVisible('Delete Forever');

    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteNotVisible('Delete Forever');
  });

  test('pins a note and it appears in the pinned section', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to Pin');

    await dashboardPage.pinNote('Note to Pin');

    // Pinned section heading should appear
    await expect(page.locator('h2:has-text("Pinned")')).toBeVisible();
    // The pin icon should be visible on the card
    await expect(dashboardPage.noteCard('Note to Pin').locator('[data-testid="pin-icon"]')).toBeVisible();
  });

  test('unpins a pinned note', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Pinned Note');
    await dashboardPage.pinNote('Pinned Note');
    await expect(page.locator('h2:has-text("Pinned")')).toBeVisible();

    await dashboardPage.unpinNote('Pinned Note');
    // Pin icon should no longer be visible
    await expect(dashboardPage.noteCard('Pinned Note').locator('[data-testid="pin-icon"]')).toHaveCount(0);
  });

  test('archives a note and it disappears from main view', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to Archive');
    await dashboardPage.expectNoteVisible('Note to Archive');

    await dashboardPage.archiveNote('Note to Archive');
    await dashboardPage.expectNoteNotVisible('Note to Archive');
  });

  test('archived note appears in archive view', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Archived Note');
    await dashboardPage.archiveNote('Archived Note');

    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Archived Note');
  });

  test('unarchives a note and it reappears in main view', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('To Unarchive');
    await dashboardPage.archiveNote('To Unarchive');

    await dashboardPage.switchToArchived();
    await dashboardPage.unarchiveNote('To Unarchive');

    await dashboardPage.goto();
    await dashboardPage.expectNoteVisible('To Unarchive');
  });

  test('creates a todo note with items', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Shopping List', ['Apples', 'Bread', 'Milk']);

    const card = dashboardPage.noteCard('Shopping List');
    await expect(card.getByText('Apples')).toBeVisible();
    await expect(card.getByText('Bread')).toBeVisible();
    await expect(card.getByText('Milk')).toBeVisible();
    void page;
  });

  test('shows empty state when no notes exist', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.expectEmptyState('No notes yet');
  });

  test('pressing Enter on a non-last todo item inserts a new item below it', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await page.click('button:has-text("New Note")');
    await page.click('button:has-text("Todo List")');

    // Add two items via the button
    await page.click('button:has-text("Add item")');
    await page.locator('input[placeholder="List item..."]').last().fill('First item');
    await page.click('button:has-text("Add item")');
    await page.locator('input[placeholder="List item..."]').last().fill('Second item');

    // Focus the first item and press Enter
    await page.locator('input[placeholder="List item..."]').first().focus();
    await page.keyboard.press('Enter');

    // A new empty item should be inserted between the existing two items and focused
    await expect(page.locator('input[placeholder="List item..."]')).toHaveCount(3);
    await expect(page.locator('input[placeholder="List item..."]').first()).toHaveValue('First item');
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toBeFocused();
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toHaveValue('');
    await expect(page.locator('input[placeholder="List item..."]').nth(2)).toHaveValue('Second item');
  });

  test('arrow keys navigate between todo items', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await page.click('button:has-text("New Note")');
    await page.click('button:has-text("Todo List")');

    // Add three items
    for (const text of ['Alpha', 'Beta', 'Gamma']) {
      await page.click('button:has-text("Add item")');
      await page.locator('input[placeholder="List item..."]').last().fill(text);
    }

    // Focus the first item and press ArrowDown
    await page.locator('input[placeholder="List item..."]').first().focus();
    await expect(page.locator('input[placeholder="List item..."]').first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('input[placeholder="List item..."]').nth(2)).toBeFocused();

    // ArrowDown on last item should keep focus there
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('input[placeholder="List item..."]').nth(2)).toBeFocused();

    // ArrowUp back to second item
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toBeFocused();

    // ArrowUp back to first item
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('input[placeholder="List item..."]').first()).toBeFocused();

    // ArrowUp on first item should keep focus there
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('input[placeholder="List item..."]').first()).toBeFocused();
  });

  test('pressing Enter on the last todo item creates a new item', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await page.click('button:has-text("New Note")');
    await page.click('button:has-text("Todo List")');

    // Add one item
    await page.click('button:has-text("Add item")');
    await page.locator('input[placeholder="List item..."]').last().fill('Only item');

    // Press Enter on the only (last) item
    await page.locator('input[placeholder="List item..."]').last().press('Enter');

    // A new empty input should appear and be focused
    await expect(page.locator('input[placeholder="List item..."]')).toHaveCount(2);
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toBeFocused();
  });
});
