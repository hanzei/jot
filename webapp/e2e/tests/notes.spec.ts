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

  test('sets page title to note title when a note is opened', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('My Page Title Note', 'Some content');

    await dashboardPage.openNote('My Page Title Note');
    await expect(page).toHaveTitle('My Page Title Note - Jot');

    await dashboardPage.closeNoteModal();
    await expect(page).toHaveTitle('Jot');
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

  test('empties trash in one action', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Trash One');
    await dashboardPage.createNote('Trash Two');
    await dashboardPage.createNote('Trash Three');

    await dashboardPage.deleteNote('Trash One');
    await dashboardPage.deleteNote('Trash Two');
    await dashboardPage.deleteNote('Trash Three');

    await dashboardPage.switchToBin();
    await dashboardPage.expectEmptyTrashButtonVisible();

    await dashboardPage.emptyTrash();

    await dashboardPage.expectEmptyTrashButtonHidden();
    await dashboardPage.expectEmptyState(
      'Bin is empty',
      'Deleted notes remain here until they are removed.',
    );
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

  test('archiving a note from within the modal closes the modal', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Modal Archive Test');

    await dashboardPage.openNote('Modal Archive Test');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();

    await dashboardPage.archiveCurrentNoteFromModal();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await dashboardPage.expectNoteNotVisible('Modal Archive Test');
  });

  test('creates a list note with items', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Shopping List', ['Apples', 'Bread', 'Milk']);

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

  test('switches sort modes and persists the selected sort preference', async ({
    page,
    authenticatedUser,
    dashboardPage,
    loginPage,
  }) => {
    await page.setViewportSize({ width: 600, height: 1000 });
    await dashboardPage.goto();

    // These 1.1s waits keep created/updated timestamps in distinct seconds so
    // the sort assertions stay deterministic across create/edit operations.
    await dashboardPage.createNote('Zulu');
    await page.waitForTimeout(1100);
    await dashboardPage.createNote('alpha');
    await page.waitForTimeout(1100);
    await dashboardPage.createNote('Bravo');
    await dashboardPage.pinNote('Zulu');

    await dashboardPage.selectSort('created_at');
    await dashboardPage.expectManualReorderDisabledNotice();
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'Bravo', 'alpha']);

    await page.waitForTimeout(1100);
    // Patch the alpha note directly so updated_at changes deterministically without
    // relying on modal timing or extra UI interactions in this ordering test.
    await page.evaluate(async () => {
      const response = await fetch('/api/v1/notes', { credentials: 'include' });
      const notes = await response.json() as Array<{
        id: string;
        title: string;
        pinned: boolean;
        archived: boolean;
        color: string;
        checked_items_collapsed: boolean;
      }>;
      const alphaNote = notes.find(note => note.title === 'alpha');
      if (!alphaNote) {
        throw new Error('alpha note not found');
      }

      const updateResponse = await fetch(`/api/v1/notes/${alphaNote.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: alphaNote.title,
          pinned: alphaNote.pinned,
          archived: alphaNote.archived,
          color: alphaNote.color,
          checked_items_collapsed: alphaNote.checked_items_collapsed,
        }),
      });

      if (!updateResponse.ok) {
        throw new Error(`Failed to update alpha note: ${updateResponse.status}`);
      }
    });
    await dashboardPage.selectSort('updated_at');
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'alpha', 'Bravo']);

    await dashboardPage.selectSort('created_at');
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'Bravo', 'alpha']);
    expect(await dashboardPage.getSortValue()).toBe('created_at');

    await page.reload();
    expect(await dashboardPage.getSortValue()).toBe('created_at');
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'Bravo', 'alpha']);

    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    await loginPage.login(authenticatedUser.username, authenticatedUser.password);
    await expect(page).toHaveURL('/');
    expect(await dashboardPage.getSortValue()).toBe('created_at');
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'Bravo', 'alpha']);
  });

  test('duplicates text and list notes with copied labels and cleared shares/assignments', async ({ page, dashboardPage, request }) => {
    const collaboratorName = `dup-collab-${Date.now()}`;
    const collaboratorPassword = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: collaboratorName, password: collaboratorPassword },
    });
    expect(registerResp.ok()).toBeTruthy();
    const collaboratorData = await registerResp.json();
    const collaboratorId = collaboratorData.user.id as string;

    await dashboardPage.goto();

    // Create a list note (has h3 title, needed for menu operations) with a label.
    await dashboardPage.createNote('Source Text');
    await dashboardPage.addLabelToNote('Source Text', 'text-label');
    await dashboardPage.duplicateNoteFromMenu('Source Text');
    await expect(page.getByText('Note duplicated')).toBeVisible();
    await dashboardPage.expectNoteAtPosition(0, 'Copy of Source Text');
    const duplicatedTextCard = dashboardPage.noteCard('Copy of Source Text');
    await expect(duplicatedTextCard.getByText('text-label')).toBeVisible();

    await dashboardPage.createListNote('Source List', ['Prepare agenda', 'Send follow-up']);
    await dashboardPage.addLabelToNote('Source List', 'list-label');
    await dashboardPage.shareNoteWithUser('Source List', collaboratorName);
    await dashboardPage.assignListItemToUser('Source List', 0, collaboratorName);

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'jot_session');
    expect(sessionCookie, 'session cookie must exist').toBeDefined();
    const authHeaders = { Cookie: `jot_session=${sessionCookie!.value}` };

    const listNotes = async () => {
      const response = await request.get('/api/v1/notes', { headers: authHeaders });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };

    const findNoteByTitle = async (title: string) => {
      const notes = await listNotes();
      const note = notes.find((candidate: { title: string }) => candidate.title === title);
      expect(note, `note "${title}" must exist`).toBeDefined();
      return note as {
        id: string;
        title: string;
        content: string;
        pinned: boolean;
        archived: boolean;
        color: string;
        checked_items_collapsed: boolean;
        items: Array<{ text: string; position: number; completed: boolean; indent_level: number; assigned_to: string }>;
        labels: Array<{ name: string }>;
        shared_with: Array<{ shared_with_user_id: string }>;
      };
    };

    const sourceList = await findNoteByTitle('Source List');
    const updateResp = await request.patch(`/api/v1/notes/${sourceList.id}`, {
      headers: authHeaders,
      data: {
        title: sourceList.title,
        content: sourceList.content,
        pinned: sourceList.pinned,
        archived: sourceList.archived,
        color: sourceList.color,
        checked_items_collapsed: sourceList.checked_items_collapsed,
        items: sourceList.items.map((item, index) => ({
          text: item.text,
          position: item.position,
          completed: index === 1,
          indent_level: index === 1 ? 1 : item.indent_level,
          assigned_to: index === 0 ? collaboratorId : '',
        })),
      },
    });
    expect(updateResp.ok()).toBeTruthy();

    await dashboardPage.openNote('Source List');
    await dashboardPage.duplicateCurrentNoteFromModal();
    await expect(page.getByText('Note duplicated')).toBeVisible();
    await dashboardPage.expectNoteAtPosition(0, 'Copy of Source List');

    const duplicatedList = await findNoteByTitle('Copy of Source List');
    expect(duplicatedList.labels.map((label) => label.name)).toEqual(['list-label']);
    expect(duplicatedList.shared_with ?? []).toEqual([]);
    expect(duplicatedList.items ?? []).toEqual([
      expect.objectContaining({
        text: 'Prepare agenda',
        position: 0,
        completed: false,
        indent_level: 0,
        assigned_to: '',
      }),
      expect.objectContaining({
        text: 'Send follow-up',
        position: 1,
        completed: true,
        indent_level: 1,
        assigned_to: '',
      }),
    ]);
  });

  test('shows empty state when no notes exist', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.expectEmptyState(
      'No notes yet',
      'Click "New Note" to create your first note',
      true,
    );
  });

  test('pressing Enter on a non-last list item inserts a new item below it', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectListType();

    await dashboardPage.addListItem('First item');
    await dashboardPage.addListItem('Second item');

    await dashboardPage.focusListItem(0);
    await dashboardPage.pressKey('Enter');

    await dashboardPage.expectListItemCount(3);
    await dashboardPage.expectListItemValue(0, 'First item');
    await dashboardPage.expectListItemFocused(1);
    await dashboardPage.expectListItemValue(1, '');
    await dashboardPage.expectListItemValue(2, 'Second item');
  });

  test('arrow keys navigate between list items', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectListType();

    for (const text of ['Alpha', 'Beta', 'Gamma']) {
      await dashboardPage.addListItem(text);
    }

    await dashboardPage.focusListItem(0);
    await dashboardPage.expectListItemFocused(0);

    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectListItemFocused(1);

    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectListItemFocused(2);

    // ArrowDown on last item should keep focus there
    await dashboardPage.pressKey('ArrowDown');
    await dashboardPage.expectListItemFocused(2);

    // ArrowUp back to second item
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectListItemFocused(1);

    // ArrowUp back to first item
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectListItemFocused(0);

    // ArrowUp on first item should keep focus there
    await dashboardPage.pressKey('ArrowUp');
    await dashboardPage.expectListItemFocused(0);
  });

  test('pressing Enter on the last list item creates a new item', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await dashboardPage.selectListType();

    await dashboardPage.addListItem('Only item');

    await dashboardPage.focusListItem(0);
    await dashboardPage.pressKey('Enter');

    await dashboardPage.expectListItemCount(2);
    await dashboardPage.expectListItemFocused(1);
  });
});
