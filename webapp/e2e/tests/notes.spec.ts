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

  test('shows archive/bin view context help in sidebar and banners', async ({ dashboardPage }) => {
    await dashboardPage.goto();

    await dashboardPage.expectArchiveTabTooltip();
    await dashboardPage.expectBinTabTooltip();

    await dashboardPage.switchToArchived();
    await dashboardPage.expectArchiveInfoVisible();

    await dashboardPage.switchToBin();
    await dashboardPage.expectBinInfoVisible();
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

  test('creates a todo note with items', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Shopping List', ['Apples', 'Bread', 'Milk']);

    const card = dashboardPage.noteCard('Shopping List');
    await expect(card.getByText('Apples')).toBeVisible();
    await expect(card.getByText('Bread')).toBeVisible();
    await expect(card.getByText('Milk')).toBeVisible();
  });

  test('newly created notes appear at the first position', async ({ dashboardPage }) => {
    await dashboardPage.goto();

    await dashboardPage.createNote('First Note');
    await dashboardPage.createNote('Second Note');
    await dashboardPage.createNote('Third Note');

    // Most recently created note should be first
    await dashboardPage.expectNoteAtPosition(0, 'Third Note');
    await dashboardPage.expectNoteAtPosition(1, 'Second Note');
    await dashboardPage.expectNoteAtPosition(2, 'First Note');
  });

  test('reorders notes from drag handle and keeps card click-to-edit behavior', async ({ page, dashboardPage }, testInfo) => {
    test.skip(
      testInfo.project.name === 'mobile-chrome',
      'Mouse/pointer drag reorder is validated on desktop Chromium only'
    );

    await dashboardPage.goto();

    await dashboardPage.createNote('First Note');
    await dashboardPage.createNote('Second Note');

    await dashboardPage.expectNoteAtPosition(0, 'Second Note');
    await dashboardPage.expectNoteAtPosition(1, 'First Note');

    const secondNoteCard = dashboardPage.noteCard('Second Note');
    await secondNoteCard.hover();
    const secondNoteHandle = secondNoteCard
      .locator('..')
      .locator('..')
      .getByRole('button', { name: 'Drag to reorder' });
    await expect(secondNoteHandle).toBeVisible();
    const firstNoteCard = dashboardPage.noteCard('First Note');
    await secondNoteHandle.scrollIntoViewIfNeeded();
    await firstNoteCard.scrollIntoViewIfNeeded();
    await secondNoteHandle.dragTo(firstNoteCard, { steps: 12 });

    await dashboardPage.expectNoteAtPosition(0, 'First Note');
    await dashboardPage.expectNoteAtPosition(1, 'Second Note');

    await dashboardPage.openNote('Second Note');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();
    await page.click('button[aria-label="Close"]');

    await dashboardPage.archiveNote('Second Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.expectNoteVisible('Second Note');
    await expect(page.getByRole('button', { name: 'Drag to reorder' })).toHaveCount(0);
  });

  test('shows empty state when no notes exist', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.expectEmptyState('No notes yet');
  });

  test('pressing Enter on a non-last todo item inserts a new item below it', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectTodoType();

    await dashboardPage.addTodoItem('First item');
    await dashboardPage.addTodoItem('Second item');

    await dashboardPage.focusTodoItem(0);
    await dashboardPage.pressKey('Enter');

    await dashboardPage.expectTodoItemCount(3);
    await dashboardPage.expectTodoItemValue(0, 'First item');
    await dashboardPage.expectTodoItemFocused(1);
    await dashboardPage.expectTodoItemValue(1, '');
    await dashboardPage.expectTodoItemValue(2, 'Second item');
  });

  test('arrow keys navigate between todo items', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectTodoType();

    for (const text of ['Alpha', 'Beta', 'Gamma']) {
      await dashboardPage.addTodoItem(text);
    }

    await dashboardPage.focusTodoItem(0);
    await dashboardPage.expectTodoItemFocused(0);

    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectTodoItemFocused(1);

    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectTodoItemFocused(2);

    // ArrowDown on last item should keep focus there
    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectTodoItemFocused(2);

    // ArrowUp back to second item
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectTodoItemFocused(1);

    // ArrowUp back to first item
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectTodoItemFocused(0);

    // ArrowUp on first item should keep focus there
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectTodoItemFocused(0);
  });

  test('pressing Enter on the last todo item creates a new item', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectTodoType();

    await dashboardPage.addTodoItem('Only item');

    await dashboardPage.focusTodoItem(0);
    await dashboardPage.pressKey('Enter');

    await dashboardPage.expectTodoItemCount(2);
    await dashboardPage.expectTodoItemFocused(1);
  });
});
