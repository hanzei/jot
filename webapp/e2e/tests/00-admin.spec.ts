import { test, expect, uniqueUsername } from '../fixtures';
import type { Page } from '@playwright/test';
import { AdminPage } from '../pages/AdminPage';

type MeResponse = {
  user?: {
    role?: string;
  };
};

type Credentials = {
  username: string;
  password: string;
};

const bootstrapAdmin: Credentials = {
  username: 'e2eadmin',
  password: 'testpass123',
};

async function ensureAdminSession(page: Page) {
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const meData = await meResponse.json() as MeResponse;
  if (meData.user?.role !== 'admin') {
    throw new Error(
      'Expected authenticated test user to be admin. Run this spec first in a fresh e2e DB.'
    );
  }
}

async function expectOk(response: { ok(): boolean; status(): number; statusText(): string }, action: string) {
  expect(response.ok(), `${action} failed with ${response.status()} ${response.statusText()}`).toBeTruthy();
}

async function ensureBootstrapAdmin(page: Page) {
  const registerResponse = await page.request.post('/api/v1/register', { data: bootstrapAdmin });
  if (!registerResponse.ok()) {
    expect(registerResponse.status()).toBe(409);
    await expectOk(
      await page.request.post('/api/v1/login', { data: bootstrapAdmin }),
      'login bootstrap admin',
    );
  }
}

