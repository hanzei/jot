import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { DashboardPage } from '../pages/DashboardPage';
import type { NoteEditorPage } from '../pages/NoteEditorPage';

interface ApiNote {
  id: string;
  content: string;
  version: number;
}

/**
 * The same user's other device: API calls outside the tab's own requests
 * (page.request shares the logged-in session, but not the page's routes).
 */
export function otherDevice(page: Page) {
  return {
    async findTextNote(content: string): Promise<ApiNote> {
      const response = await page.request.get('/api/v1/notes');
      expect(response.ok()).toBeTruthy();
      const { notes } = (await response.json()) as { notes: ApiNote[] };
      const note = notes.find(candidate => candidate.content === content);
      expect(note, `note "${content}" must exist`).toBeDefined();
      return note!;
    },
    async getNote(id: string): Promise<ApiNote> {
      const response = await page.request.get(`/api/v1/notes/${id}`);
      expect(response.ok()).toBeTruthy();
      return (await response.json()) as ApiNote;
    },
    async setContent(id: string, content: string) {
      const response = await page.request.patch(`/api/v1/notes/${id}`, { data: { content } });
      expect(response.ok()).toBeTruthy();
    },
  };
}

/**
 * Creates a text note, opens it, types `mine` into the editor and, while that
 * autosave is held in flight, changes the note to `theirs` from another device.
 * The held save then goes out based on the version the tab loaded and is
 * rejected as stale, which raises the conflict banner.
 *
 * Holding the request (rather than racing the debounce) is what makes this
 * deterministic: the other device's write is guaranteed to land between the
 * tab reading its version and its save reaching the server.
 */
export async function openNoteInConflict(
  { page, dashboardPage, noteEditorPage }: { page: Page; dashboardPage: DashboardPage; noteEditorPage: NoteEditorPage },
  { original, mine, theirs }: { original: string; mine: string; theirs: string },
) {
  await dashboardPage.goto();
  await dashboardPage.createTextNote(original);
  const device = otherDevice(page);
  const note = await device.findTextNote(original);
  await dashboardPage.openTextNote(original);

  const notePath = `**/api/v1/notes/${note.id}`;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const patchHeld = new Promise<void>(resolve => {
    void page.route(notePath, async route => {
      if (route.request().method() !== 'PATCH' || held) {
        await route.fallback();
        return;
      }
      held = true;
      resolve();
      await released;
      await route.fallback();
    });
  });

  await noteEditorPage.preview().click();
  await noteEditorPage.setContent(mine);
  await patchHeld;

  await device.setContent(note.id, theirs);
  const rejected = page.waitForResponse(response =>
    response.url().endsWith(`/api/v1/notes/${note.id}`) && response.request().method() === 'PATCH');
  release();
  expect((await rejected).status()).toBe(409);
  await page.unroute(notePath);

  return { device, noteId: note.id };
}
