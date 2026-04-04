import { test, expect } from '../fixtures';

test.describe('Labels on Note Creation', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('can add a label while creating a new note', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Created With Label', 'content', ['myLabel']);
    await dashboardPage.expectLabelInSidebar('myLabel');
  });

  test('label added during creation appears on the note card', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Badge Note', 'content', ['visible']);
    const card = dashboardPage.noteCard('Badge Note');
    await expect(card.getByText('visible')).toBeVisible();
  });

  test('label can be renamed and deleted from the sidebar', async ({ dashboardPage, isMobile }) => {
    test.skip(isMobile, 'Sidebar label management is covered on desktop only.');
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Manage Label Note', 'content', ['groceries']);

    const card = dashboardPage.noteCard('Manage Label Note');
    await expect(card.getByText('groceries')).toBeVisible();

    await dashboardPage.renameSidebarLabel('groceries', 'weekly groceries');
    await expect(card.getByText('weekly groceries')).toBeVisible();

    await dashboardPage.deleteSidebarLabel('weekly groceries');
    await expect(card.getByText('weekly groceries')).toHaveCount(0);
  });

  test('note created with label is filterable by that label', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Plain', 'no label');
    await dashboardPage.createNoteWithLabels('Labeled', 'content', ['filterme']);

    await dashboardPage.selectSidebarLabel('filterme');

    await dashboardPage.expectNoteVisible('Labeled');
    await dashboardPage.expectNoteNotVisible('Plain');
  });

  test('multiple labels can be added during creation', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Multi Label', 'content', ['alpha', 'beta']);

    await dashboardPage.expectLabelInSidebar('alpha');
    await dashboardPage.expectLabelInSidebar('beta');

    const card = dashboardPage.noteCard('Multi Label');
    await expect(card.getByText('alpha')).toBeVisible();
    await expect(card.getByText('beta')).toBeVisible();
  });

  test('can create a sidebar label and show count after assigning it', async ({ dashboardPage, isMobile }) => {
    test.skip(isMobile, 'Sidebar label management is covered on desktop only.');
    await dashboardPage.goto();

    await dashboardPage.createSidebarLabel('taxonomy');
    await dashboardPage.expectSidebarLabelCount('taxonomy', 0);

    await dashboardPage.createNoteWithLabels('Sidebar Counted Note', 'content', ['taxonomy']);
    await dashboardPage.expectSidebarLabelCount('taxonomy', 1);
  });
});

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

  test('deleting the active label clears the filter and returns to notes view', async ({ page, dashboardPage, isMobile }) => {
    test.skip(isMobile, 'Sidebar label management is covered on desktop only.');
    await dashboardPage.goto();
    await dashboardPage.createNote('Filtered Note', 'content');
    await dashboardPage.createNote('Plain Note', 'content');
    await dashboardPage.addLabelToNote('Filtered Note', 'temp-filter');

    await dashboardPage.expectLabelInSidebar('temp-filter');
    await dashboardPage.selectSidebarLabel('temp-filter');
    await dashboardPage.expectNoteVisible('Filtered Note');
    await dashboardPage.expectNoteNotVisible('Plain Note');
    await expect(page).toHaveURL(/label=/);

    await dashboardPage.deleteSidebarLabel('temp-filter');

    await expect(page).not.toHaveURL(/label=/);
    await dashboardPage.expectNoteVisible('Filtered Note');
    await dashboardPage.expectNoteVisible('Plain Note');
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

test.describe('Label Filtering — Mobile', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('label list is visible in the sidebar on mobile', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Mobile Note', 'content');
    await dashboardPage.addLabelToNote('Mobile Note', 'mobilelabel');

    const sidebar = page.locator('aside[aria-label="Main navigation"]');
    await expect(sidebar).toBeHidden();

    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(sidebar).toBeVisible();

    await expect(sidebar.getByTestId('sidebar-labels')).toBeVisible();
    await expect(
      sidebar.locator('ul').getByRole('button', { name: 'mobilelabel', exact: true })
    ).toBeVisible();
  });

  test('clicking a label filters notes and closes the sidebar on mobile', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Labeled Mobile', 'has label');
    await dashboardPage.createNote('Plain Mobile', 'no label');
    await dashboardPage.addLabelToNote('Labeled Mobile', 'mobiletag');

    const sidebar = page.locator('aside[aria-label="Main navigation"]');
    await expect(sidebar).toBeHidden();

    await dashboardPage.selectSidebarLabel('mobiletag');
    await expect(sidebar).toBeHidden();

    await dashboardPage.expectNoteVisible('Labeled Mobile');
    await dashboardPage.expectNoteNotVisible('Plain Mobile');
  });

  test('multiple labels appear in the sidebar on mobile', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNoteWithLabels('Multi Mobile', 'content', ['alpha', 'beta']);

    const sidebar = page.locator('aside[aria-label="Main navigation"]');
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(sidebar).toBeVisible();

    await expect(
      sidebar.locator('ul').getByRole('button', { name: 'alpha', exact: true })
    ).toBeVisible();
    await expect(
      sidebar.locator('ul').getByRole('button', { name: 'beta', exact: true })
    ).toBeVisible();
  });
});
