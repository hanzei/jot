import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

interface ApiNote {
  id: string;
  content: string;
  version: number;
}

/**
 * Talks to the API as the page's logged-in user from a separate request
 * context — standing in for the same user's other device.
 */
export async function otherDevice(page: Page, request: APIRequestContext) {
  const cookies = await page.context().cookies();
  const session = cookies.find(cookie => cookie.name === 'jot_session');
  expect(session, 'session cookie must exist').toBeDefined();
  const headers = { Cookie: `jot_session=${session!.value}` };

  return {
    async findTextNote(content: string): Promise<ApiNote> {
      const response = await request.get('/api/v1/notes', { headers });
      expect(response.ok()).toBeTruthy();
      const notes = (await response.json()) as ApiNote[];
      const note = notes.find(candidate => candidate.content === content);
      expect(note, `note "${content}" must exist`).toBeDefined();
      return note!;
    },
    async getNote(id: string): Promise<ApiNote> {
      const response = await request.get(`/api/v1/notes/${id}`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()) as ApiNote;
    },
    async setContent(id: string, content: string) {
      const response = await request.patch(`/api/v1/notes/${id}`, { headers, data: { content } });
      expect(response.ok()).toBeTruthy();
    },
  };
}

/**
 * Types `localText` into the open note's editor and, while that autosave is
 * held in flight, changes the note to `remoteText` from another device. The
 * held save then goes out based on the version the tab loaded and is rejected
 * as stale.
 *
 * Holding the request (rather than racing the debounce) is what makes this
 * deterministic: the other device's write is guaranteed to land between the
 * tab reading its version and its save reaching the server.
 */
export async function provokeVersionConflict(
  page: Page,
  device: Awaited<ReturnType<typeof otherDevice>>,
  noteId: string,
  localText: string,
  remoteText: string,
) {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const patchHeld = new Promise<void>(resolve => {
    void page.route(`**/api/v1/notes/${noteId}`, async route => {
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

  await page.getByTestId('note-content-preview').click();
  await page.getByRole('dialog').locator('textarea').fill(localText);
  await patchHeld;

  await device.setContent(noteId, remoteText);
  const rejected = page.waitForResponse(response =>
    response.url().endsWith(`/api/v1/notes/${noteId}`) && response.request().method() === 'PATCH');
  release();
  expect((await rejected).status()).toBe(409);
  await page.unroute(`**/api/v1/notes/${noteId}`);
}
