import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { failRequests } from '../fixtures/apiErrors';
import {
  createListNote,
  createTextNote,
  revokePublicLink,
  setPublicLink,
  shareNote,
  signUp,
} from '../fixtures/publicLinks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noteImageFile = {
  name: 'test-icon.png',
  mimeType: 'image/png',
  buffer: fs.readFileSync(path.join(__dirname, '../fixtures/test-icon.png')),
};

const TOKEN_SHAPE = /\/share\/[A-Za-z0-9_-]{43}$/;

/** Every API request the page makes from now on. */
function recordApiRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) requests.push(req);
  });
  return requests;
}

const paths = (requests: Request[]) => requests.map((req) => new URL(req.url()).pathname);

test.describe('Public note viewer', () => {
  test('shows a text note to a visitor without an account, through the public API only', async ({ page, request, publicNotePage }) => {
    // The owner works through `request`, a separate context: `page` never
    // signs in.
    await signUp(request);
    const noteId = await createTextNote(request, '## Packing\n\nBring **sunscreen** and a [map](https://example.com/map).');
    const token = await setPublicLink(request, noteId);

    const requests = recordApiRequests(page);
    await publicNotePage.goto(token);

    await expect(publicNotePage.content().getByRole('heading', { name: 'Packing' })).toBeVisible();
    await expect(publicNotePage.content().locator('strong')).toHaveText('sunscreen');
    await expect(publicNotePage.content().getByRole('link', { name: 'map' })).toHaveAttribute('href', 'https://example.com/map');
    // Stays on the link, rather than the 401 handler sending the visitor to /login.
    await expect(page).toHaveURL(TOKEN_SHAPE);
    expect(paths(requests)).toEqual([`/api/v1/public/notes/${token}`]);
  });

  test('shows a signed-in user the same viewer, with no signed-in calls', async ({ page, authenticatedUser, publicNotePage }) => {
    void authenticatedUser;
    const noteId = await createTextNote(page.request, 'Signed-in visitors see the same page');
    const token = await setPublicLink(page.request, noteId);
    // Leave the dashboard first, so its in-flight requests are not counted.
    await page.goto('about:blank');

    const requests = recordApiRequests(page);
    await publicNotePage.goto(token);

    await expect(publicNotePage.content()).toHaveText('Signed-in visitors see the same page');
    // No session check, SSE stream, profile icons or config: only the note.
    expect(paths(requests)).toEqual([`/api/v1/public/notes/${token}`]);
  });

  test('renders a list note with nested items, struck-through completed items and images', async ({ page, request, publicNotePage }) => {
    await signUp(request);
    const noteId = await createListNote(request, 'Groceries', [
      { text: 'Fruit' },
      { text: 'Apples', indent: 1 },
      { text: 'Pears', indent: 1, completed: true },
      { text: '**Bread**' },
      { text: 'Milk', completed: true },
    ]);
    const upload = await request.post(`/api/v1/notes/${noteId}/images`, { multipart: { file: noteImageFile } });
    expect(upload.ok()).toBeTruthy();
    const token = await setPublicLink(request, noteId);

    await publicNotePage.goto(token);

    await expect(publicNotePage.heading()).toHaveText('Groceries');
    await expect(publicNotePage.activeItems()).toHaveText(['Fruit', 'Apples', 'Bread']);
    await expect(publicNotePage.activeItems().nth(2).locator('strong')).toHaveText('Bread');
    // Apples is nested under Fruit.
    const fruitBox = await publicNotePage.activeItems().nth(0).boundingBox();
    const applesBox = await publicNotePage.activeItems().nth(1).boundingBox();
    expect(applesBox!.x).toBeGreaterThan(fruitBox!.x);

    await expect(publicNotePage.completedToggle()).toHaveText('Completed items (2)');
    // Pears keeps its group: it is listed under a copy of its active parent.
    const completed = publicNotePage.completedItems().getByRole('listitem');
    await expect(completed).toHaveText(['Fruit', 'Pears', 'Milk']);
    await expect(completed.filter({ hasText: 'Milk' }).locator('.line-through')).toBeVisible();

    const image = page.getByRole('img', { name: 'Image 1' });
    await expect(image).toHaveAttribute('src', new RegExp(`/api/v1/public/notes/${token}/images/[^/]+/thumbnail$`));
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    // The single-image frame is rendered at the image's real (1x1) aspect
    // ratio, so nothing is cropped: not 4:3, and not cut short by the height cap.
    const frame = await image.locator('xpath=../..').boundingBox();
    expect(frame!.height).toBeGreaterThan(0);
    expect(Math.abs(frame!.width - frame!.height)).toBeLessThanOrEqual(1);
  });

  test('starts the completed section in the note\'s collapsed state and toggles it locally', async ({ page, request, publicNotePage }) => {
    await signUp(request);
    const items = [{ text: 'Open' }, { text: 'Done', completed: true }];
    const collapsedToken = await setPublicLink(request, await createListNote(request, 'Collapsed', items, { checkedItemsCollapsed: true }));
    const expandedToken = await setPublicLink(request, await createListNote(request, 'Expanded', items));

    await publicNotePage.goto(collapsedToken);
    await expect(publicNotePage.completedToggle()).toHaveAttribute('aria-expanded', 'false');
    await expect(publicNotePage.completedItems()).toBeHidden();

    const requests = recordApiRequests(page);
    await publicNotePage.completedToggle().click();
    await expect(publicNotePage.completedToggle()).toHaveAttribute('aria-expanded', 'true');
    await expect(publicNotePage.completedItems().getByRole('listitem')).toHaveText(['Done']);
    await publicNotePage.completedToggle().click();
    await expect(publicNotePage.completedItems()).toBeHidden();
    // The toggle is this visitor's own view: nothing goes to the server.
    expect(paths(requests)).toEqual([]);

    // A reload goes back to the note's own state.
    await publicNotePage.completedToggle().click();
    await page.reload();
    await expect(publicNotePage.completedToggle()).toHaveAttribute('aria-expanded', 'false');

    await publicNotePage.goto(expandedToken);
    await expect(publicNotePage.completedToggle()).toHaveAttribute('aria-expanded', 'true');
    await expect(publicNotePage.completedItems().getByRole('listitem')).toHaveText(['Done']);
  });

  test('shows the same not-found state for a malformed, an unknown and a revoked link', async ({ page, request, publicNotePage }) => {
    await signUp(request);
    const noteId = await createTextNote(request, 'Soon gone');
    const token = await setPublicLink(request, noteId);
    await revokePublicLink(request, noteId);

    for (const dead of ['not-a-token', 'A'.repeat(43), token]) {
      await publicNotePage.goto(dead);
      await expect(publicNotePage.notFound()).toBeVisible();
      await expect(page.getByTestId('public-note-message')).toHaveText(
        "Note not foundThis link doesn't lead to a note. Check the link, or ask the person who sent it for a new one.",
      );
      await expect(publicNotePage.note()).toHaveCount(0);
    }
  });
});

