import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

const escapeForRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class DashboardPage {
  constructor(private page: Page) {}

  private async closeActiveDialog() {
    const activeDialog = this.page.getByRole('dialog').last();
    await activeDialog.getByRole('button', { name: 'Close' }).click();
    // Wait for the dialog to close. When no save is already in flight, the
    // modal only unmounts after onSave() fires post-PATCH, so this ensures
    // the save completes before callers close the tab or reload the page.
    await expect(activeDialog).toBeHidden();
  }

  async goto() {
    await this.page.goto('/');
  }

  /** The live-update (SSE) connection status indicator. */
  sseStatusIndicator(): Locator {
    return this.page.getByTestId('sse-status-indicator');
  }

  async clickNewNote() {
    await this.page.click('button:has-text("New Note")');
  }

  async createNote(title: string, _content?: string) {
    await this.clickNewNote();
    // List notes have a title field; switch to list type to use the title for identification.
    await this.selectListType();
    await this.page.fill('input[placeholder="Note title..."]', title);
    // Close the modal to save (auto-save on close when there are changes)
    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  /** Creates a new text note with labels attached during creation. */
  async createNoteWithLabels(title: string, _content: string, labelNames: string[]) {
    await this.clickNewNote();
    // Text notes have a content textarea; fill with title so the card can be identified by hasText.
    await this.page.fill('textarea[placeholder="Take a note..."]', title);

    for (const labelName of labelNames) {
      await this.page.getByRole('button', { name: 'Add labels' }).click();
      await this.selectOrCreateLabelInPicker(labelName);
      // Click "Add labels" again to toggle the picker closed without triggering Dialog.onClose.
      await this.page.getByRole('button', { name: 'Add labels' }).click();
    }

    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async createListNote(title: string, items: string[]) {
    await this.clickNewNote();
    await this.selectListType();
    await this.page.fill('input[placeholder="Note title..."]', title);
    for (const item of items) {
      await this.addListItem(item);
    }
    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({ hasText: title })).toBeVisible();
  }

  async selectListType() {
    await this.page.click('button:has-text("List")');
  }

  async addListItem(text: string) {
    const inputs = this.page.locator('[data-testid="list-item-input"]');
    const existingCount = await inputs.count();
    await this.page.click('button:has-text("Add item")');
    await expect(inputs).toHaveCount(existingCount + 1);
    await inputs.nth(existingCount).fill(text);
  }

  listItemInput(index: number): Locator {
    return this.page.locator('[data-testid="list-item-input"]').nth(index);
  }

  async focusListItem(index: number) {
    await this.listItemInput(index).focus();
  }

  async expectListItemFocused(index: number) {
    await expect(this.listItemInput(index)).toBeFocused();
  }

  async expectListItemCount(count: number) {
    await expect(this.page.locator('[data-testid="list-item-input"]')).toHaveCount(count);
  }

  async expectListItemValue(index: number, value: string) {
    await expect(this.listItemInput(index)).toHaveValue(value);
  }

  /** Creates a new text note (no title) with the given content and closes the modal. */
  async createTextNote(content: string) {
    await this.clickNewNote();
    const dialog = this.page.getByRole('dialog').last();
    await dialog.locator('textarea').first().fill(content);
    await this.closeActiveDialog();
  }

  /**
   * Returns the note card whose visible text contains the given string.
   * Use for text notes (which have no h3 title), filtering by content text instead.
   */
  noteCardByText(text: string) {
    return this.page.locator('[data-testid="note-card"]').filter({ hasText: text });
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

  /**
   * Opens the note modal's three-dot overflow menu (Share/Duplicate/Convert/
   * Delete live here now, mirroring the mobile layout). The menu is rendered in
   * a portal (headlessui `anchor`) outside the dialog to avoid clipping, so its
   * items must be queried at page scope, not scoped to the dialog.
   */
  async openModalOverflowMenu(): Promise<void> {
    const menuButton = this.page.getByRole('dialog').last().getByRole('button', { name: 'Note options' });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  }

  async duplicateCurrentNoteFromModal() {
    await this.openModalOverflowMenu();
    await this.page.getByRole('menuitem', { name: 'Duplicate' }).click();
  }

  /** Converts the open text note to a list. Text -> list has no confirmation dialog. */
  async convertCurrentNoteToList() {
    await this.openModalOverflowMenu();
    await this.page.getByRole('menuitem', { name: 'Convert to list' }).click();
  }

  /** Converts the open list note to text, confirming the lossy-conversion dialog. */
  async convertCurrentNoteToText() {
    await this.openModalOverflowMenu();
    await this.page.getByRole('menuitem', { name: 'Convert to text' }).click();
    const confirmDialog = this.page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Convert to text' }).click();
  }

  /** Unchecks all completed items on the open list via the overflow menu. */
  async uncheckAllItemsFromModal() {
    await this.openModalOverflowMenu();
    await this.page.getByTestId('note-uncheck-all').click();
  }

  /** Deletes all checked items on the open list via the overflow menu. */
  async deleteCheckedItemsFromModal() {
    await this.openModalOverflowMenu();
    await this.page.getByTestId('note-delete-checked').click();
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

  async switchToMyTasks() {
    await this.ensureSidebarOpen();
    await this.page
      .locator('aside[aria-label="Main navigation"] nav [aria-label="My Tasks"]')
      .click();
  }

  async clickLogo() {
    await this.page.click('a:has-text("Jot")');
  }

  async expectSearchValue(value: string) {
    await expect(this.page.locator('[aria-label="Search notes"]')).toHaveValue(value);
  }

  async expectArchivedSectionVisible() {
    await expect(this.page.getByRole('heading', { name: 'Archived', exact: true })).toBeVisible();
  }

  async expectArchivedSectionHidden() {
    await expect(this.page.getByRole('heading', { name: 'Archived', exact: true })).toHaveCount(0);
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

  /**
   * The "Pinned" section heading. Since the per-card pin badge was removed, this
   * heading is the UI contract for "a note is pinned" on the dashboard: it is
   * visible when at least one note is pinned and absent otherwise.
   */
  pinnedSectionHeading(): Locator {
    return this.page.locator('h2:has-text("Pinned")');
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

  async editNote(title: string, newTitle: string, _newContent: string) {
    await this.openNote(title);
    await expect(this.page.getByRole('button', { name: 'Close' })).toBeVisible();
    // createNote creates list notes which have a title input; edit only the title.
    await this.page.fill('input[placeholder="Note title..."]', newTitle);
    await this.closeActiveDialog();
  }

  /**
   * Within an open label picker, selects an existing label or creates a new one
   * by typing into the search box, then waits for it to be selected.
   */
  async selectOrCreateLabelInPicker(labelName: string) {
    const search = this.page.getByRole('textbox', { name: 'Search or create label...' });
    await search.fill(labelName);
    const existing = this.page.getByRole('option', { name: labelName, exact: true });
    if (await existing.count() > 0) {
      if ((await existing.first().getAttribute('aria-selected')) !== 'true') {
        await existing.first().click();
      }
    } else {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.page.getByRole('option', { name: `Create "${labelName}"`, exact: true }).click();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await search.fill('');
          await search.fill(labelName);
        }
      }
    }
    await expect(
      this.page.getByRole('option', { name: labelName, exact: true, selected: true }),
    ).toBeVisible();
  }

  /** Opens the label picker for the open note via the overflow menu. */
  async openLabelPickerFromModal() {
    await this.openModalOverflowMenu();
    await this.page.getByRole('menuitem', { name: 'Labels' }).click();
  }

  /** Opens the share modal for the open note via the overflow menu. */
  async openShareModalFromModal() {
    await this.openModalOverflowMenu();
    await this.page.getByRole('menuitem', { name: 'Share' }).click();
  }

  /** Opens a note and creates a new label, attaching it to the note. */
  async addLabelToNote(noteTitle: string, labelName: string) {
    await this.openNote(noteTitle);
    await this.openLabelPickerFromModal();
    await this.selectOrCreateLabelInPicker(labelName);
    // Closing the modal also dismisses the picker (outside-click fires on mousedown)
    await this.closeActiveDialog();
    await expect(this.page.locator('[data-testid="note-card"]').filter({
      has: this.page.locator('h3').getByText(noteTitle, { exact: true }),
    })).toBeVisible();
  }

  /** Clicks a label chip on a note card to activate the label filter. */
  async clickNoteLabelChip(noteTitle: string, labelName: string) {
    const card = this.noteCard(noteTitle);
    await card.getByRole('button', { name: labelName, exact: true }).click();
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
    await this.page.getByRole('button', { name: 'New Label' }).click();
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

  /** Opens a note, assigns a list item at the given index to a user, then closes the modal. */
  async assignListItemToUser(noteTitle: string, itemIndex: number, username: string) {
    await this.openNote(noteTitle);
    await expect(this.page.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();

    const itemRow = this.page.locator('[data-testid="list-item-row"]').nth(itemIndex);
    // The assign button is only revealed for the row the user is working on.
    // Focus the row's text field to reveal it — this works on both desktop and
    // mobile emulation (no hover needed), and makes the button interactive
    // (it's pointer-events-none while hidden), so a normal click lands.
    await itemRow.locator('[data-testid="list-item-input"]').focus();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    await expect(assignBtn).toBeVisible();
    await assignBtn.click();

    await expect(this.page.getByText('Assign item')).toBeVisible();
    const pickerPopover = this.page.locator('.max-h-48');
    await pickerPopover.getByText(username).click();

    await this.closeActiveDialog();
  }

  /** Asserts that Archive and Bin appear directly after the labels section in the sidebar. */
  async expectArchiveAndBinDirectlyAfterLabel(labelName: string) {
    await this.ensureSidebarOpen();
    const sidebar = this.page.locator('aside[aria-label="Main navigation"]');

    const labelRow = this.sidebarLabelRow(labelName);
    const labelsSection = sidebar.locator('[data-testid="sidebar-labels"]');
    const archiveButton = sidebar.locator('[aria-label="Archive"]');
    const binButton = sidebar.locator('[aria-label="Bin"]');

    await expect(labelRow).toBeVisible();
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

  /**
   * Recolours the note open in the modal. The whole panel takes the note's
   * colour, so this changes the background every piece of modal chrome sits on.
   */
  async setNoteColorFromModal(colorName: string) {
    const dialog = this.page.getByRole('dialog').last();
    await dialog.getByRole('button', { name: 'Select note color' }).click();
    await dialog.getByRole('button', { name: colorName, exact: true }).click();
  }

  /** Shares a note with a user via the card context menu and share modal. */
  async shareNoteWithUser(noteTitle: string, username: string) {
    await this.openNoteMenu(noteTitle);
    await this.page.getByRole('menuitem', { name: /share/i }).click();
    await this.page.getByPlaceholder(/search users/i).fill(username);
    await this.page.getByText(username).click();
    await this.page.keyboard.press('Escape');
  }

  /**
   * Creates a note and shares it, leaving a share-history record behind.
   *
   * Waits for the collaborator avatar to appear on the card before returning:
   * the share is only useful to a caller once it is reflected in the notes
   * list, and `shareNoteWithUser` closes the modal without waiting for the
   * request to land.
   */
  async createAndShareNote(noteTitle: string, username: string) {
    await this.createNote(noteTitle);
    await this.shareNoteWithUser(noteTitle, username);
    const card = this.page.locator('[data-testid="note-card"]').filter({ hasText: noteTitle });
    await expect(card.locator('svg[role="img"], img[alt]').first()).toBeVisible();
  }
}
