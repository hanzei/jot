import { test, expect } from '../fixtures';
import { otherDevice, provokeVersionConflict } from '../fixtures/noteConflict';

/**
 * A stale tab must not silently overwrite a newer edit made elsewhere (#489).
 * The tab's content autosave carries base_version; when another device changed
 * the note first, the save is rejected, the local text stays on screen, and a
 * banner offers Reload (take theirs) or Overwrite (keep mine).
 */
test.describe('Note version conflicts', () => {
  test('Reload discards the local edit and shows the other device\'s copy', async ({ page, request, authenticatedUser, dashboardPage, noteEditorPage, noteConflictBanner }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createTextNote('Original text');
    const device = await otherDevice(page, request);
    const note = await device.findTextNote('Original text');

    await dashboardPage.openTextNote('Original text');
    await provokeVersionConflict(page, device, note.id, 'Mine', 'Theirs');

    await noteConflictBanner.expectVisible();
    // Nothing is lost silently: the rejected edit is still in the editor.
    await noteEditorPage.expectContent('Mine');

    await noteConflictBanner.reload();

    await noteConflictBanner.expectHidden();
    await noteEditorPage.expectContent('Theirs');
    expect((await device.getNote(note.id)).content).toBe('Theirs');
  });

  test('Overwrite re-sends the local edit against the current version', async ({ page, request, authenticatedUser, dashboardPage, noteEditorPage, noteConflictBanner }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createTextNote('Original text');
    const device = await otherDevice(page, request);
    const note = await device.findTextNote('Original text');

    await dashboardPage.openTextNote('Original text');
    await provokeVersionConflict(page, device, note.id, 'Mine', 'Theirs');
    await noteConflictBanner.expectVisible();

    await noteConflictBanner.overwrite();

    await noteConflictBanner.expectHidden();
    await noteEditorPage.expectContent('Mine');
    // Overwrite resends against the refetched version, so this write lands.
    await expect.poll(async () => (await device.getNote(note.id)).content).toBe('Mine');
  });
});
