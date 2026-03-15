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

    await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });

    // Create a todo note
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Assignment Test', ['Buy milk', 'Buy eggs']);

    // Share the note with user2 via the card context menu
    const noteCard = dashboardPage.noteCard('Assignment Test');
    await noteCard.hover();
    await noteCard.getByRole('button', { name: /note options/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /share/i }).click();
    await page.getByPlaceholder(/search users/i).fill(user2Name);
    await page.getByText(user2Name).click();
    await page.keyboard.press('Escape');

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

  test('assignment is visible on the dashboard card', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const user2Name = uniqueUsername('collab');
    const user2Pass = 'testpass123';

    await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });

    // Create and share a todo note
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Card Avatar Test', ['Item A', 'Item B']);

    const noteCard = dashboardPage.noteCard('Card Avatar Test');
    await noteCard.hover();
    await noteCard.getByRole('button', { name: /note options/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /share/i }).click();
    await page.getByPlaceholder(/search users/i).fill(user2Name);
    await page.getByText(user2Name).click();
    await page.keyboard.press('Escape');

    // Open and assign the first item
    await dashboardPage.openNote('Card Avatar Test');
    await expect(page.getByRole('heading', { name: 'Edit Note' })).toBeVisible();

    const firstItemRow = page.locator('input[placeholder="List item..."]').first().locator('..');
    await firstItemRow.hover();
    const assignBtn = firstItemRow.locator('button[aria-label="Assign item"]');
    await assignBtn.waitFor({ state: 'visible', timeout: 5000 });
    await assignBtn.click();
    await page.getByText(user2Name).click();

    // Close the modal
    await page.click('button[aria-label="Close"]');

    // Verify the assignment avatar appears on the dashboard card
    const card = dashboardPage.noteCard('Card Avatar Test');
    await expect(card.locator('[data-testid="note-card"]').or(card).locator('svg[role="img"], img[alt]').first()).toBeVisible();
  });

  test('unsharing a user clears their assignment', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const user2Name = uniqueUsername('collab');
    const user2Pass = 'testpass123';

    await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });

    // Create a shared todo note and assign an item
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Unshare Cleanup', ['Task 1']);

    const noteCard = dashboardPage.noteCard('Unshare Cleanup');
    await noteCard.hover();
    await noteCard.getByRole('button', { name: /note options/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /share/i }).click();
    await page.getByPlaceholder(/search users/i).fill(user2Name);
    await page.getByText(user2Name).click();
    await page.keyboard.press('Escape');

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

    // Now unshare the note via API (simpler than UI flow for this test)
    // First get our session cookie from the page context
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c => c.name === 'jot_session');

    // Get the note ID from the API
    const notesResp = await request.get('/api/v1/notes', {
      headers: { Cookie: `jot_session=${sessionCookie?.value}` },
    });
    const notes = await notesResp.json();
    const note = notes.find((n: { title: string }) => n.title === 'Unshare Cleanup');

    // Unshare the user
    const unshareResp = await request.delete(`/api/v1/notes/${note.id}/share`, {
      headers: { Cookie: `jot_session=${sessionCookie?.value}` },
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

  test('collaborator sees the assignment on a shared note', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    const ownerName = authenticatedUser.username;
    const user2Name = uniqueUsername('viewer');
    const user2Pass = 'testpass123';

    await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });

    // Create a shared todo note and assign the owner to an item
    await dashboardPage.goto();
    await dashboardPage.createTodoNote('Collab View', ['Shared Task']);

    const noteCard = dashboardPage.noteCard('Collab View');
    await noteCard.hover();
    await noteCard.getByRole('button', { name: /note options/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /share/i }).click();
    await page.getByPlaceholder(/search users/i).fill(user2Name);
    await page.getByText(user2Name).click();
    await page.keyboard.press('Escape');

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
    // The picker buttons are inside the popover; scope to it to avoid matching sortable item buttons
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