test.describe('Admin', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // The admin tests require the first registered user to be admin (fresh DB).
    // With multiple Playwright projects sharing a single webServer, only the
    // first project gets a fresh DB.
    test.skip(testInfo.project.name === 'mobile-chrome', 'Admin tests require a fresh DB (first project only)');

    if (testInfo.title.includes('non-admin')) {
      return;
    }

    await ensureBootstrapAdmin(page);
  });

  test('admin stats render seeded instance metrics', async ({ page, request }) => {
    const adminPage = new AdminPage(page);
    const memberOneUsername = uniqueUsername('m1');
    const memberTwoUsername = uniqueUsername('m2');
    const password = 'testpass123';

    await ensureAdminSession(page);

    const memberOneResponse = await request.post('/api/v1/register', {
      data: { username: memberOneUsername, password },
    });
    await expectOk(memberOneResponse, 'register member one');
    const memberOne = await memberOneResponse.json() as { user: { id: string } };

    const memberTwoResponse = await request.post('/api/v1/register', {
      data: { username: memberTwoUsername, password },
    });
    await expectOk(memberTwoResponse, 'register member two');
    const memberTwo = await memberTwoResponse.json() as { user: { id: string } };

    const sharedTextResponse = await page.request.post('/api/v1/notes', {
      data: { title: 'Shared text note', content: 'shared content', note_type: 'text' },
    });
    await expectOk(sharedTextResponse, 'create shared text note');
    const sharedTextNote = await sharedTextResponse.json() as { id: string };

    const archivedListResponse = await page.request.post('/api/v1/notes', {
      data: {
        title: 'Archived list note',
        note_type: 'list',
        items: [
          { text: 'First item', position: 0 },
          { text: 'Second item', position: 1 },
        ],
      },
    });
    await expectOk(archivedListResponse, 'create archived list note');
    const archivedListNote = await archivedListResponse.json() as { id: string };

    const activeListResponse = await page.request.post('/api/v1/notes', {
      data: {
        title: 'Active list note',
        note_type: 'list',
        items: [{ text: 'Assigned item', position: 0 }],
      },
    });
    await expectOk(activeListResponse, 'create active list note');
    const activeListNote = await activeListResponse.json() as { id: string };

    const trashedTextResponse = await page.request.post('/api/v1/notes', {
      data: { title: 'Trashed text note', content: 'trashed content', note_type: 'text' },
    });
    await expectOk(trashedTextResponse, 'create trashed text note');
    const trashedTextNote = await trashedTextResponse.json() as { id: string };

    await expectOk(
      await page.request.post(`/api/v1/notes/${archivedListNote.id}/share`, { data: { user_id: memberOne.user.id } }),
      'share archived list note with member one',
    );
    await expectOk(
      await page.request.post(`/api/v1/notes/${activeListNote.id}/share`, { data: { user_id: memberTwo.user.id } }),
      'share active list note with member two',
    );

    const updateArchivedListResponse = await page.request.patch(`/api/v1/notes/${archivedListNote.id}`, {
      data: {
        archived: true,
        items: [
          { text: 'First item', position: 0, completed: true, assigned_to: memberOne.user.id },
          { text: 'Second item', position: 1, completed: false, assigned_to: '' },
        ],
      },
    });
    await expectOk(updateArchivedListResponse, 'update archived list note');

    const updateActiveListResponse = await page.request.patch(`/api/v1/notes/${activeListNote.id}`, {
      data: {
        items: [
          { text: 'Assigned item', position: 0, completed: false, assigned_to: memberTwo.user.id },
        ],
      },
    });
    await expectOk(updateActiveListResponse, 'update active list note');

    const trashNoteResponse = await page.request.delete(`/api/v1/notes/${trashedTextNote.id}`);
    await expectOk(trashNoteResponse, 'trash text note');

    await expectOk(
      await page.request.post(`/api/v1/notes/${sharedTextNote.id}/share`, { data: { user_id: memberOne.user.id } }),
      'share note with member one',
    );
    await expectOk(
      await page.request.post(`/api/v1/notes/${sharedTextNote.id}/share`, { data: { user_id: memberTwo.user.id } }),
      'share note with member two',
    );

    await expectOk(
      await page.request.post(`/api/v1/notes/${sharedTextNote.id}/labels`, { data: { name: 'work' } }),
      'add work label',
    );
    await expectOk(
      await page.request.post(`/api/v1/notes/${sharedTextNote.id}/labels`, { data: { name: 'urgent' } }),
      'add urgent label',
    );
    await expectOk(
      await page.request.post(`/api/v1/notes/${archivedListNote.id}/labels`, { data: { name: 'work' } }),
      'add work label to archived list note',
    );

    const statsResponse = await page.request.get('/api/v1/admin/stats');
    await expectOk(statsResponse, 'fetch admin stats');
    const stats = await statsResponse.json() as {
      users: { total: number };
      notes: { total: number };
      sharing: { shared_notes: number };
      labels: { total: number };
      list_items: { total: number };
    };

    await adminPage.goto();
    await expect(page).toHaveURL('/admin');
    expect(await adminPage.isVisible()).toBe(true);

    expect(await adminPage.getUsersTotal()).toBe(String(stats.users.total));
    expect(await adminPage.getNotesTotal()).toBe(String(stats.notes.total));
    expect(await adminPage.getSharedNotesCount()).toBe(String(stats.sharing.shared_notes));
    expect(await adminPage.getLabelsTotal()).toBe(String(stats.labels.total));
    expect(await adminPage.getListItemsTotal()).toBe(String(stats.list_items.total));
    expect(await adminPage.getDatabaseSizeText()).not.toBe('0 B');
  });

  test('admin can create, update role, and delete a user', async ({ page }) => {
    const adminPage = new AdminPage(page);
    const managedUsername = uniqueUsername('managed');
    const managedPassword = 'testpass123';

    await ensureAdminSession(page);
    await adminPage.goto();
    await expect(page).toHaveURL('/admin');
    expect(await adminPage.isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Create User', exact: true }).click();
    const createModal = page.getByRole('dialog', { name: 'Create New User' });
    await createModal.getByPlaceholder('Username (2-30 characters)').fill(managedUsername);
    await createModal.locator('input[type="password"]').fill(managedPassword);
    await createModal.getByRole('button', { name: 'Create User' }).click();

    const usersList = page.getByTestId('users-list');
    const managedUserRow = usersList.getByTestId(`user-row-${managedUsername}`);
    await expect(managedUserRow).toBeVisible();

    await managedUserRow.getByRole('button', { name: 'Make Admin' }).click();
    await expect(managedUserRow.getByRole('button', { name: 'Remove Admin' })).toBeVisible();
    await expect(managedUserRow.getByText(/^Admin$/)).toBeVisible();

    await managedUserRow.getByRole('button', { name: 'Remove Admin' }).click();
    await expect(managedUserRow.getByRole('button', { name: 'Make Admin' })).toBeVisible();

    await managedUserRow.getByRole('button', { name: `Delete user ${managedUsername}` }).click();
    const confirmDialog = page.getByRole('dialog').last();
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();
    await expect(usersList.getByTestId(`user-row-${managedUsername}`)).toHaveCount(0);
  });

  test('non-admin users are redirected away from admin page', async ({
    page,
    loginPage,
    request,
  }) => {
    const standardUsername = uniqueUsername('member');
    const standardPassword = 'testpass123';

    const bootstrapRegisterResponse = await request.post('/api/v1/register', {
      data: bootstrapAdmin,
    });
    if (!bootstrapRegisterResponse.ok()) {
      expect(bootstrapRegisterResponse.status()).toBe(409);
    }

    const registerResponse = await request.post('/api/v1/register', {
      data: { username: standardUsername, password: standardPassword },
    });
    expect(registerResponse.ok()).toBeTruthy();

    await loginPage.goto();
    await loginPage.login(standardUsername, standardPassword);
    await expect(page).toHaveURL('/');

    await page.goto('/admin');
    await expect(page).toHaveURL('/');

    await page.getByRole('button', { name: 'Profile menu' }).click();
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });
});
