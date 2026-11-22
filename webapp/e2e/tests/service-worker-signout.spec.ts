import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { confirmDialog } from '../pages/dialogs';

// The rest of the suite blocks service workers (playwright.config.ts). These
// tests need one: they check what it keeps for a user is gone after sign-out.
test.use({ serviceWorkers: 'allow' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imageBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/test-icon.png'));

/** Waits until the service worker controls the page, reloading once to let it claim it. */
async function waitForServiceWorker(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Requests waiting in Workbox's background-sync queue. */
const queuedRequestCount = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open('workbox-background-sync');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('requests')) {
      db.close();
      resolve(0);
      return;
    }
    const count = db.transaction('requests').objectStore('requests').count();
    count.onsuccess = () => {
      db.close();
      resolve(count.result);
    };
  };
}));

test.describe('Service worker on sign-out', () => {
  test('drops writes queued offline instead of replaying them later', async ({ page, context, authenticatedUser, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await waitForServiceWorker(page);

    await context.setOffline(true);
    const status = await page.evaluate(() =>
      fetch('/api/v1/notes/queued-offline', { method: 'PATCH', body: '{}' }).then((r) => r.status, () => -1));
    expect(status).toBe(202);
    expect(await queuedRequestCount(page)).toBe(1);

    // Offline, so the logout itself fails and must not be queued either. The
    // offline banner covers the header on phone widths, so the profile menu is
    // opened from the keyboard rather than clicked.
    await page.getByRole('button', { name: 'Profile menu' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    await confirmDialog(page, 'Logout');
    await expect(page.getByTestId('pending-logout-notice')).toBeVisible();
    expect(await queuedRequestCount(page)).toBe(0);
  });

  test('caches note images while signed in and deletes them on sign-out', async ({ page, authenticatedUser, dashboardPage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await waitForServiceWorker(page);

    const created = await page.request.post('/api/v1/notes', { data: { note_type: 'text', content: 'sw image' } });
    const { id: noteId } = await created.json() as { id: string };
    const upload = await page.request.post(`/api/v1/notes/${noteId}/images`, {
      multipart: { file: { name: 'test-icon.png', mimeType: 'image/png', buffer: imageBuffer } },
    });
    const { id: imageId } = await upload.json() as { id: string };
    const imageUrl = `/api/v1/images/${imageId}`;

    expect(await page.evaluate((url) => fetch(url).then((r) => r.status), imageUrl)).toBe(200);
    await expect.poll(() => page.evaluate(
      async (url) => !!(await (await caches.open('note-images')).match(url)), imageUrl)).toBe(true);

    await dashboardPage.logout();
    await expect(page).toHaveURL('/login');
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('note-images');
  });
});
