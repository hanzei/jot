import { test, expect, uniqueUsername } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';

test.describe('Shared-with-you toast', () => {
  test('the recipient is told about a share while the app is open and can open the note', async ({ page, authenticatedUser, dashboardPage, request, browser }) => {
    const recipient = uniqueUsername('sharetoast');
    const recipientPass = 'testpass123';
    await request.post('/api/v1/register', {
      data: { username: recipient, password: recipientPass },
    });

    await dashboardPage.goto();
    await dashboardPage.createNote('Trip Plan');

    // The recipient has the app open in their own browser, with the live-update
    // stream connected before the share happens.
    const baseURL = test.info().project.use.baseURL;
    const recipientContext = await browser.newContext(baseURL ? { baseURL } : {});
    const recipientPage = await recipientContext.newPage();
    const recipientDashboard = new DashboardPage(recipientPage);
    await new LoginPage(recipientPage).goto();
    const streamOpened = recipientPage.waitForResponse('**/api/v1/events');
    await new LoginPage(recipientPage).login(recipient, recipientPass);
    await expect(recipientPage).toHaveURL('/');
    await streamOpened;

    await dashboardPage.shareNoteWithUser('Trip Plan', recipient);

    const toast = recipientPage.getByTestId('toast').filter({ hasText: 'shared “Trip Plan” with you' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(authenticatedUser.username);
    // The sharer is not told about their own share.
    await expect(page.getByTestId('toast').filter({ hasText: 'with you' })).toHaveCount(0);

    // Opening from the toast goes through the normal open path, so the "New"
    // badge clears.
    await expect(recipientDashboard.noteCardUnreadBadge('Trip Plan')).toHaveText('New');
    await toast.getByRole('button', { name: 'Open' }).click();
    await expect(recipientPage).toHaveURL(/\/notes\//);
    await expect(recipientPage.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();
    await recipientDashboard.closeNoteModal();
    await expect(recipientDashboard.noteCardUnreadBadge('Trip Plan')).toHaveCount(0);

    await recipientContext.close();
  });
});
