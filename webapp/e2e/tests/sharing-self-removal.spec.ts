import { test, expect, uniqueUsername } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

test.describe('Leaving a shared note', () => {
  test('a collaborator can view who has access and remove themselves', async ({ page, authenticatedUser, dashboardPage, request }) => {
    // Destructured for its side effect: the fixture registers and logs in the
    // owner of the note. Playwright only runs a fixture a test names.
    void authenticatedUser;

    const collaborator = uniqueUsername('leave');
    const collaboratorPass = 'testpass123';
    await request.post('/api/v1/register', {
      data: { username: collaborator, password: collaboratorPass },
    });

    // As the owner: create a note and share it with the collaborator.
    await dashboardPage.goto();
    await dashboardPage.createNote('Leave Me');
    await dashboardPage.expectNoteVisible('Leave Me');
    await dashboardPage.shareNoteWithUser('Leave Me', collaborator);

    // Switch to the collaborator.
    await dashboardPage.logout();
    const loginPage = new LoginPage(page);
    await loginPage.login(collaborator, collaboratorPass);
    await expect(page).toHaveURL('/');
    await expect(page.getByText('Leave Me')).toBeVisible();

    // Open the note and the read-only sharing view.
    await dashboardPage.openNote('Leave Me');
    await dashboardPage.openSharingModalFromModal();

    // The dialog root is a zero-box wrapper; assert on its content instead.
    const shareDialog = page.getByRole('dialog', { name: 'Sharing' });
    // Read-only: the access list is shown, but there is no share picker.
    await expect(shareDialog.getByText(/people with access/i)).toBeVisible();
    await expect(shareDialog.getByRole('textbox')).toHaveCount(0);

    // Leaving requires a confirmation step: the first click only reveals the
    // confirm control.
    await shareDialog.getByRole('button', { name: /leave note/i }).click();
    const confirmButton = shareDialog.getByRole('button', { name: /^leave$/i });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    // The note disappears from the collaborator's dashboard once they leave.
    await expect(page.getByText('Leave Me')).not.toBeVisible();
  });
});
