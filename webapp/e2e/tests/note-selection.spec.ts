import { test, expect } from '../fixtures';
import { confirmDialog } from '../pages/dialogs';
import { createTextNote, createTextNotes, currentUserId, shareNote, signUp } from '../fixtures/publicLinks';

// Multi-select on the note grid (#1255): select several cards, apply one action
// to all of them, undo the whole batch at once.

test.describe('Note multi-select', () => {
  test('pins several notes at once and undoes the whole batch', async ({ page, authenticatedUser, dashboardPage, toastPage }) => {
    void authenticatedUser;
    await createTextNotes(page.request, ['Select Alpha', 'Select Beta', 'Select Gamma']);
    await dashboardPage.goto();

    await dashboardPage.toggleNoteSelection('Select Alpha');
    await dashboardPage.toggleNoteSelection('Select Gamma');
    await dashboardPage.expectSelectionCount(2);
    // The action bar takes the search bar's place while anything is selected.
    await expect(page.getByRole('search')).toHaveCount(0);

    await dashboardPage.selectionAction('Pin').click();
    await expect(toastPage.toastWithText('2 notes pinned')).toBeVisible();
    await expect(dashboardPage.selectionBar()).toHaveCount(0);
    await expect(dashboardPage.pinnedSectionHeading()).toBeVisible();
    await expect(dashboardPage.noteCard('Select Alpha')).toHaveCount(1);
    // Both selected notes sit in the pinned section, the other one does not.
    const pinnedSection = page.locator('div').filter({ has: dashboardPage.pinnedSectionHeading() }).last();
    await expect(pinnedSection.getByTestId('note-card')).toHaveCount(2);

    await toastPage.clickUndoOnLatestToast();
    await expect(dashboardPage.pinnedSectionHeading()).toHaveCount(0);
  });

  test('selects a range with shift-click, and Escape clears the selection', async ({ page, authenticatedUser, dashboardPage }) => {
    void authenticatedUser;
    await createTextNotes(page.request, ['Range One', 'Range Two', 'Range Three', 'Range Four']);
    await dashboardPage.goto();

    const cards = page.getByTestId('note-card');
    await expect(cards).toHaveCount(4);
    const firstTitle = (await cards.nth(0).innerText()).trim();
    const thirdTitle = (await cards.nth(2).innerText()).trim();

    await dashboardPage.toggleNoteSelection(firstTitle);
    // With a selection active a plain click on a card toggles it instead of
    // opening the note; a shift-click selects everything in between.
    await cards.nth(2).click({ modifiers: ['Shift'] });
    await dashboardPage.expectSelectionCount(3);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(dashboardPage.noteCardCheckbox(thirdTitle)).toBeChecked();
    await expect(cards.nth(3).getByTestId('note-card-select')).not.toBeChecked();

    await page.keyboard.press('Escape');
    await expect(dashboardPage.selectionBar()).toHaveCount(0);
    await expect(page.getByTestId('note-card').locator('[data-selected="true"]')).toHaveCount(0);
  });

  test('archives, colours and labels a selection', async ({ page, authenticatedUser, dashboardPage, toastPage }) => {
    void authenticatedUser;
    await createTextNotes(page.request, ['Batch Red', 'Batch Blue', 'Batch Keep']);
    await page.request.post('/api/v1/labels', { data: { name: 'batch-label' } });
    await dashboardPage.goto();

    // Colour
    await dashboardPage.toggleNoteSelection('Batch Red');
    await dashboardPage.toggleNoteSelection('Batch Blue');
    await dashboardPage.selectionAction('Color').click();
    await page.getByRole('menuitem', { name: 'Coral' }).click();
    await expect(toastPage.toastWithText('Color changed on 2 notes')).toBeVisible();
    await expect(dashboardPage.noteCard('Batch Red')).toHaveClass(/coral/);
    await expect(dashboardPage.noteCard('Batch Blue')).toHaveClass(/coral/);
    await expect(dashboardPage.noteCard('Batch Keep')).not.toHaveClass(/coral/);

    // Labels: added to every selected note, then removed again on a second pick.
    await dashboardPage.toggleNoteSelection('Batch Red');
    await dashboardPage.toggleNoteSelection('Batch Blue');
    await dashboardPage.selectionAction('Labels').click();
    const labelItem = page.getByRole('menuitem', { name: /^batch-label/ });
    await expect(labelItem).toHaveAccessibleName('batch-label');
    await labelItem.click();
    await expect(toastPage.toastWithText('Label "batch-label" added to 2 notes')).toBeVisible();
    await expect(dashboardPage.noteCard('Batch Red')).toContainText('batch-label');
    await expect(dashboardPage.noteCard('Batch Blue')).toContainText('batch-label');
    await expect(dashboardPage.noteCard('Batch Keep')).not.toContainText('batch-label');

    // A label only some of the selection carries shows as mixed and is added
    // to the rest.
    await dashboardPage.toggleNoteSelection('Batch Red');
    await dashboardPage.toggleNoteSelection('Batch Keep');
    await dashboardPage.selectionAction('Labels').click();
    await expect(labelItem).toHaveAccessibleName('batch-label, on some selected notes');
    await page.keyboard.press('Escape');
    await expect(labelItem).toHaveCount(0);

    // Archive, with a single undo for the batch.
    await dashboardPage.selectionAction('Archive').click();
    await expect(toastPage.toastWithText('2 notes archived')).toBeVisible();
    await expect(dashboardPage.noteCard('Batch Red')).toHaveCount(0);
    await expect(dashboardPage.noteCard('Batch Keep')).toHaveCount(0);
    await dashboardPage.expectNoteVisible('Batch Blue');
    await toastPage.clickUndoOnLatestToast();
    await dashboardPage.expectNoteVisible('Batch Red');
    await dashboardPage.expectNoteVisible('Batch Keep');
  });

  test('trashes only owned notes from a mixed selection and reports the rest', async ({ page, request, authenticatedUser, dashboardPage, toastPage }) => {
    void authenticatedUser;
    const myId = await currentUserId(page.request);
    await createTextNote(page.request, 'Mine To Trash');
    await signUp(request, 'selectowner');
    const sharedId = await createTextNote(request, 'Shared With Me');
    await shareNote(request, sharedId, myId);
    await dashboardPage.goto();

    await dashboardPage.toggleNoteSelection('Mine To Trash');
    await dashboardPage.toggleNoteSelection('Shared With Me');
    await dashboardPage.selectionAction('Delete').click();

    await expect(toastPage.toastWithText('1 note shared with you was skipped')).toBeVisible();
    await expect(toastPage.toastWithText('1 note moved to bin')).toBeVisible();
    await expect(dashboardPage.noteCard('Mine To Trash')).toHaveCount(0);
    await dashboardPage.expectNoteVisible('Shared With Me');
  });

  test('restores and permanently deletes a selection in the bin', async ({ page, authenticatedUser, dashboardPage, toastPage }) => {
    void authenticatedUser;
    const ids = await createTextNotes(page.request, ['Bin Restore A', 'Bin Restore B', 'Bin Forever A', 'Bin Forever B']);
    for (const id of ids) {
      await page.request.delete(`/api/v1/notes/${id}`);
    }
    await dashboardPage.goto();
    await dashboardPage.switchToBin();

    await dashboardPage.toggleNoteSelection('Bin Restore A');
    await dashboardPage.toggleNoteSelection('Bin Restore B');
    await expect(dashboardPage.selectionAction('Archive')).toHaveCount(0);
    await dashboardPage.selectionAction('Restore').click();
    await expect(toastPage.toastWithText('2 notes restored')).toBeVisible();
    await expect(dashboardPage.noteCard('Bin Restore A')).toHaveCount(0);
    await expect(dashboardPage.noteCard('Bin Restore B')).toHaveCount(0);

    await dashboardPage.toggleNoteSelection('Bin Forever A');
    await dashboardPage.toggleNoteSelection('Bin Forever B');
    await dashboardPage.selectionAction('Delete forever').click();
    await expect(page.getByRole('dialog')).toContainText('Permanently delete 2 notes?');
    await confirmDialog(page, 'Delete forever');
    await expect(toastPage.toastWithText('2 notes permanently deleted')).toBeVisible();
    await expect(page.getByTestId('note-card')).toHaveCount(0);

    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteVisible('Bin Restore A');
    await dashboardPage.expectNoteVisible('Bin Restore B');
  });

  test('refuses a selection over the cap without applying any of it', async ({ page, authenticatedUser, dashboardPage, toastPage }) => {
    void authenticatedUser;
    const contents = Array.from({ length: 101 }, (_, i) => `Cap Note ${String(i).padStart(3, '0')}`);
    await createTextNotes(page.request, contents);
    await dashboardPage.goto();

    const cards = page.getByTestId('note-card');
    await expect(cards).toHaveCount(101);
    // Ranges are symmetric, so the ends can be named in creation order.
    await dashboardPage.toggleNoteSelection(contents[0]!);
    await dashboardPage.toggleNoteSelection(contents[100]!, { range: true });
    await dashboardPage.expectSelectionCount(101);

    let writes = 0;
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/v1/notes/')) writes++;
    });
    await dashboardPage.selectionAction('Archive').click();
    await expect(toastPage.toastWithText('Select at most 100 at a time')).toBeVisible();
    await expect(cards).toHaveCount(101);
    expect(writes).toBe(0);
  });
});
