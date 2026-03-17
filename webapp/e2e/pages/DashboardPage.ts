import { Page, expect, Locator } from '@playwright/test';

export class DashboardPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/');
  }

  async clickNewNote() {
    await this.page.click('button:has-text("New Note")');
  }

  async createNote(title: string, content?: string) {
    await this.clickNewNote();
    await this.page.fill('input[placeholder="Note title..."]', title);
    if (content) {
      await this.page.fill('textarea[placeholder="Take a note..."]', content);
    }
    // Close the modal to save (auto-save on close when there are changes)
    await this.page.click('button[aria-label="Close"]');
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  /** Creates a new note with labels attached during creation. */
  async createNoteWithLabels(title: string, content: string, labelNames: string[]) {
    await this.clickNewNote();
    await this.page.fill('input[placeholder="Note title..."]', title);
    await this.page.fill('textarea[placeholder="Take a note..."]', content);

    for (const labelName of labelNames) {
      await this.page.getByRole('button', { name: 'Add labels' }).click();
      await this.page.getByRole('button', { name: 'Create new...' }).click();
      await this.page.getByPlaceholder('Label name...').fill(labelName);
      await this.page.keyboard.press('Enter');
      // Wait for checkbox to become checked, then close the picker
      await expect(this.page.getByRole('checkbox', { name: labelName })).toBeChecked();
      // Click outside picker to close it
      await this.page.locator('input[placeholder="Note title..."]').click();
    }

    await this.page.click('button[aria-label="Close"]');
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async createTodoNote(title: string, items: string[]) {
    await this.clickNewNote();
    await this.selectTodoType();
    await this.page.fill('input[placeholder="Note title..."]', title);
    for (const item of items) {
      await this.addTodoItem(item);
    }
    await this.page.click('button[aria-label="Close"]');
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async selectTodoType() {
    await this.page.click('button:has-text("Todo List")');
  }

  async addTodoItem(text: string) {
    await this.page.click('button:has-text("Add item")');
    await this.page.locator('input[placeholder="List item..."]').last().fill(text);
  }

  todoItemInput(index: number): Locator {
    return this.page.locator('input[placeholder="List item..."]').nth(index);
  }

  async focusTodoItem(index: number) {
    await this.todoItemInput(index).focus();
  }

  async expectTodoItemFocused(index: number) {
    await expect(this.todoItemInput(index)).toBeFocused();
  }

  async expectTodoItemCount(count: number) {
    await expect(this.page.locator('input[placeholder="List item..."]')).toHaveCount(count);
  }

  async expectTodoItemValue(index: number, value: string) {
    await expect(this.todoItemInput(index)).toHaveValue(value);
  }

  async pressKey(key: string) {
    await this.page.keyboard.press(key);
  }

  async openNote(title: string) {
    await this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(title, { exact: true }),
    }).click();
  }

  private async openNoteMenu(title: string) {
    const card = this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(title, { exact: true }),
    });
    // force is intentional: hover/waitFor-based approaches were flaky in CI when sidebar overlays intercepted pointer events.
    // TODO: remove force when note-card menu is reliably actionability-safe without hover timing dependence.
    await card.locator('button[aria-label="Note options"]').click({ force: true });
  }

  async deleteNote(title: string) {
    await this.openNoteMenu(title);
    this.page.once('dialog', dialog => dialog.accept());
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
  }

  async restoreNoteFromBin(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Restore' }).click();
  }

  async permanentlyDeleteNoteFromBin(title: string) {
    await this.openNoteMenu(title);
    this.page.once('dialog', dialog => dialog.accept());
    await this.page.getByRole('menuitem', { name: 'Delete forever' }).click();
  }

  async pinNote(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Pin' }).click();
  }

  async unpinNote(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Unpin' }).click();
  }

  async archiveNote(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Archive' }).click();
    // Wait for the API call and UI refresh to complete
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toHaveCount(0);
  }

  async unarchiveNote(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Unarchive' }).click();
    // Wait for the API call and UI refresh to complete
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toHaveCount(0);
  }

  async search(query: string) {
    await this.page.fill('[aria-label="Search notes"]', query);
  }

  async clearSearch() {
    await this.page.fill('[aria-label="Search notes"]', '');
  }

  async switchToArchived() {
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Archive"]')
      .click();
  }

  async switchToNotes() {
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Notes"]')
      .click();
  }

  async switchToBin() {
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Bin"]')
      .click();
  }

  async switchToMyTodo() {
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="My Todo"]')
      .click();
  }

  async clickLogo() {
    await this.page.click('a:has-text("Jot")');
  }

  async expectSearchValue(value: string) {
    await expect(this.page.locator('[aria-label="Search notes"]')).toHaveValue(value);
  }

  async expectNoteVisible(title: string) {
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async expectNoteNotVisible(title: string) {
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toHaveCount(0);
  }

  async expectEmptyState(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  noteCard(title: string): Locator {
    return this.page.locator('[data-testid="note-card"]').filter({ hasText: title });
  }

  /** Returns the nth note card (0-based) visible on the page. */
  nthNoteCard(index: number): Locator {
    return this.page.locator('[data-testid="note-card"]').nth(index);
  }

  /** Asserts that the nth note card (0-based) has the given title. */
  async expectNoteAtPosition(index: number, title: string) {
    await expect(
      this.nthNoteCard(index).locator('h3')
    ).toHaveText(title);
  }

  async logout() {
    // Open the profile dropdown, then click Logout (role=menuitem set by headlessui)
    await this.page.getByRole('button', { name: 'Profile menu' }).click();
    await this.page.getByRole('menuitem', { name: 'Logout' }).click();
  }

  async expectProfileMenuTooltip(expected: string) {
    await expect(this.page.getByRole('button', { name: 'Profile menu' })).toHaveAttribute('title', expected);
  }

  async editNote(title: string, newTitle: string, newContent: string) {
    await this.openNote(title);
    await expect(this.page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();
    await this.page.fill('input[placeholder="Note title..."]', newTitle);
    await this.page.fill('textarea[placeholder="Take a note..."]', newContent);
    await this.page.click('button[aria-label="Close"]');
  }

  /** Opens a note and creates a new label, attaching it to the note. */
  async addLabelToNote(noteTitle: string, labelName: string) {
    await this.openNote(noteTitle);
    await this.page.getByRole('button', { name: 'Add labels' }).waitFor();
    await this.page.getByRole('button', { name: 'Add labels' }).click();
    await this.page.getByRole('button', { name: 'Create new...' }).click();
    await this.page.getByPlaceholder('Label name...').fill(labelName);
    await this.pressKey('Enter');
    // Wait for the label to be created and checked before closing the modal
    await expect(this.page.getByRole('checkbox', { name: labelName })).toBeChecked();
    // Closing the modal also dismisses the picker (outside-click fires on mousedown)
    await this.page.locator('button[aria-label="Close"]').click();
    await expect(this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(noteTitle, { exact: true }),
    })).toBeVisible();
  }

  /** Clicks a label button in the sidebar to toggle the label filter. */
  async selectSidebarLabel(labelName: string) {
    await this.page.locator('aside ul').getByRole('button', { name: labelName, exact: true }).click();
  }

  async expectLabelInSidebar(labelName: string) {
    await expect(
      this.page.locator('aside ul').getByRole('button', { name: labelName, exact: true })
    ).toBeVisible();
  }

  async expectLabelNotInSidebar(labelName: string) {
    await expect(
      this.page.locator('aside ul').getByRole('button', { name: labelName, exact: true })
    ).toHaveCount(0);
  }

  /** Opens a note, assigns a todo item at the given index to a user, then closes the modal. */
  async assignTodoItemToUser(noteTitle: string, itemIndex: number, username: string) {
    await this.openNote(noteTitle);
    await expect(this.page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const itemRow = this.page.locator('input[placeholder="List item..."]').nth(itemIndex).locator('..');
    await itemRow.hover();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    await assignBtn.waitFor({ state: 'visible', timeout: 5000 });
    await assignBtn.click();

    await expect(this.page.getByText('Assign item')).toBeVisible();
    const pickerPopover = this.page.locator('.max-h-48');
    await pickerPopover.getByText(username).click();

    await this.page.click('button[aria-label="Close"]');
  }

  /** Shares a note with a user via the card context menu and share modal. */
  async shareNoteWithUser(noteTitle: string, username: string) {
    await this.openNoteMenu(noteTitle);
    await this.page.getByRole('menuitem', { name: /share/i }).click();
    await this.page.getByPlaceholder(/search users/i).fill(username);
    await this.page.getByText(username).click();
    await this.page.keyboard.press('Escape');
  }
}
