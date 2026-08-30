import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * The half of accessibility that axe cannot see.
 *
 * Automated scans check the static accessibility tree; they say nothing about
 * whether focus is trapped inside a modal, comes back when it closes, or
 * whether a pointer-driven affordance like drag-and-drop has a keyboard
 * equivalent at all. Those are the failures a modal-heavy app actually ships,
 * so they are asserted here rather than assumed from the libraries in use.
 *
 * Much of this behaviour comes from `@headlessui/react` and `@dnd-kit` rather
 * than from Jot's own code. That is exactly why it is worth pinning: a
 * dependency bump or a stray `role` can remove it silently, and nothing else
 * in the suite would notice.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noteImageFile = {
  name: 'test-icon.png',
  mimeType: 'image/png',
  buffer: fs.readFileSync(path.join(__dirname, '../fixtures/test-icon.png')),
};

/** Whether the currently focused element lives inside `container`. */
function focusIsInside(container: Locator): Promise<boolean> {
  return container.evaluate((el) => el.contains(document.activeElement));
}

/**
 * Tabs forward repeatedly and asserts focus never escapes the dialog.
 *
 * The step count only needs to exceed the number of tabbable elements in the
 * panel for the cycle to wrap at least once — that wrap is the thing being
 * tested.
 */
async function expectFocusTrapped(page: Page, dialog: Locator, steps = 15) {
  // The headlessui Dialog root is a zero-size wrapper around the panel, so
  // `toBeVisible` is false for it even while the modal is on screen. Presence
  // is the right check — it is the containment boundary, not a rendered box.
  await expect(dialog).toBeAttached();
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press('Tab');
    expect(await focusIsInside(dialog), `focus left the dialog after ${step + 1} Tab press(es)`).toBe(true);
  }
}

/**
 * Picks a sortable up from `activator`, moves it one slot and drops it.
 *
 * Each step waits for @dnd-kit to acknowledge the previous one — `aria-pressed`
 * for the pick-up, a changed screen-reader announcement for the move. Firing
 * the three keys back to back instead makes the drop land on the position the
 * item started from, which looks exactly like keyboard dragging not working.
 */
async function keyboardReorder(page: Page, activator: Locator, direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') {
  const announcement = () =>
    page.locator('[id^="DndLiveRegion"]').allTextContents().then((texts) => texts.join(' '));

  await activator.focus();
  await page.keyboard.press('Space');
  await expect(activator).toHaveAttribute('aria-pressed', 'true');

  const pickedUp = await announcement();
  await page.keyboard.press(direction);
  await expect.poll(announcement).not.toBe(pickedUp);

  await page.keyboard.press('Space');
}