test.describe('Public link section of the share dialog', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('creates, copies, re-times and revokes a link', async ({ page, authenticatedUser, dashboardPage, publicLinkSection, publicNotePage }) => {
    void authenticatedUser;
    await dashboardPage.goto();
    await dashboardPage.createNote('Public link note');
    await dashboardPage.openNote('Public link note');
    await dashboardPage.openShareModalFromModal();

    await expect(publicLinkSection.urlField()).toHaveCount(0);
    await publicLinkSection.create('In 7 days');
    const url = await publicLinkSection.copiedUrl();
    await expect(publicLinkSection.section().getByRole('button', { name: 'Copied!' })).toBeVisible();
    // Built on this page's origin: the e2e server sets no JOT_PUBLIC_URL.
    const origin = new URL(page.url()).origin;
    expect(url).toMatch(new RegExp(`^${origin}/share/[A-Za-z0-9_-]{43}$`));
    const token = new URL(url).pathname.slice('/share/'.length);
    // Shown without the scheme and with the token cut short, so it stays out
    // of screenshots and screen readers alike.
    await expect(publicLinkSection.shownUrl()).toHaveText(`${new URL(url).host}/share/${token.slice(0, 4)}…`);
    await expect(publicLinkSection.section()).not.toContainText(token);
    await expect(publicLinkSection.details()).toContainText('Expires');
    await expect(publicLinkSection.details()).toContainText('Created by you');

    // Nothing is preselected for a change, so the current expiry is never
    // replaced by whatever the select happened to show.
    await expect(publicLinkSection.section().getByRole('button', { name: 'Change expiry' })).toBeDisabled();
    // A new expiry keeps the URL, so links already sent keep working.
    await publicLinkSection.changeExpiry('Never');
    await expect(publicLinkSection.details()).toContainText('Never expires');
    expect(await publicLinkSection.copiedUrl()).toBe(url);

    await publicLinkSection.revoke();
    await expect(publicLinkSection.createButton()).toBeVisible();
    await expect(publicLinkSection.urlField()).toHaveCount(0);

    await publicNotePage.goto(new URL(url).pathname.slice('/share/'.length));
    await expect(publicNotePage.notFound()).toBeVisible();
  });

  test('copies a link built on public_url when the server sets one', async ({ page, authenticatedUser, dashboardPage, publicLinkSection }) => {
    void authenticatedUser;
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), public_url: 'https://jot.example.com' } });
    });
    await dashboardPage.goto();
    await dashboardPage.createNote('Public URL note');
    await dashboardPage.openNote('Public URL note');
    await dashboardPage.openShareModalFromModal();

    await publicLinkSection.create();
    await expect(publicLinkSection.shownUrl()).toHaveText(/^jot\.example\.com\/share\/[A-Za-z0-9_-]{4}…$/);
    expect(await publicLinkSection.copiedUrl()).toMatch(/^https:\/\/jot\.example\.com\/share\/[A-Za-z0-9_-]{43}$/);
  });

  test('offers the full link to select by hand when copying fails', async ({ page, authenticatedUser, dashboardPage, publicLinkSection }) => {
    void authenticatedUser;
    // Neither the Clipboard API nor the execCommand fallback works, as on a
    // browser that blocks both.
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
      document.execCommand = () => false;
    });
    await dashboardPage.goto();
    await dashboardPage.createNote('Copy fails note');
    await dashboardPage.openNote('Copy fails note');
    await dashboardPage.openShareModalFromModal();

    await publicLinkSection.create();
    await expect(publicLinkSection.fullUrlFallback()).toHaveCount(0);
    await publicLinkSection.copy();
    await expect(publicLinkSection.section().getByRole('alert')).toHaveText("Couldn't copy the link. Select it below and copy it yourself.");
    await expect(publicLinkSection.fullUrlFallback()).toBeFocused();
    await expect(publicLinkSection.fullUrlFallback()).toHaveValue(new RegExp(`^${new URL(page.url()).origin}/share/[A-Za-z0-9_-]{43}$`));
  });

  test('is hidden when the server has public links switched off', async ({ page, authenticatedUser, dashboardPage, publicLinkSection }) => {
    void authenticatedUser;
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), public_links_enabled: false } });
    });
    await dashboardPage.goto();
    await dashboardPage.createNote('No public links note');
    await dashboardPage.openNote('No public links note');
    await dashboardPage.openShareModalFromModal();

    await expect(page.getByLabel('Share with user')).toBeVisible();
    await expect(publicLinkSection.section()).toHaveCount(0);
  });

  test('explains a create refused because public links were switched off', async ({ page, authenticatedUser, dashboardPage, publicLinkSection }) => {
    void authenticatedUser;
    await failRequests(page, '**/api/v1/notes/*/public-link', 'PUT', {
      status: 403,
      code: 'public_links_disabled',
      message: 'public links are disabled on this server',
      requestId: 'req-public-links-off',
    });
    await dashboardPage.goto();
    await dashboardPage.createNote('Switched off note');
    await dashboardPage.openNote('Switched off note');
    await dashboardPage.openShareModalFromModal();

    await publicLinkSection.createButton().click();
    await expect(publicLinkSection.section().getByRole('alert')).toHaveText('Public links are switched off on this server.');
    await expect(publicLinkSection.urlField()).toHaveCount(0);
  });

  test("shows a collaborator the owner's link, and its revocation as it happens", async ({ page, request, authenticatedUser, dashboardPage, publicLinkSection }) => {
    const me = (await (await page.request.get('/api/v1/users/me')).json()) as { user: { id: string } };
    const owner = await signUp(request, 'publinkowner');
    const noteId = await createTextNote(request, 'Owned elsewhere');
    await shareNote(request, noteId, me.user.id);
    await setPublicLink(request, noteId);

    await dashboardPage.goto();
    await dashboardPage.openTextNote('Owned elsewhere');
    await dashboardPage.openSharingModalFromModal();
    await expect(publicLinkSection.details()).toContainText(`Created by ${owner.username}`);
    expect(authenticatedUser.username).not.toBe(owner.username);

    // Revoked by the owner while the dialog is open: the change arrives over SSE.
    await revokePublicLink(request, noteId);
    await expect(publicLinkSection.createButton()).toBeVisible();
    await expect(publicLinkSection.urlField()).toHaveCount(0);
  });
});
