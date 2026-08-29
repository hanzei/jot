import { test, expect } from '../fixtures';

test.describe('Arrow key card navigation', () => {
  test('navigates between cards with ArrowDown and ArrowUp', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    // Single-column layout so DOM order matches visual top-to-bottom order
    await page.setViewportSize({ width: 500, height: 900 });
    await dashboardPage.goto();
    // Create three notes; newest-first ordering means last-created = nth(0) = topmost
    await dashboardPage.createNote('KS Nav Alpha');
    await dashboardPage.createNote('KS Nav Beta');
    await dashboardPage.createNote('KS Nav Gamma');

    // The focusable control each card contributes, not the card container —
    // the container is a plain div and cannot take focus.
    const cards = page.locator('[data-note-card="true"]');
    await expect(cards).toHaveCount(3);

    await cards.first().focus();
    await expect(cards.first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(2)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(cards.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(cards.first()).toBeFocused();
  });

  test('navigates between cards with ArrowLeft and ArrowRight', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('KS LR One');
    await dashboardPage.createNote('KS LR Two');

    // The focusable control each card contributes, not the card container —
    // the container is a plain div and cannot take focus.
    const cards = page.locator('[data-note-card="true"]');
    await expect(cards).toHaveCount(2);

    await cards.first().focus();

    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowLeft');
    await expect(cards.first()).toBeFocused();
  });

  test('navigates through multi-line cards without skipping', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    // Single-column layout to ensure deterministic vertical stacking
    await page.setViewportSize({ width: 500, height: 900 });
    await dashboardPage.goto();
    // Create a short note, then a tall multi-line text note, then another short note.
    // Newest-first: display order is short-bottom (nth 0), multi-line (nth 1), short-top (nth 2).
    await dashboardPage.createNote('KS ML Short Top');
    await dashboardPage.createTextNote(
      Array(12).fill('A line of content in this multi-line note.').join('\n')
    );
    await dashboardPage.createNote('KS ML Short Bottom');

    // The focusable control each card contributes, not the card container —
    // the container is a plain div and cannot take focus.
    const cards = page.locator('[data-note-card="true"]');
    await expect(cards).toHaveCount(3);

    await cards.first().focus();

    // All three cards must be reachable via ArrowDown — tall cards must not break navigation
    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(2)).toBeFocused();

    // Reversible via ArrowUp
    await page.keyboard.press('ArrowUp');
    await expect(cards.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(cards.first()).toBeFocused();
  });

  test('jumps to the first and last card with Home and End', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await page.setViewportSize({ width: 500, height: 900 });
    await dashboardPage.goto();
    await dashboardPage.createNote('KS Jump Alpha');
    await dashboardPage.createNote('KS Jump Beta');
    await dashboardPage.createNote('KS Jump Gamma');

    const cards = page.locator('[data-note-card="true"]');
    await expect(cards).toHaveCount(3);

    // From the middle, so neither jump could pass by stepping one card.
    await cards.nth(1).focus();

    await page.keyboard.press('End');
    await expect(cards.nth(2)).toBeFocused();

    await page.keyboard.press('Home');
    await expect(cards.first()).toBeFocused();

    // Idempotent at the ends rather than wrapping around.
    await page.keyboard.press('Home');
    await expect(cards.first()).toBeFocused();
  });
});

test.describe('ConfirmDialog keyboard confirm', () => {
  test('pressing Enter in the permanent-delete confirmation dialog deletes the note forever', async ({ authenticatedUser, dashboardPage, page }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to Delete Forever via Enter');
    await dashboardPage.deleteNote('Note to Delete Forever via Enter');
    await dashboardPage.switchToBin();
    await dashboardPage.expectNoteVisible('Note to Delete Forever via Enter');

    const card = page.locator('[data-testid="note-card"]').filter({
      has: page.locator('h3').getByText('Note to Delete Forever via Enter', { exact: true }),
    });
    await card.getByRole('button', { name: 'Note options' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete forever' }).click();

    const confirmDialog = page.getByRole('dialog').last();
    await expect(confirmDialog.getByRole('button', { name: 'Delete forever', exact: true })).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(confirmDialog).not.toBeVisible();
    await dashboardPage.expectNoteNotVisible('Note to Delete Forever via Enter');
  });
});

test.describe('Keyboard shortcuts help dialog', () => {
  test('focuses search with Cmd+F', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('body').click();
    await page.keyboard.press('Meta+F');

    await expect(page.locator('form[role="search"] input')).toBeFocused();
  });

  test('focuses search with Ctrl+F', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('body').click();
    await page.keyboard.press('Control+F');

    await expect(page.locator('form[role="search"] input')).toBeFocused();
  });

  test('opens a new note with n when no input is focused', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('n');

    // New notes open as text notes; text notes have a content textarea (no title input).
    const noteContentInput = page.locator('[role="dialog"][aria-modal="true"] textarea').first();
    await expect(noteContentInput).toBeVisible();
    // First Escape collapses the content area from edit to preview (two-step dismiss).
    await page.keyboard.press('Escape');
    // Second Escape closes the modal.
    await page.keyboard.press('Escape');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toHaveCount(0);
  });

  test('opens with ? and closes with Escape', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('Shift+/');

    const shortcutsDialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(shortcutsDialog).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-focus-search')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-focus-search')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-new-note')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-new-note')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-notes-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-notes-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-my-tasks-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-my-tasks-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-archive-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-archive-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-bin-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-bin-view')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-open-help')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-navigate-cards')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-navigate-cards')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-jump-first-last')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-jump-first-last')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-key-escape')).toBeVisible();
    await expect(shortcutsDialog.getByTestId('shortcut-description-escape')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(shortcutsDialog).toBeHidden();
  });

  test('opens from profile menu keyboard shortcuts item', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.getByRole('button', { name: 'Profile menu' }).click();
    await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();

    const shortcutsDialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(shortcutsDialog).toBeVisible();
    await expect(shortcutsDialog.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('opens notes/list/archive/bin views with d/t/a/b', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    await page.locator('main').click();
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/\?view=my-tasks$/);

    await page.locator('main').click();
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\/\?view=archive$/);

    await page.locator('main').click();
    await page.keyboard.press('b');
    await expect(page).toHaveURL(/\/\?view=bin$/);

    await page.locator('main').click();
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/\/$/);
  });
});