test.describe('Modal focus management', () => {
  test('note modal traps focus and restores it to the card on close', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createListNote('Focus Trap Note', ['first item']);

    const card = dashboardPage.noteCardButton('Focus Trap Note');
    await card.focus();
    await page.keyboard.press('Enter');

    const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
    await expect(page.getByTestId('list-item-input').first()).toBeVisible();
    expect(await focusIsInside(dialog)).toBe(true);

    await expectFocusTrapped(page, dialog);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // headlessui returns focus to whatever was focused when the dialog opened,
    // which is what lets keyboard users carry on from where they were instead
    // of restarting at the top of the document.
    await expect(card).toBeFocused();
  });

  test('markdown toolbar is a single tab stop with arrow-key navigation', async ({ authenticatedUser, page, dashboardPage, noteEditorPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await noteEditorPage.openNewNote();
    await noteEditorPage.setContent('formatting');

    const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
    const toolbar = noteEditorPage.toolbar();
    await expect(toolbar).toHaveAttribute('role', 'toolbar');

    // The toolbar is docked to the modal chrome, below the scrolling body, so
    // Tab reaches the body's remaining controls first and only then the bar.
    // That is the correct order for where it sits, and it costs nothing here
    // because a text note's edit mode does not end on a blur.
    await noteEditorPage.textarea().focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Add labels' })).toBeFocused();

    // Then one Tab onto the first button, and one tab stop for the whole bar —
    // the WAI-ARIA toolbar pattern, so the six buttons do not sit between the
    // body and the rest of the modal.
    await page.keyboard.press('Tab');
    await expect(noteEditorPage.formatButton('bold')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(noteEditorPage.formatButton('italic')).toBeFocused();

    // A second Tab leaves the toolbar entirely rather than stepping through it.
    await page.keyboard.press('Tab');
    await expect(noteEditorPage.formatButton('italic')).not.toBeFocused();
    expect(await focusIsInside(toolbar)).toBe(false);
    expect(await focusIsInside(dialog)).toBe(true);

    await expectFocusTrapped(page, dialog);
  });

  test('confirm dialog traps focus and restores it to the menu button on cancel', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Confirm Focus Note');
    await dashboardPage.deleteNote('Confirm Focus Note');
    await dashboardPage.switchToBin();

    const menuButton = dashboardPage.noteCard('Confirm Focus Note').getByRole('button', { name: 'Note options' });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete forever' }).click();

    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByRole('button', { name: 'Delete forever', exact: true })).toBeVisible();
    await expectFocusTrapped(page, dialog);

    // Escape must dismiss the confirmation, and the note must survive it —
    // backing out of a destructive prompt should not need a hunt for Cancel.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await dashboardPage.expectNoteVisible('Confirm Focus Note');
  });

  test('keyboard shortcuts dialog traps focus and restores it to its menu item', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();

    const profileMenuButton = page.getByRole('button', { name: 'Profile menu' });
    await profileMenuButton.click();
    await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();

    const dialog = page.getByTestId('keyboard-shortcuts-dialog');
    await expect(dialog).toBeVisible();
    await expectFocusTrapped(page, dialog);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // The menu item that opened the dialog is gone by now, so headlessui falls
    // back to the button that owns the menu.
    await expect(profileMenuButton).toBeFocused();
  });

  test('share modal traps focus and restores it to the note modal on close', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Share Focus Note');
    await dashboardPage.openNote('Share Focus Note');
    await dashboardPage.openShareModalFromModal();

    const shareDialog = page.getByRole('dialog', { name: 'Share' });
    await expect(shareDialog.getByLabel('Share with user')).toBeVisible();
    await expectFocusTrapped(page, shareDialog);

    await page.keyboard.press('Escape');
    await expect(shareDialog).toBeHidden();
    // Focus must land back inside the note modal underneath, not on the body:
    // the note modal is still open and is what the user is looking at.
    const noteDialog = page.locator('[role="dialog"][aria-modal="true"]').first();
    expect(await focusIsInside(noteDialog)).toBe(true);
  });

  test('image lightbox traps focus and closes on Escape', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    const title = `Lightbox Focus Note ${Date.now()}`;
    await dashboardPage.createNote(title);

    const notes: Array<{ id: string; title?: string }> = await (await page.request.get('/api/v1/notes')).json();
    const note = notes.find((n) => n.title === title);
    expect(note, 'note was not created').toBeTruthy();
    for (let i = 0; i < 2; i++) {
      const upload = await page.request.post(`/api/v1/notes/${note!.id}/images`, { multipart: { file: noteImageFile } });
      expect(upload.ok()).toBeTruthy();
    }

    await page.reload();
    await dashboardPage.openNote(title);
    await page.getByTestId('note-image-grid').locator('img').first().click();

    const lightbox = page.getByRole('dialog').last();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expectFocusTrapped(page, lightbox);

    await page.keyboard.press('Escape');
    await expect(page.getByText('1 / 2')).toBeHidden();
  });
});

