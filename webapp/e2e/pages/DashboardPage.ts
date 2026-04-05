import { Page, expect, Locator } from '@playwright/test';

const escapeForRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class DashboardPage {
  constructor(private page: Page) {}

  private async closeActiveDialog() {
    const activeDialog = this.page.getByRole('dialog').last();
    await activeDialog.getByRole('button', { name: 'Close' }).click();
  }

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
    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  /** Creates a new note with labels attached during creation. */
  async createNoteWithLabels(title: string, content: string, labelNames: string[]) {
    await this.clickNewNote();
    await this.page.fill('input[placeholder="Note title..."]', title);
    await this.page.fill('textarea[placeholder="Take a note..."]', content);

    for (const labelName of labelNames) {
      await this.page.getByRole('button', { name: 'Add labels' }).click();
      const existingCheckbox = this.page.getByRole('checkbox', { name: labelName });
      if (await existingCheckbox.count() > 0 && !(await existingCheckbox.isChecked())) {
        await existingCheckbox.click();
      } else if (await existingCheckbox.count() === 0) {
        await this.page.getByRole('button', { name: 'Create new...' }).click();
        await this.page.getByPlaceholder('Label name...').fill(labelName);
        await this.page.keyboard.press('Enter');
      }
      await expect(this.page.getByRole('checkbox', { name: labelName })).toBeChecked();
      // Click outside picker to close it
      await this.page.locator('input[placeholder="Note title..."]').click();
    }

    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async createTodoNote(title: string, items: string[]) {
    await this.clickNewNote();
    await this.selectTodoType();
    await this.page.fill('input[placeholder="Note title..."]', title);
    for (const item of items) {
      await this.addTodoItem(item);
    }
    await this.closeActiveDialog();
    await expect(this.page.getByRole('dialog')).toHaveCount(0);
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async selectTodoType() {
    await this.page.click('button:has-text("Todo List")');
  }

  async addTodoItem(text: string) {
    const inputs = this.page.locator('[data-testid="todo-item-input"]');
    const existingCount = await inputs.count();
    await this.page.click('button:has-text("Add item")');
    await expect(inputs).toHaveCount(existingCount + 1);
    await inputs.nth(existingCount).fill(text);
  }

  todoItemInput(index: number): Locator {
    return this.page.locator('[data-testid="todo-item-input"]').nth(index);
  }

  async focusTodoItem(index: number) {
    await this.todoItemInput(index).focus();
  }

  async expectTodoItemFocused(index: number) {
    await expect(this.todoItemInput(index)).toBeFocused();
  }

  async expectTodoItemCount(count: number) {
    await expect(this.page.locator('[data-testid="todo-item-input"]')).toHaveCount(count);
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

  async closeNoteModal() {
    await this.closeActiveDialog();
  }

  private async openNoteMenu(title: string) {
    const card = this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(title, { exact: true }),
    });
    await expect(card).toBeVisible();
    const menuButton = card.getByRole('button', { name: 'Note options' });
    // Focus + keyboard activation avoids pointer-interception flakes from overlays.
    await menuButton.focus();
    await this.page.keyboard.press('Enter');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  }

  async deleteNote(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirmDialog = this.page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();
  }

  async restoreNoteFromBin(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Restore' }).click();
  }

  async permanentlyDeleteNoteFromBin(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Delete forever' }).click();
    const confirmDialog = this.page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete forever' }).click();
  }

  async emptyTrash() {
    await this.page.getByRole('button', { name: 'Empty Trash' }).click();
    const confirmDialog = this.page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Empty Trash' }).click();
  }

  async expectEmptyTrashButtonVisible() {
    await expect(this.page.getByRole('button', { name: 'Empty Trash' })).toBeVisible();
  }

  async expectEmptyTrashButtonHidden() {
    await expect(this.page.getByRole('button', { name: 'Empty Trash' })).toHaveCount(0);
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

  async duplicateNoteFromMenu(title: string) {
    await this.openNoteMenu(title);
    await this.page.getByRole('menuitem', { name: 'Duplicate' }).click();
  }

  async duplicateCurrentNoteFromModal() {
    const activeDialog = this.page.getByRole('dialog').last();
    await activeDialog.getByRole('button', { name: 'Duplicate' }).click();
  }

  async archiveCurrentNoteFromModal() {
    const activeDialog = this.page.getByRole('dialog').last();
    await activeDialog.getByRole('button', { name: 'Archive note' }).click();
  }

  async search(query: string) {
    await this.page.fill('[aria-label="Search notes"]', query);
  }

  async selectSort(sort: 'manual' | 'updated_at' | 'created_at') {
    await this.page.getByLabel('Sort notes').selectOption(sort);
  }

  async getSortValue() {
    return this.page.getByLabel('Sort notes').inputValue();
  }

  async expectVisibleNoteTitles(titles: string[]) {
    await expect(this.page.locator('[data-testid="note-card"] h3')).toHaveText(titles);
  }

  async expectManualReorderDisabledNotice() {
    await expect(this.page.getByTestId('manual-reorder-disabled-notice')).toBeVisible();
  }

  async clearSearch() {
    await this.page.fill('[aria-label="Search notes"]', '');
  }

  private async ensureSidebarOpen() {
    const sidebar = this.page.locator('aside[aria-label="Main navigation"]');
    const toggleSidebarButton = this.page.getByRole('button', { name: 'Toggle sidebar' });
    if (!(await sidebar.isVisible())) {
      await toggleSidebarButton.click();
      await expect(sidebar).toBeVisible();
    }

    // On desktop, a collapsed sidebar is still visible but hides label text/buttons.
    const isSidebarCollapsed = await this.page.evaluate(() => localStorage.getItem('sidebar-collapsed') === 'true');
    if (isSidebarCollapsed) {
      await toggleSidebarButton.click();
      await expect(sidebar).toBeVisible();
      await expect.poll(
        () => this.page.evaluate(() => localStorage.getItem('sidebar-collapsed'))
      ).toBe('false');
    }
  }

  async switchToArchived() {
    await this.ensureSidebarOpen();
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Archive"]')
      .click();
  }

  async switchToNotes() {
    await this.ensureSidebarOpen();
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Notes"]')
      .click();
  }

  async switchToBin() {
    await this.ensureSidebarOpen();
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="Bin"]')
      .click();
  }

  async expectArchiveTabTooltip(expected = 'Hidden notes you want to keep') {
    await this.ensureSidebarOpen();
    await expect(
      this.page.locator('aside[aria-label="Main navigation"] nav [aria-label="Archive"]')
    ).toHaveAttribute('title', expected);
  }

  async expectBinTabTooltip(expected = 'Deleted notes — removed after 7 days') {
    await this.ensureSidebarOpen();
    await expect(
      this.page.locator('aside[aria-label="Main navigation"] nav [aria-label="Bin"]')
    ).toHaveAttribute('title', expected);
  }

  async expectArchiveInfoVisible() {
    await expect(this.page.getByText('Archived notes are hidden from the main view but kept forever.')).toBeVisible();
  }

  async expectBinInfoVisible() {
    await expect(this.page.getByText('Notes in the bin are deleted after 7 days')).toBeVisible();
  }

  async switchToMyTodo() {
    await this.ensureSidebarOpen();
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

  async expectEmptyState(title?: string, description?: string, expectCreateCta?: boolean) {
    const emptyState = this.page.getByTestId('dashboard-empty-state');
    await expect(emptyState).toBeVisible();

    if (title) {
      await expect(emptyState.getByText(title)).toBeVisible();
    }

    if (description) {
      await expect(emptyState.getByText(description)).toBeVisible();
    }

    if (typeof expectCreateCta === 'boolean') {
      const createCtaButton = emptyState.getByRole('button');
      if (expectCreateCta) {
        await expect(createCtaButton).toBeVisible();
      } else {
        await expect(createCtaButton).toHaveCount(0);
      }
    }
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
    // Confirm the logout in the confirmation dialog
    const confirmDialog = this.page.getByRole('dialog');
    await confirmDialog.getByRole('button', { name: 'Logout' }).click();
  }

  async expectProfileMenuTooltip(expected: string) {
    await expect(this.page.getByRole('button', { name: 'Profile menu' })).toHaveAttribute('title', expected);
  }

  async editNote(title: string, newTitle: string, newContent: string) {
    await this.openNote(title);
    await expect(this.page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();
    await this.page.fill('input[placeholder="Note title..."]', newTitle);
    await this.page.fill('textarea[placeholder="Take a note..."]', newContent);
    await this.closeActiveDialog();
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
    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(noteTitle, { exact: true }),
    })).toBeVisible();
  }

  /** Clicks a label button in the sidebar to toggle the label filter. */
  async selectSidebarLabel(labelName: string) {
    await this.ensureSidebarOpen();
    const row = this.sidebarLabelRow(labelName);
    await expect(row).toBeVisible();
    await row.locator('button').first().click();
  }

  async expectLabelInSidebar(labelName: string) {
    await this.ensureSidebarOpen();
    const row = this.sidebarLabelRow(labelName);
    await expect(row).toBeVisible();
    await expect(row.locator('button span.truncate')).toHaveText(labelName);
  }

  async expectLabelNotInSidebar(labelName: string) {
    await this.ensureSidebarOpen();
    await expect(this.sidebarLabelRow(labelName)).toHaveCount(0);
  }

  async createSidebarLabel(labelName: string) {
    await this.ensureSidebarOpen();
    await this.page.getByRole('button', { name: '+ New Label' }).click();
    const input = this.page.getByRole('textbox', { name: 'New label name' });
    await input.fill(labelName);
    await input.press('Enter');
    await this.expectLabelInSidebar(labelName);
  }

  async expectSidebarLabelCount(labelName: string, count: number) {
    await this.ensureSidebarOpen();
    const row = this.sidebarLabelRow(labelName);
    await expect(row.locator('button span').last()).toHaveText(String(count));
  }

  private sidebarLabelRow(labelName: string): Locator {
    const exactLabelName = new RegExp(`^${escapeForRegex(labelName)}$`);
    return this.page
      .locator('aside [data-testid="sidebar-labels"] li')
      .filter({ has: this.page.locator('button span.truncate', { hasText: exactLabelName }) })
      .first();
  }

  async renameSidebarLabel(currentName: string, nextName: string) {
    await this.ensureSidebarOpen();
    const row = this.sidebarLabelRow(currentName);
    await row.getByRole('button', { name: `Label options for ${currentName}` }).click();
    const renameMenuItem = this.page.getByRole('menuitem', { name: 'Rename' });
    if (await renameMenuItem.count() > 0) {
      await renameMenuItem.click();
    } else {
      await this.page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    }
    const input = this.page.getByPlaceholder('Rename label...');
    await input.fill(nextName);
    await input.press('Enter');
    await this.expectLabelInSidebar(nextName);
  }

  async deleteSidebarLabel(labelName: string) {
    await this.ensureSidebarOpen();
    const row = this.sidebarLabelRow(labelName);
    await row.getByRole('button', { name: `Label options for ${labelName}` }).click();
    const deleteMenuItem = this.page.getByRole('menuitem', { name: 'Delete' });
    if (await deleteMenuItem.count() > 0) {
      await deleteMenuItem.click();
    } else {
      await this.page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    }
    const confirmDialog = this.page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();
    await this.expectLabelNotInSidebar(labelName);
  }

  /** Opens a note, assigns a todo item at the given index to a user, then closes the modal. */
  async assignTodoItemToUser(noteTitle: string, itemIndex: number, username: string) {
    await this.openNote(noteTitle);
    await expect(this.page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const itemRow = this.page.locator('[data-testid="todo-item-row"]').nth(itemIndex);
    await itemRow.hover();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    // force: true bypasses visibility so the click works on both desktop (hover
    // shows the button) and mobile emulation (group-hover CSS doesn't trigger).
    await assignBtn.click({ force: true });

    await expect(this.page.getByText('Assign item')).toBeVisible();
    const pickerPopover = this.page.locator('.max-h-48');
    await pickerPopover.getByText(username).click();

    await this.closeActiveDialog();
  }

  /** Asserts that Archive and Bin appear directly after the labels section in the sidebar. */
  async expectArchiveAndBinDirectlyAfterLabel(labelName: string) {
    await this.ensureSidebarOpen();
    const sidebar = this.page.locator('aside[aria-label="Main navigation"]');

    const labelButton = sidebar.getByRole('button', { name: labelName, exact: true });
    const labelsSection = sidebar.locator('[data-testid="sidebar-labels"]');
    const archiveButton = sidebar.locator('[aria-label="Archive"]');
    const binButton = sidebar.locator('[aria-label="Bin"]');

    await expect(labelButton).toBeVisible();
    await expect(labelsSection).toBeVisible();
    await expect(archiveButton).toBeVisible();
    await expect(binButton).toBeVisible();

    const labelsSectionBox = await labelsSection.boundingBox();
    const archiveBox = await archiveButton.boundingBox();
    const binBox = await binButton.boundingBox();

    expect(labelsSectionBox).toBeTruthy();
    expect(archiveBox).toBeTruthy();
    expect(binBox).toBeTruthy();

    const gapBetweenLabelsSectionAndArchive = archiveBox!.y - (labelsSectionBox!.y + labelsSectionBox!.height);
    expect(gapBetweenLabelsSectionAndArchive).toBeLessThan(40);

    expect(binBox!.y).toBeGreaterThan(archiveBox!.y);
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
