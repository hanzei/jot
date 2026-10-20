import { test, expect, uniqueUsername } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

test.describe('Unread badges', () => {
  test('a shared note is marked new, and a collaborator change marks it updated', async ({ page, authenticatedUser, dashboardPage, request }) => {
    const owner = authenticatedUser;

    const collaborator = uniqueUsername('unread');
    const collaboratorPass = 'testpass123';
    await request.post('/api/v1/register', {
      data: { username: collaborator, password: collaboratorPass },
    });

    // As the owner: create a list note and share it. The owner's own note never
    // carries a badge.
    await dashboardPage.goto();
    await dashboardPage.createNote('Badge Me');
    await dashboardPage.shareNoteWithUser('Badge Me', collaborator);
    await expect(dashboardPage.noteCardUnreadBadge('Badge Me')).toHaveCount(0);

    // As the collaborator: the shared note is new until opened.
    await dashboardPage.logout();
    const loginPage = new LoginPage(page);
    await loginPage.login(collaborator, collaboratorPass);
    await expect(page).toHaveURL('/');
    const newBadge = dashboardPage.noteCardUnreadBadge('Badge Me');
    await expect(newBadge).toHaveText('New');
    await expect(dashboardPage.noteCardButton('Badge Me')).toHaveAccessibleDescription('New');

    await dashboardPage.openNote('Badge Me');
    await expect(newBadge).toHaveCount(0);

    // The collaborator adds an item; their own change does not flag the note
    // for them, and the cleared "new" state survives a reload.
    await dashboardPage.addListItem('milk');
    await dashboardPage.closeNoteModal();
    // Reloading while the URL still points at the note would reopen it.
    await expect(page).toHaveURL('/');
    await page.reload();
    await expect(dashboardPage.noteCard('Badge Me')).toBeVisible();
    await expect(dashboardPage.noteCardUnreadBadge('Badge Me')).toHaveCount(0);

    // As the owner: the collaborator's change marks the note updated until
    // the owner opens it.
    await dashboardPage.logout();
    await loginPage.login(owner.username, owner.password);
    await expect(page).toHaveURL('/');
    const updatedBadge = dashboardPage.noteCardUnreadBadge('Badge Me');
    await expect(updatedBadge).toHaveText('Updated');

    await dashboardPage.openNote('Badge Me');
    await dashboardPage.closeNoteModal();
    await expect(updatedBadge).toHaveCount(0);
    await expect(page).toHaveURL('/');
    await page.reload();
    await expect(dashboardPage.noteCard('Badge Me')).toBeVisible();
    await expect(updatedBadge).toHaveCount(0);
  });
});
