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

    const archivedTodoResponse = await page.request.post('/api/v1/notes', {
      data: {
        title: 'Archived todo note',
        note_type: 'todo',
        items: [
          { text: 'First todo', position: 0 },
          { text: 'Second todo', position: 1 },
        ],
      },
    });
    await expectOk(archivedTodoResponse, 'create archived todo note');
    const archivedTodoNote = await archivedTodoResponse.json() as { id: string };

    const activeTodoResponse = await page.request.post('/api/v1/notes', {
      data: {
        title: 'Active todo note',
        note_type: 'todo',
        items: [{ text: 'Assigned todo', position: 0 }],
      },
    });
    await expectOk(activeTodoResponse, 'create active todo note');
    const activeTodoNote = await activeTodoResponse.json() as { id: string };

    const trashedTextResponse = await page.request.post('/api/v1/notes', {
      data: { title: 'Trashed text note', content: 'trashed content', note_type: 'text' },
    });
    await expectOk(trashedTextResponse, 'create trashed text note');
    const trashedTextNote = await trashedTextResponse.json() as { id: string };

    await expectOk(
      await page.request.post(`/api/v1/notes/${archivedTodoNote.id}/share`, { data: { user_id: memberOne.user.id } }),
      'share archived todo note with member one',
    );
    await expectOk(
      await page.request.post(`/api/v1/notes/${activeTodoNote.id}/share`, { data: { user_id: memberTwo.user.id } }),
      'share active todo note with member two',
    );

    const updateArchivedTodoResponse = await page.request.patch(`/api/v1/notes/${archivedTodoNote.id}`, {
      data: {
        archived: true,
        items: [
          { text: 'First todo', position: 0, completed: true, assigned_to: memberOne.user.id },
          { text: 'Second todo', position: 1, completed: false, assigned_to: '' },
        ],
      },
    });
    await expectOk(updateArchivedTodoResponse, 'update archived todo note');

    const updateActiveTodoResponse = await page.request.patch(`/api/v1/notes/${activeTodoNote.id}`, {
      data: {
        items: [
          { text: 'Assigned todo', position: 0, completed: false, assigned_to: memberTwo.user.id },
        ],
      },
    });
    await expectOk(updateActiveTodoResponse, 'update active todo note');

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
      await page.request.post(`/api/v1/notes/${archivedTodoNote.id}/labels`, { data: { name: 'work' } }),
      'add work label to archived todo',
    );

    const statsResponse = await page.request.get('/api/v1/admin/stats');
    await expectOk(statsResponse, 'fetch admin stats');
    const stats = await statsResponse.json() as {
      users: { total: number };
      notes: { total: number };
      sharing: { shared_notes: number };
      labels: { total: number };
      todo_items: { total: number };
    };

    await adminPage.goto();
    await expect(page).toHaveURL('/admin');
    expect(await adminPage.isVisible()).toBe(true);

    expect(await adminPage.getUsersTotal()).toBe(String(stats.users.total));
    expect(await adminPage.getNotesTotal()).toBe(String(stats.notes.total));
    expect(await adminPage.getSharedNotesCount()).toBe(String(stats.sharing.shared_notes));
    expect(await adminPage.getLabelsTotal()).toBe(String(stats.labels.total));
    expect(await adminPage.getTodoItemsTotal()).toBe(String(stats.todo_items.total));
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
    await page.getByPlaceholder('Username (2-30 characters)').fill(managedUsername);
    await page.locator('input[type="password"]').fill(managedPassword);
    await page.getByRole('button', { name: 'Create User' }).click();

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
