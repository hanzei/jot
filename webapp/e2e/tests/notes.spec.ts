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

  test('pressing Enter on a todo item jumps to the next item', async ({ page, dashboardPage }) => {
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

    // The second item should now be focused
    await expect(page.locator('input[placeholder="List item..."]').nth(1)).toBeFocused();
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
