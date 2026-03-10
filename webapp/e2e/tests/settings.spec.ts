import { test, expect, uniqueUsername } from '../fixtures';

test.describe('Settings', () => {
  test('changes username successfully', async ({ page, authenticatedUser, settingsPage }) => {
    const newUsername = uniqueUsername('renamed');
    await settingsPage.goto();

    await settingsPage.changeUsername(newUsername);
    await settingsPage.expectSuccess('Username updated successfully.');

    // Username should be reflected in the nav header (desktop nav has it as a span)
    await expect(page.getByText(newUsername).last()).toBeVisible();
    void authenticatedUser;
  });

  test('changes password and can log in with new password', async ({
    page,
    authenticatedUser,
    settingsPage,
    loginPage,
    dashboardPage,
  }) => {
    const newPassword = 'newpass456';

    await settingsPage.goto();
    await settingsPage.changePassword(authenticatedUser.password, newPassword);
    await settingsPage.expectSuccess('Password changed successfully.');

    // Logout and log back in with new password
    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');

    await loginPage.login(authenticatedUser.username, newPassword);
    await expect(page).toHaveURL('/');
  });

  test('shows error when current password is wrong', async ({ authenticatedUser, settingsPage }) => {
    await settingsPage.goto();
    await settingsPage.changePassword('wrongpassword', 'newpass456');
    await settingsPage.expectError('current password is incorrect');
    void authenticatedUser;
  });

  test('shows error when new passwords do not match', async ({ page, authenticatedUser, settingsPage }) => {
    await settingsPage.goto();

    // Fill in mismatching new passwords manually
    await page.getByLabel('Current password').fill(authenticatedUser.password);
    await page.getByLabel('New password').fill('newpass456');
    await page.getByLabel('Confirm password').fill('different789');
    await page.getByRole('button', { name: 'Change Password' }).click();

    await expect(page.getByText('New passwords do not match.')).toBeVisible();
    void authenticatedUser;
  });
});
