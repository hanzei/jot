import { test, expect } from '../fixtures';

test.describe('Search', () => {
  test.beforeEach(async ({ authenticatedUser, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    // Create a set of notes to search through
    await dashboardPage.createNote('TypeScript Tutorial', 'Learn TypeScript basics');
    await dashboardPage.createNote('Go Programming', 'Goroutines and channels');
    await dashboardPage.createNote('React Hooks', 'useState and useEffect');
  });

  test('finds notes by title', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');

    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteNotVisible('Go Programming');
    await dashboardPage.expectNoteNotVisible('React Hooks');
  });

  test('finds notes by content', async ({ dashboardPage }) => {
    await dashboardPage.search('Goroutines');

    await dashboardPage.expectNoteVisible('Go Programming');
    await dashboardPage.expectNoteNotVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteNotVisible('React Hooks');
  });

  test('shows empty state when search has no results', async ({ page, dashboardPage }) => {
    await dashboardPage.search('xyznonexistent');
    await expect(page.locator('[data-testid="note-card"]')).toHaveCount(0);
  });

  test('shows all notes when search is cleared', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');
    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteNotVisible('Go Programming');

    await dashboardPage.clearSearch();
    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteVisible('Go Programming');
    await dashboardPage.expectNoteVisible('React Hooks');
  });

  test('search is case-insensitive', async ({ dashboardPage }) => {
    await dashboardPage.search('typescript');
    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
  });

  test('clicking Notes tab clears search', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');
    await dashboardPage.expectNoteNotVisible('Go Programming');

    await dashboardPage.switchToArchived();
    await dashboardPage.switchToNotes();
    // Search should have been cleared when switching tabs
    await dashboardPage.expectSearchValue('');
    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteVisible('Go Programming');
    await dashboardPage.expectNoteVisible('React Hooks');
  });

  test('clicking Archive tab clears search', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');
    await dashboardPage.expectNoteNotVisible('Go Programming');

    await dashboardPage.switchToArchived();
    await dashboardPage.expectSearchValue('');
  });

  test('clicking Bin tab clears search', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');
    await dashboardPage.expectNoteNotVisible('Go Programming');

    await dashboardPage.switchToBin();
    await dashboardPage.expectSearchValue('');
  });

  test('clicking Jot logo clears search', async ({ dashboardPage }) => {
    await dashboardPage.search('TypeScript');
    await dashboardPage.expectNoteNotVisible('Go Programming');

    await dashboardPage.clickLogo();
    await dashboardPage.expectSearchValue('');
    await dashboardPage.expectNoteVisible('TypeScript Tutorial');
    await dashboardPage.expectNoteVisible('Go Programming');
    await dashboardPage.expectNoteVisible('React Hooks');
  });
});
