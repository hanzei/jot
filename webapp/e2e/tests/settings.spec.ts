import { test, expect, uniqueUsername } from '../fixtures';

test.describe('Settings', () => {
  test('changes username successfully', async ({ authenticatedUser, settingsPage, dashboardPage }) => {
    const newUsername = uniqueUsername('renamed');
    await settingsPage.goto();

    await settingsPage.changeUsername(newUsername);
    await settingsPage.expectSuccess('Profile updated successfully.');

    // Username should be reflected in the profile menu button tooltip
    await dashboardPage.expectProfileMenuTooltip(newUsername);
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
    await page.getByLabel('New Password', { exact: true }).fill('newpass456');
    await page.getByLabel('Confirm New Password').fill('different789');
    await page.getByRole('button', { name: 'Change Password' }).click();

    await expect(page.getByText('New passwords do not match.')).toBeVisible();
    void authenticatedUser;
  });

  test.describe('Profile Icon', () => {
    test('uploads a profile icon and shows it in settings and nav header', async ({
      page,
      authenticatedUser,
      settingsPage,
    }) => {
      await settingsPage.goto();

      // Before upload: no <img> in the Profile Icon section
      await expect(page.getByText('Profile Icon')).toBeVisible();
      await expect(settingsPage.profileIconPreview()).toHaveCount(0);

      // Upload the icon
      const uploadResponse = page.waitForResponse(
        resp => resp.url().includes('/api/v1/users/me/profile-icon') && resp.request().method() === 'POST'
      );
      await settingsPage.uploadProfileIcon();
      await uploadResponse;

      // Icon preview appears in settings
      await expect(settingsPage.profileIconPreview()).toBeVisible();

      // Icon appears in nav header
      await expect(settingsPage.navProfileIcon()).toBeVisible();

      void authenticatedUser;
    });

    test('removes a profile icon and falls back to placeholder', async ({
      page,
      authenticatedUser,
      settingsPage,
    }) => {
      await settingsPage.goto();

      // Upload first
      const uploadResponse = page.waitForResponse(
        resp => resp.url().includes('/api/v1/users/me/profile-icon') && resp.request().method() === 'POST'
      );
      await settingsPage.uploadProfileIcon();
      await uploadResponse;

      await expect(settingsPage.profileIconPreview()).toBeVisible();

      // Now remove
      const deleteResponse = page.waitForResponse(
        resp => resp.url().includes('/api/v1/users/me/profile-icon') && resp.request().method() === 'DELETE'
      );
      await settingsPage.removeProfileIcon();
      await deleteResponse;

      // Preview img is gone; Remove button is gone
      await expect(settingsPage.profileIconPreview()).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove icon' })).toHaveCount(0);

      // Nav header no longer shows an <img>
      await expect(settingsPage.navProfileIcon()).toHaveCount(0);

      void authenticatedUser;
    });
  });

  test.describe('Theme setting', () => {
    test('shows theme section with system/light/dark options', async ({ authenticatedUser, settingsPage, page }) => {
      await settingsPage.goto();

      await expect(page.getByText('Appearance')).toBeVisible();
      await expect(page.getByLabel('App theme')).toBeVisible();

      const select = page.getByLabel('App theme');
      await expect(select.locator('option[value="system"]')).toHaveText('System Default');
      await expect(select.locator('option[value="light"]')).toHaveText('Light');
      await expect(select.locator('option[value="dark"]')).toHaveText('Dark');

      void authenticatedUser;
    });

    test('selecting dark theme adds dark class to html element', async ({ authenticatedUser, settingsPage, page }) => {
      await settingsPage.goto();

      await settingsPage.selectTheme('Dark');

      // The dark class must be applied immediately to <html>
      await expect.poll(() => settingsPage.isDarkMode()).toBe(true);

      // The page background should reflect dark mode styling
      await expect(page.locator('html')).toHaveClass(/dark/);

      void authenticatedUser;
    });

    test('selecting light theme removes dark class from html element', async ({ authenticatedUser, settingsPage, page }) => {
      await settingsPage.goto();

      // First set dark, then switch to light
      await settingsPage.selectTheme('Dark');
      await expect.poll(() => settingsPage.isDarkMode()).toBe(true);

      await settingsPage.selectTheme('Light');
      await expect.poll(() => settingsPage.isDarkMode()).toBe(false);
      await expect(page.locator('html')).not.toHaveClass(/dark/);

      void authenticatedUser;
    });

    test('theme preference persists across page reload', async ({ authenticatedUser, settingsPage, page }) => {
      await settingsPage.goto();

      const saveResponse = page.waitForResponse(resp =>
        resp.url().includes('/api/v1/users/me') && !resp.url().includes('/password') && resp.request().method() === 'PATCH'
      );
      await settingsPage.selectTheme('Dark');
      await saveResponse;

      // Reload and verify the theme is still applied
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(/dark/);

      void authenticatedUser;
    });

    test('theme select shows saved value after reload', async ({ authenticatedUser, settingsPage, page }) => {
      await settingsPage.goto();

      const saveResponse = page.waitForResponse(resp =>
        resp.url().includes('/api/v1/users/me') && !resp.url().includes('/password') && resp.request().method() === 'PATCH'
      );
      await settingsPage.selectTheme('Dark');
      await saveResponse;

      await page.reload();
      await page.waitForLoadState('networkidle');

      const value = await settingsPage.getThemeSelectValue();
      expect(value).toBe('dark');

      void authenticatedUser;
    });
  });
});

