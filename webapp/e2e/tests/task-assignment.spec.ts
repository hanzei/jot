import { test, expect, uniqueUsername } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

test.describe('Task Assignment', () => {
  test('assign and unassign a todo item via the note modal', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const user2Name = uniqueUsername('collab');
    const user2Pass = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });
    expect(registerResp.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Assignment Test', ['Buy milk', 'Buy eggs']);
    await dashboardPage.shareNoteWithUser('Assignment Test', user2Name);

    // Open the note modal
    await dashboardPage.openNote('Assignment Test');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    // Hover over the first todo item row to reveal the assign button
    const firstItemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await firstItemRow.hover();

    // Click the assign button (UserPlusIcon button)
    const assignButton = firstItemRow.locator('button[aria-label="Assign item"]');
    await assignButton.waitFor({ state: 'visible', timeout: 5000 });
    await assignButton.click();

    // The assignee picker popover should appear
    await expect(page.getByText('Assign item')).toBeVisible();

    // Click on the collaborator to assign them
    await page.getByText(user2Name).click();

    // The avatar should now be visible on the item row (picker closes automatically)
    await expect(firstItemRow.locator('svg[role="img"], img[alt]').first()).toBeVisible();

    // Close and reopen the note to verify persistence
    await page.click('button[aria-label="Close"]');
    await dashboardPage.openNote('Assignment Test');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    // The avatar should still be visible after reopening
    const firstItemRowAfter = page.locator('input[placeholder="List item..."]').first().locator('..');
    await expect(firstItemRowAfter.locator('svg[role="img"], img[alt]').first()).toBeVisible();

    // Now unassign: click the avatar to open the picker
    await firstItemRowAfter.locator('svg[role="img"], img[alt]').first().click();
    await expect(page.getByText('Unassign')).toBeVisible();
    await page.getByText('Unassign').click();

    // The avatar should no longer be always-visible on the item
    // (the assign button only shows on hover, so the row should have no avatar)
    await expect(firstItemRowAfter.locator('button[aria-label="Assign item"]')).toHaveCount(1);

    await page.click('button[aria-label="Close"]');
  });

  test('unsharing a user clears their assignment', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const user2Name = uniqueUsername('collab');
    const user2Pass = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });
    expect(registerResp.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Unshare Cleanup', ['Task 1']);
    await dashboardPage.shareNoteWithUser('Unshare Cleanup', user2Name);

    // Open the note and assign the item
    await dashboardPage.openNote('Unshare Cleanup');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const itemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await itemRow.hover();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    await assignBtn.waitFor({ state: 'visible', timeout: 5000 });
    await assignBtn.click();
    await page.getByText(user2Name).click();

    // Confirm the avatar is visible
    await expect(itemRow.locator('svg[role="img"], img[alt]').first()).toBeVisible();
    await page.click('button[aria-label="Close"]');

    // Unshare via API
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c => c.name === 'jot_session');
    expect(sessionCookie, 'session cookie must exist').toBeDefined();

    const notesResp = await request.get('/api/v1/notes', {
      headers: { Cookie: `jot_session=${sessionCookie!.value}` },
    });
    expect(notesResp.ok()).toBeTruthy();
    const notes = await notesResp.json();
    const note = notes.find((n: { title: string }) => n.title === 'Unshare Cleanup');
    expect(note, 'note "Unshare Cleanup" must exist in API response').toBeDefined();

    const unshareResp = await request.delete(`/api/v1/notes/${note.id}/share`, {
      headers: { Cookie: `jot_session=${sessionCookie!.value}` },
      data: { username: user2Name },
    });
    expect(unshareResp.ok()).toBeTruthy();

    // Reopen the note — the assignment should be gone
    await dashboardPage.openNote('Unshare Cleanup');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    // The assign button should not be visible since the note is no longer shared
    const itemRowAfter = page.locator('input[placeholder="List item..."]').first().locator('..');
    await expect(itemRowAfter.locator('button[aria-label="Assign item"]')).toHaveCount(0);

    await page.click('button[aria-label="Close"]');
  });

  test('My Todo filter shows only notes with items assigned to current user', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const user2Name = uniqueUsername('collab');
    const user2Pass = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });
    expect(registerResp.ok()).toBeTruthy();

    await dashboardPage.goto();

    await dashboardPage.createTodoNote('Assigned Todo', ['Task for me']);
    await dashboardPage.createNote('Plain Note', 'No todos here');

    await dashboardPage.shareNoteWithUser('Assigned Todo', user2Name);

    // Open the note and self-assign the first item
    await dashboardPage.openNote('Assigned Todo');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const itemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await itemRow.hover();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    await assignBtn.waitFor({ state: 'visible', timeout: 5000 });
    await assignBtn.click();

    await expect(page.getByText('Assign item')).toBeVisible();
    const pickerPopover = page.locator('.max-h-48');
    await pickerPopover.getByText(authenticatedUser.username).click();

    await page.click('button[aria-label="Close"]');

    // Switch to My Todo view
    await dashboardPage.switchToMyTodo();

    // Should see the assigned note
    await dashboardPage.expectNoteVisible('Assigned Todo');
    // Should not see the plain note
    await dashboardPage.expectNoteNotVisible('Plain Note');

    // Switch back to Notes view
    await dashboardPage.switchToNotes();
    await dashboardPage.expectNoteVisible('Assigned Todo');
    await dashboardPage.expectNoteVisible('Plain Note');
  });

  test('My Todo filter shows empty state when no assignments', async ({
    page,
    authenticatedUser,
    dashboardPage,
  }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Regular Note', 'Just a note');

    await dashboardPage.switchToMyTodo();
    await dashboardPage.expectEmptyState('No notes with todos assigned to you');
  });

  test('collaborator sees the assignment on a shared note', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const ownerName = authenticatedUser.username;
    const user2Name = uniqueUsername('viewer');
    const user2Pass = 'testpass123';

    const registerResp = await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });
    expect(registerResp.ok()).toBeTruthy();

    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Collab View', ['Shared Task']);
    await dashboardPage.shareNoteWithUser('Collab View', user2Name);

    // Open the note and assign the first item to the owner (self-assign)
    await dashboardPage.openNote('Collab View');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const itemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await itemRow.hover();
    const assignBtn = itemRow.locator('button[aria-label="Assign item"]');
    await assignBtn.waitFor({ state: 'visible', timeout: 5000 });
    await assignBtn.click();

    // Click the owner in the assignee picker
    await expect(page.getByText('Assign item')).toBeVisible();
    const pickerPopover = page.locator('.max-h-48');
    await pickerPopover.getByText(ownerName).click();

    await page.click('button[aria-label="Close"]');

    // Log out and log in as user2
    await dashboardPage.logout();
    const loginPage = new LoginPage(page);
    await loginPage.login(user2Name, user2Pass);
    await expect(page).toHaveURL('/');

    // User2 should see the shared note with the assignment avatar
    await expect(page.getByText('Collab View')).toBeVisible();
    const sharedCard = page.locator('[data-testid="note-card"]').filter({ hasText: 'Collab View' });
    await sharedCard.click();
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    // The assigned item should show an avatar
    const sharedItemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await expect(sharedItemRow.locator('svg[role="img"], img[alt]').first()).toBeVisible();

    await page.click('button[aria-label="Close"]');
  });
});
