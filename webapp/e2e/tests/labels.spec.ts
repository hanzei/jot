import { test, expect } from '../fixtures';

test.describe('Label Filtering', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure we're logged in for every test in this suite
    void authenticatedUser;
  });

  test('label appears in sidebar after adding it to a note', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('My Note', 'some content');
    await dashboardPage.addLabelToNote('My Note', 'work');
    await dashboardPage.expectLabelInSidebar('work');
  });

  test('clicking a label filters notes to only those with that label', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Labeled Note', 'has a label');
    await dashboardPage.createNote('Plain Note', 'no label');
    await dashboardPage.addLabelToNote('Labeled Note', 'important');

    await dashboardPage.expectLabelInSidebar('important');
    await dashboardPage.selectSidebarLabel('important');

    await dashboardPage.expectNoteVisible('Labeled Note');
    await dashboardPage.expectNoteNotVisible('Plain Note');
  });

  test('clicking active label again deselects filter and shows all notes', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Tagged Note', 'content');
    await dashboardPage.createNote('Untagged Note', 'content');
    await dashboardPage.addLabelToNote('Tagged Note', 'personal');

    await dashboardPage.expectLabelInSidebar('personal');
    await dashboardPage.selectSidebarLabel('personal');
    await dashboardPage.expectNoteNotVisible('Untagged Note');

    // Click again to deselect
    await dashboardPage.selectSidebarLabel('personal');

    await dashboardPage.expectNoteVisible('Tagged Note');
    await dashboardPage.expectNoteVisible('Untagged Note');
  });

  test('selected label is reflected in the URL', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note', 'content');
    await dashboardPage.addLabelToNote('Note', 'urltest');
    await dashboardPage.expectLabelInSidebar('urltest');

    await dashboardPage.selectSidebarLabel('urltest');

    await expect(page).toHaveURL(/[?&]label=/);
  });

  test('deselecting a label removes the label param from the URL', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note', 'content');
    await dashboardPage.addLabelToNote('Note', 'clearparam');
    await dashboardPage.expectLabelInSidebar('clearparam');

    await dashboardPage.selectSidebarLabel('clearparam');
    await expect(page).toHaveURL(/label=/);

    await dashboardPage.selectSidebarLabel('clearparam');
    await expect(page).not.toHaveURL(/label=/);
  });

  test('clicking a label from archive view shows active labeled notes', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Active Labeled', 'content');
    await dashboardPage.createNote('Active Plain', 'content');
    await dashboardPage.addLabelToNote('Active Labeled', 'fromarchive');

    // Archive a note so archive view has content
    await dashboardPage.archiveNote('Active Plain');

    await dashboardPage.switchToArchived();
    await expect(page).toHaveURL(/view=archive/);

    await dashboardPage.expectLabelInSidebar('fromarchive');
    await dashboardPage.selectSidebarLabel('fromarchive');

    // Should leave archive view and show only the active labeled note
    await expect(page).not.toHaveURL(/view=archive/);
    await expect(page).toHaveURL(/label=/);
    await dashboardPage.expectNoteVisible('Active Labeled');
    await dashboardPage.expectNoteNotVisible('Active Plain');
  });

  test('clicking a label from bin view shows active labeled notes', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Labeled Note', 'content');
    await dashboardPage.addLabelToNote('Labeled Note', 'frombin');

    await dashboardPage.switchToBin();
    await expect(page).toHaveURL(/view=bin/);

    await dashboardPage.expectLabelInSidebar('frombin');
    await dashboardPage.selectSidebarLabel('frombin');

    // Should leave bin view
    await expect(page).not.toHaveURL(/view=bin/);
    await expect(page).toHaveURL(/label=/);
    await dashboardPage.expectNoteVisible('Labeled Note');
  });

  test('label filter is cleared when switching to archive view', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note', 'content');
    await dashboardPage.addLabelToNote('Note', 'archivetag');
    await dashboardPage.expectLabelInSidebar('archivetag');

    await dashboardPage.selectSidebarLabel('archivetag');
    await expect(page).toHaveURL(/label=/);

    await dashboardPage.switchToArchived();
    await expect(page).not.toHaveURL(/label=/);
  });

  test('label filter is cleared when switching to bin view', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note', 'content');
    await dashboardPage.addLabelToNote('Note', 'bintag');
    await dashboardPage.expectLabelInSidebar('bintag');

    await dashboardPage.selectSidebarLabel('bintag');
    await expect(page).toHaveURL(/label=/);

    await dashboardPage.switchToBin();
    await expect(page).not.toHaveURL(/label=/);
  });

  test('archive and bin appear directly after the label list in the sidebar', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Note A', 'content');
    await dashboardPage.addLabelToNote('Note A', 'sidebar-order');
    await dashboardPage.expectLabelInSidebar('sidebar-order');

    await dashboardPage.expectArchiveAndBinDirectlyAfterLabel('sidebar-order');
  });
});