test.describe('Keyboard drag and drop', () => {
  test('reorders notes on the dashboard with the keyboard', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    // Single column so DOM order matches what a user sees top to bottom.
    await page.setViewportSize({ width: 500, height: 900 });
    await dashboardPage.goto();
    // Newest first, so the display order is Second, First.
    await dashboardPage.createNote('DnD First');
    await dashboardPage.createNote('DnD Second');
    await dashboardPage.expectVisibleNoteTitles(['DnD Second', 'DnD First']);

    // The KeyboardSensor lives on a per-card reorder button that is invisible
    // until focused, not on the sortable wrapper: the wrapper carries no role
    // and no tab stop, so there is nothing there for a keypress to reach.
    await keyboardReorder(page, page.getByRole('button', { name: 'Reorder note' }).first(), 'ArrowDown');

    await dashboardPage.expectVisibleNoteTitles(['DnD First', 'DnD Second']);
  });

  test('reveals the reorder handle when the card is highlighted, before it is tabbed to', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Grip Reveal Note');

    // The reveal is an opacity transition, and Playwright's toBeVisible() does
    // not read opacity — an opacity-0 element still counts as visible — so this
    // asserts on the computed value instead.
    const grip = page.getByRole('button', { name: 'Reorder note' }).first();
    await expect(grip).toHaveCSS('opacity', '0');

    // Focus the card itself, not the grip. The grip has to appear alongside the
    // overflow menu on this highlight — if it only revealed on its own focus,
    // it would stay hidden until an extra Tab.
    await dashboardPage.noteCardButton('Grip Reveal Note').focus();
    await expect(grip).toHaveCSS('opacity', '1');
  });

  test('reorders list items in the note modal with the keyboard', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createListNote('DnD Items Note', ['alpha', 'beta']);
    await dashboardPage.openNote('DnD Items Note');
    await dashboardPage.expectListItemValue(0, 'alpha');
    await dashboardPage.expectListItemValue(1, 'beta');

    // The grip is a real button, so it is reachable by keyboard at all — the
    // drag listeners and the tab stop have to be on the same element for the
    // KeyboardSensor to ever see a keypress.
    await keyboardReorder(page, page.getByRole('button', { name: 'Reorder item' }).first(), 'ArrowDown');

    await dashboardPage.expectListItemValue(0, 'beta');
    await dashboardPage.expectListItemValue(1, 'alpha');
  });

  test('reorders a row that is showing rendered Markdown', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createListNote('DnD Rendered Note', ['**alpha**', 'beta']);
    await dashboardPage.openNote('DnD Rendered Note');

    // An unfocused row shows its rendered form, so the row dnd-kit measures is
    // the rendered one. Reordering has to work from there, not just from the
    // source form a freshly typed row happens to be in.
    await expect(dashboardPage.listItemRendered(0)).toBeVisible();
    await keyboardReorder(page, page.getByRole('button', { name: 'Reorder item' }).first(), 'ArrowDown');

    await dashboardPage.expectListItemValue(0, 'beta');
    await dashboardPage.expectListItemValue(1, '**alpha**');
  });
});

/**
 * The row-level view/edit swap (docs/specs/markdown-rendering.md §1.2) makes
 * "focused" and "editing" the same state, which is what keeps every keystroke
 * handler on a real textarea. These pin that: the keys that move between rows
 * have to keep working when the rows they move to and from are rendered.
 */
test.describe('List rows with rendered Markdown', () => {
  test('splits and navigates between rendered rows with the keyboard', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createListNote('Rendered Keys Note', ['**alpha**', '**beta**']);
    await dashboardPage.openNote('Rendered Keys Note');

    // Both rows start rendered, and focusing one is what turns it back into a
    // field — there is no separate "enter edit mode" step to forget.
    await expect(page.getByTestId('list-item-rendered')).toHaveCount(2);
    await dashboardPage.focusListItem(0);
    await expect(page.getByTestId('list-item-rendered')).toHaveCount(1);

    // Arrow down moves to the next row, which becomes a field in turn.
    await page.keyboard.press('ArrowDown');
    await dashboardPage.expectListItemFocused(1);
    await expect(page.getByTestId('list-item-rendered')).toHaveCount(1);

    // Enter at the end appends a row and focuses it; the row left behind
    // renders again because it is no longer the focused one.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await dashboardPage.expectListItemCount(3);
    await dashboardPage.expectListItemFocused(2);
    await expect(page.getByTestId('list-item-rendered')).toHaveCount(2);
  });

  test('indents a rendered row with Tab', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createListNote('Rendered Indent Note', ['**parent**', '**child**']);
    await dashboardPage.openNote('Rendered Indent Note');

    const childRow = dashboardPage.listItemRow(1);
    const before = (await childRow.boundingBox())!.x;

    await dashboardPage.focusListItem(1);
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await childRow.boundingBox())!.x).toBeGreaterThan(before);
  });
});

test.describe('Toast announcements', () => {
  test('announces an undoable action in a polite live region with a reachable undo', async ({ authenticatedUser, page, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Toast A11y Note');
    await dashboardPage.archiveNote('Toast A11y Note');

    // Polite, not assertive: the toast reports something that already
    // happened, so it must not interrupt whatever is being read.
    const toast = page.getByTestId('toast');
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toHaveAttribute('aria-live', 'polite');

    // The undo is the reason the announcement matters — a message a screen
    // reader user hears but cannot act on before it auto-dismisses is not an
    // undo affordance.
    const undo = toast.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await undo.focus();
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');

    await dashboardPage.expectNoteVisible('Toast A11y Note');
  });
});
