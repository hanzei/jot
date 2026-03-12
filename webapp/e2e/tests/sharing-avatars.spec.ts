import { test, expect, uniqueUsername } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

test.describe('Sharing Avatars', () => {
  test('shared note shows recipient avatar on dashboard', async ({ page, authenticatedUser, dashboardPage, request }) => {
    const user2Name = uniqueUsername('share');
    const user2Pass = 'testpass123';

    // Register second user via API (avoids browser session/cookie conflicts)
    await request.post('/api/v1/register', {
      data: { username: user2Name, password: user2Pass },
    });

    // As user1, create a note
    await dashboardPage.goto();
    await dashboardPage.createNote('Shared Note Test');
    await dashboardPage.expectNoteVisible('Shared Note Test');

    // Share via context menu on the note card
    const noteCard = page.locator('[data-testid="note-card"]').filter({ hasText: 'Shared Note Test' });
    await noteCard.hover();
    await noteCard.getByRole('button', { name: /note options/i }).click();
    await page.getByRole('menuitem', { name: /share/i }).click();

    // Share modal: search for user and select from dropdown
    await page.getByPlaceholder(/search users/i).fill(user2Name);
    await page.getByText(user2Name).click();

    // Close share modal
    await page.keyboard.press('Escape');

    // Verify avatar appears on the dashboard card
    await expect(noteCard.locator('svg[role="img"], img[alt]').first()).toBeVisible();

    // Log out and log in as user2 to verify owner avatar
    await page.getByRole('button', { name: /profile menu/i }).click();
    await page.getByRole('menuitem', { name: /log\s*out/i }).click();

    const loginPage = new LoginPage(page);
    await loginPage.login(user2Name, user2Pass);
    await expect(page).toHaveURL('/');
    await expect(page.getByText('Shared Note Test')).toBeVisible();

    // The note card should show the owner's avatar
    const sharedCard = page.locator('[data-testid="note-card"]').filter({ hasText: 'Shared Note Test' });
    await expect(sharedCard.locator('svg[role="img"], img[alt]').first()).toBeVisible();
  });
});
