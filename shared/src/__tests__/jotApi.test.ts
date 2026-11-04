import { describe, expect, it, vi } from 'vitest';
import { createJotApi, type JotHttpClient } from '../api';

function mockHttp(data: unknown = {}) {
  const res = Promise.resolve({ data });
  const http = {
    get: vi.fn(() => res),
    delete: vi.fn(() => res),
    post: vi.fn(() => res),
    patch: vi.fn(() => res),
    put: vi.fn(() => res),
  };
  return { http, api: createJotApi(http as unknown as JotHttpClient) };
}

describe('createJotApi', () => {
  it('does not touch the instance until an endpoint is called', () => {
    expect(() => createJotApi(undefined as unknown as JotHttpClient)).not.toThrow();
  });

  // Every endpoint: the request it makes, and what it returns for a response
  // body. `[]` as the body expectation means "called with the path only".
  const note = { id: 'n1' };
  type Case = [name: string, call: (api: ReturnType<typeof createJotApi>) => Promise<unknown>, method: 'get' | 'delete' | 'post' | 'patch' | 'put', args: unknown[], response: unknown, result: unknown];
  const cases: Case[] = [
    ['config.get', a => a.config.get(), 'get', ['/config'], { x: 1 }, { x: 1 }],
    ['about.get', a => a.about.get({ skipAuthRedirect: true }), 'get', ['/about', { skipAuthRedirect: true }], { v: 1 }, { v: 1 }],
    ['auth.login', a => a.auth.login({ username: 'u', password: 'p' }), 'post', ['/login', { username: 'u', password: 'p' }], { user: 1 }, { user: 1 }],
    ['auth.logout', a => a.auth.logout(), 'post', ['/logout', undefined, undefined], {}, undefined],
    ['auth.me', a => a.auth.me(), 'get', ['/users/me'], { user: 1 }, { user: 1 }],
    ['sso.unlink', a => a.sso.unlink(), 'post', ['/auth/oidc/unlink'], {}, undefined],
    ['notes.getById', a => a.notes.getById('n1'), 'get', ['/notes/n1'], note, note],
    ['notes.create', a => a.notes.create({ title: 't' } as never), 'post', ['/notes', { title: 't' }], note, note],
    ['notes.update', a => a.notes.update('n1', { title: 't' }), 'patch', ['/notes/n1', { title: 't' }], note, note],
    ['notes.emptyTrash', a => a.notes.emptyTrash(), 'delete', ['/notes/trash'], { deleted: 2 }, { deleted: 2 }],
    ['notes.markViewed', a => a.notes.markViewed('n1'), 'post', ['/notes/n1/viewed'], {}, undefined],
    ['notes.convert', a => a.notes.convert('n1', { note_type: 'list' } as never), 'post', ['/notes/n1/convert', { note_type: 'list' }], note, note],
    ['notes.listRevisions', a => a.notes.listRevisions('n1'), 'get', ['/notes/n1/revisions'], { revisions: [1] }, [1]],
    ['notes.getRevision', a => a.notes.getRevision('n1', 'r1'), 'get', ['/notes/n1/revisions/r1'], { id: 'r1' }, { id: 'r1' }],
    ['notes.restoreRevision', a => a.notes.restoreRevision('n1', 'r1', { base_version: 3 }, { timeout: 5 }), 'post', ['/notes/n1/revisions/r1/restore', { base_version: 3 }, { timeout: 5 }], note, note],
    ['notes.share', a => a.notes.share('n1', { user_id: 'u1' }), 'post', ['/notes/n1/share', { user_id: 'u1' }], {}, undefined],
    ['notes.unshare', a => a.notes.unshare('n1', 'u1'), 'delete', ['/notes/n1/shares/u1'], {}, undefined],
    ['notes.getShares', a => a.notes.getShares('n1'), 'get', ['/notes/n1/shares'], { shares: [1] }, [1]],
    ['notes.reorder', a => a.notes.reorder(['a']), 'post', ['/notes/reorder', { note_ids: ['a'] }], {}, undefined],
    ['notes.import', a => a.notes.import('form', { timeout: 1 }), 'post', ['/notes/import', 'form', { timeout: 1 }], { imported: 1 }, { imported: 1 }],
    ['notes.addLabel', a => a.notes.addLabel('n1', 'Work'), 'post', ['/notes/n1/labels', { name: 'Work' }], note, note],
    ['notes.removeLabel', a => a.notes.removeLabel('n1', 'l1'), 'delete', ['/notes/n1/labels/l1'], note, note],
    ['notes.createItem', a => a.notes.createItem('n1', { text: 'x' } as never), 'post', ['/notes/n1/items', { text: 'x' }], { id: 'i1' }, { id: 'i1' }],
    ['notes.updateItem', a => a.notes.updateItem('n1', 'i1', { text: 'y' }), 'patch', ['/notes/n1/items/i1', { text: 'y' }], { id: 'i1' }, { id: 'i1' }],
    ['notes.deleteItem', a => a.notes.deleteItem('n1', 'i1'), 'delete', ['/notes/n1/items/i1'], {}, undefined],
    ['notes.reorderItems', a => a.notes.reorderItems('n1', ['i1']), 'post', ['/notes/n1/items/reorder', { item_ids: ['i1'] }], {}, undefined],
    ['notes.setItemsCompleted', a => a.notes.setItemsCompleted('n1', ['i1'], false), 'post', ['/notes/n1/items/set-completed', { item_ids: ['i1'], completed: false }], [1], [1]],
    ['notes.deleteItems', a => a.notes.deleteItems('n1', ['i1']), 'post', ['/notes/n1/items/delete', { item_ids: ['i1'] }], [1], [1]],
    ['labels.getAll', a => a.labels.getAll(), 'get', ['/labels'], { labels: [1] }, [1]],
    ['labels.create', a => a.labels.create('Work'), 'post', ['/labels', { name: 'Work' }], { id: 'l1' }, { id: 'l1' }],
    ['labels.rename', a => a.labels.rename('l1', 'Home'), 'patch', ['/labels/l1', { name: 'Home' }], { id: 'l1' }, { id: 'l1' }],
    ['labels.delete', a => a.labels.delete('l1'), 'delete', ['/labels/l1'], {}, undefined],
    ['users.list', a => a.users.list(), 'get', ['/users'], { users: [1] }, [1]],
    ['users.search', a => a.users.search('al'), 'get', ['/users', { params: { search: 'al' } }], { users: [1], truncated: true }, { users: [1], truncated: true }],
    ['users.updateMe', a => a.users.updateMe({ theme: 'dark' }), 'patch', ['/users/me', { theme: 'dark' }], { user: 1 }, { user: 1 }],
    ['users.changePassword', a => a.users.changePassword({ new_password: 'x' } as never), 'put', ['/users/me/password', { new_password: 'x' }], {}, undefined],
    ['users.uploadProfileIcon', a => a.users.uploadProfileIcon('form'), 'post', ['/users/me/profile-icon', 'form', undefined], { id: 'u1' }, { id: 'u1' }],
    ['users.deleteProfileIcon', a => a.users.deleteProfileIcon(), 'delete', ['/users/me/profile-icon'], {}, undefined],
    ['sessions.list', a => a.sessions.list(), 'get', ['/sessions'], { sessions: [1] }, [1]],
    ['sessions.revoke', a => a.sessions.revoke('s1'), 'delete', ['/sessions/s1'], {}, undefined],
    ['pats.list', a => a.pats.list(), 'get', ['/pats'], { pats: [1] }, [1]],
    ['pats.create', a => a.pats.create({ name: 'ci' }), 'post', ['/pats', { name: 'ci' }], { id: 'p1' }, { id: 'p1' }],
    ['pats.revoke', a => a.pats.revoke('p1'), 'delete', ['/pats/p1'], {}, undefined],
    ['images.delete', a => a.images.delete('m1'), 'delete', ['/images/m1'], {}, undefined],
    ['admin.getStats', a => a.admin.getStats(), 'get', ['/admin/stats'], { users: 1 }, { users: 1 }],
    ['admin.getUsers', a => a.admin.getUsers(), 'get', ['/admin/users'], { users: [] }, { users: [] }],
    ['admin.createUser', a => a.admin.createUser({ username: 'u' } as never), 'post', ['/admin/users', { username: 'u' }], { id: 'u1' }, { id: 'u1' }],
    ['admin.updateUserRole', a => a.admin.updateUserRole('u1', { role: 'admin' }), 'put', ['/admin/users/u1/role', { role: 'admin' }], { id: 'u1' }, { id: 'u1' }],
    ['admin.setUserPassword', a => a.admin.setUserPassword('u1', { password: 'x' } as never), 'put', ['/admin/users/u1/password', { password: 'x' }], {}, undefined],
    ['admin.deleteUser', a => a.admin.deleteUser('u1'), 'delete', ['/admin/users/u1'], {}, undefined],
  ];

  it.each(cases)('%s', async (_name, call, method, args, response, result) => {
    const { http, api } = mockHttp(response);
    await expect(call(api)).resolves.toEqual(result);
    expect(http[method]).toHaveBeenCalledTimes(1);
    expect(http[method]).toHaveBeenCalledWith(...args);
  });

  it('propagates request failures', async () => {
    const { http, api } = mockHttp();
    http.get.mockReturnValueOnce(Promise.reject(new Error('Network Error')));
    await expect(api.notes.getById('n1')).rejects.toThrow('Network Error');
  });

  it('unwraps list responses', async () => {
    const { http, api } = mockHttp({ notes: [{ id: 'a' }] });
    await expect(api.notes.getAll({ archived: true })).resolves.toEqual([{ id: 'a' }]);
    expect(http.get).toHaveBeenCalledWith('/notes', {
      params: { archived: true, search: undefined, trashed: undefined, label: undefined, my_tasks: undefined },
    });
  });

  it('never sends the client-only user_id filter or an empty label', async () => {
    const { http, api } = mockHttp({ notes: [] });
    await api.notes.getAll({ label: '', my_tasks: false, user_id: 'u1', search: 'x' });
    expect(http.get).toHaveBeenCalledWith('/notes', {
      params: { archived: undefined, search: 'x', trashed: undefined, label: undefined, my_tasks: undefined },
    });
  });

  it('sends duplicate client IDs only when given', async () => {
    const { http, api } = mockHttp({ id: 'copy' });
    await api.notes.duplicate('n1');
    expect(http.post).toHaveBeenLastCalledWith('/notes/n1/duplicate', undefined);
    await api.notes.duplicate('n1', { id: 'c1', itemIds: { a: 'b' } });
    expect(http.post).toHaveBeenLastCalledWith('/notes/n1/duplicate', { id: 'c1', item_ids: { a: 'b' } });
  });

  it('returns the restored note', async () => {
    const { api } = mockHttp({ id: 'n1' });
    await expect(api.notes.restore('n1')).resolves.toEqual({ id: 'n1' });
  });

  it('sends a permanent delete to the URL the sync queue stores', async () => {
    const { http, api } = mockHttp();
    await api.notes.delete('n1', { permanent: true });
    expect(http.delete).toHaveBeenLastCalledWith('/notes/n1?permanent=true');
    await api.notes.delete('n1');
    expect(http.delete).toHaveBeenLastCalledWith('/notes/n1');
  });

  it('passes upload bodies and config through untouched', async () => {
    const { http, api } = mockHttp();
    const body = { opaque: true };
    const config = { timeout: 1 };
    await api.images.upload('n1', body, config);
    expect(http.post).toHaveBeenCalledWith('/notes/n1/images', body, config);
  });
});
