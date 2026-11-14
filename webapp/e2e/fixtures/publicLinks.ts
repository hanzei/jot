import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { uniqueUsername } from './index';

/**
 * API helpers for the public link specs. Each takes a request context that is
 * already signed in — `page.request` for the page's own user, or the separate
 * `request` fixture for a second user — so a spec can set up notes and links
 * without driving the UI.
 */

async function ok(response: Promise<APIResponse>): Promise<APIResponse> {
  const res = await response;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return res;
}

/** Registers and signs in a fresh user on `request`. */
export async function signUp(request: APIRequestContext, prefix = 'publink'): Promise<{ id: string; username: string }> {
  const username = uniqueUsername(prefix);
  await ok(request.post('/api/v1/register', { data: { username, password: 'testpass123' } }));
  await ok(request.post('/api/v1/login', { data: { username, password: 'testpass123' } }));
  return { id: await currentUserId(request), username };
}

export interface NewItem {
  text: string;
  completed?: boolean;
  /** 1 nests the item under the nearest preceding top-level item. */
  indent?: 0 | 1;
}

/** The id of the user `request` is signed in as. */
export async function currentUserId(request: APIRequestContext): Promise<string> {
  const me = (await (await ok(request.get('/api/v1/users/me'))).json()) as { user: { id: string } };
  return me.user.id;
}

export async function createTextNote(request: APIRequestContext, content: string): Promise<string> {
  const res = await ok(request.post('/api/v1/notes', { data: { note_type: 'text', content } }));
  return ((await res.json()) as { id: string }).id;
}

/** Creates one text note per entry, in order, and returns their ids. */
export async function createTextNotes(request: APIRequestContext, contents: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const content of contents) {
    ids.push(await createTextNote(request, content));
  }
  return ids;
}

export async function createListNote(
  request: APIRequestContext,
  title: string,
  items: NewItem[],
  { checkedItemsCollapsed = false } = {},
): Promise<string> {
  const res = await ok(request.post('/api/v1/notes', {
    data: {
      note_type: 'list',
      title,
      items: items.map((item, position) => ({
        text: item.text,
        position,
        completed: item.completed ?? false,
        indent_level: item.indent ?? 0,
      })),
    },
  }));
  const id = ((await res.json()) as { id: string }).id;
  if (checkedItemsCollapsed) {
    await ok(request.patch(`/api/v1/notes/${id}`, { data: { checked_items_collapsed: true } }));
  }
  return id;
}

/** Creates the note's public link (or changes its expiry) and returns its token. */
export async function setPublicLink(request: APIRequestContext, noteId: string, expiresAt: string | null = null): Promise<string> {
  const res = await ok(request.put(`/api/v1/notes/${noteId}/public-link`, { data: { expires_at: expiresAt } }));
  return ((await res.json()) as { token: string }).token;
}

export async function revokePublicLink(request: APIRequestContext, noteId: string): Promise<void> {
  await ok(request.delete(`/api/v1/notes/${noteId}/public-link`));
}

export async function shareNote(request: APIRequestContext, noteId: string, userId: string): Promise<void> {
  await ok(request.post(`/api/v1/notes/${noteId}/share`, { data: { user_id: userId } }));
}