test.describe('Export & Import', () => {
  test('shows Backup & Restore section with Export Notes and Import Notes buttons', async ({ authenticatedUser, settingsPage, page }) => {
    await settingsPage.goto();

    await expect(page.getByText('Backup & Restore')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export Notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import Notes' })).toBeVisible();

    void authenticatedUser;
  });

  test('export button triggers a file download', async ({ authenticatedUser, dashboardPage, settingsPage, page }) => {
    // Create a note to ensure there is something to export
    await dashboardPage.goto();
    await dashboardPage.createNote('Export test note', 'some content');

    await settingsPage.goto();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Notes' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^jot-export-.*\.json$/);

    void authenticatedUser;
  });

  test('import modal shows format selector with Google Keep and Jot JSON options', async ({ authenticatedUser, settingsPage, page }) => {
    await settingsPage.goto();

    await page.getByRole('button', { name: 'Import Notes' }).click();

    await expect(page.getByRole('heading', { name: 'Import Notes' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Google Keep' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Jot JSON' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Google Keep' })).toBeChecked();

    void authenticatedUser;
  });

  test('import modal switches description when format changes', async ({ authenticatedUser, settingsPage, page }) => {
    await settingsPage.goto();

    await page.getByRole('button', { name: 'Import Notes' }).click();

    // Default shows Google Keep description
    await expect(page.getByText(/Google Takeout/i)).toBeVisible();

    // Switch to Jot JSON
    await page.getByRole('radio', { name: 'Jot JSON' }).click();
    await expect(page.getByText(/Jot JSON export file/i)).toBeVisible();

    void authenticatedUser;
  });

  test('can import a Jot JSON file', async ({ authenticatedUser, settingsPage, dashboardPage, page }) => {
    // First export notes to get a valid Jot JSON file
    await dashboardPage.goto();
    await dashboardPage.createNote('Note to round-trip', 'round-trip content');

    await settingsPage.goto();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Notes' }).click();
    const download = await downloadPromise;
    const exportPath = await download.path();

    // Now import the exported file using Jot JSON format
    await page.getByRole('button', { name: 'Import Notes' }).click();
    await page.getByRole('radio', { name: 'Jot JSON' }).click();

    const fileInput = page.getByTestId('import-dropzone').locator('input[type="file"]');
    await fileInput.setInputFiles(exportPath!);

    const importResponse = page.waitForResponse(
      resp => resp.url().includes('/api/v1/notes/import') && resp.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Import' }).click();
    const resp = await importResponse;
    expect(resp.status()).toBe(200);

    await expect(page.getByText(/Imported/i)).toBeVisible();

    void authenticatedUser;
  });
});

test.describe('Settings sidebar labels — Mobile', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('shows labels in the settings sidebar and navigates to label filter', async ({ page, authenticatedUser, dashboardPage, settingsPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Unlabeled note', 'content');
    await dashboardPage.createNoteWithLabels('Seed settings label', 'content', ['settings-mobile-label']);

    await settingsPage.goto();
    await settingsPage.isSidebarHidden();
    await settingsPage.openSidebar();
    await settingsPage.isSidebarVisible();
    await settingsPage.clickMobileLabel('settings-mobile-label');

    await expect(page).toHaveURL(/[?&]label=/);
    await settingsPage.isSidebarHidden();
    await dashboardPage.expectNoteVisible('Seed settings label');
    await dashboardPage.expectNoteNotVisible('Unlabeled note');
    void authenticatedUser;
  });
});
