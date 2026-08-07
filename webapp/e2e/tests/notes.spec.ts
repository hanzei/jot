import type { Page } from '@playwright/test';
import { test, expect, uniqueUsername } from '../fixtures';

// created_at/updated_at have 1-second resolution (SQLite/Postgres DATETIME), so
// two writes in the same second sort ambiguously. Wait for the wall clock to
// actually cross into a new second rather than guessing a fixed delay.
async function waitForNextSecond(page: Page) {
  const startSecond = await page.evaluate(() => Math.floor(Date.now() / 1000));
  await page.waitForFunction(
    (start) => Math.floor(Date.now() / 1000) > start,
    startSecond,
  );
}

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

  test('opens a binned note read-only, with Restore / Delete forever in the overflow menu', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Read Only In Bin');
    await dashboardPage.deleteNote('Read Only In Bin');
    await dashboardPage.switchToBin();

    await dashboardPage.openNote('Read Only In Bin');

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByPlaceholder('Note title...')).toHaveAttribute('readonly', '');
    await expect(dialog.getByRole('button', { name: 'Pin note' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Archive note' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Select note color' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Add image' })).toBeDisabled();

    await dashboardPage.openModalOverflowMenu();
    await expect(page.getByRole('menuitem', { name: 'Restore' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete forever' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Share' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(0);
  });

  test('restores a binned note from within the read-only modal', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Restore From Modal');
    await dashboardPage.deleteNote('Restore From Modal');
    await dashboardPage.switchToBin();

    await dashboardPage.openNote('Restore From Modal');
    await dashboardPage.openModalOverflowMenu();
    await page.getByRole('menuitem', { name: 'Restore' }).click();

    await dashboardPage.expectNoteNotVisible('Restore From Modal');
    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteVisible('Restore From Modal');
  });

  test('permanently deletes a binned note from within the read-only modal', async ({ dashboardPage, page }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Delete Forever From Modal');
    await dashboardPage.deleteNote('Delete Forever From Modal');
    await dashboardPage.switchToBin();

    await dashboardPage.openNote('Delete Forever From Modal');
    await dashboardPage.openModalOverflowMenu();
    await page.getByRole('menuitem', { name: 'Delete forever' }).click();
    const confirmDialog = page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete forever' }).click();

    await dashboardPage.expectNoteNotVisible('Delete Forever From Modal');
    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteNotVisible('Delete Forever From Modal');
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

  test('pins a note and it appears in the pinned section', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to Pin');

    await dashboardPage.pinNote('Note to Pin');

    // Pinned section heading should appear with the note under it
    await expect(dashboardPage.pinnedSectionHeading()).toBeVisible();
    await expect(dashboardPage.noteCard('Note to Pin')).toBeVisible();
  });

  test('unpins a pinned note', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Pinned Note');
    await dashboardPage.pinNote('Pinned Note');
    await expect(dashboardPage.pinnedSectionHeading()).toBeVisible();

    await dashboardPage.unpinNote('Pinned Note');
    // Pinned section heading should disappear once the only pinned note is unpinned
    await expect(dashboardPage.pinnedSectionHeading()).toHaveCount(0);
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

    // These waits keep created/updated timestamps in distinct seconds so the
    // sort assertions stay deterministic across create/edit operations.
    await dashboardPage.createNote('Zulu');
    await waitForNextSecond(page);
    await dashboardPage.createNote('alpha');
    await waitForNextSecond(page);
    await dashboardPage.createNote('Bravo');
    await dashboardPage.pinNote('Zulu');

    await dashboardPage.selectSort('created_at');
    await dashboardPage.expectManualReorderDisabledNotice();
    await dashboardPage.expectVisibleNoteTitles(['Zulu', 'Bravo', 'alpha']);

    await waitForNextSecond(page);
    // Patch the alpha note directly so updated_at changes deterministically without
    // relying on modal timing or extra UI interactions in this ordering test.
    // createNote() creates list notes (title only), so content is rejected. Use a
    // round-trip title change (alpha → alpha_tmp → alpha) to bump updated_at while
    // keeping the final title intact for the sort assertions below.
    await page.evaluate(async () => {
      const response = await fetch('/api/v1/notes', { credentials: 'include' });
      const notes = await response.json() as Array<{ id: string; title: string }>;
      const alphaNote = notes.find(note => note.title === 'alpha');
      if (!alphaNote) {
        throw new Error('alpha note not found');
      }

      const patch = (body: object) => fetch(`/api/v1/notes/${alphaNote.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const r1 = await patch({ title: 'alpha_tmp' });
      if (!r1.ok) throw new Error(`Failed to update alpha note: ${r1.status}`);
      const r2 = await patch({ title: 'alpha' });
      if (!r2.ok) throw new Error(`Failed to revert alpha note title: ${r2.status}`);
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
    // Wait for this toast to clear before the next duplication. The "Note duplicated" toast
    // includes an Undo action, so it auto-dismisses after 7 s. If we don't wait, a second
    // duplicate later in the same test will cause a strict-mode violation because both
    // "Note duplicated" toasts are simultaneously in the DOM.
    await expect(page.getByText('Note duplicated')).toHaveCount(0, { timeout: 10000 });
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
        items: Array<{ id: string; text: string; position: number; completed: boolean; parent_id: string | null; assigned_to: string }>;
        labels: Array<{ name: string }>;
        shared_with: Array<{ shared_with_user_id: string }>;
      };
    };

    const sourceList = await findNoteByTitle('Source List');
    // Set up the source list via the granular item endpoints: assign the first
    // item to the collaborator and mark the second completed + nested under the
    // first. Duplication should copy text/position/completed/grouping but clear
    // assignments (and shares).
    const assignResp = await request.patch(`/api/v1/notes/${sourceList.id}/items/${sourceList.items[0]!.id}`, {
      headers: authHeaders,
      data: { assigned_to: collaboratorId },
    });
    expect(assignResp.ok()).toBeTruthy();
    const secondItemResp = await request.patch(`/api/v1/notes/${sourceList.id}/items/${sourceList.items[1]!.id}`, {
      headers: authHeaders,
      data: { completed: true, parent_id: sourceList.items[0]!.id },
    });
    expect(secondItemResp.ok()).toBeTruthy();

    await dashboardPage.openNote('Source List');
    await dashboardPage.duplicateCurrentNoteFromModal();
    await expect(page.getByText('Note duplicated')).toBeVisible();
    await dashboardPage.expectNoteAtPosition(0, 'Copy of Source List');

    const duplicatedList = await findNoteByTitle('Copy of Source List');
    expect(duplicatedList.labels.map((label) => label.name)).toEqual(['list-label']);
    expect(duplicatedList.shared_with ?? []).toEqual([]);
    const duplicatedItems = duplicatedList.items ?? [];
    expect(duplicatedItems).toHaveLength(2);
    expect(duplicatedItems[0]).toEqual(
      expect.objectContaining({
        text: 'Prepare agenda',
        position: 0,
        completed: false,
        parent_id: null,
        assigned_to: '',
      }),
    );
    // The nested child is re-pointed at the duplicated parent's new ID, so the
    // group survives duplication.
    expect(duplicatedItems[1]).toEqual(
      expect.objectContaining({
        text: 'Send follow-up',
        position: 1,
        completed: true,
        parent_id: duplicatedItems[0]!.id,
        assigned_to: '',
      }),
    );
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

  test('converts a text note to a list and back, restoring the title as an h1 line and warning about dropped assignments', async ({ page, dashboardPage, request }) => {
    const collaboratorName = uniqueUsername('convert');
    const collaboratorPassword = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: collaboratorName, password: collaboratorPassword },
    });
    expect(registerResp.ok()).toBeTruthy();
    const collaboratorId = (await registerResp.json()).user.id as string;

    await dashboardPage.goto();

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'jot_session');
    expect(sessionCookie, 'session cookie must exist').toBeDefined();
    const authHeaders = { Cookie: `jot_session=${sessionCookie!.value}` };

    const listNotesApi = async () => {
      const response = await request.get('/api/v1/notes', { headers: authHeaders });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };

    // Seed the source text note via the API — multi-line markdown content is
    // awkward to type into the dashboard's title-based note lookup helpers,
    // which key off an <h3> that only list notes with a title render.
    const createResp = await request.post('/api/v1/notes', {
      headers: authHeaders,
      data: { note_type: 'text', content: '# Groceries\n- [x] **Milk**\n- Eggs\n  - [ ] Free range' },
    });
    expect(createResp.ok()).toBeTruthy();
    const sourceNote = await createResp.json();

    // --- text -> list: block markers are consumed, inline formatting and
    // nesting survive (docs/specs/markdown-rendering.md §2.2) ---
    await page.reload();
    await dashboardPage.noteCardByText('Groceries').click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();
    await dashboardPage.convertCurrentNoteToList();
    await expect(page.getByText('Note converted')).toBeVisible();

    let allNotes = await listNotesApi();
    let converted = allNotes.find((n: { id: string }) => n.id === sourceNote.id);
    expect(converted.note_type).toBe('list');
    expect(
      converted.items.map((item: { text: string; completed: boolean }) => ({ text: item.text, completed: item.completed })),
    ).toEqual([
      { text: 'Groceries', completed: false },
      { text: '**Milk**', completed: true },
      { text: 'Eggs', completed: false },
      { text: 'Free range', completed: false },
    ]);
    // The indented line became a child of the item above it; the server rebuilt
    // parent_id from the indent_level the client sent.
    expect(converted.items[2].parent_id).toBeNull();
    expect(converted.items[3].parent_id).toBe(converted.items[2].id);

    // The modal stays open on the converted list note. Give it a title so it
    // round-trips back as an h1 line below and is findable via the title-based
    // note-lookup helpers.
    await page.fill('input[placeholder="Note title..."]', 'Groceries List');
    await dashboardPage.closeNoteModal();

    // --- list -> text: assigning an item requires sharing the note first ---
    const shareResp = await request.post(`/api/v1/notes/${converted.id}/share`, {
      headers: authHeaders,
      data: { user_id: collaboratorId },
    });
    expect(shareResp.ok()).toBeTruthy();
    const assignResp = await request.patch(`/api/v1/notes/${converted.id}/items/${converted.items[1].id}`, {
      headers: authHeaders,
      data: { assigned_to: collaboratorId },
    });
    expect(assignResp.ok()).toBeTruthy();

    await page.reload();
    await dashboardPage.openNote('Groceries List');
    await dashboardPage.openModalOverflowMenu();
    await page.getByRole('menuitem', { name: 'Convert to text' }).click();
    await expect(page.getByText(/lose the assignment of 1 item/)).toBeVisible();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Convert to text' }).click();
    await expect(page.getByText('Note converted')).toBeVisible();

    allNotes = await listNotesApi();
    const revertedToText = allNotes.find((n: { id: string }) => n.id === sourceNote.id);
    expect(revertedToText.note_type).toBe('text');
    expect(revertedToText.title).toBe('');
    // Inline formatting and nesting round-tripped. The content is not identical
    // to the source: `# Groceries` comes back as a task line, because an item has
    // only one representation (docs/specs/markdown-rendering.md §2.2).
    expect(revertedToText.content).toBe(
      '# Groceries List\n\n- [ ] Groceries\n- [x] **Milk**\n- [ ] Eggs\n  - [ ] Free range',
    );
  });
});
