import { test, expect, uniqueUsername } from '../fixtures';

test.describe('Share dialog live updates', () => {
  test('the owner\'s open dialog drops a collaborator who deletes their account', async ({ page, playwright, baseURL, authenticatedUser, dashboardPage }) => {
    void authenticatedUser;
    const collaborator = uniqueUsername('gone');
    const collaboratorPass = 'testpass123';

    // The collaborator acts from a script with its own session.
    const api = await playwright.request.newContext({ baseURL: baseURL! });
    expect((await api.post('/api/v1/register', { data: { username: collaborator, password: collaboratorPass } })).ok()).toBeTruthy();

    // The owner's live-update stream is connected before anything changes.
    const streamOpened = page.waitForResponse('**/api/v1/events');
    await dashboardPage.goto();
    await streamOpened;
    await dashboardPage.createNote('Shared Plans');
    await dashboardPage.shareNoteWithUser('Shared Plans', collaborator);

    const shareDialog = await dashboardPage.openShareModal('Shared Plans');
    await expect(shareDialog.getByText(collaborator)).toBeVisible();

    const deleted = await api.delete('/api/v1/users/me', { data: { current_password: collaboratorPass } });
    expect(deleted.status()).toBe(204);
    await api.dispose();

    // The note_unshared event refreshes the open dialog; no reopen needed.
    await expect(shareDialog.getByText(collaborator)).toHaveCount(0);
    await expect(shareDialog.getByText(/not shared with anyone yet/i)).toBeVisible();
  });
});
